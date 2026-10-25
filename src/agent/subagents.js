/**
 * @file src/agent/subagents.js
 * @module agent/subagents
 * @purpose Registry of sub-agents and the runner that executes one of them on its own context.
 * @depends agent/tool-specs, agent/tools, roles/index
 * @usedBy agent/tools, agent/team, commands/run
 * @exports SUBAGENTS, SUBAGENT_NAMES, subagentToolNames, createSubagentRunner
 * @ai.tags subagent, roles, tools
 * @ai.hint hot
 * @changed 2026-10-25 First version: reader, implementor, verifier.
 */

import { READ_ONLY_TOOLS, SHELL_TOOL_NAMES } from './tool-specs.js';
import { createToolset } from './tools.js';
import { errorMessage } from '../util/text.js';

/**
 * Tools a sub-agent never gets: they would let a nested run delegate again or drive the screen.
 * @returns {string[]}
 * @ai.hint pure
 */
const NESTED_FORBIDDEN = ['run_subagent', 'delegate_role', 'run_batch', 'ask_user'];

/**
 * Sub-agents the model can start with run_subagent. `tools` picks the tool set, `turns` caps the loop,
 * and `description` is what the calling model reads when it chooses between them.
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export const SUBAGENTS = {
    reader: {
        role: 'reader',
        tools: 'read',
        turns: 12,
        description: 'Read-only investigation: reads files and links, answers one focused question, changes nothing.',
    },
    implementor: {
        role: 'implementor',
        tools: 'all',
        turns: 25,
        description: 'One self-contained piece of implementation: edits the files the task names and verifies them.',
    },
    verifier: {
        role: 'verifier',
        tools: 'verify',
        turns: 12,
        description: 'Independent check of one claim: runs the project tests, build, or linters and reports evidence.',
    },
};

/** @returns {string[]} Sub-agent names in the order the tool lists them. */
export const SUBAGENT_NAMES = Object.keys(SUBAGENTS);

/**
 * Tool names available to a sub-agent kind, intersected with what the caller has enabled.
 * @param {string} kind A key of SUBAGENTS.
 * @param {string[]} allNames Tool names the calling agent has.
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function subagentToolNames(kind, allNames) {
    const spec = SUBAGENTS[kind];
    if (!spec) throw new Error(`Неизвестный суб-агент «${kind}».`);
    const base = spec.tools === 'read'
        ? [...READ_ONLY_TOOLS, 'fetch_url']
        : spec.tools === 'verify'
            ? [...READ_ONLY_TOOLS, ...SHELL_TOOL_NAMES]
            : allNames;
    const forbidden = new Set(NESTED_FORBIDDEN);
    return allNames.filter((name) => base.includes(name) && !forbidden.has(name));
}

/**
 * Build the run_subagent handler bound to one calling agent.
 *
 * The sub-agent runs in a fresh conversation with only its task, its own tool set, and its own
 * turn cap; the caller sees the report and the nested tool stats. It never receives the
 * run_subagent tool itself, so a sub-agent cannot delegate further.
 *
 * @param {{ config: object, roles: object, root: string, allNames: string[], approvalLevel: string,
 *   toolBase?: object, toolOptions?: object, agentsText?: string|Function|null, emit?: Function }} options
 *   `roles` is the role runner; `toolBase` and `toolOptions` are passed through to createToolset;
 *   `agentsText` may be a function so AGENTS.md text discovered later still reaches the sub-agent.
 * @returns {(kind: string, task: string) => Promise<{ output: string, summary: string, ok: boolean, stats: object, images: string[] }>}
 * @exports
 * @ai.hint hot
 */
export function createSubagentRunner({ config, roles, root, allNames = [], approvalLevel, toolBase = {}, toolOptions = {}, agentsText = null, emit = () => {} }) {
    const notify = (event) => { try { emit(event); } catch { /* observer */ } };

    return async function runSubagent(kind, task) {
        const spec = SUBAGENTS[kind];
        if (!spec) throw new Error(`run_subagent: неизвестный суб-агент «${kind}» (${SUBAGENT_NAMES.join(', ')}).`);
        const text = String(task ?? '').trim();
        if (!text) throw new Error('run_subagent: task пуст — опиши задачу целиком, суб-агент не видит переписку.');

        const names = subagentToolNames(kind, allNames);
        const toolset = createToolset({ ...toolBase, ...toolOptions, root, config, names, approvalLevel });
        const model = roles.resolve(spec.role).model;
        // The role prompt itself comes from the role runner; here only the project rules are added.
        const notes = typeof agentsText === 'function' ? agentsText() : agentsText;
        const instructions = String(notes ?? '').trim();
        notify({ type: 'subagent.start', kind, role: spec.role, model, tools: names, task });
        const result = await roles.run(spec.role, {
            text,
            instructions,
            toolset,
            maxTurns: spec.turns,
            silent: true,
        });
        notify({ type: 'subagent.done', kind, role: spec.role, status: result.status, turns: result.turns, toolCalls: result.toolCalls });

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
