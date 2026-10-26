/**
 * @file src/agent/tool-specs.js
 * @module agent/tool-specs
 * @purpose JSON schemas and enablement rules for the local function tools.
 * @depends agent/desktop
 * @usedBy agent/tools
 * @exports TOOL_SPECS, READ_ONLY_TOOLS, SHELL_TOOL_NAMES, IMAGE_TOOL_NAMES, toolDefinitions, enabledToolNames, describeTool, toolCategory
 * @ai.tags tools, schema
 * @ai.hint pure
 * @changed 2026-10-25 run_subagent (tools.subagents). Image splitting, cropping, SVG generation, fonts, and icon sets.
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
        description: 'List files and directories under a path of the working directory (noisy folders like node_modules/.git are skipped). A path that does not exist yet returns the nearest existing parent instead of an error; write_file creates the missing parents.',
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
    list_backups: {
        category: 'read', group: 'fs',
        description: 'List project snapshots in .backup. Each record is the file contents from before that slot changed it. Pass path to see one file, or null for the latest records.',
        parameters: schema({
            path: nullableStr('Project file path. Null lists the latest snapshots in the project.'),
        }),
    },
    restore_backup: {
        category: 'write', group: 'fs',
        description: 'Restore a file from a .backup snapshot id. The current contents are snapshotted first. Use this when a step or turn lost a good version, instead of regenerating the file.',
        parameters: schema({
            id: str('Snapshot id from list_backups, such as b001.'),
            path: nullableStr('Expected project path. Null accepts the path stored on the snapshot.'),
        }),
    },
    make_dir: {
        category: 'write', group: 'fs',
        description: 'Create a directory (recursively).',
        parameters: schema({ path: str('Directory path relative to the working directory.') }),
    },
    structure_file: {
        category: 'write', group: 'fs',
        description: 'Restructure a source file or the selected range of an opened file. tasks: sort-imports, sort-rules, sort-properties, group-properties, group-selectors, layers, clean, dedupe, merge, sort-lines (comma-separated; empty = language default). rules_json holds import order, property groups, and layer patterns. prompt is an extra instruction for the model. SCSS/CSS and TS/JS are built in; other languages use clean, sort-lines, and prompt.',
        parameters: schema({
            path: str('File path relative to the working directory.'),
            language: str('Language id such as scss or ts. Empty string uses the file extension.'),
            tasks: str('Comma-separated task names. Empty string uses the language default.'),
            rules_json: str('JSON object: importOrder, internalPrefixes, propertyGroups, layers, layerMatch. Empty string uses defaults.'),
            prompt: str('Extra instruction for a user-defined change. Empty string skips the model.'),
            selection_start_line: nullableInt('0-based start line of an inline edit. Null = the whole file.'),
            selection_start_character: nullableInt('0-based start character. Null = 0 when a start line is set.'),
            selection_end_line: nullableInt('0-based end line. Null = the whole file.'),
            selection_end_character: nullableInt('0-based end character. Null = 0.'),
            write: bool('True writes the file. False returns the restructured text only.'),
            reason: str('One sentence shown when approval is required.'),
        }),
    },
    run_command: {
        category: 'exec', group: 'shell',
        description: 'Run one command in the working directory and return the exit code with captured stdout/stderr. Set shell to cmd, powershell, pwsh, bash, sh, or zsh; an empty shell uses the configured default (cmd.exe on Windows, /bin/sh elsewhere). Non-interactive only; output is truncated. The command must exit: do not use this for dev or preview servers, which run until stopped.',
        parameters: schema({
            command: str('The command line to execute.'),
            shell: { type: 'string', enum: ['', 'powershell', 'pwsh', 'cmd', 'bash', 'sh', 'zsh'], description: 'Interpreter for this command. Empty string = configured default.' },
            cwd: nullableStr('Subdirectory (relative to the working directory) to run in. Null = working directory.'),
            timeout_seconds: nullableInt('Time limit in seconds (max 900). Null = default.'),
            reason: str('One sentence: why this command is needed (shown to the user for approval).'),
        }),
    },
    run_script: {
        category: 'exec', group: 'shell',
        description: 'Run a script file inside the working directory. .ps1 uses PowerShell -File, .cmd and .bat use cmd, .sh and .bash use bash. Set shell to override the extension. Arguments are passed as argv, not through a shell string.',
        parameters: schema({
            path: str('Script path relative to the working directory.'),
            args: { type: 'array', items: { type: 'string' }, description: 'Arguments for the script. Empty array when there are none.' },
            shell: { type: 'string', enum: ['', 'powershell', 'pwsh', 'cmd', 'bash', 'sh', 'zsh'], description: 'Override the interpreter. Empty string = choose from the file extension.' },
            cwd: nullableStr('Subdirectory to run in. Null = the script\'s directory is not changed; the working directory is used.'),
            timeout_seconds: nullableInt('Time limit in seconds (max 900). Null = default.'),
            reason: str('One sentence: why this script is needed (shown to the user for approval).'),
        }),
    },
    ssh: {
        category: 'exec', group: 'shell',
        description: 'Run a remote command or copy one file with the system ssh and scp clients. mode exec runs command, or sends a local .ps1/.sh/.bash file to the remote interpreter on stdin when command is empty. mode put uploads local_path to remote_path. mode get downloads remote_path into local_path. BatchMode is on, so a password prompt cannot be answered; use a key or agent. An empty identity uses the default ssh key. Paths stay inside the working directory.',
        parameters: schema({
            host: str('Hostname or user@host. No spaces and no leading dash.'),
            command: str('Remote command for mode exec. Empty string when running a script file or copying.'),
            mode: { type: 'string', enum: ['exec', 'put', 'get'], description: 'exec runs a command or script. put uploads a file. get downloads a file.' },
            local_path: str('Workspace file. Empty string when unused.'),
            remote_path: str('Path on the remote host. Empty string when unused.'),
            shell: { type: 'string', enum: ['', 'powershell', 'pwsh', 'bash', 'sh', 'zsh'], description: 'Remote interpreter when exec sends a script file. Empty string = choose from the extension.' },
            port: nullableInt('TCP port. Null = 22.'),
            identity: str('Private key path relative to the working directory. Empty string = the default ssh identity.'),
            timeout_seconds: nullableInt('Time limit in seconds (max 900). Null = default.'),
            reason: str('One sentence: why this SSH call is needed (shown to the user for approval).'),
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
    generate_image: {
        category: 'write', group: 'images',
        description: 'Draw a new image and save it in the working directory. Use this for artwork that does not exist yet. When reference is set, the source image is sent directly to the generator (not only a text description) for higher visual fidelity. Ready measurement crops from .tmp/<id>/crops/ can be passed as reference, so the worker does not crop the same region again. Transparency: with background=transparent a gpt-image model that supports alpha is asked to draw the real alpha channel itself; when the reply still comes back solid or with a painted checkerboard, the background is first filled with the subject color and an anti-aliased grayscale matte is drawn from the clean source and merged as alpha (contour matte and corner fill stay as local fallbacks). The matte is always built from the clean source — the reference or the pre-processed original — never from a picture that already has a fake alpha plate, and never from the painted picture itself.',
        parameters: schema({
            prompt: str('What to draw or how the reference should look after regeneration. Describe style and composition; do not repeat pixel-level details the image already carries.'),
            path: str('Relative output path such as assets/portrait.png. Empty string lets the tool choose a name.'),
            size: str('WIDTHxHEIGHT. Supported frames: 1024x1024, 1024x1536 (portrait), 1536x1024 (landscape). Other sizes snap to the nearest frame. Empty string uses the server default.'),
            quality: str('low, medium, high, or an empty string for the server default. Ignored when reference is set.'),
            reference: str('Relative path to a reference image (e.g. .ai/refs/abc.png or a ready crop from .tmp/<id>/crops/*.png). The generator conditions on this image, and the same file is the RGB base for the alpha channel. Empty string = pure text-to-image.'),
            extra_images: str('JSON array of additional reference paths sent with reference, e.g. ["assets/ref1.png",".tmp/<id>/crops/icon.png"]. Empty string = none.'),
            background: str('transparent, opaque, or an empty string for image.background. transparent asks the model for real alpha and falls back to the matte pipeline.'),
            to_svg: bool('True for a flat mark (logo, badge, icon): the tool answers with the vectorize_image call to make right after this one.'),
        }),
    },
    edit_image: {
        category: 'write', group: 'images',
        description: 'Edit an existing image with POST /images/edits and save the result. Use this to restyle or extract a region of a reference file. extra_images sends more reference pictures together with the source image. Transparency works as in generate_image: native alpha is requested where the model supports it, otherwise the background is painted with the subject color and an anti-aliased matte drawn from the source is merged as alpha. The source image stays the RGB base for the matte.',
        parameters: schema({
            prompt: str('How to change the source image.'),
            image: str('Source image path relative to the working directory.'),
            path: str('Relative output path. Empty string lets the tool choose a name.'),
            size: str('WIDTHxHEIGHT. Supported frames: 1024x1024, 1024x1536 (portrait), 1536x1024 (landscape). Other sizes snap to the nearest frame. Empty string uses the server default.'),
            extra_images: str('JSON array of additional reference image paths, e.g. ["assets/ref1.png",".ai/refs/abc.png"]. Empty string = none.'),
            background: str('transparent, opaque, or an empty string for image.background.'),
            to_svg: bool('True for a flat mark (logo, badge, icon): the tool answers with the vectorize_image call to make right after this one.'),
        }),
    },
    delegate_role: {
        category: 'read', group: 'desktop',
        description: 'Send one task to another role and return its answer. Unlike run_subagent it may carry the shared context of this run with the task (context=true), so the role does not have to rediscover what this run already knows. encoder returns a batch and does not run it; pass that batch to run_batch. measurer re-measures a crop or a layer and returns its measurement sheet. User-defined roles from roles.<name> are accepted too.',
        parameters: schema({
            role: { type: 'string', enum: ['solver', 'clicker', 'typer', 'encoder', 'tester', 'measurer'], description: 'Role to call: a built-in executor or a name from roles.<name>.' },
            task: str('One task for that role. Say what to return; a self-contained task is still better.'),
            context: bool('True includes the shared context of this run (task, plan, progress, findings, diff) with the task. False sends the task alone, like run_subagent.'),
        }),
    },
    decide: {
        category: 'network', group: 'channels',
        description: 'Ask a decision model (POST /decisions, default openai/gpt-6-luna-decisions). Returns probabilities, not prose. questions_json is a Decisions questions object; empty string uses preset (community, support, smm, guard, route).',
        parameters: schema({
            state_json: str('JSON value: string, object, or array. The data the questions are about.'),
            questions_json: str('JSON object of questions. Empty string uses preset.'),
            preset: { type: 'string', enum: ['', 'community', 'support', 'smm', 'guard', 'route'], description: 'Built-in question pack. Empty string uses the configured preset when questions_json is empty.' },
            model: str('Decision model id. Empty string uses decisions.model.'),
        }),
    },
    moderate_text: {
        category: 'network', group: 'channels',
        description: 'Moderate one chat message. mode auto tries omni-moderation-latest and falls back to the decisions preset when /moderations is missing. Returns action allow, review, or hide.',
        parameters: schema({
            text: str('Message text.'),
            preset: { type: 'string', enum: ['community', 'support', 'smm', 'guard', 'route'], description: 'community for groups, support for customers, smm for posts, guard for injection, route for encode versus plan.' },
        }),
    },
    channel_reply: {
        category: 'network', group: 'channels',
        description: 'Draft one reply: support for a customer, community for a group, or smm for a post. Does not send it.',
        parameters: schema({
            purpose: { type: 'string', enum: ['support', 'smm', 'community'], description: 'Who the draft is for.' },
            text: str('The message to answer or the notes for a post.'),
            context: str('Extra facts the draft may use. Empty string if none. Do not invent facts that are not here.'),
        }),
    },
    telegram_call: {
        category: 'network', group: 'channels',
        description: 'Call one Telegram Bot API method. args_json is the method body (chat_id, text, message_id, user_id, permissions). Methods: getMe, getChat, sendMessage, deleteMessage, getUpdates, banChatMember, restrictChatMember.',
        parameters: schema({
            method: { type: 'string', enum: ['getMe', 'getChat', 'sendMessage', 'deleteMessage', 'getUpdates', 'banChatMember', 'restrictChatMember'], description: 'Bot API method.' },
            args_json: str('JSON object for the method. Empty string means {}.'),
        }),
    },
    split_image: {
        category: 'write', group: 'images',
        description: 'Split an image into a rows×cols grid with ImageMagick (magick or convert). Returns each tile path, its pixel size, and its x/y offset, so a tile can be cropped further or read with view_image. Requires ImageMagick.',
        parameters: schema({
            path: str('Image file path relative to the working directory.'),
            rows: nullableInt('Number of rows. Null = 1.'),
            cols: nullableInt('Number of columns. Null = 1.'),
            output: str('Output directory. Empty string = .tmp/split-<timestamp>.'),
            reason: str('One sentence: why this split is needed (shown to the user for approval).'),
        }),
    },
    crop_image: {
        category: 'write', group: 'images',
        description: 'Crop an image with ImageMagick (magick or convert) and return the cropped image path. Two modes: a given box (x, y, width, height), or trim=true which cuts the uniform-color/transparent padding off all four edges. Removing padding is always a crop_image call with trim=true — there is no separate trim tool. Requires ImageMagick.',
        parameters: schema({
            path: str('Source image path relative to the working directory.'),
            x: nullableInt('X coordinate of the crop region (0-based). Null = 0. Unused when trim is true.'),
            y: nullableInt('Y coordinate of the crop region (0-based). Null = 0. Unused when trim is true.'),
            width: nullableInt('Width of the crop region. Required and greater than zero unless trim is true.'),
            height: nullableInt('Height of the crop region. Required and greater than zero unless trim is true.'),
            trim: bool('True = cut the uniform-color/transparent padding from the edges of the whole image; width and height may be null. False = cut the box given by x/y/width/height.'),
            output: str('Output path. Empty string = .tmp/crop-<timestamp>.png.'),
            reason: str('One sentence: why this crop is needed (shown to the user for approval).'),
        }),
    },
    generate_svg: {
        category: 'write', group: 'images',
        description: 'Write an SVG file. Pass complete SVG markup (preferred) or a short text label; the tool completes the document, validates the wrapper, and saves it.',
        parameters: schema({
            prompt: str('SVG markup such as <svg …>…</svg>, or a text label to render in a simple frame.'),
            path: str('Output path such as assets/icon.svg. Empty string lets the tool choose a name.'),
            width: nullableInt('SVG width in pixels. Default 512.'),
            height: nullableInt('SVG height in pixels. Default 512.'),
            reason: str('One sentence: why this SVG is needed (shown to the user for approval).'),
        }),
    },
    vectorize_image: {
        category: 'write', group: 'images',
        description: 'Convert a flat raster (logo, badge, icon, two-tone PNG/WebP) into a real SVG with the vector model (recraft/recraft-v4.1-pro-vector). A flat background is removed locally first, so the vector keeps transparency. Prefer a ready measurement crop from .tmp/<id>/crops/ as the source; leave image empty to list the crops that are still there and their palette. The vector model follows the prompt closely: name the artwork shapes and colors, or leave prompt empty and the vision role describes the crop first. Square 1:1 logos are the usual case, but a crop of another shape keeps its own frame. Photographs and rich gradients are refused — use generate_image or generate_svg for those.',
        parameters: schema({
            image: str('Source PNG/WebP path relative to the working directory, e.g. a crop from .tmp/<id>/crops/logo.png. Empty string lists the remaining measurement crops instead of converting.'),
            path: str('Output SVG path such as assets/logo.svg. Empty string puts an .svg next to the source (or in assets/).'),
            prompt: str('What the artwork contains: shapes, layout, and colors (e.g. "black ring, white bar, two-tone badge"). Empty string asks the vision role to describe the crop first.'),
            remove_background: bool('Strip a flat background color before converting. False keeps the source pixels as they are.'),
            force: bool('Convert even when the palette looks too rich for a vector (a photo or a heavy gradient).'),
            reason: str('One sentence: why this image must become a vector (shown to the user for approval).'),
        }),
    },
    download_font: {
        category: 'write', group: 'assets',
        description: 'Download a font file (TTF/OTF/WOFF/WOFF2) from Google Fonts by family name, or from a direct http(s) URL. Saves under fonts/.',
        parameters: schema({
            name: str('Font family (e.g. "Inter", "Roboto", "Fira Code"). Empty when url is given.'),
            style: str('Style or weight: Regular (default), Bold, Italic, Light, or 100..900.'),
            url: nullableStr('Direct http(s) download URL. Overrides name and style.'),
            output: str('Relative output path. Empty string = fonts/<family>-<weight>[italic].<ext>.'),
        }),
    },
    download_icons: {
        category: 'write', group: 'assets',
        description: 'Download one icon or a common subset of an icon set (phosphor, lucide) as SVG files from a public CDN. Use a CDN link in the page instead when the icons do not need to be local.',
        parameters: schema({
            name: str('Icon set name: "phosphor" or "lucide". Required.'),
            icon: nullableStr('One icon name (e.g. "house", "user"). Null = download the common subset.'),
            variant: { type: 'string', enum: ['thin', 'light', 'regular', 'bold', 'duotone', 'fill'], description: 'Phosphor variant. Use regular for the default.' },
            output: str('Output directory. Empty string = assets/icons/<set>/.'),
        }),
    },
    run_subagent: {
        category: 'read', group: 'subagents',
        description: 'Start one sub-agent: a separate agent on a fresh context, with its own tools and turn cap, that works on the task and returns a report. It never sees this conversation, so the task must be self-contained — name the paths, the exact question, and what the report must contain. coder, worker, and writer change files; reviewer and tester only check and report; vision describes image files; solver answers from the screen or an image; image-processor prepares assets; measurer returns a measurement sheet. A sub-agent cannot start another sub-agent, and it can only write or run commands the caller itself is allowed to. Use delegate_role instead when the role should see this run’s context.',
        parameters: schema({
            kind: { type: 'string', enum: ['coder', 'worker', 'writer', 'reviewer', 'tester', 'vision', 'solver', 'image-processor'], description: 'Sub-agent to start; the name is also the role whose prompt and model are used.' },
            task: str('The whole task for that sub-agent: goal, paths, constraints, and the report it must return.'),
        }),
    },
};

export const READ_ONLY_TOOLS = ['list_files', 'read_file', 'search_files', 'view_image', 'summarize_file', 'recall', 'list_backups'];

/** Shell tools enabled together by tools.shell. Orchestrator may run these during coordination; collector context-report uses read-only tools only. */
export const SHELL_TOOL_NAMES = ['run_command', 'run_script', 'ssh'];

