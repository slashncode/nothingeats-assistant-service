import type { UIMessage } from 'ai';
import { index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * One row per conversation: the messages as the chat UI knows them (AI SDK UI messages, including
 * tool parts with the dishes that were shown), so a reload restores exactly what was on screen.
 * Kept for a limited time (`cron purge-conversations`) and deleted with the account.
 */
export const conversations = pgTable(
    'conversations',
    {
        id: text('id').primaryKey(),
        userId: text('user_id').notNull(),
        title: text('title').notNull(),
        messages: jsonb('messages').$type<UIMessage[]>().notNull(),
        /** Model tokens this conversation used, input and output. */
        tokens: integer('tokens').notNull().default(0),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    table => [
        index('conversations_user_updated_idx').on(table.userId, table.updatedAt),
        index('conversations_updated_idx').on(table.updatedAt),
    ],
);
