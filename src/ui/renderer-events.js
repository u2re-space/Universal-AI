/**
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

// ---- event handling ---------------------------------------------------------------------
/**
 * Show one agent event. JSON mode writes a trimmed object; other modes log and update status.
 * @param {object} event Agent event. Its type selects the branch.
 * @param {object} api Renderer callbacks, mode, stages, and mutable state.
 * @returns {void}
 * @exports
 * @ai.hint pure
 */
export function handleRendererEvent(event, api) {
    const {
        mode, verbose, line, setStatus, text, state, showReasoning, emitJson,
        STAGES, ensureNewline, drawStatus,
    } = api;
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

/**
 * Shorten tool arguments for the action log line.
 * @param {string} name Tool name.
 * @param {object | undefined} args Arguments from the tool call.
 * @returns {string}
 * @ai.hint pure
 */
function describeArgs(name, args) {
    if (!args || typeof args !== 'object') return '';
    switch (name) {
        case 'read_file': return `${args.path}${args.start_line || args.end_line ? ` [${args.start_line ?? 1}-${args.end_line ?? '…'}]` : ''}`;
        case 'write_file': return `${args.path} (${formatBytes(Buffer.byteLength(String(args.content ?? '')))})`;
        case 'replace_text': return `${args.path}`;
        case 'search_files': return `"${truncate(args.query, 60)}"${args.path && args.path !== '.' ? ` в ${args.path}` : ''}`;
        case 'list_files': return args.path || '.';
        case 'run_command': return truncate(`${args.shell ? `${args.shell}: ` : ''}${args.command}`, 100);
        case 'run_script': return truncate(args.path, 100);
        case 'structure_file': return truncate(`${args.path} ${args.tasks || ''}`.trim(), 100);
        case 'ssh': return truncate(`${args.mode} ${args.host}`, 100);
        case 'fetch_url': return truncate(args.url, 100);
        case 'ask_user': return truncate(args.question, 100);
        default: return truncate(JSON.stringify(args), 100);
    }
}

