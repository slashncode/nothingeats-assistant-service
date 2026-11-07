import type { ErrorTracking } from '../analytics.ts';
import type { Component } from '../lifecycle.ts';
import { Consumer } from '@platformatic/kafka';
import { log } from '../log.ts';

const MINUTE_MS = 60_000;
const READ_COMMITTED = 1;
const CONTROL_BATCH = 0x20;
const FETCH_BYTES = 1_048_576;

/** A partition with [events] after the group's committed offset, the oldest waiting [waitedMs]. */
export interface PartitionLag {
    topic: string;
    partition: number;
    events: bigint;
    waitedMs: number;
}

export interface LagSource {
    of: (groupId: string, topics: string[]) => Promise<PartitionLag[]>;
}

/**
 * How far a consumer group is behind, in time: for every partition of [topics] it has committed
 * on and that holds events after the committed offset, the age of the oldest of them. Reads only
 * what Kafka keeps anyway (committed offsets, end offsets, record timestamps). Partitions the group
 * never committed on are left out. The same measure as the Kotlin platform's `ConsumerLag`.
 *
 * The client carries the group's id but never joins the group: it only looks, it never commits.
 */
export class KafkaConsumerLag implements LagSource {
    private readonly bootstrapServers: string[];
    private readonly now: () => number;

    constructor(bootstrapServers: string[], now: () => number = Date.now) {
        this.bootstrapServers = bootstrapServers;
        this.now = now;
    }

    async of(groupId: string, topics: string[]): Promise<PartitionLag[]> {
        const reader = new Consumer({ groupId, clientId: `${groupId}-lag`, bootstrapBrokers: this.bootstrapServers });
        try {
            const metadata = await reader.metadata({ topics });
            const assignments = topics.flatMap((topic) => {
                const partitions = metadata.topics.get(topic)?.partitions ?? [];
                return partitions.length > 0
                    ? [
                            {
                                topic,
                                partitions: partitions.map((_, index) => index),
                            },
                        ]
                    : [];
            });
            if (assignments.length === 0)
                return [];
            const committed = await reader.listCommittedOffsets({ topics: assignments });
            const ends = await reader.listOffsets({
                topics: assignments.map(it => it.topic),
            });
            const lags: PartitionLag[] = [];
            for (const { topic, partitions } of assignments) {
                const topicMetadata = metadata.topics.get(topic)!;
                for (const partition of partitions) {
                    const offset = committed.get(topic)?.[partition] ?? -1n;
                    const end = ends.get(topic)?.[partition] ?? -1n;
                    if (offset < 0n || end <= offset)
                        continue;
                    const leader = topicMetadata.partitions[partition]!;
                    const timestamp = await this.firstTimestamp(reader, topicMetadata.id, partition, offset, leader.leader, leader.leaderEpoch);
                    lags.push({
                        topic,
                        partition,
                        events: end - offset,
                        waitedMs: timestamp === undefined
                            ? 0
                            : Math.max(0, this.now() - timestamp),
                    });
                }
            }
            return lags;
        }
        finally {
            await reader.close(true).catch(() => {});
        }
    }

    /** The timestamp of the first record at or after [offset]; none when only transaction markers follow. */
    private async firstTimestamp(reader: Consumer, topicId: string, partition: number, offset: bigint, leader: number, leaderEpoch: number): Promise<number | undefined> {
        const response = await reader.fetch({
            node: leader,
            topics: [
                {
                    topicId,
                    partitions: [
                        {
                            partition,
                            fetchOffset: offset,
                            currentLeaderEpoch: leaderEpoch,
                            lastFetchedEpoch: -1,
                            partitionMaxBytes: FETCH_BYTES,
                        },
                    ],
                },
            ],
            minBytes: 1,
            maxBytes: FETCH_BYTES,
            maxWaitTime: 1_000,
            isolationLevel: READ_COMMITTED,
        });
        // The broker answers with whole batches, so the first one may start before the offset.
        for (const batch of response.responses[0]?.partitions[0]?.records ?? []) {
            if ((batch.attributes & CONTROL_BATCH) !== 0)
                continue;
            for (const record of batch.records) {
                if (batch.firstOffset + BigInt(record.offsetDelta) >= offset)
                    return Number(batch.firstTimestamp + record.timestampDelta);
            }
        }
        return undefined;
    }
}

/** A consumer group whose oldest unprocessed events have waited longer than allowed. */
export class ConsumerStalledError extends Error {
    readonly groupId: string;
    readonly partitions: PartitionLag[];

    constructor(groupId: string, partitions: PartitionLag[]) {
        super(`Consumer group ${groupId} is not keeping up: ${partitions
            .map(it => `${it.topic}-${it.partition} has ${it.events} events, the oldest waiting ${Math.floor(it.waitedMs / MINUTE_MS)} min`)
            .join(', ')}`);
        this.name = 'ConsumerStalledError';
        this.groupId = groupId;
        this.partitions = partitions;
    }
}

/**
 * Every [intervalMs], checks whether the group keeps up. Events that waited longer than [maxWaitMs]
 * mean the consumer has stopped (a handler that never returns, no consumer at all) or fell far
 * behind: logged as an error and reported to error tracking. The Kotlin services run the same
 * watch (record 046). Starts with the service, never in cron mode.
 */
export class ConsumerLagWatch implements Component {
    readonly name = 'consumer-lag-watch';
    private timer: NodeJS.Timeout | undefined;
    private readonly groupId: string;
    private readonly topics: string[];
    private readonly lag: LagSource;
    private readonly errors: ErrorTracking;
    private readonly intervalMs: number;
    private readonly maxWaitMs: number;

    constructor(groupId: string, topics: string[], lag: LagSource, errors: ErrorTracking, { intervalMs = 5 * MINUTE_MS, maxWaitMs = 10 * MINUTE_MS } = {}) {
        this.groupId = groupId;
        this.topics = topics;
        this.lag = lag;
        this.errors = errors;
        this.intervalMs = intervalMs;
        this.maxWaitMs = maxWaitMs;
    }

    async start(): Promise<void> {
        this.timer = setInterval(() => void this.inspect(), this.intervalMs);
        this.timer.unref();
    }

    /** One check; the stalled partitions, if any, already reported. */
    async inspect(): Promise<PartitionLag[]> {
        let stalled: PartitionLag[];
        try {
            stalled = (await this.lag.of(this.groupId, this.topics)).filter(it => it.waitedMs > this.maxWaitMs);
        }
        catch (error) {
            log.warn({ err: error, groupId: this.groupId }, 'Could not read the lag of the consumer group');
            return [];
        }
        if (stalled.length > 0) {
            const error = new ConsumerStalledError(this.groupId, stalled);
            log.error(error.message);
            this.errors.captureException(error, {
                consumer_group: this.groupId,
                waiting_events: Number(stalled.reduce((sum, it) => sum + it.events, 0n)),
                oldest_wait_minutes: Math.floor(Math.max(...stalled.map(it => it.waitedMs)) / MINUTE_MS),
            });
        }
        return stalled;
    }

    async stop(): Promise<void> {
        clearInterval(this.timer);
    }
}
