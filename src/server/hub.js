/**
 * @file src/server/hub.js
 * @module server/hub
 * @purpose Run list, token check, subscribers, and approval waits for ai serve.
 * @depends node:crypto
 * @usedBy commands/serve, index.js
 * @exports createHub
 * @ai.tags websocket, runs
 * @ai.hint pure
 * @changed 2026-10-17 Claim registry for client-run tool holders.
 */

import { randomUUID } from 'node:crypto';

const COMMANDS = new Set(['ask', 'run', 'chat', 'image']);
const APPROVE = new Set(['ask', 'read', 'write', 'all']);
const DECISIONS = new Set(['yes', 'no', 'always', 'abort']);
const END_STATUS = new Set(['completed', 'failed', 'cancelled']);
const START_FIELDS = new Set([
    'type', 'command', 'prompt', 'cwd', 'approve', 'effort', 'summary', 'instructions', 'images', 'files', 'detail',
    'out', 'session', 'store', 'web', 'imagesTool', 'tools', 'noTools', 'maxTurns', 'budgetUsd', 'budgetTokens',
    'maxOutputTokens', 'temperature', 'verbosity', 'shell', 'stream', 'size', 'quality', 'format', 'imageBackground',
    'partials', 'imageModel', 'count', 'schema', 'role', 'single', 'team', 'memory', 'processing',
]);
const REJECTED = new Set(['background', 'detach', 'job']);

/**
 * @param {unknown} value
 * @returns {boolean}
 * @ai.hint pure
 */
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {string} code
 * @param {string} message
 * @returns {{ type: 'error', code: string, message: string }}
 * @ai.hint pure
 */
function errorFrame(code, message) {
    return { type: 'error', code, message };
}

/**
 * @returns {Error}
 * @ai.hint pure
 */
function abortError() {
    const error = new Error('Отменено.');
    error.name = 'AbortError';
    error.code = 'ABORT_ERR';
    return error;
}

/**
 * @param {object} run
 * @returns {object}
 * @ai.hint pure
 */
function publicRun(run) {
    return { id: run.id, source: run.source, command: run.command, title: run.title, cwd: run.cwd, status: run.status, startedAt: run.startedAt };
}

