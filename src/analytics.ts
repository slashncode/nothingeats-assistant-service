import type { LanguageModelCallEndEvent, LanguageModelCallStartEvent, ModelMessage, ToolExecutionEndEvent } from 'ai';
import type { Component } from './lifecycle.ts';
import { randomUUID } from 'node:crypto';
import { PostHog } from 'posthog-node';

/**
 * Present only when the browser sent its PostHog ids, which it does only after the visitor agreed
 * to analytics (record 028). Without it, nothing about the request reaches PostHog.
 */
export interface Consent {
    distinctId: string;
    sessionId?: string;
}

export interface Analytics {
    capture: (consent: Consent | undefined, event: string, properties: Record<string, unknown>) => void;
}

export interface Flags {
    /**
     * Whether [flag] is on for [distinctId], evaluated in this process from the flag definitions;
     * undefined when that is not possible (no key, no such flag, conditions on person properties).
     * Only [report] sends PostHog the `$feature_flag_called` event.
     */
    isEnabled: (flag: string, distinctId: string, report: boolean) => Promise<boolean | undefined>;
}

/**
 * posthog-node, batched; no project token (tests, local runs) means no client at all. With the
 * project's flags secret key it also loads the flag definitions (every 30 s) and evaluates flags
 * locally: deciding a flag sends PostHog nothing about the person.
 */
export class PostHogAnalytics implements Analytics, Flags, Component {
    readonly name = 'posthog';
    private readonly client: PostHog | undefined;
    private readonly localFlags: boolean;

    constructor(projectToken: string, host: string, flagsSecretKey?: string) {
        this.localFlags = Boolean(projectToken && flagsSecretKey);
        this.client = projectToken
            ? new PostHog(projectToken, {
                    host,
                    flushAt: 20,
                    flushInterval: 5_000,
                    ...(flagsSecretKey
                        ? { secretKey: flagsSecretKey, featureFlagsPollingInterval: 30_000 }
                        : { enableLocalEvaluation: false }),
                })
            : undefined;
    }

    async isEnabled(flag: string, distinctId: string, report: boolean): Promise<boolean | undefined> {
        if (!this.client || !this.localFlags)
            return undefined;
        return this.client.isFeatureEnabled(flag, distinctId, { onlyEvaluateLocally: true, sendFeatureFlagEvents: report });
    }

    capture(consent: Consent | undefined, event: string, properties: Record<string, unknown>): void {
        if (!consent || !this.client)
            return;
        this.client.capture({
            distinctId: consent.distinctId,
            event,
            // `$session_id` links the event to the session replay of the browser it came from.
            properties: {
                ...properties,
                ...(consent.sessionId
                    ? { $session_id: consent.sessionId }
                    : {}),
            },
        });
    }

    async stop(): Promise<void> {
        await this.client?.shutdown(5_000);
    }
}

type ModelCall = Pick<LanguageModelCallStartEvent, 'instructions' | 'messages' | 'tools'>;

const seconds = (ms: number) => Math.round(ms) / 1000;

/**
 * One turn of the coach as a PostHog LLM trace: a `$ai_generation` per model call, a `$ai_span`
 * per tool call and a closing `$ai_trace`, nested by span ids so PostHog shows the tree. The
 * conversation is the `$ai_session_id`, so all turns of a chat line up in PostHog's sessions view.
 *
 * Built from the AI SDK's lifecycle callbacks rather than @posthog/ai's model wrapper, which does
 * not support AI SDK 7 models (spec v4) yet, and which records generations only.
 */
export class CoachTrace {
    readonly traceId = randomUUID();
    private readonly startedAt = performance.now();
    private readonly calls = new Map<string, ModelCall>();
    private step = 0;
    private readonly analytics: Analytics;
    private readonly consent: Consent | undefined;
    private readonly conversationId: string;

    constructor(analytics: Analytics, consent: Consent | undefined, conversationId: string) {
        this.analytics = analytics;
        this.consent = consent;
        this.conversationId = conversationId;
    }

    private capture(event: string, properties: Record<string, unknown>) {
        this.analytics.capture(this.consent, event, {
            $ai_trace_id: this.traceId,
            $ai_session_id: this.conversationId,
            conversation_id: this.conversationId,
            ...properties,
        });
    }

