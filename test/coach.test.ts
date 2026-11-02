import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { LanguageModel } from 'ai';
import type { StartedTestContainer } from 'testcontainers';
import type { Flags } from '../src/analytics.ts';
import type { LimitSettings } from '../src/limits.ts';
import type { Postgres } from '../src/store/db.ts';
import { APICallError } from 'ai';
import { Valkey } from 'iovalkey';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CoachAvailability } from '../src/chat/availability.ts';
import { Coach } from '../src/chat/coach.ts';
import { DemoModel } from '../src/chat/demoModel.ts';
import { userEventHandler } from '../src/events/userEvents.ts';
import { createApp } from '../src/http/app.ts';
import { ValkeyLimiter } from '../src/limits.ts';
import { log } from '../src/log.ts';
import { CachedVocabulary } from '../src/search/catalog.ts';
import { PostgresConversations } from '../src/store/conversations.ts';
import { chunks, FakeCatalog, json, RecordingAnalytics, startPostgres, startValkey, testTokens, VALKEY_PASSWORD } from './support.ts';

let database: { container: StartedPostgreSqlContainer; postgres: Postgres };
let valkeyContainer: StartedTestContainer;
const limiters: ValkeyLimiter[] = [];
let tokens: Awaited<ReturnType<typeof testTokens>>;

beforeAll(async () => {
    [database, valkeyContainer, tokens] = await Promise.all([
        startPostgres(),
        startValkey(),
        testTokens(),
    ]);
});

afterAll(async () => {
    await Promise.all(limiters.map(limiter => limiter.stop()));
    await database?.postgres.stop();
    await Promise.all([
        database?.container.stop(),
        valkeyContainer?.stop(),
    ]);
});

async function limiter(settings: LimitSettings = { messagesPerHour: 100, tokensPerDay: 1_000_000 }) {
    const created = new ValkeyLimiter(
        new Valkey({
            host: valkeyContainer.getHost(),
            port: valkeyContainer.getMappedPort(6379),
            password: VALKEY_PASSWORD,
            lazyConnect: true,
        }),
        settings,
    );
    await created.start();
    limiters.push(created);
    return created;
}

/** The whole HTTP API with the scripted model, a fake search and real Postgres and Valkey. */
async function service(options: { limits?: LimitSettings; model?: LanguageModel; flags?: Flags } = {}) {
    const catalog = new FakeCatalog();
    const analytics = new RecordingAnalytics();
    const conversations = new PostgresConversations(database.postgres.db);
    const coach = new Coach({
        model: options.model ?? new DemoModel(),
        catalog,
        vocabulary: new CachedVocabulary(catalog),
        conversations,
        limiter: await limiter(options.limits),
        analytics,
        now: () => new Date('2026-10-30T11:30:00Z'),
    });
    const app = createApp({
        auth: tokens.auth,
        coach,
        availability: new CoachAvailability(options.flags ?? {
            isEnabled: async () => undefined,
        }, 'craving-coach'),
        conversations,
        health: {
            isLive: () => true,
            isReady: async () => true,
        },
    });
    return {
        app,
        catalog,
        analytics,
        conversations,
    };
}

let counter = 0;

function chat(app: ReturnType<typeof createApp>, token: string, text: string, options: { id?: string; language?: 'de' | 'en'; headers?: Record<string, string> } = {}) {
    counter++;
    return app.request('/api/assistant/v1/chat', {
        method: 'POST',
        headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json', ...options.headers },
        body: JSON.stringify({
            id: options.id ?? `conversation-${counter}`,
            language: options.language ?? 'de',
            message: {
                id: `user-message-${counter}`,
                role: 'user',
                parts: [
                    { type: 'text', text },
                ],
            },
        }),
    });
}

