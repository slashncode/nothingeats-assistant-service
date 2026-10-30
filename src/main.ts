import path from 'node:path';
import { loadConfig } from './config.ts';
import { log } from './log.ts';
import { createService } from './service.ts';
import { PostgresConversations } from './store/conversations.ts';
import { Postgres } from './store/db.ts';

// One program, three modes, like the Kotlin services: `serve` (default), `migrate` (the chart's
// hook Job before every rollout) and `cron <task>` (Kubernetes CronJobs).

const DAY_MS = 86_400_000;

async function main(mode: string, task: string | undefined): Promise<void> {
    const config = loadConfig();
    switch (mode) {
        case 'serve': {
            const { lifecycle } = createService(config);
            lifecycle.stopOnSignals();
            await lifecycle.start();
            return;
        }
        case 'migrate': {
            const postgres = new Postgres(config.database);
            try {
                await postgres.migrate(process.env.DATABASE__MIGRATIONS ?? path.resolve('drizzle'));
            }
            finally {
                await postgres.stop();
            }
            return;
        }
        case 'cron': {
            if (task !== 'purge-conversations')
                throw new Error(`Unknown cron task ${task}; known: purge-conversations`);
            const postgres = new Postgres(config.database);
            try {
                const cutoff = new Date(Date.now() - config.conversations.retentionDays * DAY_MS);
                const purged = await new PostgresConversations(postgres.db).purgeOlderThan(cutoff);
                log.info({ purged, cutoff }, 'Purged old conversations');
            }
            finally {
                await postgres.stop();
            }
            return;
        }
        default:
            throw new Error(`Unknown mode ${mode}; known: serve, migrate, cron <task>`);
    }
}

const [mode = 'serve', task] = process.argv.slice(2);
main(mode, task).catch((error) => {
    log.error({ err: error }, 'Failed');
    process.exit(1);
});
