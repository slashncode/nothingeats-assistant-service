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

/**
 * Runs [consume] again whenever it fails, after a pause that doubles with every failure in a row
 * (1 s up to 30 s), until [running] says stop. [consume] calls `healthy()` once it is consuming,
 * which resets the count. Like the Kotlin services' consumers: a consumer that dies (the group
 * took its partitions away after a long pause, a broker error) is replaced, never left stopped.
 */
export async function supervise(
    consume: (healthy: () => void) => Promise<void>,
    running: () => boolean,
    onFailure: (error: unknown, failuresInARow: number) => void,
    { pauseMs = 1_000, maxPauseMs = 30_000 } = {},
): Promise<void> {
    let failures = 0;
    while (running()) {
        try {
            await consume(() => {
                failures = 0;
            });
        }
        catch (error) {
            if (!running())
                return;
            failures++;
            onFailure(error, failures);
            await new Promise(resolve => setTimeout(resolve, Math.min(pauseMs * 2 ** (failures - 1), maxPauseMs)));
        }
    }
}

/** The `assistant-service` consumer group on identity's user topic. Starts after the HTTP server. */
export class UserEvents implements Component {
    readonly name = 'user-events';
    private producer: Producer<string, string, string, string> | undefined;
    private stream: MessagesStream<string, string, string, string> | undefined;
    private loop: Promise<void> | undefined;
    private running = false;
    private healthy = false;
    private readonly bootstrapServers: string[];
    private readonly conversations: ConversationStore;

    constructor(bootstrapServers: string[], conversations: ConversationStore) {
        this.bootstrapServers = bootstrapServers;
        this.conversations = conversations;
    }

    async start(): Promise<void> {
        this.producer = new Producer({ clientId: `${GROUP_ID}-dlq`, bootstrapBrokers: this.bootstrapServers, serializers: stringSerializers });
        this.running = true;
        this.loop = supervise(
            healthy => this.consume(healthy),
            () => this.running,
            (error, failuresInARow) => {
                this.healthy = false;
                log.error({ err: error, failuresInARow }, 'The user event consumer failed; replacing it');
            },
        );
    }

    /** Readiness: down until the consumer has joined its group, and from a failure until the next one has. */
    async check(): Promise<boolean> {
        return this.healthy;
    }

    async stop(): Promise<void> {
        this.running = false;
        await this.stream?.close();
        await this.loop;
        await this.producer?.close();
    }

    private async consume(healthy: () => void): Promise<void> {
        const consumer = new Consumer<string, string, string, string>({
            groupId: GROUP_ID,
            clientId: GROUP_ID,
            bootstrapBrokers: this.bootstrapServers,
            deserializers: stringDeserializers,
        });
        try {
            const stream = await consumer.consume({
                topics: [USER_TOPIC],
                mode: 'committed',
                fallbackMode: 'earliest',
                autocommit: false,
            });
            this.stream = stream;
            this.healthy = true;
            healthy();
            const handle = userEventHandler(this.conversations);
            const deadLetters = this.deadLetters(this.producer!);
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
            if (this.running)
                throw new Error('The user event stream ended');
        }
        finally {
            await this.stream?.close().catch(() => {});
            await consumer.close(true).catch(() => {});
        }
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