/** Image and asset tools of the image-processor role and sub-agent. */
export const IMAGE_TOOL_NAMES = ['view_image', 'crop_image', 'split_image', 'generate_image', 'edit_image', 'vectorize_image', 'generate_svg', 'download_font', 'download_icons'];

/**
 * Strict function-tool definitions for names that exist in `TOOL_SPECS`.
 * `createToolset` returns these from `definitions()`.
 * `enums` narrows one field of one tool to the values a configuration actually offers,
 * for example the role list of `delegate_role` once user-defined roles are known.
 * @param {string[]} names
 * @param {object} [enums] `{ toolName: { fieldName: string[] } }`
 * @returns {object[]}
 * @exports
 * @ai.hint pure
 */
export function toolDefinitions(names, enums = {}) {
    return names.filter((name) => TOOL_SPECS[name]).map((name) => {
        const spec = TOOL_SPECS[name];
        const fields = enums?.[name];
        const parameters = fields
            ? {
                ...spec.parameters,
                properties: Object.fromEntries(Object.entries(spec.parameters.properties).map(([key, value]) => [
                    key, Array.isArray(fields[key]) && fields[key].length ? { ...value, enum: [...fields[key]] } : value,
                ])),
            }
            : spec.parameters;
        return { type: 'function', name, description: spec.description, parameters, strict: true };
    });
}

