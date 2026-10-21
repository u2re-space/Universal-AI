/**
 * @file src/ui/renderer.js
 * @module ui/renderer
 * @purpose Stream agent output to a tty, plain, JSON, or quiet terminal.
 * @depends node:util, node:readline/promises, ui/sanitize, util/text, ui/glyphs, ui/renderer-events
 * @usedBy cli, index.js
 * @exports detectMode, createRenderer
 * @ai.tags ui, terminal, stream
 * @ai.hint io
 * @changed 2026-10-15 Stage label for the workspace scanner.
 */

import { styleText } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { sanitizeTerminal, sanitizeValue } from './sanitize.js';
import { formatBytes, formatDuration, formatNumber, formatUsd, truncate } from '../util/text.js';
import { ASCII_FRAMES, ASCII_SYMBOLS, FRAMES, SYMBOLS, detectMode } from './glyphs.js';
import { handleRendererEvent } from './renderer-events.js';
export { detectMode };

/**
 * All terminal output goes through here.
 *   tty   — streaming answer on stdout, action log + live status line (spinner, phase, elapsed,
 *           tokens, cost) on stderr, interactive questions.
 *   plain — the same without cursor control (pipes, CI, detached jobs).
 *   json  — one JSON object per line on stdout (events + text deltas), nothing else.
 *   quiet — only the answer text on stdout and errors on stderr.
 */