/**
 * Track runs and fan out frames. `createId` names runs and approval requests. Socket ids are separate.
 * @param {{ token: string, onStart?: Function, createId?: () => string, now?: () => string }} options
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function createHub({ token, onStart = async () => {}, createId = () => randomUUID(), now = () => new Date().toISOString() }) {
    /** @type {Map<string, object>} */
    const sockets = new Map();
    /** @type {Map<string, object>} */
    const runs = new Map();
    /** @type {Map<string, { runId: string, ownerId: string, kind: string, resolve: Function }>} */
    const pending = new Map();

    /**
     * @param {object} socket
     * @param {object} frame
     * @returns {void}
     * @ai.hint pure
     */
    const send = (socket, frame) => { try { socket.send(frame); } catch { /* observer */ } };

    /**
     * @param {object} frame
     * @param {(socket: object) => boolean} [include]
     * @returns {void}
     * @ai.hint pure
     */
    const broadcast = (frame, include = (socket) => socket.authed) => {
        for (const socket of sockets.values()) if (include(socket)) send(socket, frame);
    };

    /**
     * @param {string} runId
     * @param {object} event
     * @returns {void}
     * @ai.hint pure
     */
    function publish(runId, event) {
        broadcast({ type: 'run.event', runId, event }, (socket) => socket.authed && socket.role !== 'publisher' && (socket.all || socket.subs.has(runId)));
    }

    /**
     * @param {string} runId
     * @param {string} status
     * @param {number} exitCode
     * @returns {void}
     * @ai.hint pure
     */
    function finish(runId, status, exitCode) {
        const run = runs.get(runId);
        if (!run || run.status !== 'running') return;
        run.status = status;
        broadcast({ type: 'run.ended', runId, status, exitCode });
        const waiters = run.waiters;
        run.waiters = [];
        for (const waiter of waiters) waiter.reject(abortError());
        for (const [requestId, item] of pending) {
            if (item.runId !== runId) continue;
            if (item.kind === 'tool') item.resolve(abortError());
            else item.resolve(item.kind === 'question' ? null : 'abort');
            pending.delete(requestId);
        }
        runs.delete(runId);
    }

    /**
     * @param {object} transport
     * @returns {object}
     * @ai.hint pure
     */
    function connect(transport) {
        const socket = {
            id: randomUUID(),
            send: (frame) => transport.send(frame),
            close: (code) => transport.close(code),
            role: null,
            authed: false,
            subs: new Set(),
            all: false,
            runId: null,
        };
        sockets.set(socket.id, socket);
        return socket;
    }

    /**
     * @param {object} socket
     * @returns {void}
     * @ai.hint pure
     */
    function disconnect(socket) {
        sockets.delete(socket.id);
        for (const run of [...runs.values()]) {
            if (run.status !== 'running') continue;
            if (run.ownerId === socket.id) {
                run.controller?.abort();
                finish(run.id, 'cancelled', 130);
                continue;
            }
            if (run.source !== 'client') continue;
            let lost = false;
            for (const [name, holderId] of [...run.holders.entries()]) {
                if (holderId !== socket.id) continue;
                run.holders.delete(name);
                lost = true;
            }
            for (const item of [...pending.values()]) {
                if (item.kind === 'tool' && item.runId === run.id && item.holderId === socket.id) {
                    item.resolve(new Error('Держатель инструмента отключился.'));
                }
            }
            if (lost) publishHeld(run);
        }
    }

    /**
     * @returns {void}
     * @ai.hint pure
     */
    function shutdown() {
        for (const run of [...runs.values()]) {
            if (run.status !== 'running') continue;
            if (run.source === 'terminal') finish(run.id, 'detached', 0);
            else {
                run.controller?.abort();
                finish(run.id, 'cancelled', 130);
            }
        }
    }

    /**
     * @param {string} runId
     * @param {{ name?: string, category?: string, preview?: string }} request
     * @param {AbortSignal} [signal]
     * @returns {Promise<'yes'|'no'|'always'|'abort'>}
     * @ai.hint pure
     */
    function requestApproval(runId, request, signal) {
        return waitControl(runId, 'approval', signal, 'abort', (requestId) => {
            publish(runId, { type: 'approval.pending', name: request.name, category: request.category });
            const run = runs.get(runId);
            const owner = run ? sockets.get(run.ownerId) : null;
            owner?.send({ type: 'approval.request', runId, requestId, name: request.name ?? null, category: request.category ?? null, preview: request.preview ?? '' });
        });
    }

    /**
     * @param {string} runId
     * @param {string} question
     * @param {AbortSignal} [signal]
     * @returns {Promise<string|null>}
     * @ai.hint pure
     */
    function requestQuestion(runId, question, signal) {
        return waitControl(runId, 'question', signal, null, (requestId) => {
            publish(runId, { type: 'question.pending', question });
            const run = runs.get(runId);
            const owner = run ? sockets.get(run.ownerId) : null;
            owner?.send({ type: 'question.request', runId, requestId, question });
        });
    }

    /**
     * @param {string} runId
     * @param {'approval'|'question'} kind
     * @param {AbortSignal|undefined} signal
     * @param {'abort'|null} aborted
     * @param {(requestId: string) => void} notify
     * @returns {Promise<any>}
     * @ai.hint pure
     */
    function waitControl(runId, kind, signal, aborted, notify) {
        const run = runs.get(runId);
        if (!run || signal?.aborted) return Promise.resolve(aborted);
        const requestId = createId();
        return new Promise((resolve) => {
            /**
             * @param {any} value
             * @returns {void}
             * @ai.hint pure
             */
            const done = (value) => {
                pending.delete(requestId);
                signal?.removeEventListener('abort', onAbort);
                resolve(value);
            };
            /**
             * @returns {void}
             * @ai.hint pure
             */
            const onAbort = () => done(aborted);
            pending.set(requestId, { runId, ownerId: run.ownerId, kind, resolve: done });
            if (signal) signal.addEventListener('abort', onAbort, { once: true });
            notify(requestId);
        });
    }

    /**
     * @param {string} runId
     * @param {AbortSignal} [signal]
     * @returns {Promise<string>}
     * @ai.hint pure
     */
    function waitInput(runId, signal) {
        const run = runs.get(runId);
        if (!run) return Promise.reject(abortError());
        if (run.queue.length) return Promise.resolve(run.queue.shift());
        return new Promise((resolve, reject) => {
            /**
             * @param {Error} error
             * @returns {void}
             * @ai.hint pure
             */
            const fail = (error) => {
                run.waiters = run.waiters.filter((item) => item.reject !== fail);
                signal?.removeEventListener('abort', onAbort);
                reject(error);
            };
            /**
             * @returns {void}
             * @ai.hint pure
             */
            const onAbort = () => fail(abortError());
            run.waiters.push({
                resolve: (text) => { signal?.removeEventListener('abort', onAbort); resolve(text); },
                reject: fail,
            });
            if (signal) signal.addEventListener('abort', onAbort, { once: true });
        });
    }

    /**
     * @param {object} socket
     * @param {object} frame
     * @returns {Promise<void>}
     * @ai.hint io
     */
    async function receive(socket, frame) {
        if (!isRecord(frame) || typeof frame.type !== 'string') {
            send(socket, errorFrame('bad_request', 'Кадр должен быть JSON-объектом.'));
            return;
        }
        if (!socket.authed) {
            if (frame.type !== 'hello') {
                send(socket, errorFrame('unauthorized', 'Сначала отправьте hello с токеном.'));
                socket.close(1008);
                return;
            }
            if (frame.token !== token) {
                send(socket, errorFrame('unauthorized', 'Неверный токен.'));
                socket.close(1008);
                return;
            }
            if (frame.role === 'client') {
                socket.authed = true;
                socket.role = 'client';
                send(socket, { type: 'ready', runs: [...runs.values()].filter((run) => run.status === 'running').map(publicRun) });
                return;
            }
            if (frame.role === 'publisher') {
                if (!COMMANDS.has(frame.command) || typeof frame.title !== 'string' || typeof frame.cwd !== 'string') {
                    send(socket, errorFrame('bad_request', 'Для publisher нужны command, title и cwd.'));
                    return;
                }
                const run = openRun(socket, { source: 'terminal', command: frame.command, title: frame.title, cwd: frame.cwd, prompt: '' });
                socket.runId = run.id;
                socket.authed = true;
                socket.role = 'publisher';
                send(socket, { type: 'ready', runs: [...runs.values()].filter((item) => item.status === 'running').map(publicRun) });
                broadcast({ type: 'run.started', run: publicRun(run) });
                return;
            }
            send(socket, errorFrame('bad_request', 'role: client или publisher.'));
            return;
        }
        if (frame.type === 'hello') {
            send(socket, errorFrame('conflict', 'Повторный hello.'));
            return;
        }
        if (frame.type === 'start') return start(socket, frame);
        if (frame.type === 'subscribe') return subscribe(socket, frame.runId, true);
        if (frame.type === 'unsubscribe') return subscribe(socket, frame.runId, false);
        if (frame.type === 'event') return event(socket, frame);
        if (frame.type === 'end') return end(socket, frame);
        if (frame.type === 'cancel') return cancel(socket, frame.runId);
        if (frame.type === 'input') return input(socket, frame);
        if (frame.type === 'approve' || frame.type === 'answer') return control(socket, frame);
        if (frame.type === 'processing.claim') return claim(socket, frame);
        if (frame.type === 'tool.result') return toolResult(socket, frame);
        send(socket, errorFrame('unknown_type', `Неизвестный тип кадра: ${frame.type}.`));
    }

    const PROCESSABLE = ['delete_file', 'list_files', 'read_file', 'replace_text', 'run_command', 'run_script', 'search_files', 'write_file'];
    const PROCESSABLE_SET = new Set(PROCESSABLE);

    /**
     * @param {unknown} list
     * @param {string} label
     * @returns {string} Empty when the list is a set of processable names.
     * @ai.hint pure
     */
    function validateToolList(list, label) {
        if (!Array.isArray(list)) return `${label} должен быть массивом.`;
        const seen = new Set();
        for (const name of list) {
            if (seen.has(name)) return `Имя инструмента повторяется: ${name}.`;
            seen.add(name);
        }
        for (const name of list) {
            if (typeof name !== 'string' || !PROCESSABLE_SET.has(name)) return `Инструмент недоступен для захвата: ${name}.`;
        }
        return '';
    }

    /**
     * @param {object} run
     * @returns {string[]}
     * @ai.hint pure
     */
    function sortedHeld(run) {
        return [...run.holders.keys()].sort();
    }

    /**
     * @param {object} run
     * @returns {void}
     * @ai.hint pure
     */
    function publishHeld(run) {
        if (run.status !== 'running') return;
        publish(run.id, { type: 'processing.held', tools: sortedHeld(run) });
    }

    /**
     * Replace this socket's names on the run with `tools`.
     * @param {object} run
     * @param {object} socket
     * @param {string[]} tools
     * @returns {void}
     * @ai.hint pure
     */
    function applyClaim(run, socket, tools) {
        const next = new Set(tools);
        /** @type {Map<string, string[]>} */
        const released = new Map();
        for (const [name, holderId] of [...run.holders.entries()]) {
            const mine = holderId === socket.id;
            if (mine && !next.has(name)) run.holders.delete(name);
            if (!mine && next.has(name)) {
                run.holders.delete(name);
                const names = released.get(holderId) ?? [];
                names.push(name);
                released.set(holderId, names);
            }
        }
        for (const name of tools) run.holders.set(name, socket.id);
        for (const [holderId, names] of released) {
            sockets.get(holderId)?.send({ type: 'processing.released', runId: run.id, tools: names.sort() });
        }
        socket.send({ type: 'processing.claimed', runId: run.id, tools: [...tools] });
        publishHeld(run);
    }

    /**
     * @param {object} socket
     * @param {object} frame
     * @returns {void}
     * @ai.hint pure
     */
    function claim(socket, frame) {
        const run = typeof frame.runId === 'string' ? runs.get(frame.runId) : null;
        if (!run || run.status !== 'running') {
            send(socket, errorFrame('unknown_run', 'Запуск не найден или уже завершён.'));
            return;
        }
        if (run.source !== 'client') {
            send(socket, errorFrame('bad_request', 'Захват доступен только для клиентского запуска.'));
            return;
        }
        const problem = validateToolList(frame.tools, 'tools');
        if (problem) {
            send(socket, errorFrame('bad_request', problem));
            return;
        }
        applyClaim(run, socket, frame.tools);
    }

    const CHANGE_OPS = new Set(['create', 'overwrite', 'edit', 'delete']);

    /**
     * @param {unknown} changes
     * @returns {{ changes?: { op: string, path: string }[], error?: string }}
     * @ai.hint pure
     */
    function parseChanges(changes) {
        if (changes === undefined) return { changes: [] };
        if (!Array.isArray(changes) || changes.length > 100) return { error: 'changes: op create, overwrite, edit или delete и path-строка.' };
        const parsed = [];
        for (const item of changes) {
            if (!isRecord(item) || !CHANGE_OPS.has(item.op) || typeof item.path !== 'string') {
                return { error: 'changes: op create, overwrite, edit или delete и path-строка.' };
            }
            parsed.push({ op: item.op, path: item.path });
        }
        return { changes: parsed };
    }

    /**
     * @param {string} runId
     * @param {string} name
     * @param {object} args
     * @param {AbortSignal} [signal]
     * @returns {Promise<null | { output: string, summary: string, changes: { op: string, path: string }[] }>}
     * @ai.hint pure
     */
    function requestTool(runId, name, args, signal) {
        if (signal?.aborted) return Promise.reject(abortError());
        const run = runs.get(runId);
        if (!run || run.status !== 'running') return Promise.reject(new Error('Запуск не найден.'));
        const holderId = run.holders.get(name);
        if (!holderId) return Promise.resolve(null);
        const holder = sockets.get(holderId);
        if (!holder) return Promise.reject(new Error('Держатель инструмента отключился.'));
        const requestId = createId();
        return new Promise((resolve, reject) => {
            let settled = false;
            /**
             * @param {Error | null} error
             * @param {object} [value]
             * @returns {void}
             * @ai.hint pure
             */
            const done = (error, value) => {
                if (settled) return;
                settled = true;
                pending.delete(requestId);
                signal?.removeEventListener('abort', onAbort);
                if (error) reject(error);
                else resolve(value);
            };
            /** @returns {void} */
            const onAbort = () => done(abortError());
            pending.set(requestId, { runId, holderId, kind: 'tool', resolve: done });
            if (signal) signal.addEventListener('abort', onAbort, { once: true });
            holder.send({ type: 'tool.request', runId, requestId, name, args });
        });
    }

    /**
     * @param {object} socket
     * @param {object} frame
     * @returns {void}
     * @ai.hint pure
     */
    function toolResult(socket, frame) {
        const item = typeof frame.requestId === 'string' ? pending.get(frame.requestId) : null;
        if (!item || item.kind !== 'tool') {
            send(socket, errorFrame('bad_request', 'Неизвестный requestId.'));
            return;
        }
        if (item.holderId !== socket.id) {
            send(socket, errorFrame('bad_request', 'Этот requestId адресован другому сокету.'));
            return;
        }
        if (frame.error !== undefined && typeof frame.error !== 'string') {
            send(socket, errorFrame('bad_request', 'error должен быть строкой.'));
            return;
        }
        if (typeof frame.error === 'string' && frame.error.trim()) {
            item.resolve(new Error(frame.error));
            return;
        }
        if (typeof frame.output !== 'string' || typeof frame.summary !== 'string') {
            send(socket, errorFrame('bad_request', 'output и summary должны быть строками.'));
            return;
        }
        const parsed = parseChanges(frame.changes);
        if (parsed.error) {
            send(socket, errorFrame('bad_request', parsed.error));
            return;
        }
        item.resolve(null, { output: frame.output, summary: frame.summary, changes: parsed.changes });
    }

    /**
     * @param {object} socket
     * @param {{ source: string, command: string, title: string, cwd: string, prompt: string }} fields
     * @returns {object}
     * @ai.hint pure
     */
    function openRun(socket, fields) {
        const run = {
            id: createId(), ownerId: socket.id, status: 'running', startedAt: now(), controller: new AbortController(),
            queue: [], waiters: [], holders: new Map(), ...fields,
        };
        runs.set(run.id, run);
        return run;
    }

    /**
     * @param {object} socket
     * @param {object} frame
     * @returns {void}
     * @ai.hint io
     */
    function start(socket, frame) {
        if (socket.role !== 'client') {
            send(socket, errorFrame('bad_request', 'start доступен только клиенту.'));
            return;
        }
        for (const key of Object.keys(frame)) {
            if (REJECTED.has(key) || !START_FIELDS.has(key)) {
                send(socket, errorFrame('invalid_start', `Недопустимое поле ${key}.`));
                return;
            }
        }
        if (!COMMANDS.has(frame.command)) {
            send(socket, errorFrame('invalid_start', 'Неизвестная команда.'));
            return;
        }
        if (frame.command !== 'chat' && (typeof frame.prompt !== 'string' || !frame.prompt.trim())) {
            send(socket, errorFrame('invalid_start', 'Укажите prompt.'));
            return;
        }
        if (frame.cwd !== undefined && typeof frame.cwd !== 'string') {
            send(socket, errorFrame('invalid_start', 'cwd должен быть строкой.'));
            return;
        }
        if (frame.approve !== undefined && !APPROVE.has(frame.approve)) {
            send(socket, errorFrame('invalid_start', 'approve: ask, read, write или all.'));
            return;
        }
        const listed = frame.processing;
        const claimNow = listed !== undefined && !(Array.isArray(listed) && listed.length === 0);
        if (claimNow) {
            const problem = validateToolList(listed, 'processing');
            if (problem) {
                send(socket, errorFrame('invalid_start', problem));
                return;
            }
        }
        const prompt = typeof frame.prompt === 'string' ? frame.prompt : '';
        const run = openRun(socket, {
            source: 'client', command: frame.command, title: `${frame.command} ${prompt}`.trim().slice(0, 200),
            cwd: typeof frame.cwd === 'string' ? frame.cwd : '', prompt,
        });
        socket.subs.add(run.id);
        broadcast({ type: 'run.started', run: publicRun(run) });
        if (claimNow) applyClaim(run, socket, listed);
        if (frame.command === 'chat' && prompt.trim()) run.queue.push(prompt);
        void Promise.resolve(onStart(run, frame)).catch((error) => {
            publish(run.id, { type: 'warning', message: error.message });
            finish(run.id, 'failed', error.exitCode ?? 1);
        });
    }

    /**
     * @param {object} socket
     * @param {unknown} runId
     * @param {boolean} on
     * @returns {void}
     * @ai.hint pure
     */
    function subscribe(socket, runId, on) {
        if (runId === '*') {
            socket.all = on;
            return;
        }
        if (typeof runId !== 'string' || !runs.has(runId)) {
            send(socket, errorFrame('unknown_run', 'Запуск не найден или уже завершён.'));
            return;
        }
        if (on) socket.subs.add(runId);
        else socket.subs.delete(runId);
    }

    /**
     * @param {object} socket
     * @param {object} frame
     * @returns {void}
     * @ai.hint pure
     */
    function event(socket, frame) {
        if (socket.role !== 'publisher' || !socket.runId) {
            send(socket, errorFrame('bad_request', 'event может отправить только publisher.'));
            return;
        }
        if (!isRecord(frame.event)) {
            send(socket, errorFrame('bad_request', 'event должен быть объектом.'));
            return;
        }
        publish(socket.runId, frame.event);
    }

    /**
     * @param {object} socket
     * @param {object} frame
     * @returns {void}
     * @ai.hint pure
     */
    function end(socket, frame) {
        if (socket.role !== 'publisher' || !socket.runId) {
            send(socket, errorFrame('bad_request', 'end может отправить только publisher.'));
            return;
        }
        if (!END_STATUS.has(frame.status)) {
            send(socket, errorFrame('bad_request', 'status: completed, failed или cancelled.'));
            return;
        }
        const exitCode = Number.isInteger(frame.exitCode) ? frame.exitCode : (frame.status === 'completed' ? 0 : 1);
        finish(socket.runId, frame.status, exitCode);
    }

    /**
     * @param {object} socket
     * @param {unknown} runId
     * @returns {object|null}
     * @ai.hint pure
     */
    function owned(socket, runId) {
        const run = typeof runId === 'string' ? runs.get(runId) : null;
        if (!run || run.status !== 'running') {
            send(socket, errorFrame('unknown_run', 'Запуск не найден или уже завершён.'));
            return null;
        }
        if (run.ownerId !== socket.id) {
            send(socket, errorFrame('not_owner', 'Кадр может отправить только владелец запуска.'));
            return null;
        }
        return run;
    }

    /**
     * @param {object} socket
     * @param {unknown} runId
     * @returns {void}
     * @ai.hint pure
     */
    function cancel(socket, runId) {
        const run = owned(socket, runId);
        if (!run) return;
        run.controller?.abort();
        finish(run.id, 'cancelled', 130);
    }

    /**
     * @param {object} socket
     * @param {object} frame
     * @returns {void}
     * @ai.hint pure
     */
    function input(socket, frame) {
        const run = owned(socket, frame.runId);
        if (!run) return;
        const text = typeof frame.text === 'string' ? frame.text : '';
        const waiter = run.waiters.shift();
        if (waiter) waiter.resolve(text);
        else run.queue.push(text);
    }

    /**
     * @param {object} socket
     * @param {object} frame
     * @returns {void}
     * @ai.hint pure
     */
    function control(socket, frame) {
        const item = typeof frame.requestId === 'string' ? pending.get(frame.requestId) : null;
        if (!item || item.kind === 'tool') {
            send(socket, errorFrame('bad_request', 'Неизвестный requestId.'));
            return;
        }
        if (item.ownerId !== socket.id) {
            send(socket, errorFrame('not_owner', 'Кадр может отправить только владелец запуска.'));
            return;
        }
        if (frame.type === 'approve') {
            if (!DECISIONS.has(frame.decision)) {
                send(socket, errorFrame('bad_request', 'decision: yes, no, always или abort.'));
                return;
            }
            item.resolve(frame.decision);
            return;
        }
        item.resolve(typeof frame.text === 'string' ? frame.text : '');
    }

    return { connect, receive, disconnect, publish, requestApproval, requestQuestion, requestTool, waitInput, finish, shutdown };
}