    readonly onLanguageModelCallStart = (event: LanguageModelCallStartEvent): void => {
        if (this.consent)
            this.calls.set(event.callId, { instructions: event.instructions, messages: event.messages, tools: event.tools });
    };

    readonly onLanguageModelCallEnd = (event: LanguageModelCallEndEvent): void => {
        if (!this.consent)
            return;
        const call = this.calls.get(event.callId);
        this.calls.delete(event.callId);
        this.step++;
        this.capture('$ai_generation', {
            $ai_span_id: event.callId,
            $ai_span_name: `step ${this.step}`,
            $ai_parent_id: this.traceId,
            $ai_provider: event.provider.split('.')[0],
            $ai_model: event.modelId,
            $ai_input: [
                ...(typeof call?.instructions === 'string'
                    ? [
                            { role: 'system', content: call.instructions },
                        ]
                    : []),
                ...(call?.messages ?? []).map(message),
            ],
            $ai_output_choices: [
                {
                    role: 'assistant',
                    content: event.content.flatMap(outputPart),
                },
            ],
            $ai_input_tokens: event.usage.inputTokens ?? 0,
            $ai_output_tokens: event.usage.outputTokens ?? 0,
            $ai_cache_read_input_tokens: event.usage.inputTokenDetails.cacheReadTokens ?? 0,
            $ai_reasoning_tokens: event.usage.outputTokenDetails.reasoningTokens ?? 0,
            $ai_latency: seconds(event.performance.responseTimeMs),
            ...(event.performance.timeToFirstOutputMs === undefined
                ? {}
                : {
                        $ai_time_to_first_token: seconds(event.performance.timeToFirstOutputMs),
                    }),
            $ai_stream: true,
            $ai_stop_reason: event.finishReason,
            $ai_tools: call?.tools,
        });
    };

    readonly onToolExecutionEnd = (event: ToolExecutionEndEvent): void => {
        const output = event.toolOutput;
        const failed = output.type === 'tool-error';
        this.capture('$ai_span', {
            $ai_span_id: event.toolCall.toolCallId,
            $ai_span_name: event.toolCall.toolName,
            $ai_parent_id: this.traceId,
            $ai_input_state: event.toolCall.input,
            $ai_output_state: failed ? undefined : output.output,
            $ai_latency: seconds(event.toolExecutionMs),
            $ai_is_error: failed,
            ...(failed
                ? {
                        $ai_error: String(output.error),
                    }
                : {}),
        });
    };

    /** The whole turn: what the customer said, what came back, and which dishes were shown. */
    end(input: string, output: { text: string; dishIds: string[] }, error?: string): void {
        this.capture('$ai_trace', {
            $ai_span_name: 'craving_coach',
            $ai_input_state: { message: input },
            $ai_output_state: output,
            $ai_latency: seconds(performance.now() - this.startedAt),
            $ai_is_error: error !== undefined,
            ...(error === undefined
                ? {}
                : { $ai_error: error }),
        });
    }
}

// PostHog reads OpenAI-style messages: text as text, tool calls as functions.
function message(model: ModelMessage) {
    if (typeof model.content === 'string')
        return { role: model.role, content: model.content };
    return {
        role: model.role,
        content: model.content.map((part) => {
            switch (part.type) {
                case 'text':
                    return { type: 'text', text: part.text };
                case 'tool-call':
                    return {
                        type: 'function',
                        id: part.toolCallId,
                        function: { name: part.toolName, arguments: part.input },
                    };
                case 'tool-result':
                    return {
                        type: 'tool_result',
                        tool_call_id: part.toolCallId,
                        name: part.toolName,
                        content: part.output,
                    };
                default:
                    return { type: part.type };
            }
        }),
    };
}

function outputPart(part: LanguageModelCallEndEvent['content'][number]): Record<string, unknown>[] {
    switch (part.type) {
        case 'text':
            return [
                { type: 'text', text: part.text },
            ];
        case 'tool-call':
            return [
                {
                    type: 'function',
                    id: part.toolCallId,
                    function: { name: part.toolName, arguments: part.input },
                },
            ];
        default:
            return [];
    }
}
