/**
 * @file src/agent/tool-specs.js
 * @module agent/tool-specs
 * @purpose JSON schemas and enablement rules for the local function tools.
 * @depends agent/desktop
 * @usedBy agent/tools
 * @exports TOOL_SPECS, READ_ONLY_TOOLS, toolDefinitions, enabledToolNames, describeTool, toolCategory
 * @ai.tags tools, schema
 * @ai.hint pure
 * @changed 2026-10-15 Split from agent/tools.js so the runtime file can stay smaller.
 */
import { DESKTOP_TOOL_NAMES } from './desktop.js';

/**
 * String field for a strict tool schema.
 * @param {string} description
 * @returns {object}
 * @ai.hint pure
 */
const str = (description) => ({ type: 'string', description });
/**
 * Integer field that may be null.
 * @param {string} description
 * @returns {object}
 * @ai.hint pure
 */
const nullableInt = (description) => ({ type: ['integer', 'null'], description });
/**
 * String field that may be null.
 * @param {string} description
 * @returns {object}
 * @ai.hint pure
 */
const nullableStr = (description) => ({ type: ['string', 'null'], description });
/**
 * Boolean field for a strict tool schema.
 * @param {string} description
 * @returns {object}
 * @ai.hint pure
 */
const bool = (description) => ({ type: 'boolean', description });
/**
 * Strict object schema: every property is required and extras are rejected.
 * Each entry in `TOOL_SPECS` builds its parameters with this.
 * @param {object} properties
 * @returns {object}
 * @ai.hint pure
 */
const schema = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

/**
 * Local tools exposed to the model as strict function tools.
 * Categories drive the approval policy: read | write | exec | network | user.
 */
