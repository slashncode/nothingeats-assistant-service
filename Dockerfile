# The bundle is built outside (CI runs `pnpm build`); the image only runs it. No RUN steps, so
# multi-arch builds need no emulation. Distroless: no shell, no package manager, user 65532.
FROM gcr.io/distroless/nodejs24-debian13:nonroot

WORKDIR /app
COPY dist/ ./dist/
COPY drizzle/ ./drizzle/

ENV NODE_ENV=production
# The chart passes the mode: serve, migrate or cron <task>.
ENTRYPOINT ["/nodejs/bin/node", "--enable-source-maps", "/app/dist/main.mjs"]
CMD ["serve"]
