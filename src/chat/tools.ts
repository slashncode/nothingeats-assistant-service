import type { Catalog, Dish, Language, Vocabulary } from '../search/catalog.ts';
import { tool } from 'ai';
import { z } from 'zod';

/** A dish the coach recommended, as the chat shows it: catalog data only, plus the model's reason. */
export interface ShownDish {
    id: string;
    slug: string;
    name: string;
    description: string;
    cuisine: string;
    restaurant: { id: string; slug: string; name: string };
    priceCents: number;
    dietary: string[];
    allergens: string[];
    spiceLevel: number;
    calories: number;
    moods: string[];
    openNow: boolean;
    reason: string;
}

/** What the tools of one turn learned: every dish search returned, and what was shown. */
export interface TurnState {
    seen: Map<string, Dish>;
    recommended: ShownDish[];
}

export function newTurnState(): TurnState {
    return {
        seen: new Map(),
        recommended: [],
    };
}

interface ToolsContext {
    catalog: Catalog;
    token: string;
    language: Language;
    vocabulary: Vocabulary | undefined;
    state: TurnState;
}

const MAX_DESCRIPTION = 160;

// Strict tool schemas (OpenAI structured outputs): the model can only produce what the schema
// allows, so an enum is enforced while it writes, not rejected afterwards. They have no optional
// fields: "not given" is null. The filter words come from the live catalog, so the model cannot
// filter by a tag no dish has.
function words(values: string[] | undefined) {
    const [first, ...rest] = values ?? [];
    return first === undefined
        ? z.string().max(40)
        : z.enum([first, ...rest]);
}

/** What the model reads about a dish: compact, and clearly data rather than instructions. */
function forModel(dish: Dish) {
    return {
        id: dish.id,
        name: dish.name,
        restaurant: dish.restaurant.name,
        cuisine: dish.cuisine,
        priceEuros: dish.priceCents / 100,
        description: dish.description.slice(0, MAX_DESCRIPTION),
        diet: dish.dietary,
        allergens: dish.allergens,
        spiceLevel: dish.spiceLevel,
        moods: dish.moods,
        calories: dish.calories,
        openNow: dish.openNow,
    };
}

function shown(dish: Dish, reason: string): ShownDish {
    return {
        id: dish.id,
        slug: dish.slug,
        name: dish.name,
        description: dish.description,
        cuisine: dish.cuisine,
        restaurant: dish.restaurant,
        priceCents: dish.priceCents,
        dietary: dish.dietary,
        allergens: dish.allergens,
        spiceLevel: dish.spiceLevel,
        calories: dish.calories,
        moods: dish.moods,
        openNow: dish.openNow,
        reason,
    };
}

/**
 * The coach's tools for one turn. `searchDishes` and `getDish` read the catalog through search;
 * `recommendDishes` only displays: the chat renders its output as dish cards with "add to cart".
 * Every recommended id is checked against the catalog, and the cards carry the catalog's data,
 * never the model's, so a model cannot invent a dish, a price or an allergen-free promise.
 * Tool errors go back to the model as data; it can apologise or try again.
 */
