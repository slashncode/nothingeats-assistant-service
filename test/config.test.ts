import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';

describe('configuration', () => {
    it('starts with the scripted model and local defaults', () => {
        const config = loadConfig({});

        expect(config.ai.provider).toBe('DEMO');
        expect(config.kafka).toEqual({
            bootstrapBrokers: ['localhost:19094'],
        });
    });

    it('signs in to Kafka with SCRAM only when a user is given, and never without a password', () => {
        const config = loadConfig({ KAFKA__SASL__USERNAME: 'developer', KAFKA__SASL__PASSWORD: 'secret' });

        expect(config.kafka.sasl).toEqual({ mechanism: 'SCRAM-SHA-512', username: 'developer', password: 'secret' });
        expect(() => loadConfig({ KAFKA__SASL__USERNAME: 'developer' })).toThrow('KAFKA__SASL__PASSWORD: is required with KAFKA__SASL__USERNAME');
    });

    it('refuses OpenAI without a key, and never prints values', () => {
        expect(() => loadConfig({ AI__PROVIDER: 'OPENAI' })).toThrow('OPENAI__API_KEY: is required with AI__PROVIDER=OPENAI');
        expect(() => loadConfig({ HTTP__PORT: 'secret-value' })).toThrow(/^Invalid configuration: HTTP__PORT: (?!.*secret-value)/);
    });
});