export function createRenderer({
    mode = detectMode(), stdout = process.stdout, stderr = process.stderr, stdin = process.stdin,
    showReasoning = true, verbose = false, ascii = process.env.AI_ASCII === '1', statusIntervalMs = 100, onStatus = null,
    onInterrupt = null,
} = {}) {
    const tty = mode === 'tty';
    const symbols = ascii ? ASCII_SYMBOLS : SYMBOLS;
    const frames = ascii ? ASCII_FRAMES : FRAMES;
    /**
     * Color one status or log string when the mode is tty.
     * @param {string} format styleText color name.
     * @param {string} text Text to color.
     * @returns {string}
     * @ai.hint pure
     */
    const color = (format, text) => (tty ? styleText(format, text, { stream: stderr }) : text);
    const state = {
        phase: '', detail: '', startedAt: Date.now(), turn: null, maxTurns: null, liveChars: 0, ledger: null,
        active: false, frame: 0, textStreaming: false, lastChar: '\n', statusVisible: false, reasoningBuffer: '',
        askOpen: false, model: null, roles: [],
    };
    const STAGES = { scan: 'сканер', answer: 'ответ', encode: 'запись', plan: 'план', collect: 'сбор контекста', work: 'выполнение', review: 'ревью', fix: 'исправления', coordinate: 'координация', memory: 'память' };
    let timer = null;
    let rl = null;

    // ---- low level output -------------------------------------------------------------------
    /**
     * Erase the live status line on stderr when one is showing.
     * @returns {void}
     * @ai.hint io
     */
    function clearStatus() {
        if (!state.statusVisible) return;
        stderr.write('\r\x1b[2K');
        state.statusVisible = false;
    }
    /**
     * Build the status line from the role, phase, elapsed time, tokens, cost, and turn.
     * @returns {string}
     * @ai.hint pure
     */
    function statusText() {
        const parts = [];
        const phase = state.phase || 'работает';
        const role = state.roles.at(-1);
        const prefix = role ? `[${role.role}${role.model ? ` · ${role.model}` : ''}] ` : '';
        parts.push(`${prefix}${state.detail ? `${phase} · ${truncate(state.detail, 48)}` : phase}`);
        parts.push(formatDuration(Date.now() - state.startedAt));
        const t = state.ledger;
        if (t) {
            let tokens = `↑ ${formatNumber(t.input)} ↓ ${formatNumber(t.output)}`;
            if (state.liveChars) tokens += ` +~${formatNumber(state.liveChars / 4)}`;
            parts.push(tokens);
            if (t.costKnown && t.requests) parts.push(formatUsd(t.costUsd));
            else if (t.costUsd) parts.push(`≥ ${formatUsd(t.costUsd)}`);
        } else if (state.liveChars) parts.push(`~${formatNumber(state.liveChars / 4)} ток.`);
        if (state.turn && state.maxTurns > 1) parts.push(`ход ${state.turn}/${state.maxTurns}`);
        return parts.join(' · ');
    }
    /**
     * Write one spinner frame and the status line while a tty turn is active.
     * @returns {void}
     * @ai.hint io
     */
    function drawStatus() {
        if (!tty || !state.active || state.textStreaming || state.askOpen) return;
        const frame = frames[state.frame++ % frames.length];
        const columns = Math.max(20, stderr.columns || 100);
        const line = truncate(`${frame} ${statusText()}`, columns - 1);
        stderr.write(`\r\x1b[2K${color('cyan', line)}`);
        state.statusVisible = true;
    }
    /**
     * Clear the status line, write text to the stream, and remember the last character.
     * @param {object} stream stdout or stderr.
     * @param {string} text Characters to write.
     * @returns {void}
     * @ai.hint io
     */
    function out(stream, text) {
        clearStatus();
        stream.write(text);
        if (text.length) state.lastChar = text.at(-1);
    }
    /**
     * Write a newline to stdout when the previous character was not one.
     * @returns {void}
     * @ai.hint io
     */
    function ensureNewline() {
        if (state.lastChar !== '\n') { stdout.write('\n'); state.lastChar = '\n'; }
    }
    /**
     * Write one sanitized JSON event, including an ISO time, as a line on stdout.
     * @param {object} event Event fields merged after the time.
     * @returns {void}
     * @ai.hint io
     */
    function emitJson(event) {
        stdout.write(`${JSON.stringify(sanitizeValue({ time: new Date().toISOString(), ...event }))}\n`);
    }

    // ---- public primitives -------------------------------------------------------------------
    /** Assistant text to stdout (sanitized, streamed). */
    function text(delta) {
        if (mode === 'json') { emitJson({ type: 'text.delta', text: delta }); return; }
        const clean = sanitizeTerminal(delta);
        if (!clean) return;
        state.textStreaming = true;
        out(stdout, clean);
    }
    /** Log line on stderr. kind: action | ok | fail | warn | reasoning | image | usage | info */
    function line(kind, message, { dim = false } = {}) {
        if (mode === 'json') { emitJson({ type: 'log', kind, message }); return; }
        if (mode === 'quiet' && !['fail', 'warn'].includes(kind)) return;
        const clean = sanitizeTerminal(message);
        const symbol = symbols[kind] ?? symbols.info;
        const colors = { action: 'cyan', ok: 'green', fail: 'red', warn: 'yellow', reasoning: 'gray', image: 'magenta', usage: 'gray', info: 'gray', question: 'yellow' };
        const prefix = color(colors[kind] ?? 'gray', symbol);
        const body = dim || kind === 'reasoning' || kind === 'usage' ? color('gray', clean) : clean;
        if (state.textStreaming) { ensureNewline(); state.textStreaming = false; }
        out(stderr, `${prefix} ${body}\n`);
        drawStatus();
    }
    /** Multi-line block (previews) on stderr, indented. */
    function block(textBlock) {
        if (mode === 'json') { emitJson({ type: 'log', kind: 'block', message: textBlock }); return; }
        if (mode === 'quiet') return;
        const clean = sanitizeTerminal(textBlock).split('\n').map((l) => `    ${l}`).join('\n');
        out(stderr, `${color('gray', clean)}\n`);
        drawStatus();
    }
    /**
     * Store the phase and detail, notify onStatus, and redraw the tty status line.
     * @param {string} phase Short phase label.
     * @param {string} [detail] Extra text truncated on the status line.
     * @returns {void}
     * @ai.hint io
     */
    function setStatus(phase, detail = '') {
        state.phase = phase; state.detail = detail;
        onStatus?.({ phase, detail, elapsedMs: Date.now() - state.startedAt });
        if (!tty) return;
        if (!state.active) { state.active = true; state.startedAt = state.startedAt || Date.now(); timer ??= setInterval(drawStatus, statusIntervalMs); timer.unref?.(); }
        drawStatus();
    }
    /**
     * Reset the turn clock and start the status timer on a tty.
     * @returns {void}
     * @ai.hint io
     */
    function begin() {
        state.startedAt = Date.now(); state.liveChars = 0; state.turn = null; state.textStreaming = false;
        if (tty) { state.active = true; timer ??= setInterval(drawStatus, statusIntervalMs); timer.unref?.(); }
    }
    /** Stop the status line (end of a turn). */
    function idle() {
        state.active = false; state.phase = ''; state.detail = '';
        if (timer) { clearInterval(timer); timer = null; }
        clearStatus();
        if (state.textStreaming) { ensureNewline(); state.textStreaming = false; }
    }
    /**
     * Open the readline interface once and forward Ctrl-C to onInterrupt.
     * @returns {import('node:readline/promises').Interface}
     * @ai.hint io
     */
    function readline() {
        if (!rl) {
            rl = createInterface({ input: stdin, output: stderr, terminal: Boolean(stdin.isTTY) });
            // With a terminal readline swallows Ctrl-C; forward it to the CLI's interrupt handler.
            rl.on('SIGINT', () => { if (onInterrupt) onInterrupt(); else process.kill(process.pid, 'SIGINT'); });
        }
        return rl;
    }
    /** Ask the operator a free-form question (TTY only). Returns null when not interactive. */
    async function ask(question, { signal } = {}) {
        if (mode === 'json' || !stdin.isTTY) return null;
        state.askOpen = true;
        clearStatus();
        if (state.textStreaming) { ensureNewline(); state.textStreaming = false; }
        try {
            const answer = await readline().question(`${color('yellow', symbols.question)} ${sanitizeTerminal(question)} `, signal ? { signal } : undefined);
            return answer.trim();
        } catch (error) {
            if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return null;
            throw error;
        } finally {
            state.askOpen = false;
            drawStatus();
        }
    }
    /** Approval question with the standard choices. */
    async function approve({ name, category, preview }, { signal } = {}) {
        if (mode === 'json' || !stdin.isTTY) return 'no';
        line('question', `Требуется подтверждение: ${name} (${category})`);
        if (preview) block(preview);
        for (;;) {
            const answer = await ask('Разрешить? [y] да · [n] нет · [a] всегда для этого инструмента · [q] остановить', { signal });
            if (answer === null) return 'abort';
            const key = answer.toLowerCase();
            if (['y', 'yes', 'д', 'да'].includes(key)) return 'yes';
            if (['n', 'no', 'н', 'нет', ''].includes(key)) return 'no';
            if (['a', 'always', 'в', 'всегда'].includes(key)) return 'always';
            if (['q', 'quit', 'stop', 'с', 'стоп'].includes(key)) return 'abort';
        }
    }

    /**
     * Pass one agent event to handleRendererEvent with this renderer's callbacks.
     * @param {object} event Agent event.
     * @returns {void}
     * @ai.hint io
     */
    function handle(event) {
        return handleRendererEvent(event, {
            mode, verbose, line, setStatus, text, state, showReasoning, emitJson,
            STAGES, ensureNewline, drawStatus,
        });
    }


    /** Final summary block. */
    function summary({ title = 'итог', rows = [] } = {}) {
        if (mode === 'json') { emitJson({ type: 'summary', title, rows }); return; }
        if (mode === 'quiet') return;
        idle();
        const width = Math.min(72, Math.max(24, (stderr.columns || 80) - 2));
        const header = `── ${title} `;
        out(stderr, `${color('gray', header + '─'.repeat(Math.max(0, width - header.length)))}\n`);
        for (const [label, value] of rows) {
            if (value === undefined || value === null || value === '') continue;
            out(stderr, `${color('gray', `${label}:`)} ${sanitizeTerminal(String(value))}\n`);
        }
    }

    /**
     * Write one event object when the mode is json.
     * @param {object} event Event to emit.
     * @returns {void}
     * @ai.hint io
     */
    function json(event) { if (mode === 'json') emitJson(event); }

    /**
     * Stop the status line and close the readline interface.
     * @returns {void}
     * @ai.hint io
     */
    function close() {
        idle();
        if (rl) { rl.close(); rl = null; }
    }

    return {
        mode, text, line, block, setStatus, begin, idle, ask, approve, handle, summary, json, close, readline,
        ensureNewline,
        /** Plain stdout output for commands (suppressed in JSON mode, where callers emit objects). */
        write: (value) => { if (mode !== 'json') out(stdout, sanitizeTerminal(value)); },
        /**
         * True when the mode is not json and stdin is a TTY.
         * @returns {boolean}
         * @ai.hint pure
         */
        get interactive() { return mode !== 'json' && Boolean(stdin.isTTY); },
        /**
         * Store the usage snapshot drawn on the status line.
         * @param {object | null} snapshot Token and cost totals.
         * @returns {void}
         * @ai.hint pure
         */
        set ledger(snapshot) { state.ledger = snapshot; },
        /**
         * Replace the callback notified when the status phase changes.
         * @param {Function | null} fn Status listener.
         * @returns {void}
         * @ai.hint pure
         */
        set onStatus(fn) { onStatus = fn; },
        /**
         * Replace the callback used when readline receives Ctrl-C.
         * @param {Function | null} fn Interrupt listener.
         * @returns {void}
         * @ai.hint pure
         */
        set onInterrupt(fn) { onInterrupt = fn; },
    };
}