export function coachTools({ catalog, token, language, vocabulary, state }: ToolsContext) {
    return {
        searchDishes: tool({
            strict: true,
            description:
                'Find dishes in the NothingEats catalog that fit a craving. Rewrite the craving as a short query in the '
                + 'customer\'s language. Set filters only for what the customer asked for (diet, allergies, price, heat, open now).',
            inputSchema: z.object({
                query: z.string().max(300).describe('The craving as a short search query, e.g. "warme Suppe" or "crispy snacks to share"'),
                keywords: z.array(z.string().max(40)).max(10).nullable().describe('Dish names or ingredients that fit, e.g. ["Pho", "Curry"]'),
                avoid: z.array(z.string().max(40)).max(10).nullable().describe('Words no dish may mention, e.g. ["mushrooms"]'),
                cuisines: z.array(words(vocabulary?.cuisines)).nullable(),
                diet: z.array(words(vocabulary?.dietary)).nullable().describe('Every dish must have all of these'),
                excludeAllergens: z.array(words(vocabulary?.allergens)).nullable().describe('No dish may contain any of these'),
                moods: z.array(words(vocabulary?.moods)).nullable(),
                maxSpiceLevel: z.number().int().min(0).max(3).nullable().describe('0 mild to 3 fiery'),
                maxPriceEuros: z.number().positive().max(100).nullable(),
                openNow: z.boolean().nullable().describe('Only restaurants open right now'),
            }),
            execute: async (input) => {
                const found = await catalog.retrieve(token, {
                    query: input.query,
                    language,
                    keywords: input.keywords ?? undefined,
                    negativeKeywords: input.avoid ?? undefined,
                    cuisines: input.cuisines ?? undefined,
                    dietary: input.diet ?? undefined,
                    excludeAllergens: input.excludeAllergens ?? undefined,
                    moods: input.moods ?? undefined,
                    maxSpiceLevel: input.maxSpiceLevel ?? undefined,
                    maxPriceCents: input.maxPriceEuros === null
                        ? undefined
                        : Math.round(input.maxPriceEuros * 100),
                    openNow: input.openNow ?? undefined,
                    limit: 8,
                });
                found.dishes.forEach(dish => state.seen.set(dish.id, dish));
                return {
                    dishes: found.dishes.map(forModel),
                };
            },
        }),

        getDish: tool({
            strict: true,
            description: 'Everything about one dish from an earlier search: full description, allergens, calories.',
            inputSchema: z.object({
                id: z.string().max(80),
            }),
            execute: async ({ id }) => {
                const [dish] = state.seen.has(id)
                    ? [
                            state.seen.get(id)!,
                        ]
                    : await catalog.dishes(token, [id], language);
                if (!dish)
                    return { error: 'NOT_FOUND' as const };
                state.seen.set(dish.id, dish);
                return {
                    ...forModel(dish),
                    description: dish.description,
                    section: dish.section,
                    available: dish.available,
                };
            },
        }),

        recommendDishes: tool({
            strict: true,
            description:
                'Show one to three dishes to the customer as cards they can add to the cart. Only ids from searchDishes '
                + 'or getDish. Give each a short reason in the customer\'s language. Do not repeat the cards in your text.',
            inputSchema: z.object({
                dishes: z
                    .array(z.object({
                        id: z.string().max(80),
                        reason: z.string().max(160).describe('Why this fits the craving, one short sentence'),
                    }))
                    .min(1)
                    .max(3),
            }),
            execute: async ({ dishes }) => {
                const unseen = dishes.map(dish => dish.id).filter(id => !state.seen.has(id));
                (await catalog.dishes(token, unseen, language)).forEach(dish => state.seen.set(dish.id, dish));
                const cards = dishes.flatMap(({ id, reason }) => {
                    const dish = state.seen.get(id);
                    return dish?.available
                        ? [
                                shown(dish, reason),
                            ]
                        : [];
                });
                state.recommended.push(...cards);
                return {
                    shown: cards,
                    notShown: dishes.map(dish => dish.id).filter(id => !cards.some(card => card.id === id)),
                };
            },
            // The model only needs to know what is on screen now, not the cards' data again.
            toModelOutput: ({ output }) => ({
                type: 'text',
                value: [
                    output.shown.length > 0
                        ? `Shown to the customer: ${output.shown.map(card => `${card.name} (${card.id})`).join(', ')}.`
                        : 'Nothing was shown.',
                    output.notShown.length > 0
                        ? `Not shown, unknown or unavailable ids: ${output.notShown.join(', ')}.`
                        : '',
                ].join(' ').trim(),
            }),
        }),
    };
}

export type CoachTools = ReturnType<typeof coachTools>;
