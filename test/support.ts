import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedTestContainer } from 'testcontainers';
import type { Analytics, Consent } from '../src/analytics.ts';
import type { Catalog, Dish, Language, Retrieved, RetrieveInput, Vocabulary } from '../src/search/catalog.ts';
import { createServer } from 'node:net';
import path from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { GenericContainer, Wait } from 'testcontainers';
import { JwtAuth } from '../src/http/auth.ts';
import { Postgres } from '../src/store/db.ts';

export const ISSUER = 'http://nothingeats.localhost/api/identity';
export const AUDIENCE = 'nothingeats';

/** Signs tokens like the identity service and verifies them with a local JWKS. */
export async function testTokens() {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = {
        ...(await exportJWK(publicKey)),
        kid: 'test-key',
        alg: 'RS256',
        use: 'sig',
    };
    const auth = new JwtAuth({ issuer: ISSUER, audience: AUDIENCE, jwksUrl: 'http://unused' }, createLocalJWKSet({
        keys: [jwk],
    }));
    const token = (userId: string, overrides: { issuer?: string; expiresIn?: string; roles?: string[] } = {}) =>
        new SignJWT({
            roles: overrides.roles ?? ['customer'],
            locale: 'de',
        })
            .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
            .setSubject(userId)
            .setIssuer(overrides.issuer ?? ISSUER)
            .setAudience(AUDIENCE)
            .setIssuedAt()
            .setExpirationTime(overrides.expiresIn ?? '15m')
            .sign(privateKey);
    return { auth, token };
}

/** Postgres 18 like the cluster, migrated with the service's own migrations. */
export async function startPostgres(): Promise<{ container: StartedPostgreSqlContainer; postgres: Postgres }> {
    const container = await new PostgreSqlContainer('postgres:18-alpine').start();
    const postgres = new Postgres({
        url: `postgres://${container.getHost()}:${container.getPort()}/${container.getDatabase()}`,
        user: container.getUsername(),
        password: container.getPassword(),
        maximumPoolSize: 4,
    });
    await postgres.migrate(path.resolve('drizzle'));
    return { container, postgres };
}

export const VALKEY_PASSWORD = 'test-password';

/** Valkey with a password, like the cluster's. */
export async function startValkey(): Promise<StartedTestContainer> {
    return new GenericContainer('valkey/valkey:9.1.2')
        .withCommand(['valkey-server', '--requirepass', VALKEY_PASSWORD])
        .withExposedPorts(6379)
        .start();
}

/**
 * A single-node Kafka like the cluster's (KRaft, same image as the Kotlin platform's tests). The
 * broker advertises the host port, so it listens on a free port that is mapped one to one.
 */
export async function startKafka(): Promise<{ container: StartedTestContainer; bootstrapServers: string[] }> {
    const port = await freePort();
    const container = await new GenericContainer('apache/kafka:4.2.1')
        .withEnvironment({
            KAFKA_NODE_ID: '1',
            KAFKA_PROCESS_ROLES: 'broker,controller',
            KAFKA_LISTENERS: `PLAINTEXT://:${port},CONTROLLER://:9093`,
            KAFKA_ADVERTISED_LISTENERS: `PLAINTEXT://localhost:${port}`,
            KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
            KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: 'CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT',
            KAFKA_CONTROLLER_QUORUM_VOTERS: '1@localhost:9093',
            KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
            KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
            KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
            KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: '0',
        })
        .withExposedPorts({ container: port, host: port })
        .withWaitStrategy(Wait.forLogMessage(/Kafka Server started/))
        .start();
    return {
        container,
        bootstrapServers: [`localhost:${port}`],
    };
}

async function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, () => {
            const { port } = server.address() as { port: number };
            server.close(() => resolve(port));
        });
    });
}

export function dish(id: string, overrides: Partial<Dish> = {}): Dish {
    return {
        id,
        slug: id.replace(/^d-/, ''),
        name: `Dish ${id}`,
        description: `The description of ${id}`,
        section: 'Mains',
        cuisine: 'italian',
        restaurant: { id: 'r-phantom-pizza', slug: 'phantom-pizza', name: 'Phantom Pizza' },
        priceCents: 1090,
        dietary: ['vegetarian'],
        allergens: ['gluten'],
        spiceLevel: 0,
        calories: 800,
        moods: ['comfort'],
        available: true,
        openNow: true,
        image: null,
        ...overrides,
    };
}

/** A catalog of a few dishes; remembers every call with the token it came with. */
export class FakeCatalog implements Catalog {
    readonly retrievals: { token: string; input: RetrieveInput }[] = [];
    readonly lookups: { token: string; ids: string[] }[] = [];
    dishList: Dish[] = [
        dish('d-margherita'),
        dish('d-pho', { cuisine: 'asian' }),
        dish('d-curry', { cuisine: 'indian' }),
        dish('d-sorbet', { cuisine: 'desserts' }),
    ];

    failing = false;

    async retrieve(token: string, input: RetrieveInput): Promise<Retrieved> {
        if (this.failing)
            throw new Error('search is down');
        this.retrievals.push({ token, input });
        return {
            dishes: this.dishList.filter(it => it.available).slice(0, input.limit ?? 8),
            semantic: true,
        };
    }

    async dishes(token: string, ids: string[], _language: Language): Promise<Dish[]> {
        if (ids.length === 0)
            return [];
        this.lookups.push({ token, ids });
        return ids.flatMap(id => this.dishList.filter(it => it.id === id));
    }

    async vocabulary(_token: string): Promise<Vocabulary> {
        return {
            cuisines: [
                'italian',
                'asian',
                'indian',
                'desserts',
            ],
            dietary: ['vegan', 'vegetarian'],
            moods: ['comfort'],
            allergens: ['gluten', 'nuts'],
        };
    }
}

export class RecordingAnalytics implements Analytics {
    readonly events: { consent: Consent; event: string; properties: Record<string, unknown> }[] = [];

    capture(consent: Consent | undefined, event: string, properties: Record<string, unknown>): void {
        if (consent)
            this.events.push({ consent, event, properties });
    }

    named(event: string) {
        return this.events.filter(it => it.event === event);
    }
}

/** A response body as JSON, without types: tests compare it to what they expect. */
export async function json(response: Response): Promise<any> {
    return response.json();
}

/** The JSON chunks of an AI SDK UI message stream (server-sent events). */
export async function chunks(response: Response): Promise<Record<string, unknown>[]> {
    const body = await response.text();
    return body
        .split('\n')
        .filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
        .map(line => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>);
}
