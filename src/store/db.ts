import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Component } from '../lifecycle.ts';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { log } from '../log.ts';
import * as schema from './schema.ts';

export type Database = PostgresJsDatabase<typeof schema>;

export interface DatabaseSettings {
    url: string;
    user: string;
    password: string;
    maximumPoolSize: number;
}

/** The service's own Postgres database (one per service), through a small connection pool. */
export class Postgres implements Component {
    readonly name = 'postgres';
    readonly db: Database;
    private readonly client: postgres.Sql;

    constructor(settings: DatabaseSettings) {
        this.client = postgres(settings.url, {
            username: settings.user,
            password: settings.password,
            max: settings.maximumPoolSize,
            connect_timeout: 10,
            onnotice: () => {},
        });
        this.db = drizzle(this.client, { schema });
    }

    async start(): Promise<void> {
        await this.db.execute(sql`select 1`);
    }

    async check(): Promise<boolean> {
        await this.db.execute(sql`select 1`);
        return true;
    }

    async stop(): Promise<void> {
        await this.client.end({ timeout: 5 });
    }

    /** `migrate` mode, run by the chart's hook Job before every rollout; pods never migrate. */
    async migrate(folder: string): Promise<void> {
        await migrate(this.db, { migrationsFolder: folder });
        log.info({ folder }, 'Migrations applied');
    }
}
