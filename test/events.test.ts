import { describe, expect, it } from 'vitest';
import { processRecord, userEventHandler } from '../src/events/userEvents.ts';

const record = {
    key: 'customer-1',
    value: '{}',
    topic: 'identity.user.v1',
    partition: 0,
    offset: 42n,
};

describe('identity events', () => {
    it('retries a failing record and then parks it in the dead-letter topic', async () => {
        let attempts = 0;
        const parked: unknown[] = [];

        await processRecord(record, async () => {
            attempts++;
            throw new Error('database down');
        }, {
            send: async (_message, error) => {
                parked.push(error);
            },
        }, 1);

        expect(attempts).toBe(3);
        expect(parked).toHaveLength(1);
    });

    it('parks unreadable records at once and ignores events that are not its business', async () => {
        const deleted: string[] = [];
        const handle = userEventHandler({
            deleteUser: async (userId: string) => {
                deleted.push(userId);
                return 1;
            },
        } as never);
        const parked: unknown[] = [];
        const deadLetters = {
            send: async (_message: unknown, error: unknown) => {
                parked.push(error);
            },
        };

        await processRecord({ ...record, value: 'not json' }, handle, deadLetters, 1);
        await processRecord({
            ...record,
            value: JSON.stringify({
                type: 'nothingeats.identity.user.registered.v1',
                data: { userId: 'customer-1' },
            }),
        }, handle, deadLetters, 1);
        await processRecord({
            ...record,
            value: JSON.stringify({
                type: 'nothingeats.identity.user.deleted.v1',
                data: { userId: 'customer-1' },
            }),
        }, handle, deadLetters, 1);

        expect(parked).toHaveLength(1);
        expect(deleted).toEqual(['customer-1']);
    });
});
