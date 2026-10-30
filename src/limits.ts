import type { Component } from './lifecycle.ts';
import { createHash } from 'node:crypto';
import { Valkey } from 'iovalkey';
import { log } from './log.ts';

export interface LimitSettings {
    messagesPerHour: number;
    tokensPerDay: number;
}

export type Admission = { admitted: true } | { admitted: false; reason: 'MESSAGES' | 'TOKENS'; retryAfterSeconds: number };

export interface Limiter {
    /** Counts the message; refuses when the hour's messages or the day's tokens are used up. */
    admit: (userId: string, now?: Date) => Promise<Admission>;
    /** Adds what a turn cost to the day's budget. */
    spend: (userId: string, tokens: number, now?: Date) => Promise<void>;
}

const HOUR = 3_600;
const DAY = 86_400;

/**
 * A real model costs real money: per customer, so many messages an hour and so many tokens a day
 * (UTC days).
 * Fixed windows in Valkey, keys hashed (no user ids in Valkey). Fails open like the platform's
 * rate limiter (record 029): an outage of Valkey must not take the coach down with it.
 */
export class ValkeyLimiter implements Limiter, Component {
    readonly name = 'valkey';
    private readonly valkey: Valkey;
    private readonly settings: LimitSettings;

    constructor(valkey: Valkey, settings: LimitSettings) {
        this.valkey = valkey;
        this.settings = settings;
    }

    static connect(options: { host: string; port: number; username: string; password?: string }, settings: LimitSettings): ValkeyLimiter {
        const valkey = new Valkey({
            ...options,
            lazyConnect: true,
            maxRetriesPerRequest: 1,
            enableOfflineQueue: false,
        });
        valkey.on('error', (error: Error) => log.warn({ err: error }, 'Valkey'));
        return new ValkeyLimiter(valkey, settings);
    }

    async start(): Promise<void> {
        await this.valkey.connect();
    }

    async stop(): Promise<void> {
        this.valkey.disconnect();
    }

    async admit(userId: string, now = new Date()): Promise<Admission> {
        try {
            const seconds = Math.floor(now.getTime() / 1000);
            const hourKey = this.key('messages', userId, Math.floor(seconds / HOUR));
            const tokenKey = this.key('tokens', userId, Math.floor(seconds / DAY));
            const results = await this.valkey.multi().incr(hourKey).expire(hourKey, HOUR).get(tokenKey).exec();
            const count = Number(results?.[0]?.[1] ?? 0);
            const tokens = Number(results?.[2]?.[1] ?? 0);
            if (tokens >= this.settings.tokensPerDay)
                return { admitted: false, reason: 'TOKENS', retryAfterSeconds: DAY - (seconds % DAY) };
            if (count > this.settings.messagesPerHour)
                return { admitted: false, reason: 'MESSAGES', retryAfterSeconds: HOUR - (seconds % HOUR) };
            return { admitted: true };
        }
        catch (error) {
            log.warn({ err: error }, 'Limits unavailable; admitting');
            return { admitted: true };
        }
    }

    async spend(userId: string, tokens: number, now = new Date()): Promise<void> {
        if (tokens <= 0)
            return;
        try {
            const key = this.key('tokens', userId, Math.floor(now.getTime() / 1000 / DAY));
            await this.valkey.multi().incrby(key, tokens).expire(key, 2 * DAY).exec();
        }
        catch (error) {
            log.warn({ err: error }, 'Could not record token use');
        }
    }

    private key(kind: string, userId: string, window: number): string {
        const user = createHash('sha256').update(userId).digest('hex').slice(0, 32);
        return `assistant:${kind}:${user}:${window}`;
    }
}
