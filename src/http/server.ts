import type { ServerType } from '@hono/node-server';
import type { Hono } from 'hono';
import type { Component } from '../lifecycle.ts';
import { serve } from '@hono/node-server';

/** The HTTP server. On stop it takes no new connections and gives running chats time to finish. */
export class HttpServer implements Component {
    readonly name = 'http-server';
    private server: ServerType | undefined;
    private readonly app: Hono;
    private readonly port: number;
    private readonly shutdownGraceMs: number;

    constructor(app: Hono, port: number, shutdownGraceMs = 15_000) {
        this.app = app;
        this.port = port;
        this.shutdownGraceMs = shutdownGraceMs;
    }

    async start(): Promise<void> {
        await new Promise<void>((resolve) => {
            this.server = serve({ fetch: this.app.fetch, port: this.port }, () => resolve());
        });
    }

    async stop(): Promise<void> {
        const server = this.server;
        if (!server)
            return;
        this.server = undefined;
        const closed = new Promise<void>(resolve => server.close(() => resolve()));
        const grace = setTimeout(() => {
            if ('closeAllConnections' in server)
                server.closeAllConnections();
        }, this.shutdownGraceMs);
        await closed;
        clearTimeout(grace);
    }

    /** The port the server listens on (tests start it on port 0). */
    get address(): number | undefined {
        const address = this.server?.address();
        return typeof address === 'object' && address
            ? address.port
            : undefined;
    }
}
