import type { JSONValue, LanguageModel } from 'ai';
import type { Config } from './config.ts';
import type { Health } from './http/app.ts';
import { createOpenAI } from '@ai-sdk/openai';
import { PostHogAnalytics } from './analytics.ts';
import { CoachAvailability } from './chat/availability.ts';
import { Coach } from './chat/coach.ts';
import { DemoModel } from './chat/demoModel.ts';
import { ConsumerLagWatch, KafkaConsumerLag } from './events/consumerLag.ts';
import { GROUP_ID, USER_TOPIC, UserEvents } from './events/userEvents.ts';
import { createApp } from './http/app.ts';
import { JwtAuth } from './http/auth.ts';
import { HttpServer } from './http/server.ts';
import { Lifecycle } from './lifecycle.ts';
import { ValkeyLimiter } from './limits.ts';
import { CachedVocabulary, GrpcCatalog } from './search/catalog.ts';
import { PostgresConversations } from './store/conversations.ts';
import { Postgres } from './store/db.ts';

/**
 * OpenAI through the Responses API: stateless (`store: false`, so OpenAI keeps no copy of the
 * conversation; reasoning travels encrypted between the steps of a turn), little reasoning for a
 * quick answer, and no reasoning summaries nobody reads.
 */
export function languageModel(ai: Config['ai']): { model: LanguageModel; providerOptions?: Record<string, Record<string, JSONValue>> } {
    if (ai.provider === 'DEMO') {
        return {
            model: new DemoModel(),
        };
    }
    const openai = createOpenAI({ apiKey: ai.apiKey });
    return {
        model: openai(ai.model),
        providerOptions: {
            openai: {
                store: false,
                include: ['reasoning.encrypted_content'],
                reasoningEffort: ai.reasoningEffort,
                reasoningSummary: null,
            },
        },
    };
}

/** The composition root: the only place that knows every part, in start order. */
export function createService(config: Config) {
    const postgres = new Postgres(config.database);
    const conversations = new PostgresConversations(postgres.db);
    const limiter = ValkeyLimiter.connect(config.valkey, config.limits);
    const analytics = new PostHogAnalytics(config.posthog.projectToken, config.posthog.host, config.posthog.flagsSecretKey);
    const catalog = new GrpcCatalog(config.search.target, config.search.deadlineMs);
    const coach = new Coach({
        ...languageModel(config.ai),
        catalog,
        vocabulary: new CachedVocabulary(catalog),
        conversations,
        limiter,
        analytics,
    });
    // Says "not ready" until the lifecycle below exists and has started everything.
    const health: Health = {
        isLive: () => true,
        isReady: async () => false,
    };
    const app = createApp({
        auth: new JwtAuth(config.jwt),
        coach,
        availability: new CoachAvailability(analytics, config.coach.flag),
        conversations,
        health,
    });
    const http = new HttpServer(app, config.http.port);
    // Kafka last: events are consumed only once the service can serve.
    const lifecycle = new Lifecycle(
        [
            postgres,
            limiter,
            analytics,
            http,
            new UserEvents(config.kafka, conversations),
            new ConsumerLagWatch(GROUP_ID, [USER_TOPIC], new KafkaConsumerLag(config.kafka), analytics),
        ],
        config.lifecycle.drainDelayMs,
    );
    health.isLive = () => lifecycle.isLive();
    health.isReady = () => lifecycle.isReady();
    return {
        lifecycle,
        http,
        postgres,
        conversations,
    };
}
