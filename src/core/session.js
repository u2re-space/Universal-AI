/**
 * @file src/core/session.js
 * @module core/session
 * @purpose Conversation state: replay items, usage totals, and JSON files under the agent home.
 * @depends node:path, node:crypto, node:fs/promises, util/text
 * @usedBy commands/shared, agent/roles, agent/team
 * @exports createSession, loadSession, sessionFile
 * @ai.tags session
 * @ai.hint io
 * @changed 2026-10-15 JSDoc card, 4-space indent.
 */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { isRecord } from '../util/text.js';

const SESSION_VERSION = 1;

/**
 * Conversation state.
 *
 * store=false (default): the full history is replayed in every request. Output items from
 *   the model are stored as returned (reasoning items only when they carry encrypted_content,
 *   which we request via include=["reasoning.encrypted_content"]). Built-in tool call items
 *   are summarized into assistant messages because they cannot be replayed statelessly.
 * store=true: OpenAI keeps state; every request sends only new items + previous_response_id.
 */
export function createSession({ store = false, model = null, name = null, instructions = null } = {}) {
    const state = {
        version: SESSION_VERSION, id: randomUUID(), name, createdAt: new Date().toISOString(), updatedAt: null,
        model, store, instructions, items: [], lastResponseId: null, pendingFrom: 0, turns: 0,
        usage: { input: 0, cached: 0, output: 0, reasoning: 0, total: 0, costUsd: 0, requests: 0 },
    };

    /**
     * Stamp updatedAt with the current time.
     * @returns {void}
     * @ai.hint pure
     */
    function touch() { state.updatedAt = new Date().toISOString(); }

    /**
     * Append plain input items and stamp updatedAt.
     * @param {object[]} items
     * @returns {void}
     * @ai.hint pure
     */
    function addItems(items) {
        for (const item of items) if (isRecord(item)) state.items.push(item);
        touch();
    }

    /** Items of a response that can be replayed as input in a stateless conversation. */
    function replayable(item, { imagePaths = new Map() } = {}) {
        switch (item?.type) {
            case 'message': {
                const content = Array.isArray(item.content) ? item.content : [];
                return { type: 'message', role: item.role ?? 'assistant', ...(item.id ? { id: item.id } : {}),
                    ...(item.phase ? { phase: item.phase } : {}),
                    content: content.filter((part) => ['output_text', 'refusal', 'input_text'].includes(part?.type))
                        .map((part) => (part.type === 'output_text' ? { type: 'output_text', text: part.text ?? '', annotations: [] } : part)),
                    status: 'completed' };
            }
            case 'reasoning':
                if (store) return { type: 'reasoning', id: item.id, summary: item.summary ?? [] };
                if (!item.encrypted_content) return null;
                return { type: 'reasoning', id: item.id, summary: item.summary ?? [], encrypted_content: item.encrypted_content };
            case 'function_call':
                return { type: 'function_call', ...(item.id ? { id: item.id } : {}), call_id: item.call_id, name: item.name,
                    arguments: item.arguments ?? '{}' };
            case 'image_generation_call': {
                const saved = imagePaths.get(item.id);
                const note = saved ? `[Изображение сгенерировано и сохранено: ${saved}]`
                    : item.status === 'failed' ? '[Генерация изображения не удалась]' : '[Изображение сгенерировано]';
                return { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: note, annotations: [] }], status: 'completed' };
            }
            case 'web_search_call':
            case 'file_search_call':
            case 'code_interpreter_call':
            case 'mcp_call':
            case 'mcp_list_tools':
                return store ? item : null;
            default:
                return null;
        }
    }

    /**
     * Append replayable output items and remember the response id.
     * @param {object} response
     * @param {{ imagePaths?: Map<string, string> }} [options]
     * @returns {void}
     * @ai.hint pure
     */
    function recordResponse(response, { imagePaths } = {}) {
        if (!isRecord(response)) return;
        const items = (response.output ?? []).map((item) => replayable(item, { imagePaths })).filter(Boolean);
        state.items.push(...items);
        state.lastResponseId = response.id ?? state.lastResponseId;
        if (store) state.pendingFrom = state.items.length;
        if (response.model) state.model = response.model;
        touch();
    }

    /**
     * Add one ledger entry into the session usage totals.
     * @param {{ usage?: object, costUsd?: number }} entry
     * @returns {void}
     * @ai.hint pure
     */
    function recordUsage(entry) {
        if (!entry?.usage) return;
        for (const key of ['input', 'cached', 'output', 'reasoning', 'total']) state.usage[key] += entry.usage[key] ?? 0;
        if (Number.isFinite(entry.costUsd)) state.usage.costUsd += entry.costUsd;
        state.usage.requests++;
    }

    /** Build the `input` (and previous_response_id) for the next request. */
    function requestInput() {
        if (store && state.lastResponseId) {
            return { input: state.items.slice(state.pendingFrom), previous_response_id: state.lastResponseId };
        }
        return { input: [...state.items] };
    }

    /**
     * Replace the item list. Drops lastResponseId unless keepLastResponse is set.
     * @param {object[]} items
     * @param {{ keepLastResponse?: boolean }} [options]
     * @returns {void}
     * @ai.hint pure
     */
    function replace(items, { keepLastResponse = false } = {}) {
        state.items = items.filter(isRecord);
        if (!keepLastResponse) state.lastResponseId = null;
        state.pendingFrom = store ? state.items.length : 0;
        touch();
    }

    /**
     * Drop items, the last response id, and the turn count.
     * @returns {void}
     * @ai.hint pure
     */
    function clear() {
        state.items = []; state.lastResponseId = null; state.pendingFrom = 0; state.turns = 0;
        touch();
    }

    /** Human-readable transcript (user / assistant text only). */
    function transcript() {
        const lines = [];
        for (const item of state.items) {
            if (item.type !== 'message') continue;
            const text = (item.content ?? []).map((part) => part.text ?? part.refusal ?? (part.type === 'input_image' ? '[изображение]' : part.type === 'input_file' ? `[файл ${part.filename ?? ''}]` : '')).join('');
            lines.push(`${item.role === 'user' ? 'Вы' : item.role === 'assistant' ? 'ИИ' : item.role}: ${text}`);
        }
        return lines.join('\n\n');
    }

    /**
     * Deep copy of the session state.
     * @returns {object}
     * @ai.hint pure
     */
    function toJSON() { return structuredClone(state); }

    /**
     * Write the session as JSON via a temp file in the same directory, mode 0600.
     * @param {string} file
     * @returns {Promise<string>}
     * @ai.hint io
     */
    async function save(file) {
        await mkdir(path.dirname(file), { recursive: true });
        const temp = `${file}.${process.pid}.tmp`;
        await writeFile(temp, JSON.stringify(toJSON(), null, 2), { mode: 0o600 });
        await rename(temp, file);
        return file;
    }

    /**
     * Load a version-1 session object into this instance.
     * @param {object} data
     * @returns {object}
     * @ai.hint pure
     */
    function restore(data) {
        if (!isRecord(data) || data.version !== SESSION_VERSION || !Array.isArray(data.items)) {
            throw new Error('Файл сессии имеет неизвестный формат.');
        }
        Object.assign(state, structuredClone(data), { store: typeof data.store === 'boolean' ? data.store : store });
        store = state.store;
        return api;
    }

    const api = {
        addUserMessage: (message) => addItems([message]),
        addItems, recordResponse, recordUsage, requestInput, replace, clear, transcript, toJSON, save, restore,
        bumpTurn: () => { state.turns++; touch(); },
        /**
         * Session id.
         * @returns {string}
         * @ai.hint pure
         */
        get id() { return state.id; },
        /**
         * Optional display name.
         * @returns {string|null}
         * @ai.hint pure
         */
        get name() { return state.name; },
        /**
         * Set the display name.
         * @param {string|null} value
         * @returns {void}
         * @ai.hint pure
         */
        set name(value) { state.name = value; },
        /**
         * Live item list. Callers can mutate it.
         * @returns {object[]}
         * @ai.hint pure
         */
        get items() { return state.items; },
        /**
         * Whether OpenAI stores the conversation.
         * @returns {boolean}
         * @ai.hint pure
         */
        get store() { return store; },
        /**
         * Model id last seen, or the one passed at creation.
         * @returns {string|null}
         * @ai.hint pure
         */
        get model() { return state.model; },
        /**
         * Set the model id stored on the session.
         * @param {string|null} value
         * @returns {void}
         * @ai.hint pure
         */
        set model(value) { state.model = value; },
        /**
         * Id of the last recorded response.
         * @returns {string|null}
         * @ai.hint pure
         */
        get lastResponseId() { return state.lastResponseId; },
        /**
         * Completed turn count.
         * @returns {number}
         * @ai.hint pure
         */
        get turns() { return state.turns; },
        /**
         * Copy of accumulated usage.
         * @returns {object}
         * @ai.hint pure
         */
        get usage() { return { ...state.usage }; },
        /**
         * Session instructions, if any.
         * @returns {string|null}
         * @ai.hint pure
         */
        get instructions() { return state.instructions; },
        /**
         * Set the instructions stored on the session.
         * @param {string|null} value
         * @returns {void}
         * @ai.hint pure
         */
        set instructions(value) { state.instructions = value; },
        /**
         * Number of stored items.
         * @returns {number}
         * @ai.hint pure
         */
        get size() { return state.items.length; },
    };
    return api;
}

/**
 * Read a session file and restore it into a new session.
 * @param {string} file
 * @param {object} [options] Passed to createSession before restore.
 * @returns {Promise<object>}
 * @exports
 * @ai.hint io
 */
export async function loadSession(file, options = {}) {
    const raw = await readFile(file, 'utf8');
    return createSession(options).restore(JSON.parse(raw));
}

/**
 * Path of `<home>/sessions/<name>.json`. The name is restricted to 1–64 word characters, dots, and hyphens.
 * @param {string} home
 * @param {string} name
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function sessionFile(home, name) {
    if (!/^[\w.-]{1,64}$/.test(name)) throw new Error('Имя сессии: буквы, цифры, точка, дефис, подчёркивание (до 64 символов).');
    return path.join(home, 'sessions', `${name}.json`);
}
