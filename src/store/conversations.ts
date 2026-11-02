import type { UIMessage } from 'ai';
import type { Database } from './db.ts';
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import { conversations } from './schema.ts';

export interface Conversation {
    id: string;
    title: string;
    messages: UIMessage[];
    tokens: number;
    createdAt: Date;
    updatedAt: Date;
}

export interface ConversationSummary {
    id: string;
    title: string;
    updatedAt: Date;
}

/** A conversation in the backoffice's list: whose, how long, how expensive. */
export interface AdminConversationSummary {
    id: string;
    userId: string;
    title: string;
    messageCount: number;
    tokens: number;
    createdAt: Date;
    updatedAt: Date;
}

/** Where the backoffice's list continues: after this conversation (newest first). */
export interface AdminCursor {
    updatedAt: Date;
    id: string;
}

/** What the coach needs from storage; Postgres in the service, a map in some tests. */
export interface ConversationStore {
    /** The conversation if [userId] owns it; `'foreign'` when someone else does. */
    find: (id: string, userId: string) => Promise<Conversation | 'foreign' | undefined>;
    /** Creates the conversation or replaces its messages; never touches another user's. */
    save: (id: string, userId: string, messages: UIMessage[], tokens: number) => Promise<void>;
    list: (userId: string, limit: number) => Promise<ConversationSummary[]>;
    delete: (id: string, userId: string) => Promise<boolean>;
    deleteUser: (userId: string) => Promise<number>;
    export: (userId: string) => Promise<Conversation[]>;
    purgeOlderThan: (cutoff: Date) => Promise<number>;
    /** Every customer's conversations (the backoffice), newest first, after [cursor]. */
    adminList: (filter: { userId?: string }, cursor: AdminCursor | undefined, limit: number) => Promise<AdminConversationSummary[]>;
    /** One conversation, whoever owns it (the backoffice). */
    adminFind: (id: string) => Promise<(Conversation & { userId: string }) | undefined>;
}

const TITLE_LENGTH = 60;

/** The first thing the customer said, shortened: enough to recognise a conversation in a list. */
export function titleOf(messages: UIMessage[]): string {
    const first = messages.find(message => message.role === 'user');
    const text = first?.parts.flatMap(part => (part.type === 'text'
        ? [part.text]
        : [])).join(' ').trim() ?? '';
    return text.length > TITLE_LENGTH
        ? `${text.slice(0, TITLE_LENGTH - 1)}…`
        : text;
}

export class PostgresConversations implements ConversationStore {
    private readonly db: Database;

    constructor(db: Database) {
        this.db = db;
    }

    async find(id: string, userId: string) {
        const [row] = await this.db.select().from(conversations).where(eq(conversations.id, id));
        if (!row)
            return undefined;
        if (row.userId !== userId)
            return 'foreign' as const;
        return row;
    }

    async save(id: string, userId: string, messages: UIMessage[], tokens: number): Promise<void> {
        const now = new Date();
        await this.db
            .insert(conversations)
            .values({
                id,
                userId,
                title: titleOf(messages),
                messages,
                tokens,
                createdAt: now,
                updatedAt: now,
            })
            .onConflictDoUpdate({
                target: conversations.id,
                set: { messages, tokens: sql`${conversations.tokens} + ${tokens}`, updatedAt: now },
                // An id someone else already uses is never overwritten.
                setWhere: eq(conversations.userId, userId),
            });
    }

    async list(userId: string, limit: number): Promise<ConversationSummary[]> {
        return this.db
            .select({ id: conversations.id, title: conversations.title, updatedAt: conversations.updatedAt })
            .from(conversations)
            .where(eq(conversations.userId, userId))
            .orderBy(desc(conversations.updatedAt))
            .limit(limit);
    }

    async delete(id: string, userId: string): Promise<boolean> {
        const deleted = await this.db
            .delete(conversations)
            .where(and(eq(conversations.id, id), eq(conversations.userId, userId)))
            .returning({ id: conversations.id });
        return deleted.length > 0;
    }

    async deleteUser(userId: string): Promise<number> {
        const deleted = await this.db.delete(conversations).where(eq(conversations.userId, userId)).returning({ id: conversations.id });
        return deleted.length;
    }

    async export(userId: string): Promise<Conversation[]> {
        return this.db.select().from(conversations).where(eq(conversations.userId, userId)).orderBy(conversations.createdAt);
    }

    async adminList(filter: { userId?: string }, cursor: AdminCursor | undefined, limit: number): Promise<AdminConversationSummary[]> {
        const conditions = [
            filter.userId
                ? eq(conversations.userId, filter.userId)
                : undefined,
            cursor
                ? or(
                        lt(conversations.updatedAt, cursor.updatedAt),
                        and(eq(conversations.updatedAt, cursor.updatedAt), lt(conversations.id, cursor.id)),
                    )
                : undefined,
        ];
        return this.db
            .select({
                id: conversations.id,
                userId: conversations.userId,
                title: conversations.title,
                messageCount: sql<number>`jsonb_array_length(${conversations.messages})`.mapWith(Number),
                tokens: conversations.tokens,
                createdAt: conversations.createdAt,
                updatedAt: conversations.updatedAt,
            })
            .from(conversations)
            .where(and(...conditions))
            .orderBy(desc(conversations.updatedAt), desc(conversations.id))
            .limit(limit);
    }

    async adminFind(id: string) {
        const [row] = await this.db.select().from(conversations).where(eq(conversations.id, id));
        return row;
    }

    async purgeOlderThan(cutoff: Date): Promise<number> {
        const deleted = await this.db.delete(conversations).where(lt(conversations.updatedAt, cutoff)).returning({ id: conversations.id });
        return deleted.length;
    }
}
