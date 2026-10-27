/**
 * @file src/core/config-defaults.js
 * @module core/config-defaults
 * @purpose Frozen default configuration and the enums that validate it.
 * @usedBy core/config, commands/flags
 * @exports defaults, ROLE_NAMES, REASONING_EFFORTS, REASONING_SUMMARIES, APPROVAL_LEVELS, IMAGE_DETAILS, CONTEXT_LEVEL_NAMES
 * @ai.tags config
 * @ai.hint pure
 * @changed 2026-10-26 Model profiles section and word context levels for 0.2.0.
 */
import { MODEL_FALLBACKS } from '../openai/model-map.js';
import { CONTEXT_LEVELS } from '../openai/model-profiles.js';
const KiB = 1024;
const MiB = KiB * KiB;

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const REASONING_SUMMARIES = ['auto', 'concise', 'detailed', 'none'];
export const APPROVAL_LEVELS = ['ask', 'read', 'write', 'all'];
export const IMAGE_DETAILS = ['auto', 'low', 'high', 'original'];
/** Word levels of a context budget, plus `auto`, which follows the window of the model in use. */
export const CONTEXT_LEVEL_NAMES = Object.freeze([...Object.keys(CONTEXT_LEVELS), 'auto']);

/**
 * Base fields of one role entry in `roles`. A helper rather than a literal per role, so a new
 * field lands in every role at once and the whitelist check of `roles.<name>.<field>` follows.
 */
const ROLE_FIELDS = Object.freeze({
    model: null, effort: null, summary: null, verbosity: null,
    maxOutputTokens: null, temperature: null, instructions: null,
    /** Hardest reasoning effort this role may use; the stricter of this and the model ceiling wins. */
    maxEffort: null,
    /** Context budget of the role: a word level (small | normal | large | max | auto) or bytes. */
    context: null,
    /** Tool names the role is limited to; null keeps the tools of the run. */
    tools: null,
    /** Tool turns a nested run of this role may spend; null uses the executor default. */
    turns: null,
    /**
     * Model and effort per work size, in either shape:
     *   ladder   — `[{ model, effort: [level, ...] }, ...]`: one entry per model, each with the
     *              effort levels that model serves; complexity advances both axes;
     *   explicit — `{ trivial: { model, effort }, normal: …, complex: … }`.
     * A tier applies when the caller names a complexity and the role does not pin that field.
     */
    tiers: null,
});

/** One role entry: the standard fields with the given overrides on top. */
const r = (overrides) => ({ ...ROLE_FIELDS, ...overrides });

/**
 * Defaults. Everything here may be overridden by ~/.ai-agent/config.json, --config <file>,
 * environment variables (OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_ORG_ID, OPENAI_PROJECT_ID,
 * AI_MODEL, AI_AGENT_HOME) and finally CLI flags.
 */
