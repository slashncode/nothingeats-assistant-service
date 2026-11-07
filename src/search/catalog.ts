import type { Client } from '@connectrpc/connect';
import type { Dish as DishMessage } from '../gen/nothingeats/search/v1/search_pb.ts';
import { createClient } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import { SearchService } from '../gen/nothingeats/search/v1/search_pb.ts';

export type Language = 'de' | 'en';

/** A dish as the coach sees it: from search-service, in the customer's language. */
export interface Dish {
    id: string;
    slug: string;
    name: string;
    description: string;
    section: string;
    cuisine: string;
    restaurant: { id: string; slug: string; name: string };
    priceCents: number;
    dietary: string[];
    allergens: string[];
    spiceLevel: number;
    calories: number;
    moods: string[];
    available: boolean;
    openNow: boolean;
    /** The dish's photo (public paths under /media); null: the shop draws an illustration. */
    image: DishImage | null;
}

export interface DishImage {
    url: string;
    cardUrl: string;
    wideUrl: string;
    alt: string;
}

export interface RetrieveInput {
    query: string;
    language: Language;
    keywords?: string[];
    negativeKeywords?: string[];
    cuisines?: string[];
    dietary?: string[];
    excludeAllergens?: string[];
    moods?: string[];
    maxSpiceLevel?: number;
    maxPriceCents?: number;
    openNow?: boolean;
    limit?: number;
}

export interface Retrieved {
    dishes: Dish[];
    /** False when search answered by keywords only. */
    semantic: boolean;
}

export interface Vocabulary {
    cuisines: string[];
    dietary: string[];
    moods: string[];
    allergens: string[];
}

/** The catalog as the coach may use it. Every call happens on the customer's behalf, with their token. */
export interface Catalog {
    retrieve: (token: string, input: RetrieveInput) => Promise<Retrieved>;
    dishes: (token: string, ids: string[], language: Language) => Promise<Dish[]>;
    vocabulary: (token: string) => Promise<Vocabulary>;
}

/**
 * search-service's `SearchService` over gRPC (Connect's gRPC transport, HTTP/2). Each call has a
 * deadline and carries the customer's access token, so search decides on its own who may ask.
 */
export class GrpcCatalog implements Catalog {
    private readonly client: Client<typeof SearchService>;
    private readonly deadlineMs: number;

    constructor(target: string, deadlineMs: number) {
        this.deadlineMs = deadlineMs;
        // Pings find a connection whose pod died without a goodbye (killed, its node gone) before a
        // call waits out its deadline on it; the same values as the Kotlin services' channels.
        this.client = createClient(SearchService, createGrpcTransport({
            baseUrl: target,
            pingIntervalMs: 20_000,
            pingTimeoutMs: 5_000,
            pingIdleConnection: true,
        }));
    }

    async retrieve(token: string, input: RetrieveInput): Promise<Retrieved> {
        const response = await this.client.retrieve(
            {
                query: input.query,
                language: input.language,
                keywords: input.keywords ?? [],
                negativeKeywords: input.negativeKeywords ?? [],
                filters: {
                    cuisines: input.cuisines ?? [],
                    dietary: input.dietary ?? [],
                    excludeAllergens: input.excludeAllergens ?? [],
                    moods: input.moods ?? [],
                    maxSpiceLevel: input.maxSpiceLevel,
                    maxPriceCents: input.maxPriceCents === undefined
                        ? undefined
                        : BigInt(input.maxPriceCents),
                    openNow: input.openNow ?? false,
                },
                limit: input.limit,
            },
            this.options(token),
        );
        return {
            dishes: response.dishes.flatMap(retrieved => (retrieved.dish
                ? [
                        dish(retrieved.dish),
                    ]
                : [])),
            semantic: response.semantic,
        };
    }

    async dishes(token: string, ids: string[], language: Language): Promise<Dish[]> {
        if (ids.length === 0)
            return [];
        const response = await this.client.getDishes({ ids, language }, this.options(token));
        return response.dishes.map(dish);
    }

    async vocabulary(token: string): Promise<Vocabulary> {
        const response = await this.client.describeCatalog({}, this.options(token));
        const values = (list: { value: string }[]) => list.map(item => item.value);
        return {
            cuisines: values(response.cuisines),
            dietary: values(response.dietary),
            moods: values(response.moods),
            allergens: values(response.allergens),
        };
    }

    private options(token: string) {
        return {
            headers: { authorization: `Bearer ${token}` },
            timeoutMs: this.deadlineMs,
        };
    }
}

function dish(message: DishMessage): Dish {
    return {
        id: message.id,
        slug: message.slug,
        name: message.name,
        description: message.description,
        section: message.section,
        cuisine: message.cuisine,
        restaurant: { id: message.restaurantId, slug: message.restaurantSlug, name: message.restaurantName },
        priceCents: Number(message.priceCents),
        dietary: message.dietary,
        allergens: message.allergens,
        spiceLevel: message.spiceLevel,
        calories: message.calories,
        moods: message.moods,
        available: message.available,
        openNow: message.openNow,
        image: message.image
            ? {
                    url: message.image.url,
                    cardUrl: message.image.cardUrl,
                    wideUrl: message.image.wideUrl,
                    alt: message.image.alt,
                }
            : null,
    };
}

/**
 * The vocabulary changes when the catalog does, which is rarely: one call per few minutes for all
 * conversations. A failed call keeps the last answer (or none: the tools then accept free words).
 */
export class CachedVocabulary {
    private cached: { value: Vocabulary; at: number } | undefined;
    private readonly catalog: Catalog;
    private readonly ttlMs: number;
    private readonly now: () => number;

    constructor(catalog: Catalog, ttlMs = 5 * 60_000, now: () => number = Date.now) {
        this.catalog = catalog;
        this.ttlMs = ttlMs;
        this.now = now;
    }

    async get(token: string): Promise<Vocabulary | undefined> {
        if (this.cached && this.now() - this.cached.at < this.ttlMs)
            return this.cached.value;
        try {
            this.cached = {
                value: await this.catalog.vocabulary(token),
                at: this.now(),
            };
        }
        catch {
            // Keep serving the last known vocabulary.
        }
        return this.cached?.value;
    }
}
