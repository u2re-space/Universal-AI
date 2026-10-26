/**
 * @file src/agent/subagents.js
 * @module agent/subagents
 * @purpose Runner for `run_subagent`: one nested agent on a fresh context, with its own tools and turn cap.
 *   The role list itself lives in `agent/role-registry`, shared with `delegate_role`.
 * @depends agent/role-registry, agent/tools, agent/loop, util/text
 * @usedBy agent/tools, agent/team, commands/run
 * @exports SUBAGENTS, SUBAGENT_NAMES, subagentToolNames, createSubagentRunner
 * @ai.tags subagent, roles, tools
 * @ai.hint hot
 * @changed 2026-10-26 Version 0.2.0: one registry for delegate_role and run_subagent, plus custom roles.
 */

import { EXECUTORS, EXECUTOR_NAMES, executorNames, executorSpec, executorToolNames } from './role-registry.js';
import { createToolset } from './tools.js';
import { builtinTools } from './loop.js';
import { errorMessage } from '../util/text.js';

/**
 * The built-in executors, kept under the historical name.
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export const SUBAGENTS = EXECUTORS;

/** @returns {string[]} Built-in executor names in registry order. */
export const SUBAGENT_NAMES = EXECUTOR_NAMES;

/**
 * Tool names available to an executor, intersected with what the caller has enabled.
 * @param {string} kind A registry name or a user-defined role.
 * @param {string[]} allNames Tool names the calling agent has.
 * @param {object} [config]
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function subagentToolNames(kind, allNames, config = null) {
    const spec = executorSpec(kind, config);
    if (!spec) throw new Error(`Неизвестный суб-агент «${kind}».`);
    return executorToolNames(spec, allNames, { nested: true });
}

/**
 * Build the run_subagent handler bound to one calling agent.
 *
 * The sub-agent runs in a fresh conversation with only its task, its own tool set, and its own
 * turn cap; the caller sees the report and the nested tool stats. It never receives the
 * run_subagent tool itself, so a sub-agent cannot delegate further.
 *
 * @param {{ config: object, roles: object, root: string, allNames: string[], approvalLevel: string,
 *   toolBase?: object, toolOptions?: object, agentsText?: string|Function|null, emit?: Function, parentTask?: string|null }} options
 *   `roles` is the role runner; `toolBase` and `toolOptions` are passed through to createToolset;
 *   `agentsText` may be a function so AGENTS.md text discovered later still reaches the sub-agent;
 *   `parentTask` is the caller's task for `{{task:PROMPT}}`.
 * @returns {(kind: string, task: string) => Promise<{ output: string, summary: string, ok: boolean, stats: object, images: string[] }>}
 * @exports
 * @ai.hint hot
 */
export function createSubagentRunner({ config, roles, root, allNames = [], approvalLevel, toolBase = {}, toolOptions = {}, agentsText = null, emit = () => {}, parentTask = null }) {
    const notify = (event) => { try { emit(event); } catch { /* observer */ } };

    return async function runSubagent(kind, task) {
        const spec = executorSpec(kind, config);
        if (!spec) throw new Error(`run_subagent: неизвестный суб-агент «${kind}» (${executorNames(config).join(', ')}).`);
        const text = String(task ?? '').trim();
        if (!text) throw new Error('run_subagent: task пуст — опиши задачу целиком, суб-агент не видит переписку.');

        const names = executorToolNames(spec, allNames, { nested: true });
        const toolset = createToolset({ ...toolBase, ...toolOptions, root, config, names, approvalLevel });
        const model = roles.resolve(kind).model;
        // The role prompt itself comes from the role runner; here only the project rules are added.
        const notes = typeof agentsText === 'function' ? agentsText() : agentsText;
        const instructions = String(notes ?? '').trim();
        notify({ type: 'subagent.start', kind, model, tools: names, task });
        const result = await roles.run(kind, {
            text,
            instructions,
            toolset,
            maxTurns: spec.turns,
            silent: true,
            task: parentTask,
            delegated: text,
            ...(kind === 'image-processor' && config.tools?.web
                ? { builtin: builtinTools(config, { web: true }).filter((tool) => tool.type === 'web_search') }
                : {}),
        });
        notify({ type: 'subagent.done', kind, status: result.status, turns: result.turns, toolCalls: result.toolCalls });

        const stats = toolset.stats();
        const head = `Суб-агент ${kind}: статус ${result.status} (${result.turns} ходов, ${result.toolCalls} вызовов инструментов).`;
        const body = String(result.text ?? '').trim() || '(отчёт пуст)';
        const touched = stats.changes.length ? `\n\nФайлы: ${stats.changes.map((change) => `${change.op} ${change.path}`).join(', ')}` : '';
        const error = result.error ? `\n\nОшибка: ${errorMessage(result.error)}` : '';
        return {
            output: `${head}\n\n${body}${touched}${error}`,
            summary: `${kind}: ${result.status}`,
            ok: result.status === 'completed',
            stats,
            images: result.images ?? [],
        };
    };
}
