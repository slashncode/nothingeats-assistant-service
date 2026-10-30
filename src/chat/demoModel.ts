import type {
    LanguageModelV4,
    LanguageModelV4CallOptions,
    LanguageModelV4Content,
    LanguageModelV4FinishReason,
    LanguageModelV4Prompt,
    LanguageModelV4StreamPart,
    LanguageModelV4Usage,
} from '@ai-sdk/provider';

const USAGE: LanguageModelV4Usage = {
    inputTokens: {
        total: 400,
        noCache: 400,
        cacheRead: undefined,
        cacheWrite: undefined,
    },
    outputTokens: { total: 40, text: 40, reasoning: undefined },
};

const ANSWERS = {
    German: 'Hier sind ein paar Ideen. Bestellen kostet nichts, und satt wirst du auch nicht.',
    English: 'Here are a few ideas. Ordering costs nothing, and you will not get full either.',
};

const REASONS = { German: 'Passt zu deinem Hunger.', English: 'Fits your craving.' };

interface Step {
    content: LanguageModelV4Content[];
    finishReason: LanguageModelV4FinishReason;
}

/**
 * A scripted stand-in for a real model, for tests and clusters without an API key: it searches
 * for whatever the customer wrote, recommends the first three results and says so. Always the
 * same three steps, which is all an end-to-end test needs to check the plumbing.
 */
export class DemoModel implements LanguageModelV4 {
    readonly specificationVersion = 'v4';
    readonly provider = 'demo';
    readonly modelId = 'scripted-coach';
    readonly supportedUrls = {};
    readonly calls: LanguageModelV4CallOptions[] = [];

    async doGenerate(options: LanguageModelV4CallOptions) {
        this.calls.push(options);
        const step = next(options.prompt);
        return { ...step, usage: USAGE, warnings: [] };
    }

    async doStream(options: LanguageModelV4CallOptions) {
        this.calls.push(options);
        const step = next(options.prompt);
        const parts: LanguageModelV4StreamPart[] = [
            { type: 'stream-start', warnings: [] },
        ];
        for (const part of step.content) {
            if (part.type === 'text') {
                parts.push({ type: 'text-start', id: 'text-1' });
                for (const word of part.text.split(/(?<= )/))
                    parts.push({ type: 'text-delta', id: 'text-1', delta: word });
                parts.push({ type: 'text-end', id: 'text-1' });
            }
            else {
                parts.push(part as LanguageModelV4StreamPart);
            }
        }
        parts.push({ type: 'finish', finishReason: step.finishReason, usage: USAGE });
        return {
            stream: new ReadableStream<LanguageModelV4StreamPart>({
                start(controller) {
                    parts.forEach(part => controller.enqueue(part));
                    controller.close();
                },
            }),
        };
    }
}

function next(prompt: LanguageModelV4Prompt): Step {
    const last = prompt.at(-1);
    const toolResult = last?.role === 'tool'
        ? last.content.find(part => part.type === 'tool-result')
        : undefined;
    if (toolResult?.type === 'tool-result' && toolResult.toolName === 'searchDishes') {
        const value = toolResult.output.type === 'json'
            ? toolResult.output.value as { dishes?: { id: string }[] }
            : {};
        const dishes = (value.dishes ?? []).slice(0, 3).map(dish => ({ id: dish.id, reason: REASONS[language(prompt)] }));
        if (dishes.length > 0)
            return toolCall('recommendDishes', { dishes });
    }
    if (toolResult)
        return text(ANSWERS[language(prompt)]);
    const said = last?.role === 'user'
        ? last.content.flatMap(part => (part.type === 'text'
                ? [part.text]
                : [])).join(' ')
        : '';
    return toolCall('searchDishes', {
        query: said.slice(0, 300),
        keywords: null,
        avoid: null,
        cuisines: null,
        diet: null,
        excludeAllergens: null,
        moods: null,
        maxSpiceLevel: null,
        maxPriceEuros: null,
        openNow: null,
    });
}

function language(prompt: LanguageModelV4Prompt): keyof typeof ANSWERS {
    const system = prompt.find(message => message.role === 'system');
    return system?.content.includes('Answer in German')
        ? 'German'
        : 'English';
}

let calls = 0;

function toolCall(toolName: string, input: unknown): Step {
    calls++;
    return {
        content: [
            {
                type: 'tool-call',
                toolCallId: `demo-call-${calls}`,
                toolName,
                input: JSON.stringify(input),
            },
        ],
        finishReason: { unified: 'tool-calls', raw: undefined },
    };
}

function text(value: string): Step {
    return {
        content: [
            { type: 'text', text: value },
        ],
        finishReason: { unified: 'stop', raw: undefined },
    };
}
