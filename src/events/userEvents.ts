import type { Message, MessagesStream } from '@platformatic/kafka';
import type { Component } from '../lifecycle.ts';
import type { ConversationStore } from '../store/conversations.ts';
import { Consumer, Producer, stringDeserializers, stringSerializers } from '@platformatic/kafka';
import { log } from '../log.ts';

export const USER_TOPIC = 'identity.user.v1';
export const GROUP_ID = 'assistant-service';
/** Same naming and headers as the Kotlin consumers' dead-letter topics (record 022). */
export const DEAD_LETTER_TOPIC = `${GROUP_ID}.dlq`;

const USER_DELETED = 'nothingeats.identity.user.deleted.v1';
const MAX_ATTEMPTS = 3;
const MAX_ERROR_LENGTH = 500;

class Unreadable extends Error {}

/**
 * What identity's events mean here: `user.deleted` (GDPR, id only) erases every conversation of that
 * customer. Deleting is idempotent, so a redelivered event needs no inbox table. Other event types
 * are none of this service's business.
 */
export function userEventHandler(conversations: ConversationStore) {
    return async (value: string): Promise<void> => {
        let event: { type?: unknown; data?: { userId?: unknown } };
        try {
            event = JSON.parse(value);
        }
        catch {
            throw new Unreadable('Not a JSON CloudEvent');
        }
        if (event.type !== USER_DELETED)
            return;
        const userId = event.data?.userId;
        if (typeof userId !== 'string' || userId === '')
            throw new Unreadable('user.deleted without a userId');
        const deleted = await conversations.deleteUser(userId);
        log.info({ conversations: deleted }, 'Erased the conversations of a deleted account');
    };
}

export interface DeadLetters {
    send: (message: { key?: string; value: string; topic: string; partition: number; offset: bigint }, error: unknown) => Promise<void>;
}

/**
 * Handles one record: a few attempts with a growing pause, then the dead-letter topic (confirmed
 * before the offset moves on). An unreadable record goes there at once: retrying cannot fix it.
 */
export async function processRecord(
    message: { key?: string; value: string; topic: string; partition: number; offset: bigint },
    handle: (value: string) => Promise<void>,
    deadLetters: DeadLetters,
    pauseMs = 200,
): Promise<void> {
    for (let attempt = 1; ; attempt++) {
        try {
            await handle(message.value);
            return;
        }
        catch (error) {
            if (error instanceof Unreadable || attempt >= MAX_ATTEMPTS) {
                log.error({
                    err: error,
                    topic: message.topic,
                    partition: message.partition,
                    offset: String(message.offset),
                }, 'Moving record to the dead-letter topic');
                await deadLetters.send(message, error);
                return;
            }
            await new Promise(resolve => setTimeout(resolve, pauseMs * attempt));
        }
    }
}

/** The `assistant-service` consumer group on identity's user topic. Starts after the HTTP server. */
export class UserEvents implements Component {
    readonly name = 'user-events';
    private consumer: Consumer<string, string, string, string> | undefined;
    private producer: Producer<string, string, string, string> | undefined;
    private stream: MessagesStream<string, string, string, string> | undefined;
    private loop: Promise<void> | undefined;
    private readonly bootstrapServers: string[];
    private readonly conversations: ConversationStore;

    constructor(bootstrapServers: string[], conversations: ConversationStore) {
        this.bootstrapServers = bootstrapServers;
        this.conversations = conversations;
    }

    async start(): Promise<void> {
        this.producer = new Producer({ clientId: `${GROUP_ID}-dlq`, bootstrapBrokers: this.bootstrapServers, serializers: stringSerializers });
        this.consumer = new Consumer({
            groupId: GROUP_ID,
            clientId: GROUP_ID,
            bootstrapBrokers: this.bootstrapServers,
            deserializers: stringDeserializers,
        });
        this.stream = await this.consumer.consume({
            topics: [USER_TOPIC],
            mode: 'committed',
            fallbackMode: 'earliest',
            autocommit: false,
        });
        const handle = userEventHandler(this.conversations);
        const deadLetters = this.deadLetters(this.producer);
        const stream = this.stream;
        this.loop = (async () => {
            for await (const message of stream as AsyncIterable<Message<string, string, string, string>>) {
                await processRecord(
                    {
                        key: message.key,
                        value: message.value,
                        topic: message.topic,
                        partition: message.partition,
                        offset: message.offset,
                    },
                    handle,
                    deadLetters,
                );
                await message.commit();
            }
        })().catch((error) => {
            log.error({ err: error }, 'The user event consumer stopped');
        });
    }

    async check(): Promise<boolean> {
        return this.stream !== undefined && !this.stream.closed;
    }

    async stop(): Promise<void> {
        await this.stream?.close();
        await this.loop;
        await this.consumer?.close(true);
        await this.producer?.close();
    }

    private deadLetters(producer: Producer<string, string, string, string>): DeadLetters {
        return {
            send: async (message, error) => {
                await producer.send({
                    messages: [
                        {
                            topic: DEAD_LETTER_TOPIC,
                            key: message.key,
                            value: message.value,
                            headers: {
                                'dlq-original-topic': message.topic,
                                'dlq-original-partition': String(message.partition),
                                'dlq-original-offset': String(message.offset),
                                'dlq-error': `${error instanceof Error
                                    ? error.name
                                    : 'Error'}: ${error instanceof Error
                                    ? error.message
                                    : String(error)}`.slice(0, MAX_ERROR_LENGTH),
                            },
                        },
                    ],
                });
            },
        };
    }
}
