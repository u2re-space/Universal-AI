/**
 * @file src/core/usage.js
 * @module core/usage
 * @purpose Token and USD ledger for one process, priced only from the user's table.
 * @depends openai/errors, openai/stream, util/text
 * @usedBy commands/shared
 * @exports priceFor, costOf, createLedger
 * @ai.tags usage, budget
 * @ai.hint pure
 * @changed 2026-10-15 JSDoc card, 4-space indent.
 */
import { BudgetError } from '../openai/errors.js';
import { normalizeUsage } from '../openai/stream.js';
import { formatNumber, formatUsd } from '../util/text.js';

/** Match a price entry: exact model id, else the longest "prefix*" pattern. */
export function priceFor(prices, model) {
    if (!prices || !model) return null;
    if (prices[model]) return prices[model];
    let best = null;
    for (const [pattern, price] of Object.entries(prices)) {
        if (!pattern.endsWith('*')) continue;
        const prefix = pattern.slice(0, -1);
        if (model.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) best = { prefix, price };
    }
    return best?.price ?? null;
}

/**
 * USD cost of one usage block. Cached input uses cachedInput when that rate is set.
 * @param {{ input: number, output: number, cachedInput?: number }|null} price
 * @param {{ input: number, cached: number, output: number }|null} usage
 * @returns {number|null}
 * @exports
 * @ai.hint pure
 */
export function costOf(price, usage) {
    if (!price || !usage) return null;
    const cachedRate = Number.isFinite(price.cachedInput) ? price.cachedInput : price.input;
    return ((usage.input - usage.cached) * price.input + usage.cached * cachedRate + usage.output * price.output) / 1_000_000;
}

/**
 * Token and cost ledger for one process. Costs are computed only from prices the user
 * configured (there are no built-in price tables: they go stale). Built-in tool fees
 * (image generation, web search) are NOT included in the USD figure.
 */
