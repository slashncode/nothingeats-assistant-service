import type { JSONValue, LanguageModel, UIMessage } from 'ai';
import type { Analytics, Consent } from '../analytics.ts';
import type { Caller } from '../http/auth.ts';
import type { Limiter } from '../limits.ts';
import type { CachedVocabulary, Catalog, Language } from '../search/catalog.ts';
import type { ConversationStore } from '../store/conversations.ts';
import type { CoachTools } from './tools.ts';
import {
    APICallError,
    convertToModelMessages,
    createIdGenerator,
    createUIMessageStreamResponse,
    isStepCount,
    safeValidateUIMessages,
    streamText,
    toUIMessageStream,
} from 'ai';
import { CoachTrace } from '../analytics.ts';
import { AppError } from '../http/problems.ts';
import { log } from '../log.ts';
import { instructions } from './instructions.ts';
import { coachTools, newTurnState } from './tools.ts';

export interface CoachDependencies {
    model: LanguageModel;
    providerOptions?: Record<string, Record<string, JSONValue>>;
    catalog: Catalog;
    vocabulary: CachedVocabulary;
    conversations: ConversationStore;
    limiter: Limiter;
    analytics: Analytics;
    now?: () => Date;
}

export interface Turn {
    caller: Caller;
    conversationId: string;
    /** The customer's new message: one text part, already validated. */
    message: UIMessage;
    language: Language;
    consent?: Consent;
}

/** Search, recommend, answer: two tool steps and a reply leave room for one retry. */
const MAX_STEPS = 5;
/** What the model sees of a long conversation. */
const MAX_CONTEXT = 20;
/** What a conversation keeps. */
const MAX_STORED = 60;

/** Error codes the chat shows in the customer's language. */
export type CoachErrorCode = 'COACH_BUSY' | 'COACH_UNAVAILABLE';

function errorCode(error: unknown): CoachErrorCode {
    return APICallError.isInstance(error) && error.statusCode === 429
        ? 'COACH_BUSY'
        : 'COACH_UNAVAILABLE';
}

function textOf(message: UIMessage | undefined) {
    return message?.parts.flatMap(part => (part.type === 'text'
        ? [part.text]
        : [])).join(' ').trim() ?? '';
}

/**
 * One turn of the Craving Coach: check the budget, load the conversation, let the model search
 * and recommend with the tools, stream the answer to the chat as AI SDK UI messages, and store
 * the conversation when the turn ends (also when the customer closed the chat meanwhile).
 */
export class Coach {
    private readonly deps: CoachDependencies;
    private readonly now: () => Date;
    private readonly messageId = createIdGenerator({ prefix: 'msg', size: 16 });

    constructor(deps: CoachDependencies) {
        this.deps = deps;
        this.now = deps.now ?? (() => new Date());
    }

    async answer(turn: Turn): Promise<Response> {
        const { caller, conversationId, language, consent } = turn;
        const admission = await this.deps.limiter.admit(caller.id, this.now());
        if (!admission.admitted) {
            const code = admission.reason === 'TOKENS'
                ? 'COACH_DAILY_BUDGET_USED'
                : 'COACH_TOO_MANY_MESSAGES';
            throw new AppError(429, code, 'The coach needs a break', undefined, {
                'retry-after': String(admission.retryAfterSeconds),
            });
        }
        const existing = await this.deps.conversations.find(conversationId, caller.id);
        if (existing === 'foreign')
            throw AppError.notFound('CONVERSATION_NOT_FOUND', 'There is no such conversation');

        const state = newTurnState();
        const tools = coachTools({
            catalog: this.deps.catalog,
            token: caller.token,
            language,
            vocabulary: await this.deps.vocabulary.get(caller.token),
            state,
        });
        const messages = await valid([
            ...(existing?.messages ?? []),
            turn.message,
        ], tools);
        const trace = new CoachTrace(this.deps.analytics, consent, conversationId);
        let usedTokens = 0;
        let failure: CoachErrorCode | undefined;

        const result = streamText({
            model: this.deps.model,
            instructions: instructions(language, this.now()),
            messages: await convertToModelMessages(messages.slice(-MAX_CONTEXT), { tools, ignoreIncompleteToolCalls: true }),
            tools,
            stopWhen: isStepCount(MAX_STEPS),
            providerOptions: this.deps.providerOptions,
            maxOutputTokens: 2_000,
            timeout: { totalMs: 60_000, toolMs: 10_000 },
            onLanguageModelCallStart: trace.onLanguageModelCallStart,
            onLanguageModelCallEnd: trace.onLanguageModelCallEnd,
            onToolExecutionEnd: trace.onToolExecutionEnd,
            onEnd: ({ totalUsage }) => {
                usedTokens = totalUsage.totalTokens ?? 0;
            },
            onError: ({ error }) => {
                failure = errorCode(error);
                log.error({ err: error, conversationId }, 'The coach failed');
            },
        });
        // Runs the turn to its end even when the customer closes the chat, so it is stored.
        void result.consumeStream();

        return createUIMessageStreamResponse({
            stream: toUIMessageStream({
                stream: result.stream,
                tools,
                originalMessages: messages,
                sendReasoning: false,
                generateMessageId: this.messageId,
                onError: errorCode,
                onEnd: async ({ messages: all }) => {
                    await this.deps.conversations.save(conversationId, caller.id, all.slice(-MAX_STORED), usedTokens);
                    await this.deps.limiter.spend(caller.id, usedTokens, this.now());
                    const shown = state.recommended.map(dish => dish.id);
                    trace.end(textOf(turn.message), {
                        text: textOf(all.at(-1)),
                        dishIds: shown,
                    }, failure);
                    if (shown.length > 0) {
                        this.deps.analytics.capture(consent, 'coach_dishes_recommended', {
                            conversation_id: conversationId,
                            dish_ids: shown,
                            count: shown.length,
                            language,
                        });
                    }
                },
            }),
        });
    }
}

/**
 * Stored messages are checked against today's tools before they go back to the model. A
 * conversation from before a tool changed keeps its words and loses the old tool parts.
 */
async function valid(messages: UIMessage[], tools: CoachTools): Promise<UIMessage[]> {
    const checked = await safeValidateUIMessages({ messages, tools });
    if (checked.success)
        return checked.data;
    log.warn({ err: checked.error }, 'Stored messages no longer match the tools; keeping their text');
    return messages
        .map(message => ({
            ...message,
            parts: message.parts.filter(part => part.type === 'text'),
        }))
        .filter(message => message.parts.length > 0);
}
