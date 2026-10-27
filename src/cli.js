/**
 * @file src/cli.js
 * @module cli
 * @purpose Parse argv, dispatch one command, and map failures to process exit codes.
 * @depends node:path, node:util, node:fs/promises, node:url, node:module, core/config, ui/renderer, jobs/manager, openai/errors, commands/shared, commands/ask, commands/chat, commands/run, commands/image, commands/jobs, commands/memory, commands/misc, commands/map, commands/complete, commands/gen, commands/mcp, commands/channels, cli-help
 * @usedBy bin/ai
 * @exports HELP, stripDetach, main
 * @ai.tags cli, dispatch
 * @ai.hint keep
 * @changed 2026-10-15 Load .env and repair a split Windows API key and base URL.
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { loadConfig } from './core/config.js';
import { refreshRuntimeEnv, setLiveEnv } from './core/runtime-env.js';
import { createRenderer, detectMode } from './ui/renderer.js';
import { createJobManager } from './jobs/manager.js';
import { ApiError, BudgetError, CancelledError, isAbortError } from './openai/errors.js';
import { UsageError, overridesFrom } from './commands/shared.js';
import { ask } from './commands/ask.js';
import { chat } from './commands/chat.js';
import { run } from './commands/run.js';
import { image } from './commands/image.js';
import { jobs } from './commands/jobs.js';
import { memoryCommand } from './commands/memory.js';
import { resume, cancel, models, configCommand, agentsCommand } from './commands/misc.js';
import { mapCommand } from './commands/map.js';
import { complete } from './commands/complete.js';
import { gen } from './commands/gen.js';
import { mcpCommand } from './commands/mcp.js';
import { decide, moderate, channels, telegram } from './commands/channels.js';
import { serve } from './commands/serve.js';
import { attachPublisher, splitServeUrl } from './server/publish.js';

const pkg = createRequire(import.meta.url)('../package.json');

import { HELP } from './cli-help.js';
export { HELP };

const OPTIONS = {
    model: { type: 'string', short: 'm' }, effort: { type: 'string' }, 'max-effort': { type: 'string' }, summary: { type: 'string' },
    reasoning: { type: 'boolean', default: true }, instructions: { type: 'string', short: 'i' },
    image: { type: 'string', multiple: true }, file: { type: 'string', short: 'f', multiple: true }, detail: { type: 'string' },
    out: { type: 'string', short: 'o' }, session: { type: 'string', short: 's' }, store: { type: 'boolean', default: false },
    web: { type: 'boolean', default: false }, 'no-web': { type: 'boolean', default: false }, images: { type: 'boolean', default: false }, desktop: { type: 'boolean', default: false }, 'unsafe-screenshot': { type: 'boolean', default: false }, tools: { type: 'string' },
    'no-tools': { type: 'boolean', default: false }, agents: { type: 'boolean' }, 'agents-file': { type: 'string' }, approve: { type: 'string' }, yes: { type: 'boolean', short: 'y', default: false },
    cwd: { type: 'string', short: 'C' }, 'max-turns': { type: 'string' }, 'budget-usd': { type: 'string' }, 'budget-tokens': { type: 'string' },
    'max-output-tokens': { type: 'string' }, temperature: { type: 'string' }, verbosity: { type: 'string' }, shell: { type: 'string' },
    background: { type: 'boolean', short: 'b', default: false }, detach: { type: 'boolean', short: 'd', default: false }, job: { type: 'string' },
    json: { type: 'boolean', default: false }, quiet: { type: 'boolean', short: 'q', default: false }, verbose: { type: 'boolean', short: 'v', default: false },
    stream: { type: 'boolean', default: true }, config: { type: 'string' }, 'base-url': { type: 'string' }, timeout: { type: 'string' },
    size: { type: 'string' }, quality: { type: 'string' }, format: { type: 'string' }, 'image-background': { type: 'string' },
    partials: { type: 'string' }, 'image-model': { type: 'string' }, count: { type: 'string', short: 'n' }, schema: { type: 'string' },
    follow: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false }, version: { type: 'boolean', short: 'V', default: false },
    role: { type: 'string', multiple: true }, single: { type: 'boolean', default: false }, team: { type: 'boolean', default: false },
    route: { type: 'string' }, 'no-chain': { type: 'boolean', default: false }, 'no-resume': { type: 'boolean', default: false },
    coordinator: { type: 'boolean' }, extract: { type: 'string' }, 'no-extract': { type: 'boolean', default: false },
    orchestrator: { type: 'boolean' },
    measure: { type: 'string' }, 'no-measure': { type: 'boolean', default: false },
    decor: { type: 'string' }, 'no-decor': { type: 'boolean', default: false },
    architect: { type: 'string' }, 'no-architect': { type: 'boolean', default: false },
    memory: { type: 'boolean', default: true }, global: { type: 'boolean', default: false }, kind: { type: 'string' }, tags: { type: 'string' },
    listen: { type: 'boolean', default: false }, port: { type: 'string' }, line: { type: 'string' }, character: { type: 'string' },
    language: { type: 'string' }, token: { type: 'string' }, serve: { type: 'boolean', default: false },
    fidelity: { type: 'string' }, creativity: { type: 'string' }, platform: { type: 'string' },
    speed: { type: 'string' }, pace: { type: 'string' }, 'max-steps': { type: 'string' }, context: { type: 'string' },
    'code-quality': { type: 'string' }, 'decor-quality': { type: 'string' }, 'image-quality': { type: 'string' },
    'measurer-quality': { type: 'string' }, 'architect-quality': { type: 'string' },
    template: { type: 'string', multiple: true }, example: { type: 'string', multiple: true },
    'mcp-command': { type: 'string' }, 'mcp-arg': { type: 'string', multiple: true },
    'mcp-url': { type: 'string' }, 'mcp-description': { type: 'string' }, 'mcp-approval': { type: 'string' },
};

const COMMANDS = { ask, chat, run, image, jobs, memory: memoryCommand, resume, cancel, models, config: configCommand, agents: agentsCommand, map: mapCommand, complete, gen, mcp: mcpCommand, decide, moderate, channels, telegram, serve };
const NEEDS_API_KEY = new Set(['ask', 'chat', 'run', 'image', 'resume', 'cancel', 'models', 'gen', 'decide', 'moderate', 'channels']);
const DETACHABLE = new Set(['ask', 'run', 'image', 'gen']);

/**
 * Remove --detach / -d (also inside combined short groups like -dv) from the raw argv.
 * @param {string[]} argv Arguments after the node binary and script path.
 * @returns {string[]} Copy with detach flags removed.
 * @exports
 * @ai.hint pure
 */
