import { defineConfig } from 'drizzle-kit';

// `pnpm db:generate` writes a new SQL migration into drizzle/ from changes to the schema; commit
// it and never edit one that ran somewhere.
export default defineConfig({
    dialect: 'postgresql',
    schema: './src/store/schema.ts',
    out: './drizzle',
});