export const TOOL_SPECS = {
    list_files: {
        category: 'read', group: 'fs',
        description: 'List files and directories under a path of the working directory (noisy folders like node_modules/.git are skipped).',
        parameters: schema({
            path: str('Directory path relative to the working directory; "." for the root.'),
            depth: nullableInt('How many levels deep to list (1-6). Default 2.'),
            include_hidden: bool('Include dot-files and dot-directories.'),
        }),
    },
    read_file: {
        category: 'read', group: 'fs',
        description: 'Read a UTF-8 text file. Returns numbered lines ("N| text"). Use start_line/end_line for big files.',
        parameters: schema({
            path: str('File path relative to the working directory.'),
            start_line: nullableInt('First line to return (1-based). Null = from the beginning.'),
            end_line: nullableInt('Last line to return (inclusive). Null = to the end (bounded by a size limit).'),
        }),
    },
    search_files: {
        category: 'read', group: 'fs',
        description: 'Search text files for a literal string (or a regular expression) using the project map when .ai/map.json is present. Returns "path:line: text" matches.',
        parameters: schema({
            query: str('Literal text (case-insensitive) or a JavaScript regular expression when regex=true.'),
            path: nullableStr('Directory to search in, relative to the working directory. Null = whole working directory.'),
            regex: bool('Interpret query as a regular expression.'),
            scope: { type: 'string', enum: ['path', 'symbol', 'content', 'all'], description: 'path and symbol read the map only. content reads file text. all (use this unless a narrower scope is enough) returns path, then symbol, then content.' },
        }),
    },
    write_file: {
        category: 'write', group: 'fs',
        description: 'Create or overwrite a UTF-8 text file with the full content. Parent directories are created. Overwritten files are backed up.',
        parameters: schema({
            path: str('File path relative to the working directory.'),
            content: str('Complete new content of the file.'),
            overwrite: bool('Allow replacing an existing file. Use false when creating a file that must not exist yet.'),
        }),
    },
    replace_text: {
        category: 'write', group: 'fs',
        description: 'Edit a text file by replacing an exact fragment. The fragment must match exactly once unless all=true. Prefer this over write_file for small edits.',
        parameters: schema({
            path: str('File path relative to the working directory.'),
            search: str('Exact text to find (include enough surrounding lines to be unique). Must be copied verbatim from read_file output without the line-number prefix.'),
            replacement: str('Replacement text.'),
            all: bool('Replace every occurrence instead of requiring a unique match.'),
        }),
    },
    delete_file: {
        category: 'write', group: 'fs',
        description: 'Delete a single file (a backup copy is kept). Directories cannot be deleted.',
        parameters: schema({ path: str('File path relative to the working directory.') }),
    },
    make_dir: {
        category: 'write', group: 'fs',
        description: 'Create a directory (recursively).',
        parameters: schema({ path: str('Directory path relative to the working directory.') }),
    },
    run_command: {
        category: 'exec', group: 'shell',
        description: 'Run a shell command in the working directory (cmd.exe on Windows, /bin/sh elsewhere) and return exit code with captured stdout/stderr. Non-interactive only; output is truncated to a size limit.',
        parameters: schema({
            command: str('The command line to execute.'),
            cwd: nullableStr('Subdirectory (relative to the working directory) to run in. Null = working directory.'),
            timeout_seconds: nullableInt('Time limit in seconds (max 900). Null = default.'),
            reason: str('One sentence: why this command is needed (shown to the user for approval).'),
        }),
    },
    fetch_url: {
        category: 'network', group: 'fetch',
        description: 'Download a public http(s) URL and return its text (HTML is reduced to readable text). Use for documentation or APIs; size-limited.',
        parameters: schema({
            url: str('Absolute http(s) URL.'),
            max_bytes: nullableInt('Maximum number of bytes to return (default and cap: configured limit).'),
        }),
    },
    view_image: {
        category: 'read', group: 'fs',
        description: 'Look at a local image file (PNG/JPEG/GIF/WebP). Either the image is attached to the conversation, or a dedicated vision model describes it and answers your question.',
        parameters: schema({
            path: str('Image file path relative to the working directory.'),
            detail: { type: 'string', enum: ['auto', 'low', 'high'], description: 'Image detail level to use.' },
            question: nullableStr('What exactly you need to learn from the image (used when a vision model describes it). Null = general detailed description.'),
        }),
    },
    summarize_file: {
        category: 'read', group: 'summarize',
        description: 'Have a cheap model read a (possibly large) text file and return a focused summary: purpose, structure, key symbols, and anything relevant to the focus. Cached per file content.',
        parameters: schema({
            path: str('File path relative to the working directory.'),
            focus: nullableStr('What the summary should concentrate on. Null = general overview.'),
        }),
    },
    recall: {
        category: 'memory', group: 'memory',
        description: 'Search long-term memory (facts, conventions, decisions, pitfalls remembered from earlier sessions in this project and globally).',
        parameters: schema({ query: str('Keywords or a question to search for.') }),
    },
    remember: {
        category: 'memory', group: 'memory',
        description: 'Save a durable fact to long-term memory for future sessions (project conventions, decisions, environment quirks, user preferences). Keep it short and specific.',
        parameters: schema({
            content: str('One or two sentences to remember.'),
            kind: { type: 'string', enum: ['fact', 'convention', 'decision', 'preference', 'pitfall', 'note'], description: 'Type of the memory.' },
            scope: { type: 'string', enum: ['project', 'global'], description: 'project = only this working directory; global = everywhere.' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Short tags for retrieval.' },
        }),
    },
    ask_user: {
        category: 'user', group: 'user',
        description: 'Ask the human operator a short clarifying question and wait for the answer. Only available in interactive sessions; otherwise returns a note to proceed autonomously.',
        parameters: schema({ question: str('The question to ask.') }),
    },
    screenshot: {
        category: 'exec', group: 'desktop',
        description: 'Capture the Windows screen. The result includes the relative PNG path under .ai/desktop. When screen vision is available, a TOON description is appended.',
        parameters: schema({}),
    },
    click: {
        category: 'exec', group: 'desktop',
        description: 'Click once. mode is coord (integer x and y), title (window title), control (title and control), or image (a path inside the working directory). Unused strings are "" and unused integers are null.',
        parameters: schema({
            mode: { type: 'string', enum: ['coord', 'title', 'control', 'image'], description: 'coord, title, control, or image.' },
            x: nullableInt('Pixel x for coord, or an offset for title. Null when unused.'),
            y: nullableInt('Pixel y for coord, or an offset for title. Null when unused.'),
            button: str('left, right, or middle. Empty string means left.'),
            clicks: nullableInt('1 or 2. Null means 1.'),
            title: str('Window title. Empty string when unused.'),
            control: str('Control name. Empty string when unused.'),
            image: str('Image path relative to the working directory for ImageSearch. Empty string when unused.'),
        }),
    },
    type: {
        category: 'exec', group: 'desktop',
        description: 'Type into the focused control. mode text sends literal characters; mode keys sends an AutoHotkey key string.',
        parameters: schema({
            mode: { type: 'string', enum: ['text', 'keys'], description: 'text (literal) or keys (AutoHotkey Send).' },
            text: str('Literal text or an AutoHotkey key string such as ^s.'),
        }),
    },
    run_ahk: {
        category: 'exec', group: 'desktop',
        description: 'Run AutoHotkey v2 statements (not a whole program). The runner wraps them and can capture the screen afterward.',
        parameters: schema({
            script: str('AutoHotkey v2 statements to run inside the wrapper.'),
        }),
    },
    run_batch: {
        category: 'exec', group: 'desktop',
        description: 'Run a desktop batch. Set exactly one of batch_json, batch_toon, or path (a file inside the working directory). Each action is approved on its own.',
        parameters: schema({
            batch_json: str('JSON batch document. Empty string when unused.'),
            batch_toon: str('TOON batch document. Empty string when unused.'),
            path: str('Batch file path relative to the working directory. Empty string when unused.'),
        }),
    },
    delegate_role: {
        category: 'read', group: 'desktop',
        description: 'Send one task to a specialist and return its answer. encoder returns a batch and does not run it; pass that batch to run_batch.',
        parameters: schema({
            role: { type: 'string', enum: ['scanner', 'solver', 'clicker', 'typer', 'encoder', 'tester'], description: 'Specialist to call.' },
            task: str('One task for that specialist.'),
        }),
    },
};

export const READ_ONLY_TOOLS = ['list_files', 'read_file', 'search_files', 'view_image', 'summarize_file', 'recall'];

/**
 * Strict function-tool definitions for names that exist in `TOOL_SPECS`.
 * `createToolset` returns these from `definitions()`.
 * @param {string[]} names
 * @returns {object[]}
 * @exports
 * @ai.hint pure
 */
export function toolDefinitions(names) {
    return names.filter((name) => TOOL_SPECS[name]).map((name) => ({
        type: 'function', name, description: TOOL_SPECS[name].description, parameters: TOOL_SPECS[name].parameters, strict: true,
    }));
}

/** Which tools are enabled for a config.tools selection. */
export function enabledToolNames(tools, { interactive = false, memory = false, summarize = false } = {}) {
    const names = [];
    if (tools.fs) names.push('list_files', 'read_file', 'search_files', 'write_file', 'replace_text', 'delete_file', 'make_dir', 'view_image');
    if (tools.fs && summarize) names.push('summarize_file');
    if (tools.shell) names.push('run_command');
    if (tools.fetch) names.push('fetch_url');
    if (tools.desktop) names.push(...DESKTOP_TOOL_NAMES);
    if (memory) names.push('recall', 'remember');
    if (tools.askUser && interactive) names.push('ask_user');
    return names;
}

/**
 * Description shown to the model, or an empty string when `name` is unknown.
 * @param {string} name
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export const describeTool = (name) => TOOL_SPECS[name]?.description ?? '';
/**
 * Approval category for `name`, or null when the tool is unknown.
 * @param {string} name
 * @returns {string | null}
 * @exports
 * @ai.hint pure
 */
export const toolCategory = (name) => TOOL_SPECS[name]?.category ?? null;
