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

    function touch() { state.updatedAt = new Date().toISOString(); }

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

    function recordResponse(response, { imagePaths } = {}) {
        if (!isRecord(response)) return;
        const items = (response.output ?? []).map((item) => replayable(item, { imagePaths })).filter(Boolean);
        state.items.push(...items);
        state.lastResponseId = response.id ?? state.lastResponseId;
        if (store) state.pendingFrom = state.items.length;
        if (response.model) state.model = response.model;
        touch();
    }

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

    function replace(items, { keepLastResponse = false } = {}) {
        state.items = items.filter(isRecord);
        if (!keepLastResponse) state.lastResponseId = null;
        state.pendingFrom = store ? state.items.length : 0;
        touch();
    }

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

    function toJSON() { return structuredClone(state); }

    async function save(file) {
        await mkdir(path.dirname(file), { recursive: true });
        const temp = `${file}.${process.pid}.tmp`;
        await writeFile(temp, JSON.stringify(toJSON(), null, 2), { mode: 0o600 });
        await rename(temp, file);
        return file;
    }

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
        get id() { return state.id; }, get name() { return state.name; }, set name(value) { state.name = value; },
        get items() { return state.items; }, get store() { return store; }, get model() { return state.model; },
        set model(value) { state.model = value; },
        get lastResponseId() { return state.lastResponseId; }, get turns() { return state.turns; },
        get usage() { return { ...state.usage }; }, get instructions() { return state.instructions; },
        set instructions(value) { state.instructions = value; },
        get size() { return state.items.length; },
    };
    return api;
}

export async function loadSession(file, options = {}) {
    const raw = await readFile(file, 'utf8');
    return createSession(options).restore(JSON.parse(raw));
}

export function sessionFile(home, name) {
    if (!/^[\w.-]{1,64}$/.test(name)) throw new Error('Имя сессии: буквы, цифры, точка, дефис, подчёркивание (до 64 символов).');
    return path.join(home, 'sessions', `${name}.json`);
}
