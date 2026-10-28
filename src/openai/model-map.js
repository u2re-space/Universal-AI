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
    // non-prefixed to prefixed
    'gpt-6-luna'          : 'openai/gpt-6-luna',
    'gpt-6.1-terra'       : 'openai/gpt-6.1-terra',
    'gpt-6.1-sol'         : 'openai/gpt-6.1-sol',
    'gpt-6-luna-decisions': 'openai/gpt-6-luna-decisions',
    'gpt-6-astra'         : 'openai/gpt-6-astra',

    // non-prefixed to prefixed image API
    'gpt-image-2.5'         : 'openai/gpt-image-2.5',
    'gpt-image-2.5-flare'   : 'openai/gpt-image-2.5-flare',
    'gpt-image-2.5-sunburst': 'openai/gpt-image-2.5-sunburst',

    // non-prefixed to prefixed other models
    'claude-haiku-5-5'        : 'anthropic/claude-haiku-5-5',
    'claude-sonnet-5-5'       : 'anthropic/claude-sonnet-5-5',
    'claude-opus-5.5'         : 'anthropic/claude-opus-5.5',

    // prefixed fallback to another
    'openai/gpt-6-luna-decisions': 'typesafe/jev-1.14',
    'openai/gpt-6-luna'          : 'anthropic/claude-haiku-5-5',
    'openai/gpt-6.1-terra'       : 'anthropic/claude-sonnet-5-5',
    'openai/gpt-6.1-sol'         : 'anthropic/claude-opus-5.5',
    'openai/gpt-6-astra'         : 'anthropic/claude-opus-5.5'
});
