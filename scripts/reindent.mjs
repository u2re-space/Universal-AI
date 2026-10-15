/**
 * Double leading spaces on JS source lines that are not inside a string or template.
 * Template and string contents keep their own spaces. Newlines are preserved.
 */
import { readFile, writeFile } from 'node:fs/promises';

const KEYWORDS_BEFORE_REGEX = new Set([
    'return', 'case', 'throw', 'typeof', 'void', 'delete', 'await', 'new', 'in', 'of', 'instanceof', 'do', 'else',
]);

function reindentSource(source) {
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    const hadFinal = source.endsWith('\n') || source.endsWith('\r\n');
    const text = source.replace(/\r\n/g, '\n').replace(/\n$/, '');
    const lines = text.split('\n');
    let state = 'code';
    const stack = [];
    let expr = true;
    let interp = 0;
    const interpStack = [];

    const out = [];
    for (const raw of lines) {
        const literal = state === 'sq' || state === 'dq' || state === 'tpl';
        const line = literal ? raw : raw.replace(/^( +)/, (spaces) => (spaces.length % 2 === 0 ? spaces + spaces : spaces));
        out.push(line);
        scan(line);
    }
    const body = out.join(newline);
    return hadFinal || source === '' ? body + (source === '' ? '' : newline) : body;

    function scan(line) {
        let i = 0;
        while (i < line.length) {
            const ch = line[i];
            const next = line[i + 1];
            if (state === 'line') break;
            if (state === 'block') {
                if (ch === '*' && next === '/') { state = 'code'; i += 2; continue; }
                i += 1;
                continue;
            }
            if (state === 'sq' || state === 'dq') {
                if (ch === '\\') { i += 2; continue; }
                if (ch === (state === 'sq' ? "'" : '"')) { state = 'code'; expr = false; i += 1; continue; }
                i += 1;
                continue;
            }
            if (state === 'tpl') {
                if (ch === '\\') { i += 2; continue; }
                if (ch === '`') { state = 'code'; expr = false; i += 1; continue; }
                if (ch === '$' && next === '{') {
                    stack.push('tpl');
                    interpStack.push(interp);
                    interp = 1;
                    state = 'code';
                    expr = true;
                    i += 2;
                    continue;
                }
                i += 1;
                continue;
            }
            if (ch === '/' && next === '/') { state = 'line'; break; }
            if (ch === '/' && next === '*') { state = 'block'; i += 2; continue; }
            if (ch === "'" || ch === '"' || ch === '`') {
                state = ch === "'" ? 'sq' : ch === '"' ? 'dq' : 'tpl';
                i += 1;
                continue;
            }
            if (ch === '/' && expr) {
                i += 1;
                while (i < line.length) {
                    if (line[i] === '\\') { i += 2; continue; }
                    if (line[i] === '[') {
                        i += 1;
                        while (i < line.length && line[i] !== ']') {
                            if (line[i] === '\\') i += 2;
                            else i += 1;
                        }
                        continue;
                    }
                    if (line[i] === '/') { i += 1; break; }
                    i += 1;
                }
                while (i < line.length && /[a-z]/i.test(line[i])) i += 1;
                expr = false;
                continue;
            }
            if (ch === '{') {
                if (interp > 0) interp += 1;
                expr = true;
                i += 1;
                continue;
            }
            if (ch === '}') {
                if (interp > 0) {
                    interp -= 1;
                    if (interp === 0) {
                        state = stack.pop();
                        interp = interpStack.pop();
                        i += 1;
                        continue;
                    }
                }
                expr = false;
                i += 1;
                continue;
            }
            if ('([{,;?:'.includes(ch) || ch === '=') { expr = true; i += 1; continue; }
            if (ch === ')' || ch === ']') { expr = false; i += 1; continue; }
            if (/\s/.test(ch)) { i += 1; continue; }
            if (/[A-Za-z_$]/.test(ch)) {
                const start = i;
                i += 1;
                while (i < line.length && /[\w$]/.test(line[i])) i += 1;
                const word = line.slice(start, i);
                expr = KEYWORDS_BEFORE_REGEX.has(word);
                continue;
            }
            if (/[0-9]/.test(ch)) {
                while (i < line.length && /[0-9a-fxo._]/i.test(line[i])) i += 1;
                expr = false;
                continue;
            }
            expr = true;
            i += 1;
        }
        if (state === 'line') state = 'code';
    }
}

/**
 * After a 2-to-4 reindent, star lines of a block comment keep their old odd indent.
 * Line them up with the opening slash: indent of `/**` plus one space.
 * @param {string} source
 * @returns {string}
 */
function alignBlockStars(source) {
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    const hadFinal = source.endsWith('\n');
    const text = source.replace(/\r\n/g, '\n').replace(/\n$/, '');
    const lines = text.split('\n');
    let state = 'code';
    let blockIndent = 0;
    const out = [];
    for (const line of lines) {
        if (state === 'block') {
            const star = /^( *)(\*.*)$/.exec(line);
            out.push(star ? `${' '.repeat(blockIndent + 1)}${star[2]}` : line);
        } else {
            out.push(line);
        }
        const open = state === 'code' ? /^(\s*)\/\*\*/.exec(line) : null;
        if (open) blockIndent = open[1].length;
        scanAlign(line);
    }
    const body = out.join(newline);
    return hadFinal ? `${body}${newline}` : body;

    function scanAlign(line) {
        let i = 0;
        while (i < line.length) {
            const ch = line[i];
            const next = line[i + 1];
            if (state === 'line') break;
            if (state === 'block') {
                if (ch === '*' && next === '/') { state = 'code'; i += 2; continue; }
                i += 1;
                continue;
            }
            if (state === 'sq' || state === 'dq' || state === 'tpl') {
                if (ch === '\\') { i += 2; continue; }
                if ((state === 'sq' && ch === "'") || (state === 'dq' && ch === '"') || (state === 'tpl' && ch === '`')) {
                    state = 'code';
                    i += 1;
                    continue;
                }
                if (state === 'tpl' && ch === '$' && next === '{') { state = 'code'; i += 2; continue; }
                i += 1;
                continue;
            }
            if (ch === '/' && next === '/') break;
            if (ch === '/' && next === '*') { state = 'block'; i += 2; continue; }
            if (ch === "'" || ch === '"' || ch === '`') {
                state = ch === "'" ? 'sq' : ch === '"' ? 'dq' : 'tpl';
                i += 1;
                continue;
            }
            i += 1;
        }
        if (state === 'line') state = 'code';
    }
}

export { reindentSource, alignBlockStars };

const invoked = process.argv[1] && process.argv[1].endsWith('reindent.mjs');
if (invoked) {
    const files = process.argv.slice(2);
    let changed = 0;
    for (const file of files) {
        const before = await readFile(file, 'utf8');
        const after = reindentSource(before);
        if (after !== before) {
            await writeFile(file, after);
            changed += 1;
        }
    }
    console.log(`reindented ${changed}/${files.length}`);
}
