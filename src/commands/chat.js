/**
 * @file src/commands/chat.js
 * @module commands/chat
 * @purpose Interactive multi-turn REPL with slash commands, attachments, and optional local tools.
 * @depends node:util, core/attachments, agent/loop, agent/tools, core/config, util/text, commands/instructions, commands/shared
 * @usedBy cli
 * @exports chat
 * @ai.tags cli, repl
 * @ai.hint io
 * @changed 2026-10-15 JSDoc card, 4-space indent.
 */
import { styleText } from 'node:util';
import { buildUserMessage } from '../core/attachments.js';
import { runTurn, builtinTools, compactSession } from '../agent/loop.js';
import { createToolset, enabledToolNames } from '../agent/tools.js';
import { REASONING_EFFORTS, APPROVAL_LEVELS } from '../core/config.js';
import { formatNumber } from '../util/text.js';
import { ASSISTANT_BASE } from './instructions.js';
import { UsageError, createClientFor, createLedgerFor, openSession, loadAttachments, composeInstructions, resolveTextArg,
    approvalLevel, backupDirFor, writeOutput, usageRow, STATUS_LABELS, openMemoryFor, resolveRole } from './shared.js';

const HELP = `Команды чата:
  /help                     эта справка
  /exit, /quit              выход (Ctrl-C в пустой строке — тоже)
  /clear                    очистить историю разговора
  /image <путь|url>         приложить изображение к следующему сообщению
  /file <путь>              приложить файл (PDF, текст) к следующему сообщению
  /model [id]               показать / сменить модель
  /effort [уровень]         reasoning effort: ${REASONING_EFFORTS.join(' | ')}
  /tools [fs,shell,fetch,channels|none]  локальные инструменты (файлы, команды, загрузка URL, решения и Telegram)
  /approve <уровень>        политика подтверждений: ${APPROVAL_LEVELS.join(' | ')}
  /web [on|off]             поиск в интернете (web_search)
  /images [on|off]          генерация изображений (image_generation)
  /system <текст>           дополнительные инструкции для модели
  /usage                    токены и стоимость за сессию
  /tokens                   подсчитать входные токены текущего контекста (API)
  /compact                  сжать контекст на сервере (store=false)
  /history                  показать историю (текст)
  /save [файл]              сохранить сессию в файл
Многострочный ввод: завершите строку символом \\ или оберните текст в """ … """.`;

/**
 * `ai chat` — interactive multi-turn REPL with slash commands, attachments, optional local
 * tools, web search and image generation. Named sessions (--session) persist between runs.
 * @param {object} ctx Command context from cli.main. Requires an interactive renderer.
 * @returns {Promise<number>} 130 when the run signal is aborted, otherwise 0.
 * @exports
 * @ai.hint io
 */
