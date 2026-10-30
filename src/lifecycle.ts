import { log } from './log.ts';

/** Something with a start, a stop and maybe a say in readiness: connections, servers, consumers. */
export interface Component {
    readonly name: string;
    start?: () => Promise<void>;
    stop?: () => Promise<void>;
    /** Whether the instance may receive traffic. A dependency that fails open has no check. */
    check?: () => Promise<boolean>;
}

/**
 * Starts components in the order given (infrastructure first, traffic last) and stops them in
 * reverse. On SIGTERM readiness goes down first, then the drain delay lets the gateway stop
 * sending requests, then everything stops: the same choreography as the Kotlin services.
 */
export class Lifecycle {
    private started: Component[] = [];
    private ready = false;
    private stopping: Promise<void> | undefined;
    private readonly components: Component[];
    private readonly drainDelayMs: number;

    constructor(components: Component[], drainDelayMs: number) {
        this.components = components;
        this.drainDelayMs = drainDelayMs;
    }

    async start(): Promise<void> {
        for (const component of this.components) {
            log.info({ component: component.name }, 'Starting');
            await component.start?.();
            this.started.push(component);
        }
        this.ready = true;
        log.info('Ready');
    }

    isLive(): boolean {
        return this.stopping === undefined;
    }

    async isReady(): Promise<boolean> {
        if (!this.ready)
            return false;
        const checks = await Promise.all(this.components.map(async component => component.check?.().catch(() => false) ?? true));
        return checks.every(Boolean);
    }

    stop(): Promise<void> {
        this.stopping ??= this.shutdown();
        return this.stopping;
    }

    /** SIGTERM and SIGINT stop the service; the process exits once everything is closed. */
    stopOnSignals(): void {
        for (const signal of ['SIGTERM', 'SIGINT'] as const) {
            process.once(signal, () => {
                log.info({ signal }, 'Stopping');
                void this.stop().then(() => process.exit(0), (error) => {
                    log.error({ err: error }, 'Stopping failed');
                    process.exit(1);
                });
            });
        }
    }

    private async shutdown(): Promise<void> {
        this.ready = false;
        if (this.drainDelayMs > 0)
            await new Promise(resolve => setTimeout(resolve, this.drainDelayMs));
        for (const component of this.started.toReversed()) {
            try {
                await component.stop?.();
            }
            catch (error) {
                log.warn({ err: error, component: component.name }, 'Could not stop cleanly');
            }
        }
        this.started = [];
    }
}
