/**
 * One-shot split of the largest modules. Public import paths stay on the original files.
 */
import { readFile, writeFile } from 'node:fs/promises';

function linesOf(text) {
    const newline = text.endsWith('\n') ? '\n' : '';
    const body = text.endsWith('\n') ? text.slice(0, -1) : text;
    return { rows: body.split('\n'), newline };
}

function join(rows) {
    return `${rows.join('\n')}\n`;
}

function dedent(block, width) {
    const pad = ' '.repeat(width);
    return block.split('\n').map((line) => (line.startsWith(pad) ? line.slice(width) : line)).join('\n');
}

const tools = await readFile('src/agent/tools.js', 'utf8');
const toolRows = linesOf(tools).rows;
const specBody = [...toolRows.slice(12, 208), ...toolRows.slice(503, 505)].join('\n');
const toolSpecs = `/**
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

${specBody}
`;
await writeFile('src/agent/tool-specs.js', toolSpecs.endsWith('\n') ? toolSpecs : `${toolSpecs}\n`);
const toolsNext = [
    ...toolRows.slice(0, 12),
    "import {",
    "    TOOL_SPECS,",
    "    READ_ONLY_TOOLS,",
    "    toolDefinitions,",
    "    enabledToolNames,",
    "    describeTool,",
    "    toolCategory,",
    "} from './tool-specs.js';",
    "export { TOOL_SPECS, READ_ONLY_TOOLS, toolDefinitions, enabledToolNames, describeTool, toolCategory };",
    "",
    ...toolRows.slice(208, 503),
    toolRows[505],
];
await writeFile('src/agent/tools.js', join(toolsNext));

const toonText = await readFile('src/util/toon.js', 'utf8');
const toon = linesOf(toonText).rows;
function statementEnd(rows, start) {
    const first = rows[start];
    if (!first.includes('{') || first.includes('=>')) return start;
    let state = 'code';
    let depth = 0;
    let started = false;
    for (let lineNo = start; lineNo < rows.length; lineNo++) {
        const line = rows[lineNo];
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            const next = line[i + 1];
            if (state === 'line') break;
            if (state === 'block') {
                if (ch === '*' && next === '/') { state = 'code'; i += 1; }
                continue;
            }
            if (state === 'sq' || state === 'dq' || state === 'tpl') {
                if (ch === '\\') { i += 1; continue; }
                if ((state === 'sq' && ch === "'") || (state === 'dq' && ch === '"') || (state === 'tpl' && ch === '`')) state = 'code';
                continue;
            }
            if (ch === '/' && next === '/') { state = 'line'; break; }
            if (ch === '/' && next === '*') { state = 'block'; i += 1; continue; }
            if (ch === "'" || ch === '"' || ch === '`') {
                state = ch === "'" ? 'sq' : ch === '"' ? 'dq' : 'tpl';
                continue;
            }
            if (ch === '{') { depth += 1; started = true; }
            else if (ch === '}') {
                depth -= 1;
                if (started && depth === 0) return lineNo;
            }
        }
        if (state === 'line') state = 'code';
    }
    return start;
}

function extractFunctions(rows, names) {
    const blocks = [];
    const used = new Set();
    for (let i = 0; i < rows.length; i++) {
        const match = /^(?:export )?(?:async )?function ([A-Za-z0-9_]+)|^(?:export )?const ([A-Za-z0-9_]+) =/.exec(rows[i]);
        const name = match?.[1] || match?.[2];
        if (!name || !names.has(name)) continue;
        let from = i;
        while (from > 0 && (rows[from - 1].trim().startsWith('*') || rows[from - 1].trim().startsWith('/**') || rows[from - 1].trim().startsWith('//') || rows[from - 1].trim() === '')) {
            if (rows[from - 1].trim() === '' && from < i) {
                const prev = rows[from - 2] ?? '';
                if (!prev.trim().startsWith('*') && !prev.trim().startsWith('/') && !prev.includes('*/')) break;
            }
            from -= 1;
            if (rows[from].trim() === '' && !(rows[from + 1] || '').trim().startsWith('*') && !(rows[from + 1] || '').includes('*/')) {
                from += 1;
                break;
            }
        }
        const end = statementEnd(rows, i);
        blocks.push(rows.slice(from, end + 1).join('\n').replace(/^\n+/, ''));
        for (let k = from; k <= end; k++) used.add(k);
        i = end;
    }
    return { blocks, used };
}