export async function chat(ctx) {
    const { renderer, values, signal, emit } = ctx;
    if (!renderer.interactive) throw new UsageError('chat требует интерактивный терминал; для скриптов используйте ask.');
    // The chat speaks with the default role; its settings may be changed live with slash commands.
    const config = resolveRole(ctx.config, 'default').config;
    const client = createClientFor(config);
    const ledger = createLedgerFor(config);
    const extra = await resolveTextArg(values.instructions, { cwd: ctx.cwd, what: 'инструкции' });
    let systemExtra = extra ?? null;
    const { session, file: sessionFile, resumed } = await openSession({ config, name: values.session ?? null });
    let model = config.model;
    let pendingParts = [];
    let toolset = null;
    let store = null;
    const tools = { web: Boolean(config.tools.web), images: Boolean(config.tools.images) };
    const rl = renderer.readline();
    const tty = renderer.mode === 'tty';
    const paint = (format, text) => (tty ? styleText(format, text, { stream: process.stderr }) : text);

    /**
     * Turn local tools on or off for later messages. Opens project memory the first time tools are enabled.
     * @param {string|boolean|null|undefined} list on, none, off, or a comma list such as fs,shell,fetch.
     * @returns {string} Status line for the renderer.
     * @ai.hint io
     */
    function enableLocalTools(list) {
        if (!list || list === 'none' || list === 'off') { toolset = null; return 'локальные инструменты выключены'; }
        const selection = list === 'on' || list === true ? { fs: true, shell: true, fetch: true, askUser: true }
            : Object.fromEntries(['fs', 'shell', 'fetch', 'askUser', 'channels'].map((name) => [name, list.split(',').map((s) => s.trim()).includes(name)]));
        store ??= openMemoryFor(config, ctx.cwd, renderer);
        const names = enabledToolNames({ ...config.tools, ...selection, askUser: false }, { interactive: false, memory: Boolean(store) });
        if (!names.length) { toolset = null; return 'локальные инструменты выключены'; }
        ctx.backupDir ??= backupDirFor(config);
        toolset = createToolset({
            root: ctx.cwd, config, client, ledger, names, approvalLevel: approvalLevel(config, true),
            approve: (request) => renderer.approve(request, { signal: ctx.turnSignal() }), askUser: null,
            backupDir: ctx.backupDir, signal, emit, memory: store?.memory ?? null, projectKey: store?.projectKey ?? null, projectName: store?.projectName ?? null,
        });
        return `локальные инструменты: ${names.join(', ')} · доступ ${toolset.approvalLevel} · каталог ${ctx.cwd}${store ? ' · память' : ''}`;
    }
    if (values.tools !== undefined) renderer.line('info', enableLocalTools(values.tools), { dim: true });

    renderer.line('info', `Чат · модель ${model} · сессия ${values.session ? `${values.session}${resumed ? ` (продолжена, ${session.size} элементов)` : ' (новая)'}` : 'временная'} · /help — команды`, { dim: true });

    /**
     * Read one user message. A trailing backslash continues the line. A """ fence reads until the closing fence.
     * @returns {Promise<string>}
     * @ai.hint io
     */
    async function readMessage() {
        let text = await rl.question(paint('bold', 'вы › '), { signal });
        if (text.startsWith('"""')) {
            let body = text.slice(3);
            while (!body.includes('"""')) body += `\n${await rl.question(paint('gray', '… '), { signal })}`;
            return body.slice(0, body.indexOf('"""')).replace(/^\n/, '').replace(/\n$/, '');
        }
        while (text.endsWith('\\')) text = `${text.slice(0, -1)}\n${await rl.question(paint('gray', '… '), { signal })}`;
        return text;
    }

    /**
     * Handle one slash command. False ends the chat loop.
     * @param {string} line Full input line, including the leading slash.
     * @returns {Promise<boolean>}
     * @ai.hint io
     */
    async function slash(line) {
        const [command, ...rest] = line.slice(1).trim().split(/\s+/);
        const arg = rest.join(' ').trim();
        switch (command) {
            case 'help': case '?': renderer.block(HELP); return true;
            case 'exit': case 'quit': case 'q': return false;
            case 'clear': session.clear(); pendingParts = []; renderer.line('ok', 'История очищена.'); return true;
            case 'image': case 'img': {
                if (!arg) { renderer.line('warn', 'Укажите путь или URL изображения.'); return true; }
                pendingParts.push(...await loadAttachments({ images: [arg], detail: values.detail ?? 'auto', cwd: ctx.cwd, config, renderer }));
                renderer.line('ok', `Изображение будет приложено к следующему сообщению (${pendingParts.length} вложений).`);
                return true;
            }
            case 'file': {
                if (!arg) { renderer.line('warn', 'Укажите путь к файлу.'); return true; }
                pendingParts.push(...await loadAttachments({ files: [arg], cwd: ctx.cwd, config, renderer }));
                renderer.line('ok', `Файл будет приложен к следующему сообщению (${pendingParts.length} вложений).`);
                return true;
            }
            case 'model': if (arg) { model = arg; session.model = arg; } renderer.line('info', `Модель: ${model}`); return true;
            case 'effort':
                if (arg && !REASONING_EFFORTS.includes(arg)) { renderer.line('warn', `Допустимо: ${REASONING_EFFORTS.join(' | ')}`); return true; }
                if (arg) config.reasoning.effort = arg;
                renderer.line('info', `reasoning.effort: ${config.reasoning.effort ?? 'по умолчанию модели'}`); return true;
            case 'tools': renderer.line('info', arg ? enableLocalTools(arg) : toolset ? `локальные инструменты: ${toolset.names().join(', ')}` : 'локальные инструменты выключены (/tools fs,shell,fetch)'); return true;
            case 'approve':
                if (!APPROVAL_LEVELS.includes(arg)) { renderer.line('warn', `Допустимо: ${APPROVAL_LEVELS.join(' | ')}`); return true; }
                config.approve = arg; if (toolset) toolset.approvalLevel = arg;
                renderer.line('info', `Политика подтверждений: ${arg}`); return true;
            case 'web': tools.web = arg ? arg === 'on' : !tools.web; renderer.line('info', `web_search: ${tools.web ? 'включён' : 'выключен'}`); return true;
            case 'images': tools.images = arg ? arg === 'on' : !tools.images; renderer.line('info', `image_generation: ${tools.images ? 'включена' : 'выключена'}`); return true;
            case 'system': systemExtra = arg || null; renderer.line('info', systemExtra ? 'Дополнительные инструкции заданы.' : 'Дополнительные инструкции сброшены.'); return true;
            case 'usage': renderer.line('usage', usageRow(ledger)); return true;
            case 'tokens': {
                const { input } = session.requestInput();
                if (!input.length) { renderer.line('info', 'История пуста.'); return true; }
                renderer.setStatus('считает токены…');
                try {
                    const counted = await client.responses.inputTokens({ model, input, instructions: composeInstructions(ASSISTANT_BASE, config, systemExtra) }, { signal });
                    renderer.idle();
                    renderer.line('info', `Входных токенов в текущем контексте: ${formatNumber(counted.input_tokens ?? NaN)} (${session.size} элементов)`);
                } catch (error) { renderer.idle(); renderer.line('fail', error.message); }
                return true;
            }
            case 'compact': {
                if (session.store) { renderer.line('warn', 'В режиме --store контекст хранится на сервере; компактизация не требуется.'); return true; }
                renderer.setStatus('сжимает контекст…');
                try {
                    const done = await compactSession({ client, session, model, instructions: composeInstructions(ASSISTANT_BASE, config, systemExtra), signal });
                    renderer.idle();
                    renderer.line('ok', `Контекст сжат: ${done.before} → ${done.after} элементов.`);
                } catch (error) { renderer.idle(); renderer.line('fail', error.message); }
                return true;
            }
            case 'history': renderer.block(session.transcript() || '(пусто)'); return true;
            case 'save': {
                const target = arg || sessionFile;
                if (!target) { renderer.line('warn', 'Укажите файл: /save path.json (или запустите чат с --session имя).'); return true; }
                await session.save(target); renderer.line('ok', `Сессия сохранена: ${target}`); return true;
            }
            default: renderer.line('warn', `Неизвестная команда /${command}; /help — список команд.`); return true;
        }
    }

    let exit = 0;
    try {
        for (;;) {
            let text;
            try { text = await readMessage(); }
            catch (error) {
                if (signal.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || error?.code === 'ERR_USE_AFTER_CLOSE') break;
                throw error;
            }
            const trimmed = text.trim();
            if (!trimmed) continue;
            if (trimmed.startsWith('/')) {
                try { if (!(await slash(trimmed))) break; }
                catch (error) { renderer.line('fail', error.message); }
                continue;
            }
            session.addUserMessage(buildUserMessage({ text, parts: pendingParts }));
            pendingParts = [];
            const turnController = new AbortController();
            ctx.setTurnController(turnController);
            const turnSignal = AbortSignal.any([signal, turnController.signal]);
            renderer.begin();
            renderer.ledger = ledger.snapshot();
            const result = await runTurn({
                client, config, session, ledger, toolset, builtin: builtinTools(config, tools), model,
                instructions: composeInstructions(ASSISTANT_BASE, config, systemExtra), imageTarget: config.image.outputDir,
                maxTurns: toolset ? config.limits.maxTurns : 1, signal: turnSignal, emit,
            });
            ctx.setTurnController(null);
            renderer.idle();
            if (!config.stream && (result.text || result.refusal)) renderer.text(`${result.text || result.refusal}\n`);
            renderer.ensureNewline();
            if (result.status === 'cancelled') renderer.line('warn', 'Ответ прерван.');
            else if (result.status !== 'completed') renderer.line(result.status === 'failed' ? 'fail' : 'warn', `${STATUS_LABELS[result.status] ?? result.status}${result.error ? `: ${result.error.message}` : ''}`);
            if (sessionFile) await session.save(sessionFile).catch((error) => renderer.line('warn', `Не удалось сохранить сессию: ${error.message}`));
            if (signal.aborted) break;
        }
    } finally {
        renderer.idle();
        renderer.summary({ title: 'сессия', rows: [['сообщений', `${session.turns}`], ['токены', usageRow(ledger)], ...(sessionFile ? [['файл', sessionFile]] : [])] });
        if (values.out && session.size) {
            const target = await writeOutput(values.out, session.transcript(), { cwd: ctx.cwd });
            renderer.line('ok', `Расшифровка сохранена: ${target}`);
        }
        store?.memory.close();
        client.close();
    }
    return signal.aborted ? 130 : exit;
}
