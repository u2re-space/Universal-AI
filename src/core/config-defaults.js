/**
 * @file src/core/config-defaults.js
 * @module core/config-defaults
 * @purpose Frozen default configuration and the enums that validate it.
 * @usedBy core/config, commands/flags
 * @exports defaults, ROLE_NAMES, REASONING_EFFORTS, REASONING_SUMMARIES, APPROVAL_LEVELS, IMAGE_DETAILS
 * @ai.tags config
 * @ai.hint pure
 * @changed 2026-10-15 Decisions, moderation, Telegram, and the channel server.
 */
import { MODEL_FALLBACKS } from '../openai/model-map.js';
const KiB = 1024;
const MiB = KiB * KiB;

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const REASONING_SUMMARIES = ['auto', 'concise', 'detailed', 'none'];
export const APPROVAL_LEVELS = ['ask', 'read', 'write', 'all'];
export const IMAGE_DETAILS = ['auto', 'low', 'high', 'original'];

/**
 * Defaults. Everything here may be overridden by ~/.ai-agent/config.json, --config <file>,
 * environment variables (OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_ORG_ID, OPENAI_PROJECT_ID,
 * AI_MODEL, AI_AGENT_HOME) and finally CLI flags.
 */
export const defaults = Object.freeze({
    model: 'gpt-6-luna',
    imageModel: null,                 // null → let the image_generation tool use its default model
    baseURL: "https://api.proxyapi.ru/v1",                    // null → OPENAI_BASE_URL or https://api.openai.com/v1/
    apiKey: null,                     // prefer the OPENAI_API_KEY environment variable
    organization: null,
    project: null,
    instructions: null,               // extra system instructions appended to the built-in ones
    reasoning: { effort: "low", summary: 'auto' },
    verbosity: null,                  // low | medium | high (GPT-5 family)
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
            { baseURL: 'https://sprutdock.ru/v1', apiKey: null, env: 'SPRUTDOCK_API_KEY' },
        ],
    },
    approve: null,                    // ask | read | write | all; null → ask (TTY) or read (no TTY)
    shell: null,                      // run_command shell: null (cmd.exe / sh) | powershell | pwsh | bash | sh | zsh | cmd
    tools: { fs: true, shell: true, fetch: true, web: false, images: false, askUser: true, desktop: false, mcp: true, channels: false },
    /** Windows screen, mouse, keyboard, and AutoHotkey v2. Tools stay off until tools.desktop is true. Screen capture stays off until unsafeScreenshot. */
    desktop: { ahkPath: null, shotAfterAction: true, unsafeScreenshot: false },
    limits: {
        maxTurns: 60,
        maxToolCallsPerTurn: 32,
        budgetUsd: null,
        budgetTokens: null,
        idleTimeoutMs: 600_000,
        connectTimeoutMs: 30_000,
        maxRequestBytes: 8 * MiB,
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
    image: { size: 'auto', quality: 'auto', format: 'png', background: 'auto', partialImages: 2, outputDir: '.', transport: null },
    webSearch: { contextSize: null },       // null → { type: "web_search" }. low | medium | high adds search_context_size
    compaction: { auto: false, afterInputTokens: 200_000 },
    /**
     * Per-role model settings. Every field is optional and falls back to roles.default, then to the
     * top-level settings (model, reasoning.effort, …). Roles:
     *   default    — ask / chat / single-agent run
     *   planner    — understands the task, writes the plan (senior model)
     *   collector  — gathers context from files for the others (cheap model, read-only tools)
     *   worker     — executes plan steps that are not code generation
     *   coder      — writes code; model and effort follow plan complexity unless config pins them
     *   writer     — writes documents, reports, and Markdown; stays on the cheaper model, effort follows complexity
     *   reviewer   — verifies the result (read-only tools, may run tests)
     *   coordinator — reads the plan, progress, findings, and recent diff after every stage and decides what to do next
     *   vision     — describes images; model and effort follow the long side, unless config pins them
     *   summarizer — compaction, file summaries, memory extraction (cheapest model)
     *   solver     — solves a step from the screen or an image; model and effort follow step complexity
     *   clicker    — clicks one UI target
     *   typer      — types into a named UI field
     *   encoder    — returns a batch for later execution
     *   tester     — checks whether the step result is true
     */
    roles: {
        default: { model: null, effort: null, summary: null, verbosity: null, maxOutputTokens: null, temperature: null, instructions: null },
        planner: { model: null, effort: 'high', summary: null, verbosity: null, maxOutputTokens: null, temperature: null, instructions: null },
        collector: { model: null, effort: 'low', summary: null, verbosity: null, maxOutputTokens: null, temperature: null, instructions: null },
        worker: { model: null, effort: 'medium', summary: null, verbosity: null, maxOutputTokens: null, temperature: null, instructions: null },
        coder: { model: null, effort: null, summary: null, verbosity: null, maxOutputTokens: null, temperature: null, instructions: null },
        writer: { model: null, effort: null, summary: null, verbosity: null, maxOutputTokens: null, temperature: null, instructions: null },
        reviewer: { model: null, effort: 'medium', summary: null, verbosity: null, maxOutputTokens: null, temperature: null, instructions: null },
        coordinator: { model: null, effort: 'high', summary: null, verbosity: null, maxOutputTokens: null, temperature: null, instructions: null },
        vision: { model: null, effort: null, summary: null, verbosity: null, maxOutputTokens: null, temperature: null, instructions: null },
        summarizer: { model: null, effort: 'low', summary: 'none', verbosity: 'low', maxOutputTokens: null, temperature: null, instructions: null },
        solver: { model: null, effort: null, summary: null, verbosity: null, maxOutputTokens: null, temperature: null, instructions: null },
        clicker: { model: null, effort: 'low', summary: null, verbosity: null, maxOutputTokens: null, temperature: null, instructions: null },
        typer: { model: null, effort: 'low', summary: null, verbosity: null, maxOutputTokens: null, temperature: null, instructions: null },
        encoder: { model: null, effort: 'medium', summary: null, verbosity: null, maxOutputTokens: null, temperature: null, instructions: null },
        tester: { model: null, effort: 'medium', summary: null, verbosity: null, maxOutputTokens: null, temperature: null, instructions: null },
        classifier: { model: null, effort: 'low', summary: null, verbosity: null, maxOutputTokens: null, temperature: null, instructions: null },
    },
    /** Multi-role orchestration used by `ai run`. */
    agent: {
        mode: 'team',                   // team (planner → collector → worker → reviewer) | single (one model, one loop)
        maxSteps: 12,                   // plan steps accepted from the planner
        maxReviewRounds: 2,             // reviewer → worker fix cycles
        collectorMaxTurns: 12,
        workerMaxTurnsPerStep: 25,
        reviewerMaxTurns: 10,
        maxContextBytes: 96 * KiB,      // rendered shared context per request
        visionDelegate: 'auto',         // auto (when roles.vision has its own model) | always | never
        chain: true,                    // first answer, then encoder or planner
        route: null,                    // null | encoder | planner; null lets the answer and the heuristic choose
        encode: 'encoder',              // encoder (file-command model) | mcp (this process hosts the encode server)
        resume: true,                   // continue the newest unfinished step and its saved turn
        /**
         * The coordinator reads the plan, progress, findings, and the recent diff after a stage
         * and returns plan updates plus guidance for the next worker turn. It is off by default
         * because it adds a senior-model request per stage. maxContextBytes is its context budget
         * (~1M tokens at 4 MiB); the configured model must support that window.
         */
        coordinator: {
            enabled: false,
            after: ['plan', 'collect', 'work', 'review', 'fix'],
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
     * Project generation (`ai gen`). Fidelity is a target, not a measured score.
     * platform selects the frozen web-platform profile (Chrome 157 Beta, flags off).
     */
    generate: {
        fidelity: 87,
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
     */
    decisions: {
        model: 'openai/gpt-6-luna-decisions',
        reviewAt: 0.5,
        blockAt: 0.9,
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
    },
    /** Prices in USD per 1M tokens, e.g. { "gpt-6.1-sol": { "input": 1.25, "cachedInput": 0.125, "output": 10 } }. */
    prices: {},
    home: null,
});

export const ROLE_NAMES = Object.keys(defaults.roles);
