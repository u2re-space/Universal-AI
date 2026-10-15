/**
 * @file src/ui/glyphs.js
 * @module ui/glyphs
 * @purpose Spinner frames, status glyphs, and TTY/plain/json/quiet mode detection.
 * @usedBy ui/renderer, cli
 * @exports detectMode, FRAMES, ASCII_FRAMES, SYMBOLS, ASCII_SYMBOLS
 * @ai.tags ui
 * @ai.hint pure
 * @changed 2026-10-15 Split from ui/renderer.js.
 */
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const ASCII_FRAMES = ['-', '\\', '|', '/'];
const SYMBOLS = { action: '▸', ok: '✓', fail: '✗', warn: '⚠', reasoning: '∙', image: '▣', usage: '≡', info: '·', question: '?' };
const ASCII_SYMBOLS = { action: '>', ok: '+', fail: 'x', warn: '!', reasoning: '~', image: '#', usage: '=', info: '-', question: '?' };

export { FRAMES, ASCII_FRAMES, SYMBOLS, ASCII_SYMBOLS };

export function detectMode({ json = false, quiet = false, stdout = process.stdout, stderr = process.stderr } = {}) {
    if (json) return 'json';
    if (quiet) return 'quiet';
    return stderr.isTTY && stdout.isTTY ? 'tty' : 'plain';
}
