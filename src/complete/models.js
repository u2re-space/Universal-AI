/**
 * @file src/complete/models.js
 * @module complete/models
 * @purpose Catalog of editor completion models. Config and requests resolve through this list.
 * @usedBy core/config, complete/complete, test/completion-models.test.js
 * @exports COMPLETION_MODELS, COMPLETION_MODEL_CHOICES, resolveCompletionModel
 * @ai.tags complete
 * @ai.hint pure
 * @changed 2026-10-16 Choiceable tab-completion models. Default is gpt-6-luna.
 */

/** @type {readonly { choice: string, aliases: readonly string[], wire: string, reasoning: 'none'|'low'|null, maxOutputTokens: number, clampNone: boolean }[]} */
export const COMPLETION_MODELS = Object.freeze([
    { choice: 'gpt-6-luna', aliases: Object.freeze(['openai/gpt-6-luna']), wire: 'gpt-6-luna', reasoning: 'none', maxOutputTokens: 160, clampNone: false },
    { choice: 'anthropic/claude-haiku-5-5', aliases: Object.freeze([]), wire: 'anthropic/claude-haiku-5-5', reasoning: null, maxOutputTokens: 160, clampNone: false },
    { choice: 'qwen/qwen3.8-omni-flash', aliases: Object.freeze([]), wire: 'qwen/qwen3.8-omni-flash', reasoning: null, maxOutputTokens: 160, clampNone: false },
    { choice: 'qwen/qwen3.8-flash', aliases: Object.freeze(['qwen3.8-flash']), wire: 'qwen/qwen3.8-flash', reasoning: null, maxOutputTokens: 160, clampNone: false },
    { choice: 'z-ai/glm-5.3-flash', aliases: Object.freeze([]), wire: 'z-ai/glm-5.3-flash', reasoning: null, maxOutputTokens: 160, clampNone: false },
    { choice: 'x-ai/grok-4.7', aliases: Object.freeze([]), wire: 'x-ai/grok-4.7', reasoning: 'low', maxOutputTokens: 512, clampNone: true },
    { choice: 'gemini-3.8-flash', aliases: Object.freeze([]), wire: 'gemini-3.8-flash', reasoning: null, maxOutputTokens: 160, clampNone: false },
    { choice: 'deepseek/deepseek-v4.1-flash', aliases: Object.freeze([]), wire: 'deepseek/deepseek-v4.1-flash', reasoning: 'none', maxOutputTokens: 160, clampNone: false },
]);

/** Choice ids, in catalog order. */
export const COMPLETION_MODEL_CHOICES = Object.freeze(COMPLETION_MODELS.map((row) => row.choice));

/**
 * Resolve a choice id or alias. Empty and unknown values return null.
 * @param {unknown} value
 * @returns {{ choice: string, aliases: readonly string[], wire: string, reasoning: 'none'|'low'|null, maxOutputTokens: number, clampNone: boolean }|null}
 * @exports
 * @ai.hint pure
 */
export function resolveCompletionModel(value) {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name) return null;
    return COMPLETION_MODELS.find((row) => row.choice === name || row.aliases.includes(name)) ?? null;
}
