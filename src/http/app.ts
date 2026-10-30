import type { Consent } from '../analytics.ts';
import type { CoachAvailability } from '../chat/availability.ts';
import type { Coach } from '../chat/coach.ts';
import type { ConversationStore } from '../store/conversations.ts';
import type { Caller, JwtAuth } from './auth.ts';
import { Hono } from 'hono';
import { z } from 'zod';
import { log } from '../log.ts';
import { bearer } from './auth.ts';
import { AppError, problem } from './problems.ts';

export interface Health {
    isLive: () => boolean;
    isReady: () => Promise<boolean>;
}

export interface AppDependencies {
    auth: JwtAuth;
    coach: Coach;
    availability: CoachAvailability;
    conversations: ConversationStore;
    health: Health;
}

interface Env {
    Variables: {
        caller: Caller;
        consent: Consent | undefined;
    };
}

/** Longer cravings are not cravings any more; it also bounds what a message can cost. */
export const MAX_MESSAGE_LENGTH = 500;

const conversationId = z.string().regex(/^[\w-]{8,64}$/);

// What the chat sends: the conversation id, the newest message only (the rest is stored here) and
// the language on screen. Anything else in the message (metadata, other parts) is dropped.
const chatRequest = z.object({
    id: conversationId,
    language: z.enum(['de', 'en']).default('de'),
    message: z.object({
        id: z.string().min(1).max(100),
        role: z.literal('user'),
        parts: z
            .array(z.object({
                type: z.literal('text'),
                text: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
            }))
            .length(1),
    }),
});

/** The browser's PostHog ids, which it only sends after the visitor agreed to analytics. */
function consentOf(headers: Headers): Consent | undefined {
    const distinctId = headers.get('x-posthog-distinct-id')?.trim();
    if (!distinctId)
        return undefined;
    const sessionId = headers.get('x-posthog-session-id')?.trim();
    return {
        distinctId,
        ...(sessionId
            ? { sessionId }
            : {}),
    };
}

/**
 * `/api/assistant/v1`: every route needs a signed-in customer, and every conversation belongs to
 * exactly one of them. Health endpoints live outside the API path, for the probes.
 */
export function createApp({ auth, coach, availability, conversations, health }: AppDependencies): Hono {
    const app = new Hono();

    app.get('/health/live', c => (health.isLive()
        ? c.json({ status: 'UP' })
        : c.json({ status: 'DOWN' }, 503)));
    app.get('/health/ready', async c => ((await health.isReady())
        ? c.json({ status: 'UP' })
        : c.json({ status: 'DOWN' }, 503)));

    const api = new Hono<Env>();

    api.use('*', async (c, next) => {
        const token = bearer(c.req.header('authorization'));
        const caller = token
            ? await auth.verify(token)
            : undefined;
        if (!caller) {
            return problem(401, 'UNAUTHENTICATED', 'A valid access token is required', {
                headers: { 'www-authenticate': 'Bearer' },
            });
        }
        c.set('caller', caller);
        c.set('consent', consentOf(c.req.raw.headers));
        await next();
    });

    // Whether the chat should show the coach at all (the flag's rollout and kill switch).
    api.get('/availability', async c => c.json({ enabled: await availability.enabled(c.get('caller'), c.get('consent')) }));

    api.post('/chat', async (c) => {
        if (!(await availability.enabled(c.get('caller'), c.get('consent'))))
            throw new AppError(403, 'COACH_DISABLED', 'The coach is not available for this account');
        const parsed = chatRequest.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) {
            throw AppError.invalid(
                'COACH_INVALID',
                parsed.error.issues.map(issue => ({ field: issue.path.join('.') || 'body', message: issue.message })),
            );
        }
        const { id, language, message } = parsed.data;
        return coach.answer({
            caller: c.get('caller'),
            conversationId: id,
            message,
            language,
            consent: c.get('consent'),
        });
    });

    api.get('/conversations', async (c) => {
        const items = await conversations.list(c.get('caller').id, 20);
        return c.json({ items });
    });

    api.get('/conversations/:id', async (c) => {
        const id = conversationId.safeParse(c.req.param('id'));
        const found = id.success
            ? await conversations.find(id.data, c.get('caller').id)
            : undefined;
        if (!found || found === 'foreign')
            throw AppError.notFound('CONVERSATION_NOT_FOUND', 'There is no such conversation');
        return c.json({
            id: found.id,
            title: found.title,
            messages: found.messages,
            updatedAt: found.updatedAt,
        });
    });

    api.delete('/conversations/:id', async (c) => {
        const id = conversationId.safeParse(c.req.param('id'));
        if (!id.success || !(await conversations.delete(id.data, c.get('caller').id)))
            throw AppError.notFound('CONVERSATION_NOT_FOUND', 'There is no such conversation');
        return c.body(null, 204);
    });

    // GDPR export: every conversation with every message, as stored.
    api.get('/me/export', async (c) => {
        const all = await conversations.export(c.get('caller').id);
        return c.json({
            conversations: all.map(({ id, title, messages, tokens, createdAt, updatedAt }) => ({
                id,
                title,
                messages,
                tokens,
                createdAt,
                updatedAt,
            })),
        });
    });

    app.route('/api/assistant/v1', api);

    app.notFound(() => problem(404, 'NOT_FOUND', 'There is nothing here'));
    app.onError((error) => {
        if (error instanceof AppError)
            return problem(error.status, error.code, error.title, { violations: error.violations, headers: error.headers });
        log.error({ err: error }, 'Unexpected error');
        return problem(500, 'INTERNAL_ERROR', 'Something went wrong');
    });

    return app;
}