const sharedSet = new Set(['IDENTIFIER', 'BARE_STRING', 'NUMERIC', 'fail', 'isPlainObject', 'assign']);
const encodeSet = new Set(['encodeKey', 'encodePrimitive', 'assertDense', 'isTabular', 'isPrimitiveCell', 'encodeArray', 'encodeObject', 'encodeToon']);
const decodeSet = new Set(['readJsonString', 'parseBare', 'parsePrimitive', 'parseCells', 'parseFieldList', 'findClosingBrace', 'parseLength', 'parseKey', 'parseHeader', 'isIgnorable', 'lineIndent', 'nextContent', 'blockEnd', 'parseRow', 'parseObject', 'decodeToon', 'decodeDocument']);
const sharedExtract = extractFunctions(toon, sharedSet);
const encodeExtract = extractFunctions(toon, encodeSet);
const decodeExtract = extractFunctions(toon, decodeSet);
const exportBlock = (blocks, names) => blocks.map((block) => {
    if (block.startsWith('export ')) return block;
    return block.replace(/^(function |const )/m, (lead) => {
        const name = /^(?:function |const )([A-Za-z0-9_]+)/.exec(block)?.[1];
        return names.has(name) ? `export ${lead}` : lead;
    });
}).join('\n\n');

await writeFile('src/util/toon-shared.js', `/**
 * @file src/util/toon-shared.js
 * @module util/toon-shared
 * @purpose Shared TOON errors, object checks, and token patterns.
 * @usedBy util/toon-encode, util/toon-decode
 * @exports fail, isPlainObject, assign, IDENTIFIER, BARE_STRING, NUMERIC
 * @ai.tags toon
 * @ai.hint pure
 * @changed 2026-10-15 Split from util/toon.js.
 */
${exportBlock(sharedExtract.blocks, sharedSet)}
`);
await writeFile('src/util/toon-encode.js', `/**
 * @file src/util/toon-encode.js
 * @module util/toon-encode
 * @purpose Encode a plain object as a TOON subset. Nested objects use 2-space indent in the output, not the source indent.
 * @depends util/toon-shared
 * @usedBy util/toon, interact/batch
 * @exports encodeToon
 * @ai.tags toon
 * @ai.hint pure
 * @changed 2026-10-15 Split from util/toon.js.
 */
import { BARE_STRING, IDENTIFIER, NUMERIC, fail, isPlainObject } from './toon-shared.js';

${exportBlock(encodeExtract.blocks, new Set(['encodeToon']))}
`);
await writeFile('src/util/toon-decode.js', `/**
 * @file src/util/toon-decode.js
 * @module util/toon-decode
 * @purpose Decode a TOON subset or a JSON document.
 * @depends util/toon-shared
 * @usedBy util/toon, interact/batch
 * @exports decodeDocument
 * @ai.tags toon
 * @ai.hint pure
 * @changed 2026-10-15 Split from util/toon.js. Table rows stay at indent + 2 spaces.
 */
import { NUMERIC, assign, fail } from './toon-shared.js';

${exportBlock(decodeExtract.blocks, new Set(['decodeDocument']))}
`);
await writeFile('src/util/toon.js', `/**
 * @file src/util/toon.js
 * @module util/toon
 * @purpose Public TOON subset codec. Encode and decode live in sibling modules.
 * @depends util/toon-encode, util/toon-decode
 * @usedBy interact/batch, agent/roles
 * @exports encodeToon, decodeDocument
 * @ai.tags toon
 * @ai.hint pure
 * @changed 2026-10-15 Facade after the codec was split.
 */
export { encodeToon } from './toon-encode.js';
export { decodeDocument } from './toon-decode.js';
`);

const configText = await readFile('src/core/config.js', 'utf8');
const config = linesOf(configText).rows;
const roleLine = config.findIndex((line) => line.startsWith('export const ROLE_NAMES'));
const defaultsBody = config.slice(5, roleLine + 1).join('\n');
await writeFile('src/core/config-defaults.js', `/**
 * @file src/core/config-defaults.js
 * @module core/config-defaults
 * @purpose Frozen default configuration and the enums that validate it.
 * @usedBy core/config, commands/flags
 * @exports defaults, ROLE_NAMES, REASONING_EFFORTS, REASONING_SUMMARIES, APPROVAL_LEVELS, IMAGE_DETAILS
 * @ai.tags config
 * @ai.hint pure
 * @changed 2026-10-15 Split from core/config.js.
 */
${defaultsBody}
`);
const configRest = [
    "import os from 'node:os';",
    "import path from 'node:path';",
    "import { readFile, mkdir } from 'node:fs/promises';",
    "import { deepMerge, isRecord } from '../util/text.js';",
    "import {",
    "    APPROVAL_LEVELS,",
    "    IMAGE_DETAILS,",
    "    REASONING_EFFORTS,",
    "    REASONING_SUMMARIES,",
    "    ROLE_NAMES,",
    "    defaults,",
    "} from './config-defaults.js';",
    "",
    "export {",
    "    APPROVAL_LEVELS,",
    "    IMAGE_DETAILS,",
    "    REASONING_EFFORTS,",
    "    REASONING_SUMMARIES,",
    "    ROLE_NAMES,",
    "    defaults,",
    "};",
    "",
    ...config.slice(roleLine + 1),
];
await writeFile('src/core/config.js', join(configRest));

