/**
 * @file src/openai/web-search.js
 * @module openai/web-search
 * @purpose Build the Responses web_search tool and read queries and pages from a response.
 * @usedBy agent/loop, core/session
 * @exports webSearchTool, collectWebSources, formatWebSources
 * @ai.tags web, responses
 * @ai.hint pure
 * @changed 2026-10-15 ProxyAPI tool is { type: web_search }; sources are collected from the response.
 */

const QUERY_CAP = 8;
const SOURCE_CAP = 12;

/**
 * Hosted search tool. `search_context_size` is sent only when the config sets low, medium, or high.
 * ProxyAPI accepts `{ type: "web_search" }` on `/v1/responses`.
 * @param {string | null | undefined} contextSize
 * @returns {{ type: 'web_search', search_context_size?: string }}
 * @exports
 * @ai.hint pure
 */
export function webSearchTool(contextSize) {
    const tool = { type: 'web_search' };
    if (contextSize === 'low' || contextSize === 'medium' || contextSize === 'high') tool.search_context_size = contextSize;
    return tool;
}

/**
 * @param {Set<string>} seen
 * @param {string[]} list
 * @param {number} cap
 * @param {string} value
 * @returns {void}
 * @ai.hint pure
 */
function pushUnique(seen, list, cap, value) {
    if (!value || seen.has(value) || list.length >= cap) return;
    seen.add(value);
    list.push(value);
}

/**
 * Queries and http(s) pages from web_search_call actions and url_citation annotations.
 * @param {object | null | undefined} response
 * @returns {{ queries: string[], sources: Array<{ url: string, title: string | null }>, searches: number }}
 * @exports
 * @ai.hint pure
 */
export function collectWebSources(response) {
    const queries = [];
    const sources = [];
    const seenQueries = new Set();
    let searches = 0;
    /**
     * @param {unknown} url
     * @param {unknown} title
     * @returns {void}
     * @ai.hint pure
     */
    const addSource = (url, title) => {
        const href = String(url ?? '').trim();
        if (!/^https?:\/\//i.test(href)) return;
        const name = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : '';
        const existing = sources.find((source) => source.url === href);
        if (existing) {
            if (!existing.title && name) existing.title = name;
            return;
        }
        if (sources.length >= SOURCE_CAP) return;
        sources.push({ url: href, title: name || null });
    };
    for (const item of response?.output ?? []) {
        if (item?.type === 'web_search_call') {
            if (item.status === 'failed') continue;
            searches += 1;
            const action = item.action && typeof item.action === 'object' ? item.action : {};
            pushUnique(seenQueries, queries, QUERY_CAP, typeof action.query === 'string' ? action.query.replace(/\s+/g, ' ').trim() : '');
            if (Array.isArray(action.queries)) {
                for (const query of action.queries) {
                    pushUnique(seenQueries, queries, QUERY_CAP, typeof query === 'string' ? query.replace(/\s+/g, ' ').trim() : '');
                }
            }
            addSource(action.url, action.title);
            const listed = Array.isArray(action.sources) ? action.sources : Array.isArray(item.sources) ? item.sources : [];
            for (const source of listed) {
                if (typeof source === 'string') addSource(source, null);
                else addSource(source?.url, source?.title ?? source?.name);
            }
            continue;
        }
        if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
        for (const part of item.content) {
            for (const note of part?.annotations ?? []) {
                if (note?.type === 'url_citation' || note?.type === 'url') addSource(note.url, note.title);
            }
        }
    }
    return { queries, sources, searches };
}

/**
 * Short block for the terminal and for the next stateless turn.
 * @param {{ queries?: string[], sources?: Array<{ url: string, title?: string | null }> }} found
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function formatWebSources(found) {
    const queries = Array.isArray(found?.queries) ? found.queries : [];
    const sources = Array.isArray(found?.sources) ? found.sources : [];
    const lines = [];
    if (queries.length) lines.push(`[web_search: ${queries.join('; ')}]`);
    for (const source of sources) {
        if (!source?.url) continue;
        lines.push(source.title ? `- ${source.title} — ${source.url}` : `- ${source.url}`);
    }
    return lines.join('\n');
}
