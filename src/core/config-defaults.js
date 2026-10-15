/**
 * @file src/core/config-defaults.js
 * @module core/config-defaults
 * @purpose Frozen default configuration and the enums that validate it.
 * @usedBy core/config, commands/flags
 * @exports defaults, ROLE_NAMES, REASONING_EFFORTS, REASONING_SUMMARIES, APPROVAL_LEVELS, IMAGE_DETAILS
 * @ai.tags config
 * @ai.hint pure
 * @changed 2026-10-15 Generation defaults and MCP server list.
 */
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
    model: 'gpt-6.1-sol',
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
    retries: 2,
    approve: null,                    // ask | read | write | all; null → ask (TTY) or read (no TTY)
    shell: null,                      // run_command shell: null (cmd.exe / sh) | powershell | pwsh | bash | sh | zsh | cmd
    tools: { fs: true, shell: true, fetch: true, web: false, images: false, askUser: true, desktop: false, mcp: true },
    /** Windows screen, mouse, keyboard, and AutoHotkey v2. Tools stay off until tools.desktop is true. */
    desktop: { ahkPath: null, shotAfterAction: true },
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
    webSearch: { contextSize: 'medium' },
    compaction: { auto: false, afterInputTokens: 200_000 },
    /**
     * Per-role model settings. Every field is optional and falls back to roles.default, then to the
     * top-level settings (model, reasoning.effort, …). Roles:
     *   default    — ask / chat / single-agent run
     *   planner    — understands the task, writes the plan (senior model)
     *   collector  — gathers context from files for the others (cheap model, read-only tools)
     *   worker     — executes plan steps: generates the tool calls (JSON for the local executor)
     *   reviewer   — verifies the result (read-only tools, may run tests)
     *   vision     — describes images for other roles (view_image delegation)
     *   summarizer — compaction, file summaries, memory extraction (cheapest model)
     *   scanner    — decides what to capture; may return coordinates
     *   solver     — solves the step, including math and captchas
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
        reviewer: { model: null, effort: 'medium', summary: null, verbosity: null, maxOutputTokens: null, temperature: null, instructions: null },
        vision: { model: null, effort: 'low', summary: null, verbosity: null, maxOutputTokens: null, temperature: null, instructions: null },
        summarizer: { model: null, effort: 'low', summary: 'none', verbosity: 'low', maxOutputTokens: null, temperature: null, instructions: null },
        scanner: { model: null, effort: 'low', summary: null, verbosity: null, maxOutputTokens: null, temperature: null, instructions: null },
        solver: { model: null, effort: 'high', summary: null, verbosity: null, maxOutputTokens: null, temperature: null, instructions: null },
        clicker: { model: null, effort: 'low', summary: null, verbosity: null, maxOutputTokens: null, temperature: null, instructions: null },
        typer: { model: null, effort: 'low', summary: null, verbosity: null, maxOutputTokens: null, temperature: null, instructions: null },
        encoder: { model: null, effort: 'medium', summary: null, verbosity: null, maxOutputTokens: null, temperature: null, instructions: null },
        tester: { model: null, effort: 'medium', summary: null, verbosity: null, maxOutputTokens: null, temperature: null, instructions: null },
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
    /** User MCP servers. stdio only. An empty list leaves tools.mcp as a no-op. */
    mcp: {
        servers: [],
    },
    /**
     * Inline completion for editors (`ai complete`, HTTP and WebSocket).
     * A fast model and low effort; the file context is shortened, and a line
     * over maxLineBytes (0.5 MiB, typical of base64) is left out.
     */
    completion: {
        model: 'gpt-5.3-codex-spark',
        effort: 'low',
        maxOutputTokens: 160,
        maxLineBytes: 512 * 1024,
        maxContextBytes: 24 * 1024,
        neighborLines: 2,
        token: null,
    },
    /** Prices in USD per 1M tokens, e.g. { "gpt-6.1-sol": { "input": 1.25, "cachedInput": 0.125, "output": 10 } }. */
    prices: {},
    home: null,
});

export const ROLE_NAMES = Object.keys(defaults.roles);