export const defaults = Object.freeze({
    model: 'gpt-6-luna',
    imageModel: 'gpt-image-2.5-sunburst',                 // null → gpt-image-2.5 (flare for generation, sunburst for edits) on the images API
    baseURL: "https://api.proxyapi.ru/v1",                    // null → OPENAI_BASE_URL or https://api.openai.com/v1/
    apiKey: "{{env:PROXYAPI_API_KEY}}",                     // prefer the OPENAI_API_KEY environment variable
    /**
     * Ordered OpenAI-compatible backends. The first entry with a URL and a key is the primary host;
     * the rest are tried when it is down. An entry accepts `baseUrl` (or `baseURL`), `apiKey` with
     * `{{env:NAME}}`, extra `headers`, and `supports` route switches (`decisions: false`).
     * When the list is empty, `baseURL` + `apiKey` and `fallback.providers` are used.
     */
    backends: [],
    /**
     * Per-model overrides of the registry in `openai/model-profiles.js`.
     * Accepts `window` (bytes), `maxOutput` (tokens), `ceiling` (effort string), `efforts` (effort array).
     * All fields are optional; omitted ones keep the registry default.
     */
    models: {},
    organization: null,
    project: null,
    instructions: null,               // extra system instructions appended to the built-in ones
    documentation: {
        sources: {
            mdnCss: 'https://developer.mozilla.org/en-US/docs/Web/CSS',
            mdnJavaScript: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript',
            ecma262: 'https://tc39.es/ecma262/',
            typescript: 'https://www.typescriptlang.org/docs/',
            sass: 'https://sass-lang.com/documentation/',
            eslint: 'https://eslint.org/docs/latest/',
            stylelint: 'https://stylelint.io/user-guide/',
            prettier: 'https://prettier.io/docs/',
            canIUse: 'https://caniuse.com/',
            cssTricks: 'https://css-tricks.com/',
            chromeStatus: 'https://chromestatus.com/',
            cssLogical: 'https://drafts.csswg.org/css-logical/',
            cssProperty: 'https://drafts.css-houdini.org/css-properties-values-api/',
            cssLayer: 'https://drafts.csswg.org/css-cascade-5/',
            cssConditional: 'https://drafts.csswg.org/css-conditional-5/',
            cssAnchor: 'https://drafts.csswg.org/css-anchor-position-2/',
            cssUnits: 'https://drafts.csswg.org/css-values-5/',
            cssAnimation: 'https://drafts.csswg.org/css-animations-2/',
            cssShapes: 'https://drafts.csswg.org/css-shapes-2/',
            cssMotion: 'https://drafts.csswg.org/motion/',
            cssTransform: 'https://drafts.csswg.org/css-transforms-2/',
            cssCascade: 'https://drafts.csswg.org/css-cascade-5/',
            cssContain: 'https://drafts.csswg.org/css-contain/',
            cssImages: 'https://drafts.csswg.org/css-images-5/',
            cssMasking: 'https://drafts.csswg.org/css-masking/',
            cssFonts: 'https://drafts.csswg.org/css-fonts/',
            magickOptions: 'https://imagemagick.org/command-line-options/',
            magickTools: 'https://imagemagick.org/command-line-tools/',
            phosphorIcons: 'https://phosphoricons.com/',
            lucideIcons: 'https://lucide.dev/icons/',
            googleFonts: 'https://fonts.google.com/'
        },
        roles: {
            'image-processor': ['cssMasking', 'cssImages', 'cssFonts', 'phosphorIcons', 'lucideIcons', 'magickOptions', 'magickTools', 'googleFonts'],
            measurer: ['cssUnits', 'cssShapes', 'phosphorIcons', 'lucideIcons', 'cssTransform', 'cssMotion', 'cssContain', 'cssImages', 'cssMasking', 'cssFonts', 'googleFonts'],
            planner: ['mdnCss', 'mdnJavaScript', 'ecma262', 'typescript', 'sass', 'canIUse', 'cssTricks', 'chromeStatus', 'cssLogical', 'cssProperty', 'cssLayer', 'cssConditional', 'cssAnchor', 'cssUnits', 'cssAnimation', 'cssShapes', 'cssMotion', 'cssTransform', 'cssCascade', 'cssContain', 'cssImages', 'cssMasking', 'cssFonts', 'googleFonts'],
            architect: ['mdnCss', 'mdnJavaScript', 'ecma262', 'typescript', 'sass', 'canIUse', 'cssTricks', 'chromeStatus', 'cssLogical', 'cssProperty', 'cssLayer', 'cssConditional', 'cssAnchor', 'cssUnits', 'cssAnimation', 'cssShapes', 'cssMotion', 'cssTransform', 'cssCascade', 'cssContain', 'cssImages', 'cssMasking', 'cssFonts', 'eslint', 'stylelint', 'prettier', 'phosphorIcons', 'lucideIcons', 'googleFonts'],
            orchestrator: ['mdnCss', 'mdnJavaScript', 'ecma262', 'typescript', 'sass', 'canIUse', 'cssTricks', 'chromeStatus', 'cssLogical', 'cssProperty', 'cssLayer', 'cssConditional', 'cssAnchor', 'cssUnits', 'cssAnimation', 'cssShapes', 'cssMotion', 'cssTransform', 'cssCascade', 'cssContain', 'cssImages', 'cssMasking', 'cssFonts', 'eslint', 'stylelint', 'prettier', 'phosphorIcons', 'lucideIcons', 'googleFonts'],
            worker: ['mdnCss', 'mdnJavaScript', 'ecma262', 'typescript', 'sass', 'canIUse', 'cssTricks', 'chromeStatus', 'cssLogical', 'cssProperty', 'cssLayer', 'cssConditional', 'cssAnchor', 'cssUnits', 'cssAnimation', 'cssShapes', 'cssMotion', 'cssTransform', 'cssCascade', 'cssContain', 'cssImages', 'cssMasking', 'cssFonts', 'eslint', 'stylelint', 'prettier', 'phosphorIcons', 'lucideIcons', 'googleFonts'],
            coder: ['mdnCss', 'mdnJavaScript', 'ecma262', 'typescript', 'sass', 'canIUse', 'cssTricks', 'chromeStatus', 'cssLogical', 'cssProperty', 'cssLayer', 'cssConditional', 'cssAnchor', 'cssUnits', 'cssAnimation', 'cssShapes', 'cssMotion', 'cssTransform', 'cssCascade', 'cssContain', 'cssImages', 'cssMasking', 'cssFonts', 'eslint', 'stylelint', 'prettier', 'phosphorIcons', 'lucideIcons', 'googleFonts'],
        },
    },
    reasoning: { effort: "low", summary: 'auto' },
    verbosity: "low",                  // low | medium | high (GPT-5 family)
    temperature: null,
    maxOutputTokens: null,
    store: false,                     // false → stateless history with encrypted reasoning; true → previous_response_id
    truncation: 'auto',
    serviceTier: null,                // auto | default | flex | priority | fast
    promptCacheKey: null,
    stream: true,
    retries: 4,                    // repeats after the first try for a timeout or a dropped network; persistent HTTP statuses are not repeated
    /**
     * When a model or the whole gateway is missing, try another channel and then another host.
     * A provider entry is used only when its apiKey or its env variable is set.
     */
    fallback: {
        enabled: true,
        models: { ...MODEL_FALLBACKS },
        providers: [
            { baseURL: 'https://api.proxyapi.ru/v1', apiKey: "{{env:PROXYAPI_API_KEY}}", env: 'PROXYAPI_API_KEY' },
            { baseURL: 'https://sprutdock.ru/v1', apiKey: "{{env:SPRUTDOCK_API_KEY}}", supports: { decisionAPI: false }, env: 'SPRUTDOCK_API_KEY' },
            { baseURL: 'https://gptunnel.ru/', apiKey: '{{env:GPTUNNEL_API_KEY}}', headers: { useWalletBalance: true }, env: 'GPTUNNEL_API_KEY' }
        ],
    },
    approve: null,                    // ask | read | write | all; null → ask (TTY) or read (no TTY)
    shell: null,                      // run_command shell: null (cmd.exe / sh) | powershell | pwsh | bash | sh | zsh | cmd
    magickPath: null,                 // ImageMagick executable (magick or convert); null → look it up in PATH
    tools: { fs: true, shell: true, fetch: true, web: true, images: false, askUser: true, desktop: false, mcp: true, channels: false, subagents: true },
    /** Windows screen, mouse, keyboard, and AutoHotkey v2. Tools stay off until tools.desktop is true. Screen capture stays off until unsafeScreenshot. */
    desktop: { ahkPath: null, shotAfterAction: true, unsafeScreenshot: false },
    limits: {
        maxTurns: 60,
        extendTurns: 10,              // when maxTurns is reached, ask the operator to extend by this many turns; 0 disables
        maxToolCallsPerTurn: 32,
        budgetUsd: null,
        budgetTokens: null,
        idleTimeoutMs: 600_000,
        connectTimeoutMs: 30_000,
        maxRequestBytes: 'max',         // small | normal | large | max | auto; the request body ceiling
        maxFileReadBytes: 256 * KiB,
        maxFileWriteBytes: 4 * MiB,
        maxSearchResults: 60,
        maxListEntries: 400,
        maxCommandOutputBytes: 64 * KiB,
        commandTimeoutMs: 180_000,
        maxFetchBytes: 512 * KiB,
        maxImageBytes: 20 * MiB,
        maxAttachmentBytes: 32 * MiB,
        maxStdinBytes: 4 * MiB,
        pollIntervalMs: 2_000,
    },
    image: {
        size: 'auto', quality: 'auto', format: 'png', background: 'auto', partialImages: 2, outputDir: '.', transport: null,
        maskModel: null,             // null → the edit model draws the alpha matte (openai/gpt-image-2.5-sunburst)
        alphaMode: 'auto',           // auto: native alpha, then paint→mask, then contour, then corner fill; mask | contour | flat | off
        paintBackground: true,       // fill the background with the subject color before the matte is drawn (kills the halo)
        alphaFeather: 1,             // px of anti-aliasing on the matte edge; 0 keeps the matte as drawn
        vectorModel: null,           // null → recraft/recraft-v4.1-pro-vector through the images API
        vectorMaxColors: 256,        // raw unique-color ceiling for vectorize_image; above it the top-two coverage decides
        autoVectorize: false,        // after a cut-out mark, ask for the SVG in the same tool answer
        pngMaxBytes: 4 * MiB,        // PNG stays the default raster; a heavier file is re-encoded as WebP
    },
    webSearch: { contextSize: null },       // null → { type: "web_search" }. low | medium | high adds search_context_size
    compaction: { auto: false, afterInputTokens: 200_000 },
    /**
     * Per-role model settings. Every field is optional and falls back to roles.default, then to the
     * top-level settings (model, reasoning.effort, …). `tiers` holds the model and effort for
     * trivial, normal, and complex work; the team applies a tier when pace is not driving the run.
     * Roles:
     *   default    — ask / chat / single-agent run
     *   planner    — understands the task, writes the plan (senior model)
     *   architect  — turns the plan and the measurements into a file/module structure, design decisions,
     *                and a per-step brief for the orchestrator and the authors (senior model)
     *   orchestrator — knows the project best: collects context from files, then reads the plan, progress,
     *                  findings, and recent diff after every stage and decides what to do next
     *   worker     — executes plan steps that are not code generation
     *   coder      — writes code; model and effort follow plan complexity unless config pins them
     *   writer     — writes documents, reports, and Markdown; stays on the cheaper model, effort follows complexity
     *   reviewer   — verifies the result (read-only tools, may run tests)
     *   vision     — describes images; model and effort follow the long side, unless config pins them
     *   summarizer — compaction, file summaries, memory extraction (cheapest model)
     *   solver     — solves a step from the screen or an image; model and effort follow step complexity
     *   clicker    — clicks one UI target
     *   typer      — types into a named UI field
     *   encoder    — returns a batch for later execution
     *   tester     — checks whether the step result is true
     *   classifier — labels a task as trivial, normal, or complex
     *   extractor  — cleans a verbose answer and writes clean file bodies to .tmp
     *   measurer   — measures reference images (boxes, angles, borders, crops, spacing) before styles and artwork
     *   image-processor — generates, edits, and prepares requested images and visual assets before implementation
     * worker, coder, writer, reviewer, tester, vision, solver, and image-processor double as the
     * sub-agents of run_subagent (tools.subagents): same prompt, same model settings, own context.
     */

    roles: {
        default: r({}),
        planner: r({ effort: 'high' }),
        architect: r({ effort: 'high' }),
        orchestrator: r({ effort: 'high' }),
        worker: r({ effort: 'high' }),
        coder: r({
            // trivial → luna/high, normal → sol/high, complex → sol/xhigh: the model stops at the
            // top rung, the effort keeps climbing that model's ladder.
            tiers: [
                { model: 'gpt-6-luna', effort: ['high', 'xhigh', 'max'] },
                { model: 'gpt-6.1-sol', effort: ['medium', 'high', 'xhigh'] },
            ],
        }),
        writer: r({
            // Documents stay on the cheaper model; only the effort grows with the work.
            tiers: [
                { model: 'gpt-6-luna', effort: ['medium', 'high', 'xhigh'] },
            ],
        }),
        reviewer: r({ effort: 'high' }),
        vision: r({
            // A medium image keeps the cheap model; a screenshot or a large image moves to the senior one.
            tiers: {
                trivial: { model: 'gpt-6-luna', effort: 'medium' },
                normal: { model: 'gpt-6-luna', effort: 'high' },
                complex: { model: 'gpt-6.1-sol', effort: 'high' },
            },
        }),
        summarizer: r({ effort: 'high', summary: 'none', verbosity: 'medium' }),
        solver: r({
            tiers: {
                trivial: { model: 'gpt-6-luna', effort: 'medium' },
                normal: { model: 'gpt-6-luna', effort: 'high' },
                complex: { model: 'gpt-6.1-sol', effort: 'high' },
            },
        }),
        clicker: r({ effort: 'low' }),
        typer: r({ effort: 'low' }),
        encoder: r({ effort: 'high' }),
        tester: r({ effort: 'high' }),
        classifier: r({ effort: 'high' }),
        extractor: r({ effort: 'high', verbosity: 'low' }),
        measurer: r({
            // A plain split stays cheap; styles and SVG take the senior model.
            tiers: {
                trivial: { model: 'gpt-6-luna', effort: 'xhigh' },
                normal: { model: 'gpt-6.1-sol', effort: 'high' },
                complex: { model: 'gpt-6.1-sol', effort: 'xhigh' },
            },
        }),
        'image-processor': r({ effort: 'high' }),
    },
    /** Multi-role orchestration used by `ai run`. */
    agent: {
        mode: 'team',                   // team (planner → architect → orchestrator → worker → reviewer) | single (one model, one loop)
        /**
         * Stage order for team runs. null = the catalog order; a list reorders or drops stages
         * (answer, classify, plan, measure, architect, collect, images, work, review, outcome, memory).
         * The plan may supply its own order, which wins over this list for that task.
         */
        pipeline: null,
        maxSteps: 12,                   // plan steps accepted from the planner
        maxReviewRounds: 2,             // reviewer → worker fix cycles
        orchestratorMaxTurns: 12,       // tool turns the orchestrator may spend collecting context
        workerMaxTurnsPerStep: 25,
        reviewerMaxTurns: 10,
        maxContextBytes: 'normal',      // small | normal | large | max | auto
        visionDelegate: 'auto',         // auto (when roles.vision has its own model) | always | never
        chain: true,                    // first answer, then encoder or planner
        route: null,                    // null | encoder | planner; null lets the answer and the heuristic choose
        extract: 'auto',                // off | auto (encode route) | always (encode and plan); clean fenced code into .tmp/<id>/extracted
        /**
         * The architect works after the plan and the measurements and before context collection.
         * auto = only for non-trivial plans; always = also for trivial plans; off = never.
         * It returns a file/module structure, design decisions, a per-step brief, and questions for
         * the orchestrator. The brief goes to the shared context and to `.tmp/<id>/architecture.json`.
         */
        architect: 'auto',              // off | auto | always
        architectMaxTurns: 8,           // read-only tool turns the architect may spend inspecting the project
        /**
         * Reference measurements taken by the `measurer` role right after the plan and before the worker
         * writes styles or artwork. auto = only when reference images are attached and the plan is not
         * trivial; always = whenever references are attached; off = never. The sheet goes to the shared
         * context and to `.tmp/<id>/measurements.json`.
         */
        measure: 'auto',                // off | auto | always
        measurerPasses: 2,              // 1 = one sheet; 2 = whole reference, then staged fragments
        measurerMaxTurns: 16,           // total tool turns for the measurement passes, split between them
        measurerMaxContextBytes: 'max', // measurement context budget; keep it within limits.maxRequestBytes
        encode: 'encoder',              // encoder (file-command model) | mcp (this process hosts the encode server)
        resume: true,                   // continue the newest unfinished step and its saved turn
        /**
         * The orchestrator reads the plan, progress, findings, and the recent diff after a stage
         * and returns plan updates plus guidance for the next worker turn. It is off by default
         * because it adds a senior-model request per stage. maxContextBytes is its context budget
         * (~1M tokens at 4 MiB); the configured model must support that window.
         */
        orchestrator: {
            enabled: false,
            after: ['plan', 'work', 'review', 'fix'],
            maxContextBytes: 4 * MiB,
            diffMaxBytes: 256 * KiB,
            logMaxBytes: 32 * KiB,
            maxTurns: 6,
            applyPlan: true,
        },
    },
    /** Long-term memory (SQLite, node:sqlite) and project notes. */
    memory: {
        enabled: true,
        autoSave: true,                 // extract durable facts after a team run (summarizer role)
        maxRecall: 8,                   // memories injected into the shared context
        notesFile: 'AGENTS.md',         // project notes file included in the context when present
        dbFile: null,                   // null → <home>/memory.db
    },
    /**
     * AGENTS.md discovery and injection. Finds project-level and global AGENTS.md files,
     * merges them, and injects into system prompts and shared contexts.
     * Set `enabled: false` to disable discovery and injection; team retains legacy `memory.notesFile`.
     */
    agents: {
        enabled: true,                  // discover and inject AGENTS.md files
        filenames: ['AGENTS.md', 'agents.md'],  // filenames to search (first match per directory wins)
        globalFile: null,               // override global file path (null → <home>/AGENTS.md)
        maxBytes: 16 * 1024,            // per-file size cap (bytes)
        maxTotalBytes: 64 * 1024,       // merged total cap (bytes)
        discoverUpward: true,           // walk up from cwd looking for AGENTS.md
        nested: true,                   // also collect nested AGENTS.md from subdirectories
    },
    /**
     * Project generation (`ai gen`). Fidelity is a target, not a measured score.
     * platform selects the frozen web-platform profile (Chrome 157 Beta, flags off).
     */
    generate: {
        fidelity: 80,
        creativity: 20,
        platform: 'chrome-157-beta',
    },
    /**
     * Team pace. models run from cheap to expensive.
     * speed and quality are 0..100. mode auto follows those numbers.
     */
    pace: {
        speed: 10,
        quality: 40,
        mode: 'auto',
        models: ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra'],
    },
    /** User MCP servers. stdio is spawned here. http is sent to the API as type mcp. */
    mcp: {
        servers: [],
    },
    /**
     * Decision models. ProxyAPI serves them at POST /v1/decisions (input tokens only).
     * reviewAt marks a message for a person. blockAt hides it in a group or channel.
     * assess judges a finished team result and can skip the reviewer. vision sends reference
     * and produced PNG/JPEG pictures with that call; a gateway without image input falls back to text.
     */
    decisions: {
        model: 'openai/gpt-6-luna-decisions',
        reviewAt: 0.5,
        blockAt: 0.9,
        assess: true,
        vision: true,
    },
    /**
     * auto tries POST /moderations (omni-moderation-latest) and falls back to decisions
     * when that route is missing. decisions skips /moderations. moderations does not fall back.
     */
    moderation: {
        mode: 'auto',
        model: 'omni-moderation-latest',
        preset: 'community',
        guardReplies: false,
    },
    /** Telegram Bot API. token null reads TELEGRAM_BOT_TOKEN. reply stays off until set. */
    telegram: {
        token: null,
        baseURL: 'https://api.telegram.org',
        reply: false,
        moderate: true,
        enforce: 'delete',
    },
    /** HTTP and WebSocket for chats. host outside localhost requires token. */
    channels: {
        host: '127.0.0.1',
        port: 8787,
        token: null,
    },
    /**
     * Inline completion for editors (`ai complete`, HTTP and WebSocket).
     * A fast model at effort none so a ghost text can arrive before the next key.
     * The model must be a completion catalog choice. Each choice sets its own
     * effort and output cap. completion.effort does not replace a choice that
     * already has an effort.
     * Sixteen lines on each side of the cursor are sent, so a change a dozen
     * lines away is still visible. The rest of the file is not added on the
     * next request. A line over
     * maxLineBytes (0.5 MiB, typical of base64) is left out.
     */
    completion: {
        model: 'gpt-6-luna',
        effort: 'none',
        maxOutputTokens: 160,
        maxLineBytes: 512 * 1024,
        maxContextBytes: 24 * 1024,
        neighborLines: 16,
        token: null,
        /**
         * Probe the primary host and every fallback provider in parallel and keep the fastest
         * channel per model. The probe is a tiny completion, so it also checks that the model
         * is served there. A failed channel moves to the next probe winner.
         */
        channelProbe: true,
        probeTtlMs: 60_000,
        probeTimeoutMs: 1_500,
    },
    /** Prices in USD per 1M tokens, e.g. { "gpt-6.1-sol": { "input": 1.25, "cachedInput": 0.125, "output": 10 } }. */
    prices: {},
    home: null,
});

export const ROLE_NAMES = Object.keys(defaults.roles);

/**
 * Names of the roles the code knows: their prompts live in `roles/index.js`.
 * Any other name in `roles.<name>` is a user-defined role: it takes its instructions, tools,
 * model and ceilings from the configuration and runs on the same role runner.
 */
export const BUILTIN_ROLE_NAMES = Object.freeze([...ROLE_NAMES]);

/** A user role name: a short lower-case slug that cannot collide with a built-in one. */
export const CUSTOM_ROLE_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Every role name available to a configuration: the built-ins plus the user-defined ones.
 * @param {object} config
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function roleNames(config) {
    const own = Object.keys(config?.roles ?? {}).filter((name) => !BUILTIN_ROLE_NAMES.includes(name));
    return [...BUILTIN_ROLE_NAMES, ...own];
}
