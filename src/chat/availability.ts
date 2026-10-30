import type { Consent, Flags } from '../analytics.ts';
import type { Caller } from '../http/auth.ts';
import { log } from '../log.ts';

/**
 * Whether the coach answers this customer: the PostHog flag (`craving-coach` by default) as
 * rollout and kill switch. Evaluated locally under the account id, so the rollout bucket is the
 * same with and without analytics consent, and nothing about the customer reaches PostHog for it.
 * A missing key, a missing flag or a flag that cannot be evaluated locally keeps the coach on.
 */
export class CoachAvailability {
    private readonly flags: Flags;
    private readonly flag: string;

    constructor(flags: Flags, flag: string) {
        this.flags = flags;
        this.flag = flag;
    }

    async enabled(caller: Caller, consent: Consent | undefined): Promise<boolean> {
        try {
            return (await this.flags.isEnabled(this.flag, caller.id, consent !== undefined)) ?? true;
        }
        catch (error) {
            log.warn({ err: error }, 'Could not evaluate the coach flag; keeping the coach on');
            return true;
        }
    }
}
