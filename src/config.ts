import { z } from 'zod';

// Everything the service reads from its environment, validated at startup (a bad value stops it
// before it serves anything). Same names as the Kotlin services: `__` nests, `_` separates words.

const port = z.coerce.number().int().min(1).max(65_535);
const positive = z.coerce.number().int().positive();

const environment = z
    .object({
        HTTP__PORT: port.default(8080),
        DATABASE__URL: z.string().default('postgres://localhost:15432/assistant'),
        DATABASE__USER: z.string().default('assistant'),
        DATABASE__PASSWORD: z.string().default(''),
        DATABASE__MAXIMUM_POOL_SIZE: positive.default(5),
        KAFKA__BOOTSTRAP_SERVERS: z.string().default('localhost:19094'),
        VALKEY__HOST: z.string().default('localhost'),
        VALKEY__PORT: port.default(16379),
        VALKEY__USERNAME: z.string().default('default'),
        VALKEY__PASSWORD: z.string().optional(),
        JWT__ISSUER: z.string().default('http://nothingeats.localhost/api/identity'),
        JWT__AUDIENCE: z.string().default('nothingeats'),
        JWT__JWKS_URL: z.url().default('http://nothingeats.localhost/api/identity/.well-known/jwks.json'),
        POSTHOG__PROJECT_TOKEN: z.string().default(''),
        POSTHOG__HOST: z.url().default('https://eu.i.posthog.com'),
        // The project's Feature Flags Secure API Key (phs_…): flags are evaluated here, locally.
        POSTHOG__FLAGS_SECRET_KEY: z.string().optional(),
        // Rollout and kill switch of the coach; without the flag (or the key) the coach is on.
        COACH__FLAG: z.string().default('craving-coach'),
        // DEMO is a scripted model: no key, no costs, always the same three steps.
        AI__PROVIDER: z.enum(['OPENAI', 'DEMO']).default('DEMO'),
        AI__MODEL: z.string().default('gpt-5-nano-2025-08-07'),
        // `minimal` answers fast but often announces a search instead of calling the tool (eval: 3 of 11).
        AI__REASONING_EFFORT: z.enum(['minimal', 'low', 'medium', 'high']).default('low'),
        OPENAI__API_KEY: z.string().optional(),
        SEARCH__TARGET: z.url().default('http://localhost:19090'),
        SEARCH__DEADLINE_MS: positive.default(5_000),
        LIMITS__MESSAGES_PER_HOUR: positive.default(30),
        // A turn takes about 8k tokens (instructions, tool schemas and results, three model steps).
        LIMITS__TOKENS_PER_DAY: positive.default(300_000),
        CONVERSATIONS__RETENTION_DAYS: positive.default(30),
        LIFECYCLE__DRAIN_DELAY_MS: z.coerce.number().int().min(0).default(5_000),
    })
    .refine(env => env.AI__PROVIDER !== 'OPENAI' || env.OPENAI__API_KEY, {
        message: 'is required with AI__PROVIDER=OPENAI',
        path: ['OPENAI__API_KEY'],
    });

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

export interface Config {
    http: { port: number };
    database: { url: string; user: string; password: string; maximumPoolSize: number };
    kafka: { bootstrapServers: string[] };
    valkey: { host: string; port: number; username: string; password?: string };
    jwt: { issuer: string; audience: string; jwksUrl: string };
    posthog: { projectToken: string; host: string; flagsSecretKey?: string };
    coach: { flag: string };
    ai: { provider: 'OPENAI' | 'DEMO'; model: string; reasoningEffort: ReasoningEffort; apiKey?: string };
    search: { target: string; deadlineMs: number };
    limits: { messagesPerHour: number; tokensPerDay: number };
    conversations: { retentionDays: number };
    lifecycle: { drainDelayMs: number };
}

export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
    const parsed = environment.safeParse(source);
    if (!parsed.success) {
        // Names and reasons only: values may be secrets.
        const problems = parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`);
        throw new Error(`Invalid configuration: ${problems.join('; ')}`);
    }
    const env = parsed.data;
    return {
        http: { port: env.HTTP__PORT },
        database: {
            url: env.DATABASE__URL,
            user: env.DATABASE__USER,
            password: env.DATABASE__PASSWORD,
            maximumPoolSize: env.DATABASE__MAXIMUM_POOL_SIZE,
        },
        kafka: {
            bootstrapServers: env.KAFKA__BOOTSTRAP_SERVERS.split(',').map(server => server.trim()),
        },
        valkey: {
            host: env.VALKEY__HOST,
            port: env.VALKEY__PORT,
            username: env.VALKEY__USERNAME,
            password: env.VALKEY__PASSWORD,
        },
        jwt: { issuer: env.JWT__ISSUER, audience: env.JWT__AUDIENCE, jwksUrl: env.JWT__JWKS_URL },
        posthog: { projectToken: env.POSTHOG__PROJECT_TOKEN, host: env.POSTHOG__HOST, flagsSecretKey: env.POSTHOG__FLAGS_SECRET_KEY },
        coach: { flag: env.COACH__FLAG },
        ai: {
            provider: env.AI__PROVIDER,
            model: env.AI__MODEL,
            reasoningEffort: env.AI__REASONING_EFFORT,
            apiKey: env.OPENAI__API_KEY,
        },
        search: { target: env.SEARCH__TARGET, deadlineMs: env.SEARCH__DEADLINE_MS },
        limits: { messagesPerHour: env.LIMITS__MESSAGES_PER_HOUR, tokensPerDay: env.LIMITS__TOKENS_PER_DAY },
        conversations: { retentionDays: env.CONVERSATIONS__RETENTION_DAYS },
        lifecycle: { drainDelayMs: env.LIFECYCLE__DRAIN_DELAY_MS },
    };
}
