/**
 * @file src/agent/pipeline.js
 * @module agent/pipeline
 * @purpose Ordered team stages as data: the catalog, the resolver, and the runner that honours a plan- or config-supplied order.
 * @usedBy agent/team
 * @exports STAGE_CATALOG, PIPELINE_STAGE_IDS, DEFAULT_PIPELINE, TAIL_STAGES, normalizePipeline, resolvePipeline, createPipeline
 * @ai.tags pipeline, team, roles
 * @ai.hint pure
 * @changed 2026-10-26 Stages are a list, not a fixed sequence: the planner and the config may reorder or skip them.
 * @changed 2026-10-27 `decor` builds the decorative layer before `work` writes the page.
 * @changed 2026-10-28 `iconify` reviews generated markup after `work` and before `review`.
 */

/**
 * Every stage the team can run, in the default order. `after` names the stages that should precede
 * this one when both are present (a soft order); `requires` names the stages the body cannot work
 * without (a hard dependency, added even when a caller forgets it).
 * @type {ReadonlyArray<{ id: string, title: string, after: string[], requires: string[] }>}
 */
export const STAGE_CATALOG = Object.freeze([
    { id: 'answer', title: 'First answer and route', after: [], requires: [] },
    { id: 'classify', title: 'Task label', after: ['answer'], requires: [] },
    { id: 'plan', title: 'Plan', after: ['classify'], requires: [] },
    { id: 'decompose', title: 'Screen decomposition', after: ['plan'], requires: ['plan'] },
    { id: 'measure', title: 'Reference measurements', after: ['plan', 'decompose'], requires: ['plan', 'decompose'] },
    { id: 'architect', title: 'Architecture brief', after: ['plan', 'measure'], requires: ['plan'] },
    { id: 'collect', title: 'Context collection', after: ['plan', 'architect'], requires: ['plan'] },
    { id: 'images', title: 'Visual assets', after: ['plan', 'measure'], requires: ['plan'] },
    { id: 'decor', title: 'Decorative elements', after: ['plan', 'measure', 'architect', 'images'], requires: ['plan'] },
    { id: 'work', title: 'Plan steps', after: ['plan', 'decor'], requires: ['plan'] },
    { id: 'iconify', title: 'Icon integration', after: ['work'], requires: ['work'] },
    { id: 'review', title: 'Review and fixes', after: ['plan', 'work', 'iconify'], requires: ['work'] },
    { id: 'outcome', title: 'Outcome', after: ['plan', 'work', 'iconify', 'review'], requires: ['plan'] },
    { id: 'memory', title: 'Memory', after: ['outcome'], requires: ['outcome'] },
]);

export const PIPELINE_STAGE_IDS = Object.freeze(STAGE_CATALOG.map((stage) => stage.id));

/** The catalog order, used when neither the plan nor the config asks for another one. */
export const DEFAULT_PIPELINE = PIPELINE_STAGE_IDS;

/**
 * Stages that always run last even when a caller forgets them: without them a run has no status,
 * no text, and no memory record.
 */
export const TAIL_STAGES = Object.freeze(['outcome', 'memory']);

const KNOWN = new Set(PIPELINE_STAGE_IDS);
const AFTER = new Map(STAGE_CATALOG.map((stage) => [stage.id, stage.after]));
const REQUIRES = new Map(STAGE_CATALOG.map((stage) => [stage.id, stage.requires]));

/**
 * Read a stage list in either shape: `['plan', 'work']` or `[{ id: 'plan' }, { id: 'work', enabled: false }]`.
 * Unknown ids are reported, not thrown: a stale plan must not break a run.
 * @param {unknown} value
 * @returns {{ ids: string[], ignored: string[] } | null} null when the value is not a list at all.
 * @ai.hint pure
 */
export function normalizePipeline(value) {
    if (!Array.isArray(value)) return null;
    const ids = [];
    const ignored = [];
    for (const item of value) {
        if (item && typeof item === 'object' && item.enabled === false) continue;
        const id = typeof item === 'string' ? item.trim() : typeof item?.id === 'string' ? item.id.trim() : '';
        if (!id) continue;
        if (!KNOWN.has(id)) {
            ignored.push(id);
            continue;
        }
        if (!ids.includes(id)) ids.push(id);
    }
    return { ids, ignored };
}