const cliText = await readFile('src/cli.js', 'utf8');
const helpStart = cliText.indexOf('export const HELP');
const helpEnd = cliText.indexOf('`;\n', helpStart);
if (helpStart < 0 || helpEnd < 0) throw new Error('HELP not found');
const helpBody = cliText.slice(helpStart, helpEnd + 3);
await writeFile('src/cli-help.js', `/**
 * @file src/cli-help.js
 * @module cli-help
 * @purpose Help text printed by \`ai --help\`. Wording is user-facing; keep the spacing inside the template.
 * @usedBy cli
 * @exports HELP
 * @ai.tags cli
 * @ai.hint pure
 * @changed 2026-10-15 Split from cli.js.
 */
${helpBody}
`);
const cliNext = `${cliText.slice(0, helpStart)}import { HELP } from './cli-help.js';\nexport { HELP };\n${cliText.slice(helpEnd + 3)}`;
await writeFile('src/cli.js', cliNext);

const fsText = await readFile('src/interact/filesystem.js', 'utf8');
const fsRows = linesOf(fsText).rows;
const scriptExtract = extractFunctions(fsRows, new Set(['ahkString', 'scriptFor', 'wrapScript']));
await writeFile('src/interact/ahk-script.js', `/**
 * @file src/interact/ahk-script.js
 * @module interact/ahk-script
 * @purpose Build one AutoHotkey v2 program for a normalized desktop action.
 * @depends interact/mouse, interact/keyboard, interact/screenshot
 * @usedBy interact/filesystem
 * @exports ahkString, scriptFor, wrapScript
 * @ai.tags desktop, autohotkey
 * @ai.hint pure
 * @changed 2026-10-15 Split from interact/filesystem.js.
 */
import { clickBody } from './mouse.js';
import { typeBody } from './keyboard.js';
import { CAPTURE_LIBRARY } from './screenshot.js';

${exportBlock(scriptExtract.blocks, new Set(['ahkString', 'scriptFor', 'wrapScript']))}
`);
const fsKept = fsRows.filter((_, index) => !scriptExtract.used.has(index));
const fsImportAt = fsKept.findIndex((line) => line.startsWith('import { clickBody }'));
const fsWithoutMovedImports = fsKept.filter((line) => !line.startsWith('import { clickBody }') && !line.startsWith('import { typeBody }') && !line.startsWith('import { CAPTURE_LIBRARY }'));
await writeFile('src/interact/filesystem.js', join([
    ...fsWithoutMovedImports.slice(0, 6),
    "import { scriptFor, wrapScript, ahkString } from './ahk-script.js';",
    "export { ahkString, scriptFor, wrapScript };",
    ...fsWithoutMovedImports.slice(6),
]));

const rendererText = await readFile('src/ui/renderer.js', 'utf8');
const renderer = linesOf(rendererText).rows;
const glyphFns = extractFunctions(renderer, new Set(['detectMode']));
const glyphConsts = renderer.slice(5, 9);
await writeFile('src/ui/glyphs.js', `/**
 * @file src/ui/glyphs.js
 * @module ui/glyphs
 * @purpose Spinner frames, status glyphs, and TTY/plain/json/quiet mode detection.
 * @usedBy ui/renderer, cli
 * @exports detectMode, FRAMES, ASCII_FRAMES, SYMBOLS, ASCII_SYMBOLS
 * @ai.tags ui
 * @ai.hint pure
 * @changed 2026-10-15 Split from ui/renderer.js.
 */
${glyphConsts.join('\n')}

export { FRAMES, ASCII_FRAMES, SYMBOLS, ASCII_SYMBOLS };

${exportBlock(glyphFns.blocks, new Set(['detectMode']))}
`);
const eventStart = renderer.findIndex((line) => line.includes('// ---- event handling'));
const summaryAt = renderer.findIndex((line) => line.includes('Final summary block'));
const eventBlock = dedent(renderer.slice(eventStart, summaryAt).join('\n'), 4)
    .replace('function handle(event) {', `export function handleRendererEvent(event, api) {
    const {
        mode, verbose, line, setStatus, text, state, showReasoning, emitJson,
        STAGES, ensureNewline, drawStatus,
    } = api;`);
