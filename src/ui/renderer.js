import { styleText } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { sanitizeTerminal, sanitizeValue } from './sanitize.js';
import { formatBytes, formatDuration, formatNumber, formatUsd, truncate } from '../util/text.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const ASCII_FRAMES = ['-', '\\', '|', '/'];
const SYMBOLS = { action: '▸', ok: '✓', fail: '✗', warn: '⚠', reasoning: '∙', image: '▣', usage: '≡', info: '·', question: '?' };
const ASCII_SYMBOLS = { action: '>', ok: '+', fail: 'x', warn: '!', reasoning: '~', image: '#', usage: '=', info: '-', question: '?' };

export function detectMode({ json = false, quiet = false, stdout = process.stdout, stderr = process.stderr } = {}) {
  if (json) return 'json';
  if (quiet) return 'quiet';
  return stderr.isTTY && stdout.isTTY ? 'tty' : 'plain';
}

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
  const color = (format, text) => (tty ? styleText(format, text, { stream: stderr }) : text);
  const state = {
    phase: '', detail: '', startedAt: Date.now(), turn: null, maxTurns: null, liveChars: 0, ledger: null,
    active: false, frame: 0, textStreaming: false, lastChar: '\n', statusVisible: false, reasoningBuffer: '',
    askOpen: false, model: null, roles: [],
  };
  const STAGES = { plan: 'план', collect: 'сбор контекста', work: 'выполнение', review: 'ревью', fix: 'исправления', memory: 'память' };
  let timer = null;
  let rl = null;

  // ---- low level output -------------------------------------------------------------------
  function clearStatus() {
    if (!state.statusVisible) return;
    stderr.write('\r\x1b[2K');
    state.statusVisible = false;
  }
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
  function drawStatus() {
    if (!tty || !state.active || state.textStreaming || state.askOpen) return;
    const frame = frames[state.frame++ % frames.length];
    const columns = Math.max(20, stderr.columns || 100);
    const line = truncate(`${frame} ${statusText()}`, columns - 1);
    stderr.write(`\r\x1b[2K${color('cyan', line)}`);
    state.statusVisible = true;
  }
  function out(stream, text) {
    clearStatus();
    stream.write(text);
    if (text.length) state.lastChar = text.at(-1);
  }
  function ensureNewline() {
    if (state.lastChar !== '\n') { stdout.write('\n'); state.lastChar = '\n'; }
  }
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
  function setStatus(phase, detail = '') {
    state.phase = phase; state.detail = detail;
    onStatus?.({ phase, detail, elapsedMs: Date.now() - state.startedAt });
    if (!tty) return;
    if (!state.active) { state.active = true; state.startedAt = state.startedAt || Date.now(); timer ??= setInterval(drawStatus, statusIntervalMs); timer.unref?.(); }
    drawStatus();
  }
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

  // ---- event handling ---------------------------------------------------------------------
  function handle(event) {
    if (mode === 'json') {
      // Full event stream; large payloads (base64 images, raw items) are trimmed.
      const { b64, item, ...rest } = event;
      if (event.type === 'text.delta') { emitJson(rest); return; }
      emitJson(item ? { ...rest, itemType: item.type, itemId: item.id ?? null } : rest);
      return;
    }
    switch (event.type) {
      case 'request.start':
        setStatus(event.attempt ? `повтор ${event.attempt}` : 'подключение…', event.stream ? '' : 'без потока');
        if (verbose) line('info', `${event.method} ${event.path} (${formatBytes(event.requestBytes)})`, { dim: true });
        break;
      case 'request.retry':
        line('warn', `Повтор запроса через ${formatDuration(event.delayMs)}: ${event.reason}`);
        break;
      case 'request.headers':
        if (verbose) line('info', `HTTP ${event.status} · request-id ${event.requestId ?? '—'}`, { dim: true });
        break;
      case 'response.created':
        state.model = event.model ?? state.model;
        setStatus(event.status === 'queued' ? 'в очереди (фоновый режим)…' : 'ожидание ответа…');
        if (verbose && event.responseId) line('info', `response ${event.responseId}`, { dim: true });
        break;
      case 'response.status':
        setStatus(event.status === 'queued' ? 'в очереди (фоновый режим)…' : event.status === 'in_progress' ? 'в работе…' : event.status);
        break;
      case 'reasoning.start':
        state.reasoningBuffer = '';
        setStatus('думает…');
        break;
      case 'reasoning.delta':
        state.liveChars += event.text.length;
        state.reasoningBuffer += event.text;
        setStatus('думает…', showReasoning ? state.reasoningBuffer.split('\n').pop() : '');
        break;
      case 'reasoning.done': {
        const summary = (event.text || state.reasoningBuffer).trim();
        state.reasoningBuffer = '';
        if (showReasoning && summary) {
          for (const paragraph of summary.split(/\n+/)) if (paragraph.trim()) line('reasoning', truncate(paragraph, 400));
        }
        break;
      }
      case 'message.start':
        setStatus('отвечает…');
        break;
      case 'text.delta':
        state.liveChars += event.text.length;
        text(event.text);
        break;
      case 'text.done':
        if (state.textStreaming) { ensureNewline(); state.textStreaming = false; drawStatus(); }
        break;
      case 'refusal.delta':
        text(event.text);
        break;
      case 'refusal.done':
        if (state.textStreaming) { ensureNewline(); state.textStreaming = false; }
        line('warn', 'Модель отказалась выполнять запрос.');
        break;
      case 'tool.call.start':
        setStatus(`готовит вызов ${event.name ?? 'инструмента'}…`);
        break;
      case 'tool.args.delta':
        state.liveChars += event.bytes;
        break;
      case 'tool.exec.start':
        line('action', `${event.name} ${describeArgs(event.name, event.args)}`);
        setStatus(`выполняется ${event.name}…`);
        break;
      case 'tool.exec.done':
        line(event.ok ? 'ok' : 'fail', `${event.name} · ${event.summary || (event.ok ? 'готово' : 'ошибка')} · ${formatDuration(event.durationMs)}`);
        break;
      case 'builtin.start':
        if (event.kind === 'image_generation') { setStatus('генерирует изображение…'); line('action', 'image_generation'); }
        else if (event.kind === 'web_search') { setStatus('ищет в интернете…'); line('action', 'web_search'); }
        else { setStatus(`${event.kind}…`); line('action', event.kind); }
        break;
      case 'builtin.progress':
        setStatus(state.phase, event.status.replace(/_/g, ' '));
        break;
      case 'builtin.done':
        if (event.kind === 'web_search') {
          const query = event.item?.action?.query ?? event.item?.action?.url ?? '';
          line('ok', `web_search${query ? `: ${truncate(query, 80)}` : ''}`);
        } else if (event.kind !== 'image_generation') line('ok', event.kind);
        break;
      case 'image.progress':
        setStatus('генерирует изображение…', `черновик ${event.index + 1} → ${event.path}`);
        break;
      case 'image.saved':
        line('image', `Изображение сохранено: ${event.path} (${formatBytes(event.bytes)})`);
        if (verbose && event.revisedPrompt) line('info', `prompt: ${truncate(event.revisedPrompt, 200)}`, { dim: true });
        break;
      case 'turn.start':
        state.turn = event.turn; state.maxTurns = event.maxTurns;
        if (event.tools && event.turn > 1) setStatus('продолжает…');
        break;
      case 'response.done': {
        state.liveChars = 0;
        state.ledger = event.ledger ?? state.ledger;
        const u = event.usage;
        const tokens = u ? `↑ ${formatNumber(u.input)}${u.cached ? ` (кеш ${formatNumber(u.cached)})` : ''} ↓ ${formatNumber(u.output)}${u.reasoning ? ` (reasoning ${formatNumber(u.reasoning)})` : ''}` : 'usage неизвестен';
        const cost = Number.isFinite(event.costUsd) ? ` · ${formatUsd(event.costUsd)}` : '';
        line('usage', `${tokens}${cost} · ${formatDuration(event.elapsedMs)}${verbose && event.responseId ? ` · ${event.responseId}` : ''}`);
        break;
      }
      case 'approval.result':
        if (verbose) line('info', `${event.name}: ${event.answer}`, { dim: true });
        break;
      case 'compaction.start':
        line('info', `Компактизация контекста (${formatNumber(event.inputTokens)} входных токенов)…`);
        break;
      case 'compaction.done':
        line('ok', `Контекст сжат: ${event.before} → ${event.after} элементов`);
        break;
      case 'budget.exceeded':
        line('fail', event.message);
        break;
      case 'warning':
        line('warn', event.message);
        break;
      case 'error':
        line('fail', event.message);
        break;
      case 'stream.error':
        if (verbose) line('fail', `Ошибка потока: ${event.message}`);
        break;
      case 'stream.other':
        if (verbose) line('info', event.raw, { dim: true });
        break;
      case 'item.done':
      case 'tool.args.done':
      case 'request.done':
      case 'approval.request':
        break;
      // ---- team / roles / memory ----
      case 'role.start':
        state.roles.push({ role: event.role, model: event.model });
        drawStatus();
        break;
      case 'role.done':
        state.roles.pop();
        if (verbose) line('info', `${event.role}: ${event.status}${event.toolCalls ? ` · инструментов ${event.toolCalls}` : ''}`, { dim: true });
        break;
      case 'stage.start':
        line('action', `этап «${STAGES[event.stage] ?? event.stage}»${event.round ? ` (раунд ${event.round})` : ''} — ${event.role}${event.model ? ` · ${event.model}` : ''}`);
        setStatus(`${STAGES[event.stage] ?? event.stage}…`);
        break;
      case 'stage.done':
        if (verbose) line('info', `этап «${STAGES[event.stage] ?? event.stage}»: ${event.status}`, { dim: true });
        break;
      case 'plan.ready':
        line('ok', `план (${event.complexity}${event.needsReview ? ', с ревью' : ''}): ${truncate(event.summary, 300)}`);
        event.steps.forEach((goal, index) => line('info', `  ${index + 1}. ${truncate(goal, 160)}`, { dim: true }));
        if (verbose) for (const criterion of event.acceptanceCriteria ?? []) line('info', `  критерий: ${truncate(criterion, 160)}`, { dim: true });
        break;
      case 'step.start':
        line('action', `шаг ${event.index}/${event.total}: ${truncate(event.goal, 160)}`);
        setStatus(`шаг ${event.index}/${event.total}…`);
        break;
      case 'step.done':
        line(event.status === 'completed' ? 'ok' : 'warn', `шаг ${event.index}: ${event.status === 'completed' ? 'готов' : event.status}`);
        break;
      case 'review.done': {
        const accepted = event.verdict === 'accept';
        line(accepted ? 'ok' : 'warn', `ревью${event.round > 1 ? ` (раунд ${event.round})` : ''}: ${accepted ? 'принято' : 'нужны правки'} — ${truncate(event.summary, 300)}`);
        for (const issue of event.issues ?? []) line('info', `  [${issue.severity}] ${issue.path ? `${issue.path}: ` : ''}${truncate(issue.message, 200)}`, { dim: true });
        for (const item of event.unverified ?? []) line('info', `  не проверено: ${truncate(item, 160)}`, { dim: true });
        break;
      }
      case 'memory.recalled':
        line('info', `память: найдено ${event.count} подходящих записей`, { dim: true });
        if (verbose) for (const item of event.items ?? []) line('info', `  #${item.id} ${truncate(item.content, 160)}`, { dim: true });
        break;
      case 'memory.saved':
        line('info', `память: сохранено ${event.count}`, { dim: true });
        for (const item of event.items ?? []) line('info', `  + [${item.scope}/${item.kind}] ${truncate(item.content, 200)}`, { dim: true });
        break;
      default:
        if (verbose && event.type) line('info', event.type, { dim: true });
    }
  }

  function describeArgs(name, args) {
    if (!args || typeof args !== 'object') return '';
    switch (name) {
      case 'read_file': return `${args.path}${args.start_line || args.end_line ? ` [${args.start_line ?? 1}-${args.end_line ?? '…'}]` : ''}`;
      case 'write_file': return `${args.path} (${formatBytes(Buffer.byteLength(String(args.content ?? '')))})`;
      case 'replace_text': return `${args.path}`;
      case 'search_files': return `"${truncate(args.query, 60)}"${args.path && args.path !== '.' ? ` в ${args.path}` : ''}`;
      case 'list_files': return args.path || '.';
      case 'run_command': return truncate(args.command, 100);
      case 'fetch_url': return truncate(args.url, 100);
      case 'ask_user': return truncate(args.question, 100);
      default: return truncate(JSON.stringify(args), 100);
    }
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

  function json(event) { if (mode === 'json') emitJson(event); }

  function close() {
    idle();
    if (rl) { rl.close(); rl = null; }
  }

  return {
    mode, text, line, block, setStatus, begin, idle, ask, approve, handle, summary, json, close, readline,
    ensureNewline,
    /** Plain stdout output for commands (suppressed in JSON mode, where callers emit objects). */
    write: (value) => { if (mode !== 'json') out(stdout, sanitizeTerminal(value)); },
    get interactive() { return mode !== 'json' && Boolean(stdin.isTTY); },
    set ledger(snapshot) { state.ledger = snapshot; },
    set onStatus(fn) { onStatus = fn; },
    set onInterrupt(fn) { onInterrupt = fn; },
  };
}
