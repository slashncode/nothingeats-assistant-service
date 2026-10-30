import type { JWTVerifyGetKey } from 'jose';
import { createRemoteJWKSet, jwtVerify } from 'jose';

/** The customer behind a request, from a verified access token. [token] is forwarded to search. */
export interface Caller {
    id: string;
    roles: string[];
    locale?: string;
    token: string;
}

export interface JwtSettings {
    issuer: string;
    audience: string;
    jwksUrl: string;
}

/**
 * Verifies access tokens against the identity service's JWKS, like every Kotlin service (record
 * 015): RS256 only, issuer and audience checked, the key picked by `kid`. jose caches the key set
 * and fetches it again when a token names a key it does not know yet (key rotation).
 */
export class JwtAuth {
    private readonly settings: JwtSettings;
    private readonly keys: JWTVerifyGetKey;

    constructor(settings: JwtSettings, keys?: JWTVerifyGetKey) {
        this.settings = settings;
        this.keys = keys ?? createRemoteJWKSet(new URL(settings.jwksUrl), { cooldownDuration: 30_000 });
    }

    async verify(token: string): Promise<Caller | undefined> {
        try {
            const { payload } = await jwtVerify(token, this.keys, {
                issuer: this.settings.issuer,
                audience: this.settings.audience,
                algorithms: ['RS256'],
                clockTolerance: 30,
            });
            if (typeof payload.sub !== 'string' || payload.sub === '')
                return undefined;
            const roles = Array.isArray(payload.roles)
                ? payload.roles.filter((role): role is string => typeof role === 'string')
                : [];
            const locale = typeof payload.locale === 'string'
                ? payload.locale
                : undefined;
            return {
                id: payload.sub,
                roles,
                locale,
                token,
            };
        }
        catch {
            return undefined;
        }
    }
}

/** The token of an `Authorization: Bearer …` header, if there is one. */
export function bearer(header: string | undefined): string | undefined {
    const match = header?.match(/^Bearer\s+(\S+)$/i);
    return match?.[1];
}
