import type { StartedTestContainer } from 'testcontainers';
import type { PartitionLag } from '../src/events/consumerLag.ts';
import { Admin, Producer, stringSerializers } from '@platformatic/kafka';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConsumerLagWatch, ConsumerStalledError, KafkaConsumerLag } from '../src/events/consumerLag.ts';
import { startKafka } from './support.ts';

const MINUTE_MS = 60_000;

class RecordingErrors {
    readonly captured: { error: Error; properties: Record<string, unknown> }[] = [];

    captureException(error: Error, properties: Record<string, unknown>): void {
        this.captured.push({ error, properties });
    }
}

describe('consumer lag watch', () => {
    const lag = (waitedMinutes: number, partition = 0): PartitionLag => ({
        topic: 'identity.user.v1',
        partition,
        events: 3n,
        waitedMs: waitedMinutes * MINUTE_MS,
    });

    it('reports only partitions whose oldest event waited longer than allowed', async () => {
        const errors = new RecordingErrors();
        const watch = new ConsumerLagWatch('assistant-service', ['identity.user.v1'], {
            of: async () => [
                lag(2, 0),
                lag(25, 1),
            ],
        }, errors);

        const stalled = await watch.inspect();

        expect(stalled.map(it => it.partition)).toEqual([1]);
        expect(errors.captured).toHaveLength(1);
        expect(errors.captured[0]!.error).toBeInstanceOf(ConsumerStalledError);
        expect(errors.captured[0]!.error.message).toContain('identity.user.v1-1 has 3 events, the oldest waiting 25 min');
        expect(errors.captured[0]!.properties).toEqual({
            consumer_group: 'assistant-service',
            waiting_events: 3,
            oldest_wait_minutes: 25,
        });
    });

    it('stays quiet when the group keeps up or the lag cannot be read', async () => {
        const errors = new RecordingErrors();
        const keepingUp = new ConsumerLagWatch('assistant-service', ['identity.user.v1'], {
            of: async () => [
                lag(1),
            ],
        }, errors);
        const unreadable = new ConsumerLagWatch('assistant-service', ['identity.user.v1'], {
            of: async () => {
                throw new Error('broker down');
            },
        }, errors);

        expect(await keepingUp.inspect()).toEqual([]);
        expect(await unreadable.inspect()).toEqual([]);
        expect(errors.captured).toEqual([]);
    });
});

describe('consumer lag from kafka', () => {
    let kafka: { container: StartedTestContainer; bootstrapServers: string[] };
    let admin: Admin;
    let producer: Producer<string, string, string, string>;

    beforeAll(async () => {
        kafka = await startKafka();
        admin = new Admin({ clientId: 'test-admin', bootstrapBrokers: kafka.bootstrapServers });
        producer = new Producer({ clientId: 'test-producer', bootstrapBrokers: kafka.bootstrapServers, serializers: stringSerializers });
    }, 180_000);

    afterAll(async () => {
        await producer?.close();
        await admin?.close();
        await kafka?.container.stop();
    });

    it('measures the age of the oldest event after the committed offset', async () => {
        const topic = 'lag.measured.v1';
        await admin.createTopics({
            topics: [topic],
            partitions: 3,
            replicas: 1,
        });
        const start = Date.now() - 30 * MINUTE_MS;
        // One batch on partition 0, minutes apart: the committed offset lies inside it.
        await producer.send({
            messages: [0, 1, 2, 3].map(minute => ({
                topic,
                partition: 0,
                key: `k${minute}`,
                value: 'v',
                timestamp: BigInt(start + minute * MINUTE_MS),
            })),
        });
        // Partition 1: processed to the end. Partition 2: never committed on (a new group catching up).
        await producer.send({
            messages: [
                {
                    topic,
                    partition: 1,
                    key: 'k',
                    value: 'v',
                },
            ],
        });
        await producer.send({
            messages: [
                {
                    topic,
                    partition: 2,
                    key: 'k',
                    value: 'v',
                    timestamp: BigInt(start),
                },
            ],
        });
        await admin.alterConsumerGroupOffsets({
            groupId: 'lagging-service',
            topics: [
                {
                    name: topic,
                    partitionOffsets: [
                        { partition: 0, offset: 2n },
                        { partition: 1, offset: 1n },
                    ],
                },
            ],
        });
        const now = start + 40 * MINUTE_MS;

        const lags = await new KafkaConsumerLag({ bootstrapBrokers: kafka.bootstrapServers }, () => now).of('lagging-service', [topic]);

        expect(lags).toEqual([
            {
                topic,
                partition: 0,
                events: 2n,
                waitedMs: 38 * MINUTE_MS,
            },
        ]);
    }, 60_000);

    it('finds nothing for a group that has kept up', async () => {
        const topic = 'lag.current.v1';
        await admin.createTopics({
            topics: [topic],
            partitions: 1,
            replicas: 1,
        });
        await producer.send({
            messages: [
                {
                    topic,
                    partition: 0,
                    key: 'k',
                    value: 'v',
                },
            ],
        });
        await admin.alterConsumerGroupOffsets({
            groupId: 'current-service',
            topics: [
                {
                    name: topic,
                    partitionOffsets: [
                        { partition: 0, offset: 1n },
                    ],
                },
            ],
        });

        expect(await new KafkaConsumerLag({ bootstrapBrokers: kafka.bootstrapServers }).of('current-service', [topic])).toEqual([]);
    }, 60_000);
});