describe('the craving coach', () => {
    it('searches, recommends catalog dishes as cards and stores the conversation for its owner only', async () => {
        const { app, catalog, conversations } = await service();
        const token = await tokens.token('customer-1');

        const response = await chat(app, token, 'Etwas Warmes, bitte', { id: 'conversation-warm' });
        expect(response.status).toBe(200);
        const parts = await chunks(response);

        // The search ran on the customer's behalf, with their token, in their language.
        expect(catalog.retrievals).toHaveLength(1);
        expect(catalog.retrievals[0]).toMatchObject({
            token,
            input: { query: 'Etwas Warmes, bitte', language: 'de' },
        });
        const shown = parts.find(part => part.type === 'tool-output-available' && (part.output as { shown?: unknown[] }).shown);
        expect((shown?.output as { shown: { id: string; restaurant: { slug: string } }[] }).shown.map(card => card.id)).toEqual(['d-margherita', 'd-pho', 'd-curry']);
        expect(parts.filter(part => part.type === 'text-delta').map(part => part.delta).join('')).toContain('Bestellen kostet nichts');

        const stored = await vi.waitFor(async () => {
            const found = await conversations.find('conversation-warm', 'customer-1');
            if (!found || found === 'foreign')
                throw new Error('not stored yet');
            return found;
        });
        expect(stored.title).toBe('Etwas Warmes, bitte');
        expect(stored.messages.map(message => message.role)).toEqual(['user', 'assistant']);
        expect(stored.tokens).toBeGreaterThan(0);

        const loaded = await app.request('/api/assistant/v1/conversations/conversation-warm', {
            headers: { authorization: `Bearer ${token}` },
        });
        expect((await json(loaded)).messages).toHaveLength(2);

        // Someone else cannot read it, continue it or delete it.
        const stranger = await tokens.token('customer-2');
        expect((await app.request('/api/assistant/v1/conversations/conversation-warm', {
            headers: { authorization: `Bearer ${stranger}` },
        })).status).toBe(404);
        expect((await chat(app, stranger, 'Und jetzt?', { id: 'conversation-warm' })).status).toBe(404);
        expect((await app.request('/api/assistant/v1/conversations/conversation-warm', {
            method: 'DELETE',
            headers: { authorization: `Bearer ${stranger}` },
        })).status).toBe(404);
    });

    it('continues a conversation with what it showed before', async () => {
        const { app } = await service();
        const token = await tokens.token('customer-3');

        await chunks(await chat(app, token, 'Pizza', { id: 'conversation-again', language: 'en' }));
        await vi.waitFor(async () => {
            const list = await json(await app.request('/api/assistant/v1/conversations', {
                headers: { authorization: `Bearer ${token}` },
            }));
            expect(list.items.map((item: { id: string }) => item.id)).toContain('conversation-again');
        });
        await chunks(await chat(app, token, 'Something sweeter', { id: 'conversation-again', language: 'en' }));

        await vi.waitFor(async () => {
            const loaded = await json(await app.request('/api/assistant/v1/conversations/conversation-again', {
                headers: { authorization: `Bearer ${token}` },
            }));
            expect(loaded.messages.map((message: { role: string }) => message.role)).toEqual([
                'user',
                'assistant',
                'user',
                'assistant',
            ]);
        });
    });

    it('traces every turn in PostHog only for customers who agreed to analytics', async () => {
        const { app, analytics } = await service();
        const token = await tokens.token('customer-4');

        await chunks(await chat(app, token, 'Ohne Zustimmung'));
        await vi.waitFor(() => expect(analytics.events).toEqual([]));

        await chunks(await chat(app, token, 'Mit Zustimmung', {
            id: 'conversation-traced',
            headers: { 'x-posthog-distinct-id': 'customer-4', 'x-posthog-session-id': 'session-4' },
        }));
        await vi.waitFor(() => expect(analytics.named('$ai_trace')).toHaveLength(1));

        const generations = analytics.named('$ai_generation');
        const spans = analytics.named('$ai_span');
        const [trace] = analytics.named('$ai_trace');
        expect(generations).toHaveLength(3);
        expect(spans.map(span => span.properties.$ai_span_name)).toEqual(['searchDishes', 'recommendDishes']);
        const traceId = trace!.properties.$ai_trace_id;
        expect([
            ...generations,
            ...spans,
        ].every(event => event.properties.$ai_trace_id === traceId && event.properties.$ai_parent_id === traceId)).toBe(true);
        expect(generations[0]!.properties).toMatchObject({
            $ai_model: 'scripted-coach',
            $ai_provider: 'demo',
            $ai_session_id: 'conversation-traced',
            $ai_input_tokens: 400,
        });
        expect(trace!.properties).toMatchObject({
            $ai_input_state: { message: 'Mit Zustimmung' },
            $ai_is_error: false,
        });
        expect(trace!.consent).toEqual({ distinctId: 'customer-4', sessionId: 'session-4' });
        expect(analytics.named('coach_dishes_recommended')[0]!.properties).toMatchObject({
            count: 3,
            dish_ids: ['d-margherita', 'd-pho', 'd-curry'],
        });
    });

    it('refuses strangers, nonsense and the message after the hour\'s budget', async () => {
        const { app } = await service({
            limits: { messagesPerHour: 1, tokensPerDay: 1_000_000 },
        });
        const token = await tokens.token('customer-5');

        expect((await app.request('/api/assistant/v1/conversations')).status).toBe(401);
        const expired = await tokens.token('customer-5', { issuer: 'https://evil.example' });
        expect((await chat(app, expired, 'Hallo')).status).toBe(401);

        const tooLong = await chat(app, token, 'x'.repeat(501));
        expect(tooLong.status).toBe(422);
        expect((await json(tooLong)).code).toBe('COACH_INVALID');

        await chunks(await chat(app, token, 'eins'));
        const refused = await chat(app, token, 'zwei');
        expect(refused.status).toBe(429);
        expect(refused.headers.get('retry-after')).toMatch(/^\d+$/);
        expect((await json(refused)).code).toBe('COACH_TOO_MANY_MESSAGES');
    });

    it('tells the chat when the model fails, and keeps what the customer said', async () => {
        const failing = new DemoModel();
        failing.doStream = async () => {
            throw new APICallError({
                message: 'Rate limit',
                url: 'https://api.openai.com/v1/responses',
                requestBodyValues: {},
                statusCode: 429,
                isRetryable: false,
            });
        };
        const { app, conversations } = await service({ model: failing });
        const token = await tokens.token('customer-6');

        const parts = await chunks(await chat(app, token, 'Hunger', { id: 'conversation-failed' }));

        expect(parts.find(part => part.type === 'error')).toMatchObject({ errorText: 'COACH_BUSY' });
        await vi.waitFor(async () => {
            const stored = await conversations.find('conversation-failed', 'customer-6');
            expect(stored !== 'foreign' && stored?.messages[0]?.role).toBe('user');
        });
    });

    it('lets admins read every customer\'s transcripts, page by page, and logs who read which', async () => {
        const { app } = await service();
        const customer = await tokens.token('customer-admin-1');
        const other = await tokens.token('customer-admin-2');
        const admin = await tokens.token('admin-1', {
            roles: ['admin', 'customer'],
        });
        await chunks(await chat(app, customer, 'Etwas Scharfes', { id: 'conversation-admin-1' }));
        await chunks(await chat(app, other, 'Etwas Süßes', { id: 'conversation-admin-2' }));
        const get = (path: string, token = admin) => app.request(`/api/assistant/v1/admin${path}`, {
            headers: { authorization: `Bearer ${token}` },
        });

        expect((await get('/conversations', customer)).status).toBe(403);

        await vi.waitFor(async () => {
            const mine = await json(await get('/conversations?userId=customer-admin-1'));
            expect(mine.items).toHaveLength(1);
            expect(mine.items[0]).toMatchObject({ id: 'conversation-admin-1', userId: 'customer-admin-1', title: 'Etwas Scharfes' });
            expect(mine.items[0].messageCount).toBeGreaterThanOrEqual(2);
        });
        const first = await json(await get('/conversations?limit=1'));
        const second = await json(await get(`/conversations?limit=1&cursor=${first.nextCursor}`));
        expect([first.items[0].id, second.items[0].id]).not.toContain(undefined);
        expect(first.items[0].id).not.toBe(second.items[0].id);
        expect((await get('/conversations?cursor=nonsense')).status).toBe(422);

        const reads = vi.spyOn(log, 'info');
        const transcript = await json(await get('/conversations/conversation-admin-2'));
        expect(transcript).toMatchObject({ id: 'conversation-admin-2', userId: 'customer-admin-2' });
        expect(transcript.messages[0].parts[0].text).toBe('Etwas Süßes');
        expect(reads).toHaveBeenCalledWith({ adminId: 'admin-1', conversationId: 'conversation-admin-2', ownerId: 'customer-admin-2' }, 'An admin read a coach transcript');
        reads.mockRestore();
        expect((await get('/conversations/conversation-gone')).status).toBe(404);
    });

    it('hands out every conversation for the GDPR export and forgets them all when the account is deleted', async () => {
        const { app, conversations } = await service();
        const token = await tokens.token('customer-7');
        await chunks(await chat(app, token, 'Eins', { id: 'conversation-export-1' }));
        await chunks(await chat(app, token, 'Zwei', { id: 'conversation-export-2' }));

        await vi.waitFor(async () => {
            const exported = await json(await app.request('/api/assistant/v1/me/export', {
                headers: { authorization: `Bearer ${token}` },
            }));
            expect(exported.conversations.map((it: { id: string }) => it.id)).toEqual(['conversation-export-1', 'conversation-export-2']);
        });

        expect((await app.request('/api/assistant/v1/conversations/conversation-export-1', {
            method: 'DELETE',
            headers: { authorization: `Bearer ${token}` },
        })).status).toBe(204);
        await userEventHandler(conversations)(JSON.stringify({
            type: 'nothingeats.identity.user.deleted.v1',
            data: { userId: 'customer-7' },
        }));

        expect(await conversations.export('customer-7')).toEqual([]);
    });

    it('follows the flag: off means no button and no answers, and only consent reports the call', async () => {
        const calls: { flag: string; distinctId: string; report: boolean }[] = [];
        let on: boolean | undefined = false;
        const flags: Flags = {
            isEnabled: async (flag, distinctId, report) => {
                calls.push({ flag, distinctId, report });
                return on;
            },
        };
        const { app } = await service({ flags });
        const token = await tokens.token('customer-8');
        const availability = async (headers: Record<string, string> = {}) =>
            json(await app.request('/api/assistant/v1/availability', {
                headers: { authorization: `Bearer ${token}`, ...headers },
            }));

        expect(await availability()).toEqual({ enabled: false });
        const refused = await chat(app, token, 'Hunger');
        expect(refused.status).toBe(403);
        expect((await json(refused)).code).toBe('COACH_DISABLED');

        on = undefined;
        expect(await availability({ 'x-posthog-distinct-id': 'customer-8' })).toEqual({ enabled: true });
        // Always under the account id; the event only with consent.
        expect(calls.map(call => [call.flag, call.distinctId, call.report])).toEqual([
            ['craving-coach', 'customer-8', false],
            ['craving-coach', 'customer-8', false],
            ['craving-coach', 'customer-8', true],
        ]);

        const broken = new CoachAvailability({
            isEnabled: async () => { throw new Error('PostHog is down'); },
        }, 'craving-coach');
        expect(await broken.enabled({ id: 'customer-8', roles: [], token }, undefined)).toBe(true);
    });
});
