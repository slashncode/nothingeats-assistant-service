import { describe, expect, it } from 'vitest';
import { coachTools, newTurnState } from '../src/chat/tools.ts';
import { dish, FakeCatalog } from './support.ts';

const call = { toolCallId: 'call-1', messages: [], context: {} };

function tools(catalog = new FakeCatalog()) {
    const state = newTurnState();
    const vocabulary = {
        cuisines: ['italian', 'asian'],
        dietary: ['vegan'],
        moods: ['comfort'],
        allergens: ['nuts'],
    };
    return {
        catalog,
        state,
        tools: coachTools({
            catalog,
            token: 'token-1',
            language: 'en',
            vocabulary,
            state,
        }),
    };
}

const noFilters = {
    keywords: null,
    avoid: null,
    cuisines: null,
    diet: null,
    excludeAllergens: null,
    moods: null,
    maxSpiceLevel: null,
    maxPriceEuros: null,
    openNow: null,
};

describe('the coach\'s tools', () => {
    it('search turns the model\'s filters into a retrieval and remembers what it found', async () => {
        const { catalog, state, tools: { searchDishes } } = tools();

        const found = await searchDishes.execute!(
            {
                ...noFilters,
                query: 'warm soup',
                keywords: ['pho'],
                avoid: ['mushrooms'],
                diet: ['vegan'],
                maxPriceEuros: 12.5,
                openNow: true,
            },
            call,
        );

        expect(catalog.retrievals[0]).toEqual({
            token: 'token-1',
            input: expect.objectContaining({
                query: 'warm soup',
                language: 'en',
                keywords: ['pho'],
                negativeKeywords: ['mushrooms'],
                dietary: ['vegan'],
                maxPriceCents: 1250,
                openNow: true,
                cuisines: undefined,
            }),
        });
        expect('dishes' in found && found.dishes[0]).toMatchObject({ id: 'd-margherita', priceEuros: 10.9, restaurant: 'Phantom Pizza' });
        expect([
            ...state.seen.keys(),
        ]).toEqual([
            'd-margherita',
            'd-pho',
            'd-curry',
            'd-sorbet',
        ]);
    });

    it('filters only by words the catalog uses', () => {
        const { tools: { searchDishes } } = tools();
        const schema = searchDishes.inputSchema as unknown as { safeParse: (value: unknown) => { success: boolean } };

        expect(schema.safeParse({
            ...noFilters,
            query: 'x',
            cuisines: ['italian'],
        }).success).toBe(true);
        expect(schema.safeParse({
            ...noFilters,
            query: 'x',
            cuisines: ['martian'],
        }).success).toBe(false);
    });

    it('recommendations show catalog data only: unknown and unavailable dishes are left out', async () => {
        const catalog = new FakeCatalog();
        catalog.dishList.push(dish('d-gone', { available: false }));
        const { state, tools: { searchDishes, recommendDishes } } = tools(catalog);
        await searchDishes.execute!({ ...noFilters, query: 'pizza' }, call);
        catalog.dishList.push(dish('d-earlier', { name: 'From an earlier turn' }));

        const result = await recommendDishes.execute!(
            {
                dishes: [
                    { id: 'd-pho', reason: 'Warm' },
                    { id: 'd-invented', reason: 'Made up' },
                    { id: 'd-gone', reason: 'Gone' },
                    { id: 'd-earlier', reason: 'Still good' },
                ].slice(0, 3),
            },
            call,
        );
        const again = await recommendDishes.execute!({
            dishes: [
                { id: 'd-earlier', reason: 'Still good' },
            ],
        }, call);

        expect('shown' in result && result.shown.map(card => [card.id, card.name, card.reason])).toEqual([
            ['d-pho', 'Dish d-pho', 'Warm'],
        ]);
        expect('notShown' in result && result.notShown).toEqual(['d-invented', 'd-gone']);
        // Dishes from earlier turns are looked up in the catalog first.
        expect(catalog.lookups.at(-1)).toEqual({
            token: 'token-1',
            ids: ['d-earlier'],
        });
        expect('shown' in again && again.shown[0]?.name).toBe('From an earlier turn');
        expect(state.recommended.map(card => card.id)).toEqual(['d-pho', 'd-earlier']);

        const forModel = await recommendDishes.toModelOutput!({
            toolCallId: 'call-1',
            input: { dishes: [] },
            output: result as never,
        });
        expect(forModel).toEqual({ type: 'text', value: 'Shown to the customer: Dish d-pho (d-pho). Not shown, unknown or unavailable ids: d-invented, d-gone.' });
    });
});
