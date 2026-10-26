/**
 * @file src/generate/platform.js
 * @module generate/platform
 * @purpose Frozen web-platform profile for generation. Default is Chrome 157 Beta with flags off.
 * @usedBy generate/brief, commands/flags, commands/gen, core/config
 * @exports ENABLED_IN_157, WITHHELD, PLATFORM_SOURCES, CHROME_157_BETA, PLATFORMS, resolvePlatform, platformInstructions
 * @ai.tags generate, css, javascript
 * @ai.hint pure
 * @changed 2026-10-21 Vite target strings live on the profile.
 */

/** Features enabled by default in Chrome 157. Origin trials and flags are not in this list. */
export const ENABLED_IN_157 = Object.freeze([
    Object.freeze({ id: 'sanitizer-javascript-urls', area: 'html', summary: 'SanitizerConfig javascriptURLs option. Omitting the option keeps the previous behavior.' }),
    Object.freeze({ id: 'background-fetch-cors', area: 'fetch', summary: 'Background Fetch enforces CORS and the same security checks as fetch, including Local Network Access.' }),
    Object.freeze({ id: 'css-corner-shorthand', area: 'css', summary: 'corner shorthand plus per-corner, physical, and logical sub-shorthands for border-radius and corner-shape. corners stays as a compat alias.' }),
    Object.freeze({ id: 'css-position-visibility-anchor-valid', area: 'css', summary: 'position-visibility: anchor-valid. Only the default anchor counts.' }),
    Object.freeze({ id: 'css-text-overflow-string', area: 'css', summary: 'text-overflow accepts a custom string such as "(more)".' }),
    Object.freeze({ id: 'capability-elements-icon-only', area: 'html', summary: 'Capability elements can render as icon-only buttons with the displaymode attribute.' }),
    Object.freeze({ id: 'canvas-text-metrics', area: 'canvas', summary: 'TextMetrics adds selection rectangles, bounding boxes, and glyph-cluster operations.' }),
    Object.freeze({ id: 'progress-event-service-worker', area: 'workers', summary: 'Service workers can construct ProgressEvent.' }),
    Object.freeze({ id: 'html-in-canvas', area: 'canvas', summary: 'HTML-in-canvas primitives for canvas layout, drawing, and DOM synchronization.' }),
    Object.freeze({ id: 'language-detector-android', area: 'js', summary: 'LanguageDetector on Chrome for Android, on device.' }),
    Object.freeze({ id: 'loaf-style-duration', area: 'js', summary: 'Long Animation Frames expose styleDuration and forcedStyleDuration.' }),
    Object.freeze({ id: 'html-insertion-streaming', area: 'html', summary: 'Positional HTML insertion methods and streaming HTML writers, including runScripts on the unsafe setters.' }),
    Object.freeze({ id: 'css-anchor-valid-visible', area: 'css', summary: 'anchor-valid and anchor-visible ship. The plural names are deprecated aliases, not removed.' }),
    Object.freeze({ id: 'web-bluetooth-gatt-event-target', area: 'webbluetooth', summary: 'BluetoothRemoteGATTServer extends EventTarget.' }),
    Object.freeze({ id: 'webgpu-atomic-vec2u', area: 'webgpu', summary: 'WGSL atomic min and max on atomic vec2u.' }),
    Object.freeze({ id: 'svg-object-fit', area: 'css', summary: 'object-fit and object-position size embedded SVG documents instead of stretching the document viewport.' }),
]);

/** Not allowed for generated pages. Gates are origin-trial, flag, or not-default. */
export const WITHHELD = Object.freeze([
    Object.freeze({ id: 'connection-allowlists-embedded', gate: 'origin-trial', summary: 'Connection Allowlists embedded enforcement is an origin trial in Chrome 157.' }),
    Object.freeze({ id: 'overscroll-areas', gate: 'origin-trial', summary: 'Overscroll Areas is an origin trial in Chrome 157.' }),
    Object.freeze({ id: 'flagged-in-157', gate: 'flag', summary: 'The 2026-10-15 snapshot has five Chrome 157 features behind a flag. Do not toggle chrome://flags and do not ship a feature whose status is behind a flag.' }),
    Object.freeze({ id: 'css-random', gate: 'not-default', summary: 'CSS random() appears in Dev notes and on CSS-Tricks. It is not in the Chrome 157 default-enabled list.' }),
]);