await writeFile('src/ui/renderer-events.js', `/**
 * @file src/ui/renderer-events.js
 * @module ui/renderer-events
 * @purpose Format one agent event for the terminal. The renderer owns the streams; this module owns the switch.
 * @depends util/text
 * @usedBy ui/renderer
 * @exports handleRendererEvent
 * @ai.tags ui
 * @ai.hint pure
 * @changed 2026-10-15 Split from ui/renderer.js.
 */
import { formatBytes, formatDuration, formatNumber, formatUsd, truncate } from '../util/text.js';

${eventBlock}
`);
const rendererNext = [
    "import { styleText } from 'node:util';",
    "import { createInterface } from 'node:readline/promises';",
    "import { sanitizeTerminal, sanitizeValue } from './sanitize.js';",
    "import { formatBytes, formatDuration, formatNumber, formatUsd, truncate } from '../util/text.js';",
    "import { ASCII_FRAMES, ASCII_SYMBOLS, FRAMES, SYMBOLS, detectMode } from './glyphs.js';",
    "import { handleRendererEvent } from './renderer-events.js';",
    "export { detectMode };",
    "",
    ...renderer.slice(16, eventStart),
    "    function handle(event) {",
    "        return handleRendererEvent(event, {",
    "            mode, verbose, line, setStatus, text, state, showReasoning, emitJson,",
    "            STAGES, ensureNewline, drawStatus,",
    "        });",
    "    }",
    "",
    ...renderer.slice(summaryAt - 1),
];
await writeFile('src/ui/renderer.js', join(rendererNext));

const teamText = await readFile('src/agent/team.js', 'utf8');
const team = linesOf(teamText).rows;
const teamFns = extractFunctions(team, new Set(['renderPlan', 'renderFindings']));
const bulletsLine = team.find((line) => line.startsWith('const bullets'));
await writeFile('src/agent/team-text.js', `/**
 * @file src/agent/team-text.js
 * @module agent/team-text
 * @purpose Render planner and collector JSON as text the worker and reviewer can read.
 * @usedBy agent/team
 * @exports renderPlan, renderFindings, bullets
 * @ai.tags team
 * @ai.hint pure
 * @changed 2026-10-15 Split from agent/team.js.
 */
${exportBlock(teamFns.blocks, new Set(['renderPlan', 'renderFindings']))}

export ${bulletsLine}
`);
const teamKept = team.filter((line, index) => !teamFns.used.has(index) && line !== bulletsLine);
const teamImport = "import { bullets, renderFindings, renderPlan } from './team-text.js';";
const teamInsert = teamKept.findIndex((line) => line.startsWith('const HARD_STOP'));
teamKept.splice(teamInsert, 0, teamImport);
await writeFile('src/agent/team.js', join(teamKept));

const sharedText = await readFile('src/commands/shared.js', 'utf8');
const shared = linesOf(sharedText).rows;
const flagFns = extractFunctions(shared, new Set(['number', 'overridesFrom']));
const classStart = shared.findIndex((line) => line.startsWith('export class UsageError'));
const classEnd = shared.findIndex((line, index) => index > classStart && line === '}');
const classBlock = shared.slice(classStart, classEnd + 1).join('\n');
await writeFile('src/commands/flags.js', `/**
 * @file src/commands/flags.js
 * @module commands/flags
 * @purpose Turn CLI flags into configuration overrides. Bad flags throw UsageError (exit code 2).
 * @depends core/config
 * @usedBy commands/shared, cli
 * @exports UsageError, overridesFrom
 * @ai.tags cli, config
 * @ai.hint pure
 * @changed 2026-10-15 Split from commands/shared.js.
 */
import { APPROVAL_LEVELS, IMAGE_DETAILS, REASONING_EFFORTS, REASONING_SUMMARIES, ROLE_NAMES } from '../core/config.js';

${classBlock}

${exportBlock(flagFns.blocks, new Set(['overridesFrom']))}
`);
const sharedKept = shared.filter((_, index) => !flagFns.used.has(index) && (index < classStart || index > classEnd));
const sharedImportLine = sharedKept.findIndex((line) => line.startsWith('import { APPROVAL_LEVELS'));
sharedKept[sharedImportLine] = "import { resolveRole } from '../core/config.js';";
sharedKept.splice(sharedImportLine + 1, 0, "import { UsageError, overridesFrom } from './flags.js';", "export { UsageError, overridesFrom };");
await writeFile('src/commands/shared.js', join(sharedKept));

console.log('split done');