export function stripDetach(argv) {
    const result = [];
    for (const arg of argv) {
        if (arg === '--detach') continue;
        if (/^-[a-zA-Z]+$/.test(arg) && arg.includes('d')) {
            const rest = arg.slice(1).replace('d', '');
            if (rest) result.push(`-${rest}`);
            continue;
        }
        result.push(arg);
    }
    return result;
}

/**
 * Parse argv, run the selected command, and return a process exit code.
 * bin/ai.js calls this. Handles --help, --version, --detach, and SIGINT.
 * @param {string[]} [argv=process.argv.slice(2)] Raw command-line arguments.
 * @returns {Promise<number>} 0 success, 1 failure, 2 usage, 130 cancelled.
 * @exports
 * @ai.hint io
 */
export async function main(argvInput = process.argv.slice(2)) {
    const split = splitServeUrl(argvInput);
    const argv = split.argv;
    let values, positionals;
    let publisher = null;
    try {
        ({ values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true, allowNegative: true }));
    } catch (error) {
        process.stderr.write(`Ошибка аргументов: ${error.message}\nСправка: ai --help\n`);
        return 2;
    }
    if (values.version) { process.stdout.write(`${pkg.name} ${pkg.version}\n`); return 0; }
    const hasCommand = positionals.length && Object.hasOwn(COMMANDS, positionals[0]);
    const commandName = hasCommand ? positionals[0] : positionals[0] === 'help' ? 'help' : 'ask';
    const rest = hasCommand || commandName === 'help' ? positionals.slice(1) : positionals;
    if (values.help || commandName === 'help') { process.stdout.write(HELP); return 0; }

    const mode = detectMode({ json: values.json, quiet: values.quiet });
    const renderer = createRenderer({ mode, showReasoning: values.reasoning !== false, verbose: values.verbose });
    const controller = new AbortController();
    let turnController = null;
    let interrupts = 0;
    /**
     * Abort the active turn on the first SIGINT, the whole run on the second, and exit on the third.
     * @returns {void}
     * @ai.hint io
     */
    const onInterrupt = () => {
        interrupts++;
        if (turnController && !turnController.signal.aborted) {
            turnController.abort(new CancelledError('Ответ прерван пользователем.'));
            renderer.line('warn', 'Прерывание текущего ответа… (ещё раз Ctrl-C — выход)');
        } else if (!controller.signal.aborted) {
            controller.abort(new CancelledError('Операция отменена пользователем.'));
            renderer.line('warn', 'Отмена…');
        } else if (interrupts >= 3) {
            process.exit(130);
        }
    };
    renderer.onInterrupt = onInterrupt;
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onInterrupt);

    let reporter = null;
    let exitCode = 1;
    try {
        const major = Number(process.versions.node.split('.')[0]);
        if (major < 26) throw new UsageError(`Нужен Node.js 26+; запущен ${process.versions.node}.`);
        const cwd = path.resolve(values.cwd ?? '.');
        if (!(await stat(cwd).then((s) => s.isDirectory()).catch(() => false))) throw new UsageError(`Каталог не найден: ${cwd}`);
        const runtimeEnv = await refreshRuntimeEnv({ cwd });
        setLiveEnv(runtimeEnv);
        const config = await loadConfig({
            configPath: values.config, overrides: overridesFrom(values, { command: commandName }), env: runtimeEnv, cwd,
        });
        if (NEEDS_API_KEY.has(commandName) && !config.apiKey) {
            throw new UsageError('Не задан OPENAI_API_KEY. Укажите его в .env, в окружении или в ~/.ai-agent/config.json.');
        }

        if (values.detach) {
            if (values.job) throw new UsageError('--detach нельзя сочетать с --job.');
            if (!DETACHABLE.has(commandName)) throw new UsageError('--detach поддерживается для ask, run, image и gen.');
            const manager = createJobManager({ home: config.home });
            const childArgv = stripDetach(argv);
            const title = `${commandName} ${rest.join(' ')}`.trim();
            const { id } = await manager.create({ title, argv: childArgv, cwd });
            const pid = await manager.spawnDetached({ id, script: fileURLToPath(new URL('../bin/ai.js', import.meta.url)), argv: childArgv, cwd });
            if ((commandName === 'run' || commandName === 'gen') && !config.approve) {
                renderer.line('warn', 'Фоновая задача неинтерактивна: без --approve write|all агент сможет только читать файлы.');
            }
            renderer.write(`Фоновая задача ${id} запущена (pid ${pid}).\n  статус:  ai jobs status ${id}\n  журнал:  ai jobs log ${id} --follow\n  стоп:    ai jobs cancel ${id}\n`);
            renderer.json({ type: 'job.started', id, pid, title });
            return 0;
        }
        if (values.job) {
            reporter = createJobManager({ home: config.home }).reporter(values.job);
            renderer.onStatus = (status) => reporter.status(status);
        }
        if (values.serve) {
            if (commandName === 'serve') throw new UsageError('ai serve --serve нельзя сочетать.');
            publisher = await attachPublisher({
                home: config.home, url: split.serveUrl, command: commandName,
                title: `${commandName} ${rest.join(' ')}`.trim(), cwd,
            });
        }
        const emit = (event) => { renderer.handle(event); publisher?.event(event); reporter?.event(event); };
        const ctx = {
            argv, values, positionals: rest, config, renderer, controller, signal: controller.signal, emit, cwd, reporter, backupDir: null,
            /**
             * Remember the AbortController for the turn that is running now.
             * @param {AbortController|null} next Controller the next SIGINT aborts.
             * @returns {void}
             * @ai.hint pure
             */
            setTurnController(next) { turnController = next; },
            turnSignal: () => (turnController ? AbortSignal.any([controller.signal, turnController.signal]) : controller.signal),
        };
        exitCode = await COMMANDS[commandName](ctx);
        return exitCode;
    } catch (error) {
        renderer.idle();
        if (error instanceof UsageError) {
            renderer.line('fail', error.message);
            renderer.line('info', 'Справка: ai --help', { dim: true });
            exitCode = 2;
        } else if (isAbortError(error) || controller.signal.aborted) {
            renderer.line('warn', 'Отменено.');
            exitCode = 130;
        } else if (error instanceof ApiError) {
            const details = [error.status ? `HTTP ${error.status}` : null, error.apiCode ? `код ${error.apiCode}` : null,
                error.requestId ? `request-id ${error.requestId}` : null].filter(Boolean).join(', ');
            renderer.line('fail', `${error.message}${details ? ` (${details})` : ''}`);
            if (error.code === 'NO_API_KEY') renderer.line('info', 'Задайте OPENAI_API_KEY в окружении.', { dim: true });
            if (values.verbose && error.cause) renderer.line('info', String(error.cause?.stack ?? error.cause), { dim: true });
            exitCode = 1;
        } else if (error instanceof BudgetError) {
            renderer.line('fail', error.message);
            exitCode = 1;
        } else {
            renderer.line('fail', `Ошибка: ${error.message}`);
            if (values.verbose && error.stack) renderer.line('info', error.stack, { dim: true });
            exitCode = 1;
        }
        renderer.json({ type: 'fatal', message: error.message, code: error.code ?? null, exitCode });
        await reporter?.finish({ status: exitCode === 130 ? 'cancelled' : 'failed', text: '', error: { message: error.message, code: error.code ?? null } }, exitCode).catch(() => {});
        return exitCode;
    } finally {
        try { await publisher?.end(exitCode === 0 ? 'completed' : exitCode === 130 ? 'cancelled' : 'failed', exitCode); }
        catch { /* the bus is already gone */ }
        publisher?.close();
        process.off('SIGINT', onInterrupt);
        process.off('SIGTERM', onInterrupt);
        renderer.close();
    }
}