export function createLedger({ prices = {}, budgetUsd = null, budgetTokens = null } = {}) {
    const entries = [];
    const totals = { requests: 0, input: 0, cached: 0, output: 0, reasoning: 0, total: 0, costUsd: 0,
        unknownCostRequests: 0, unknownUsageRequests: 0, elapsedMs: 0, images: 0 };
    const byModel = new Map();   // model -> { requests, input, output, costUsd, unknownCost }
    const byRole = new Map();    // role  -> same
    const listeners = new Set();
    let currentRole = null;

    /**
     * Add one request to a model or role bucket.
     * @param {Map<string, object>} map
     * @param {string|null} key
     * @param {object|null} normalized
     * @param {number|null} costUsd
     * @returns {void}
     * @ai.hint pure
     */
    function bump(map, key, normalized, costUsd) {
        if (!key) return;
        const row = map.get(key) ?? { key, requests: 0, input: 0, cached: 0, output: 0, reasoning: 0, costUsd: 0, unknownCost: 0 };
        row.requests++;
        if (normalized) { row.input += normalized.input; row.cached += normalized.cached; row.output += normalized.output; row.reasoning += normalized.reasoning; }
        if (costUsd === null) row.unknownCost++; else row.costUsd += costUsd;
        map.set(key, row);
    }

    /**
     * Record one response and notify listeners with a fresh snapshot.
     * @param {{ model?: string, usage?: object, elapsedMs?: number, kind?: string, responseId?: string|null, role?: string|null }} entry
     * @returns {object}
     * @ai.hint pure
     */
    function record({ model, usage, elapsedMs = 0, kind = 'response', responseId = null, role = currentRole }) {
        const normalized = normalizeUsage(usage);
        totals.requests++;
        totals.elapsedMs += elapsedMs;
        let costUsd = null;
        if (normalized) {
            for (const key of ['input', 'cached', 'output', 'reasoning', 'total']) totals[key] += normalized[key];
            costUsd = costOf(priceFor(prices, model), normalized);
            if (costUsd === null) totals.unknownCostRequests++; else totals.costUsd += costUsd;
        } else {
            totals.unknownUsageRequests++;
            totals.unknownCostRequests++;
        }
        bump(byModel, model, normalized, costUsd);
        bump(byRole, role, normalized, costUsd);
        const entry = { at: new Date().toISOString(), model, role, kind, responseId, elapsedMs, usage: normalized, costUsd };
        entries.push(entry);
        for (const listener of listeners) { try { listener(snapshot()); } catch { /* observer */ } }
        return entry;
    }

    /**
     * Totals, remaining budget, and per-model and per-role rows.
     * @returns {object}
     * @ai.hint pure
     */
    function snapshot() {
        return { ...totals, costUsd: totals.unknownCostRequests ? (totals.costUsd || null) : totals.costUsd,
            costKnown: totals.unknownCostRequests === 0, budgetUsd, budgetTokens,
            remainingUsd: budgetUsd === null ? null : Math.max(0, budgetUsd - totals.costUsd),
            remainingTokens: budgetTokens === null ? null : Math.max(0, budgetTokens - totals.total),
            byModel: [...byModel.values()].map((r) => ({ ...r, model: r.key })),
            byRole: [...byRole.values()].map((r) => ({ ...r, role: r.key })) };
    }

    /** Throw before a request when the budget is exhausted (estimate is an optimistic lower bound). */
    function assertBudget({ estimatedTokens = 0, model = null } = {}) {
        if (budgetTokens !== null && totals.total + estimatedTokens > budgetTokens) {
            throw new BudgetError(`Исчерпан лимит токенов: использовано ${formatNumber(totals.total)} из ${formatNumber(budgetTokens)}.`,
                { kind: 'tokens', used: totals.total, limit: budgetTokens });
        }
        if (budgetUsd !== null) {
            const price = priceFor(prices, model);
            const estimate = price ? estimatedTokens * price.input / 1_000_000 : 0;
            if (totals.costUsd + estimate > budgetUsd) {
                throw new BudgetError(`Исчерпан бюджет: потрачено ${formatUsd(totals.costUsd)} из ${formatUsd(budgetUsd)}.`,
                    { kind: 'usd', used: totals.costUsd, limit: budgetUsd });
            }
            if (totals.unknownCostRequests && totals.requests) {
                throw new BudgetError('Задан бюджет в USD, но для модели не настроены цены (prices в конфигурации) — расход неизвестен; остановлено.',
                    { kind: 'unknown-price', used: totals.costUsd, limit: budgetUsd });
            }
        }
    }

    /**
     * The BudgetError when the budget is already spent, otherwise false.
     * @returns {BudgetError|false}
     * @ai.hint pure
     */
    function exceeded() {
        try { assertBudget(); return false; } catch (error) { return error instanceof BudgetError ? error : false; }
    }

    /**
     * One-line token and cost summary for the status line.
     * @param {boolean} [short]
     * @returns {string}
     * @ai.hint pure
     */
    function describe(short = false) {
        const t = snapshot();
        const parts = [`↑ ${formatNumber(t.input)}${t.cached ? ` (кеш ${formatNumber(t.cached)})` : ''}`,
            `↓ ${formatNumber(t.output)}${t.reasoning ? ` (reasoning ${formatNumber(t.reasoning)})` : ''}`];
        if (!short) parts.push(`всего ${formatNumber(t.total)}`);
        if (t.costKnown && t.requests) parts.push(formatUsd(t.costUsd));
        else if (t.costUsd) parts.push(`≥ ${formatUsd(t.costUsd)}`);
        if (!short) parts.push(`${t.requests} запрос(ов)`);
        return parts.join(' · ');
    }

    return {
        record, snapshot, assertBudget, exceeded, describe, priceFor: (model) => priceFor(prices, model),
        /**
         * Count generated images. They are not part of the USD figure.
         * @param {number} [count]
         * @returns {void}
         * @ai.hint pure
         */
        addImages(count = 1) { totals.images += count; },
        /** Tag subsequent records with a role name (team runs). */
        setRole(name) { currentRole = name ?? null; },
        /**
         * Role name applied to later records.
         * @returns {string|null}
         * @ai.hint pure
         */
        get role() { return currentRole; },
        /**
         * Subscribe to snapshots. The return value removes the listener.
         * @param {(snapshot: object) => void} listener
         * @returns {() => boolean}
         * @ai.hint pure
         */
        onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        /**
         * Copy of recorded entries.
         * @returns {object[]}
         * @ai.hint pure
         */
        get entries() { return [...entries]; },
        /**
         * Configured USD budget, or null when unset.
         * @returns {number|null}
         * @ai.hint pure
         */
        get budgetUsd() { return budgetUsd; },
        /**
         * Configured token budget, or null when unset.
         * @returns {number|null}
         * @ai.hint pure
         */
        get budgetTokens() { return budgetTokens; },
    };
}
