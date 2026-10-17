/**
 * @file src/openai/model-map.js
 * @module openai/model-map
 * @purpose Stand-in model ids when the requested id is not served.
 * @exports MODEL_FALLBACKS
 * @ai.tags openai, fallback
 * @ai.hint pure
 * @changed 2026-10-17 Cheap and strong models have an anthropic stand-in. Decisions can use typesafe or be skipped.
 */

/** Default stand-ins. Keys may be bare or prefixed with openai/. */
export const MODEL_FALLBACKS = Object.freeze({
    'gpt-6-luna': 'anthropic/claude-haiku-5-5',
    'openai/gpt-6-luna': 'anthropic/claude-haiku-5-5',
    'gpt-6.1-sol': 'anthropic/claude-opus-5.5',
    'openai/gpt-6.1-sol': 'anthropic/claude-opus-5.5',
    'gpt-6-luna-decisions': 'typesafe/jev-1.14',
    'openai/gpt-6-luna-decisions': 'typesafe/jev-1.14',
});