/** Which tools are enabled for a config.tools selection. */
export function enabledToolNames(tools, { interactive = false, memory = false, summarize = false, imageApi = false, unsafeScreenshot = false, images = true } = {}) {
    const names = [];
    if (tools.fs) names.push('list_files', 'read_file', 'search_files', 'write_file', 'replace_text', 'delete_file', 'make_dir', 'view_image', 'structure_file', 'list_backups', 'restore_backup');
    if (tools.fs && summarize) names.push('summarize_file');
    if (tools.shell) names.push(...SHELL_TOOL_NAMES);
    if (tools.fetch) names.push('fetch_url');
    if (tools.desktop) names.push(...DESKTOP_TOOL_NAMES.filter((name) => name !== 'screenshot' || unsafeScreenshot));
    if (memory) names.push('recall', 'remember');
    if (tools.askUser && interactive) names.push('ask_user');
    if (tools.images && imageApi) names.push('generate_image', 'edit_image', 'vectorize_image');
    if (tools.images && images) names.push('split_image', 'crop_image', 'generate_svg');
    if (tools.fetch) names.push('download_font', 'download_icons');
    if (tools.channels) names.push('decide', 'moderate_text', 'channel_reply', 'telegram_call');
    if (tools.subagents) names.push('run_subagent', 'delegate_role');
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