/** Pages the profile was checked against. They also describe experiments, which stay withheld. */
export const PLATFORM_SOURCES = Object.freeze([
    'https://css-tricks.com/',
    'https://chromestatus.com/roadmap',
    'https://262.ecma-international.org/',
    'https://caniuse.com/',
    'https://drafts.csswg.org/css-logical/',
    'https://drafts.css-houdini.org/css-properties-values-api/',
    'https://drafts.csswg.org/css-cascade-5/',
    'https://drafts.csswg.org/css-conditional-5/',
    'https://drafts.csswg.org/css-anchor-position-2/',
    'https://drafts.csswg.org/css-values-5/',
    'https://drafts.csswg.org/css-animations-2/',
    'https://drafts.csswg.org/css-shapes-2/',
    'https://drafts.csswg.org/motion/',
    'https://drafts.csswg.org/css-transforms-2/',
    'https://drafts.csswg.org/css-cascade-5/',
    'https://drafts.csswg.org/css-contain/',
    'https://drafts.csswg.org/css-images-5/',
    'https://drafts.csswg.org/css-masking/',
    'https://drafts.csswg.org/css-fonts/',
    'https://imagemagick.org/command-line-options/',
    'https://imagemagick.org/command-line-tools/',
    'https://phosphoricons.com/',
    'https://lucide.dev/icons/',
    'https://fonts.google.com/',
    'https://www.typescriptlang.org/docs/',
    'https://sass-lang.com/documentation/',
    'https://developer.mozilla.org/en-US/docs/Web/CSS',
    'https://developer.mozilla.org/en-US/docs/Web/JavaScript',
    'https://eslint.org/docs/latest/',
    'https://stylelint.io/user-guide/',
    'https://prettier.io/docs/'
]);

/**
 * Chrome 157 Beta, experimental flags off, origin trials off.
 * Captured 2026-10-15 from the Chrome 157 default-enabled list (16 features).
 */
export const CHROME_157_BETA = Object.freeze({
    id: 'chrome-157-beta',
    browser: 'chrome',
    version: 157,
    channel: 'beta',
    experimentalFlags: false,
    originTrials: false,
    snapshot: '2026-10-15',
    ecma: Object.freeze({ edition: 2026, spec: 'https://262.ecma-international.org/' }),
    javascript: Object.freeze({ target: 'es2026', engine: 'v8', flags: false }),
    css: Object.freeze({ target: 'chrome-157-beta', flags: false }),
    vite: Object.freeze({ target: 'esnext', cssTarget: 'chrome157' }),
    sources: PLATFORM_SOURCES,
    enabledIn157: ENABLED_IN_157,
    withheld: WITHHELD,
});

/** Profiles a config may name. The default is chrome-157-beta. */
export const PLATFORMS = Object.freeze({
    'chrome-157-beta': CHROME_157_BETA,
});

/**
 * Return the profile for `id`, or the default profile when `id` is omitted.
 * @param {string} [id='chrome-157-beta']
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function resolvePlatform(id = 'chrome-157-beta') {
    const profile = PLATFORMS[id];
    if (!profile) throw new Error(`Неизвестный профиль платформы: ${id}`);
    return profile;
}

/**
 * Model-facing rules for one profile. Built from the profile data so the list cannot drift.
 * @param {object} profile Result of resolvePlatform.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function platformInstructions(profile) {
    const enabled = profile.enabledIn157.map((feature) => `- ${feature.id} (${feature.area}): ${feature.summary}`).join('\n');
    const withheld = profile.withheld.map((feature) => `- ${feature.id} [${feature.gate}]: ${feature.summary}`).join('\n');
    const sources = profile.sources.map((url) => `- ${url}`).join('\n');
    return [
        `Platform profile ${profile.id}.`,
        `Browser: Chrome ${profile.version} ${profile.channel}. Experimental flags: ${profile.experimentalFlags ? 'on' : 'off'}. Origin trials: ${profile.originTrials ? 'allowed' : 'off'}.`,
        `Snapshot: ${profile.snapshot}.`,
        `ECMAScript edition ${profile.ecma.edition} (${profile.ecma.spec}). Use that edition only for syntax and built-ins Chrome ${profile.version} runs with experimental flags off.`,
        `JavaScript target: ${profile.javascript.target}. CSS target: ${profile.css.target}.`,
        `Vite build target: ${profile.vite.target}. Vite CSS target: ${profile.vite.cssTarget}.`,
        'Features already enabled by default in earlier Chrome versions stay allowed. That includes CSS nesting, cascade layers, :has(), container queries, subgrid, color-mix(), oklch, light-dark(), anchor positioning, same-document view transitions, popover, dialog, text-wrap: balance, and dvh/svh/lvh, plus ECMAScript built-ins those earlier versions ship without a flag.',
        `Features newly enabled by default in Chrome ${profile.version}:`,
        enabled,
        'Do not use:',
        withheld,
        'Documentation sources. These sites also describe experiments. Experiments are not allowed:',
        sources,
    ].join('\n');
}