/**
 * Move a stage in front of the stage that depends on it, keeping every other relative position.
 * @param {string[]} order
 * @param {string} id
 * @param {string} dependency
 * @returns {boolean} true when the order changed.
 * @ai.hint pure
 */
function pullBefore(order, id, dependency) {
    const at = order.indexOf(id);
    const dep = order.indexOf(dependency);
    if (at < 0 || dep < 0 || dep < at) return false;
    order.splice(dep, 1);
    order.splice(order.indexOf(id), 0, dependency);
    return true;
}

/**
 * Resolve the stage order. Precedence: the plan, then the config, then the catalog.
 * The result always contains the tail stages, adds a hard dependency even when a caller omits it,
 * and never puts a stage before a stage it should follow.
 * @param {{ planPipeline?: unknown, configPipeline?: unknown, defaults?: readonly string[] }} [input]
 * @returns {{ order: string[], source: 'plan'|'config'|'default', ignored: string[], signature: string }}
 * @ai.hint pure
 */
export function resolvePipeline({ planPipeline, configPipeline, defaults = DEFAULT_PIPELINE } = {}) {
    const fromPlan = normalizePipeline(planPipeline);
    const fromConfig = normalizePipeline(configPipeline);
    const chosen = fromPlan?.ids.length ? { ...fromPlan, source: 'plan' }
        : fromConfig?.ids.length ? { ...fromConfig, source: 'config' }
            : { ids: [...defaults], ignored: [], source: 'default' };
    const order = [];
    const add = (id) => {
        if (!KNOWN.has(id) || order.includes(id)) return;
        for (const dependency of REQUIRES.get(id) ?? []) add(dependency);
        order.push(id);
    };
    for (const id of chosen.ids) add(id);
    for (const id of TAIL_STAGES) add(id);
    // Every planned work pass gets a conditional markup pass, even if a generated plan omits it.
    if (order.includes('work')) add('iconify');
    // One pass may expose a soft dependency of a stage that was pulled earlier; repeat until stable.
    for (let pass = 0; pass < order.length; pass++) {
        let moved = false;
        for (const id of [...order]) {
            for (const dependency of AFTER.get(id) ?? []) moved = pullBefore(order, id, dependency) || moved;
        }
        if (!moved) break;
    }
    return { order, source: chosen.source, ignored: chosen.ignored, signature: order.join('>') };
}

/**
 * Run stages in the resolved order. The order is re-resolved on every step, so a plan that appears
 * mid-run (the planner stage) or changes after a plan update applies from the next stage on.
 * A stage may return `{ exit }` to stop the whole run with that value.
 * @param {{ stages: Array<{ id: string, when?: () => boolean, run: () => Promise<unknown> }>, config?: object, plan?: object | (() => object), notify?: (event: object) => void }} input
 * @returns {{ order: () => string[], run: () => Promise<unknown> }}
 */
export function createPipeline({ stages = [], config = null, plan = null, notify = null } = {}) {
    const byId = new Map(stages.map((stage) => [stage.id, stage]));
    const ran = new Set();
    let queue = [];
    let signature = null;
    const sync = () => {
        const current = typeof plan === 'function' ? plan() : plan;
        const resolved = resolvePipeline({ planPipeline: current?.pipeline, configPipeline: config?.agent?.pipeline });
        if (resolved.signature !== signature) {
            signature = resolved.signature;
            queue = resolved.order.filter((id) => !ran.has(id));
        }
        return resolved;
    };
    return {
        /** Stage ids still to run, in order. */
        order() {
            sync();
            return [...queue];
        },
        /** Run every stage once. Returns the first `{ exit }` value, if any. */
        async run() {
            for (;;) {
                sync();
                const id = queue.shift();
                if (!id) return undefined;
                const stage = byId.get(id);
                if (!stage) continue;
                ran.add(id);
                if (typeof stage.when === 'function' && !stage.when()) {
                    notify?.({ type: 'stage.skip', stage: id });
                    continue;
                }
                const result = await stage.run();
                if (result && typeof result === 'object' && 'exit' in result) return result.exit;
            }
        },
    };
}
