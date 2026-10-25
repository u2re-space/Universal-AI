/**
 * @file src/agent/subagents.js
 * @module agent/subagents
 * @purpose Registry of sub-agents (existing roles one level deep) and the runner that executes one of them.
 * @depends agent/tool-specs, agent/tools, util/text
 * @usedBy agent/tools, agent/team, commands/run
 * @exports SUBAGENTS, SUBAGENT_NAMES, subagentToolNames, createSubagentRunner
 * @ai.tags subagent, roles, tools
 * @ai.hint hot
 * @changed 2026-10-25 Sub-agents are the pipeline roles (coder, worker, writer, reviewer, tester, vision, solver, image-processor).
 */

import { READ_ONLY_TOOLS, SHELL_TOOL_NAMES, IMAGE_TOOL_NAMES } from './tool-specs.js';
import { createToolset } from './tools.js';
import { errorMessage } from '../util/text.js';

/**
 * Tools a sub-agent never gets: they would let a nested run delegate again or drive the screen blindly.
 * @returns {string[]}
 * @ai.hint pure
 */
const NESTED_FORBIDDEN = ['run_subagent', 'delegate_role', 'run_batch', 'ask_user'];

/**
 * Tool slices a sub-agent kind may use, before they are intersected with the caller's tools.
 * `all` keeps whatever the calling agent has; the other slices name a remit and never carry click, type,
 * or run_ahk — a checker or a solver may look at the screen with `screenshot`, it does not drive it.
 * @returns {object}
 * @ai.hint pure
 */
const SLICES = {
    all: (allNames) => allNames,
    read: () => [...READ_ONLY_TOOLS, 'fetch_url'],
    check: () => [...READ_ONLY_TOOLS, ...SHELL_TOOL_NAMES, 'screenshot'],
    screen: () => [...READ_ONLY_TOOLS, 'screenshot'],
    images: () => IMAGE_TOOL_NAMES,
};

/**
 * Sub-agents the model can start with run_subagent. A key is a role name from roles/index, so its prompt
 * and its model settings (`roles.<name>`, `--role <name>=…`) are the sub-agent's. `tools` picks a slice
 * from SLICES, `turns` caps the loop, and `description` is what the calling model reads when it chooses.
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export const SUBAGENTS = {
    coder: {
        tools: 'all',
        turns: 25,
        description: 'Code for one self-contained piece of work: edits the files the task names, follows the stack it finds, and checks the result.',
    },
    worker: {
        tools: 'all',
        turns: 25,
        description: 'General doer for one self-contained task of any kind: reads, edits, runs commands, and reports what changed.',
    },
    writer: {
        tools: 'all',
        turns: 20,
        description: 'Documents, README, report, or Markdown built only from the facts the task provides.',
    },
    reviewer: {
        tools: 'check',
        turns: 12,
        description: 'Independent review of a result: reads the changed files, runs the project checks, lists findings with evidence. Changes nothing.',
    },
    tester: {
        tools: 'check',
        turns: 8,
        description: 'Pass or fail one claim from evidence: runs the command or looks at the screen, then reports what was observed and what stayed unverified.',
    },
    vision: {
        tools: 'read',
        turns: 6,
        description: 'Describes the image files the task names in plain text, so their full description never enters this context.',
    },
    solver: {
        tools: 'screen',
        turns: 8,
        description: 'Solves one problem from the screen or an image: an answer, a calculation, a formula, a captcha, element coordinates.',
    },
    'image-processor': {
        tools: 'images',
        turns: 12,
        description: 'Prepares images and visual assets: crops, splits, trims padding, generates or edits artwork, saves them under assets/.',
    },
};

/** @returns {string[]} Sub-agent names in the order the tool lists them. */
export const SUBAGENT_NAMES = Object.keys(SUBAGENTS);

/**
 * Tool names available to a sub-agent kind, intersected with what the caller has enabled.
 * @param {string} kind A key of SUBAGENTS and a role name.
 * @param {string[]} allNames Tool names the calling agent has.
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function subagentToolNames(kind, allNames) {
    const spec = SUBAGENTS[kind];
    if (!spec) throw new Error(`Неизвестный суб-агент «${kind}».`);
    const base = SLICES[spec.tools](allNames);
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
