import pino from 'pino';

// Structured JSON logs, like the Kotlin services. Tokens, keys and passwords never reach them, and
// neither do chat messages: those are the customer's words.
export const log = pino({
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service: 'assistant-service' },
    redact: {
        paths: [
            '*.authorization',
            '*.password',
            '*.apiKey',
            '*.token',
            'headers.authorization',
        ],
        censor: '[redacted]',
    },
});

export type Logger = typeof log;
