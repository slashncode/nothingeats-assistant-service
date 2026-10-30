import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';

describe('configuration', () => {
    it('starts with the scripted model and local defaults', () => {
        const config = loadConfig({});

        expect(config.ai.provider).toBe('DEMO');
        expect(config.kafka.bootstrapServers).toEqual(['localhost:19094']);
    });

    it('refuses OpenAI without a key, and never prints values', () => {
        expect(() => loadConfig({ AI__PROVIDER: 'OPENAI' })).toThrow('OPENAI__API_KEY: is required with AI__PROVIDER=OPENAI');
        expect(() => loadConfig({ HTTP__PORT: 'secret-value' })).toThrow(/^Invalid configuration: HTTP__PORT: (?!.*secret-value)/);
    });
});
