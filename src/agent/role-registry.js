/**
 * @file src/agent/role-registry.js
 * @module agent/role-registry
 * @purpose One registry of the roles another agent may hand work to, shared by `delegate_role` and
 *   `run_subagent`. Holds the built-in executors and the user-defined roles of the configuration.
 * @depends agent/tool-specs, core/config-defaults
 * @usedBy agent/subagents, agent/team, agent/tool-specs, agent/tools
 * @exports SLICES, NESTED_FORBIDDEN, EXECUTORS, EXECUTOR_NAMES, executorNames, executorSpec, executorToolNames, isExecutor
 * @ai.tags roles, subagent, delegation
 * @ai.hint pure
 * @changed 2026-10-26 Version 0.2.0: one registry for delegate_role and run_subagent, plus custom roles.
 * @changed 2026-10-28 Added iconifier for markup and icon integration.
 */

import { READ_ONLY_TOOLS, SHELL_TOOL_NAMES, IMAGE_TOOL_NAMES } from './tool-specs.js';
import { BUILTIN_ROLE_NAMES } from '../core/config-defaults.js';

/**
 * Tools a nested run never gets: they would let it delegate again or drive the screen blindly.
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export const NESTED_FORBIDDEN = Object.freeze(['run_subagent', 'delegate_role', 'run_batch', 'ask_user']);

/**
 * Tool slices an executor may use, before they are intersected with the caller's tools.
 * `all` keeps whatever the calling agent has; the other slices name a remit and never carry
 * click, type, or run_ahk — a checker or a solver may look at the screen with `screenshot`,
 * it does not drive it.
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export const SLICES = {
    all: (allNames) => allNames,
    read: () => [...READ_ONLY_TOOLS, 'fetch_url'],
    check: () => [...READ_ONLY_TOOLS, ...SHELL_TOOL_NAMES, 'screenshot'],
    screen: () => [...READ_ONLY_TOOLS, 'screenshot'],
    images: (allNames) => [...IMAGE_TOOL_NAMES, ...(allNames.includes('fetch_url') ? ['fetch_url'] : [])],
};

/**
 * Every role another agent may hand work to.
 *
 * A key is a role name, so the executor takes its prompt and its model settings
 * (`roles.<name>`, `--role <name>=…`) from the same place as the pipeline.
 * `tools` is a slice name or an explicit array, `turns` caps the loop, `schema` names a strict
 * reply shape, and `description` is what the calling model reads when it chooses.
 *
 * The union of the old specialist list (delegate_role) and sub-agent list (run_subagent):
 * a role that was in either one stays reachable under both names.
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export const EXECUTORS = Object.freeze({
    coder: {
        tools: 'all', turns: 40, schema: null,
        description: 'Code for one self-contained piece of work: edits the files the task names, follows the stack it finds, and checks the result.',
    },
    styler: {
        tools: ['list_files', 'read_file', 'search_files', 'list_backups', 'write_file', 'replace_text', 'restore_backup'], turns: 40, schema: null,
        description: 'Implement one focused CSS or SCSS task: inspect the consuming markup and project style conventions, edit the named stylesheets, and report without running checks or comparisons.',
    },
    iconifier: {
        tools: ['list_files', 'read_file', 'search_files', 'view_image', 'write_file', 'replace_text', 'fetch_url', 'download_font', 'download_icons', 'generate_svg', 'vectorize_image'], turns: 12, schema: null,
        description: 'Choose suitable project icons, Unicode symbols, or verified icon fonts and integrate them accessibly into generated HTML or component markup without taking over styles.',
    },
    worker: {
        tools: 'all', turns: 40, schema: null,
        description: 'General doer for one self-contained task of any kind: reads, edits, runs commands, and reports what changed.',
    },
    writer: {
        tools: 'all', turns: 24, schema: null,
        description: 'Documents, README, report, or Markdown built only from the facts the task provides.',
    },
    reviewer: {
        tools: 'check', turns: 16, schema: null,
        description: 'Independent review of a result: reads the changed files, runs the project checks, lists findings with evidence. Changes nothing.',
    },
    tester: {
        tools: 'check', turns: 8, schema: null,
        description: 'Pass or fail one claim from evidence: runs the command or looks at the screen, then reports what was observed and what stayed unverified.',
    },
    vision: {
        tools: 'read', turns: 8, schema: null,
        description: 'Describes the image files the task names in plain text, so their full description never enters this context.',
    },
    solver: {
        tools: 'screen', turns: 8, schema: null,
        description: 'Solves one problem from the screen or an image: an answer, a calculation, a formula, a captcha, element coordinates.',
    },
    decomposer: {
        tools: ['view_image', 'fetch_url'], turns: 8, schema: 'decompose',
        description: 'Splits visual references and Figma files into ordered screens, frames, and reusable fragments before measurement.',
    },
    measurer: {
        tools: ['view_image', 'crop_image', 'split_image', 'fetch_url'], turns: 16, schema: 'measure',
        description: 'Re-measures a crop or a layer and returns a measurement sheet: boxes, angles, borders, spacing, and CSS-ready values.',
    },
    decorator: {
        tools: ['list_files', 'read_file', 'search_files', 'view_image', 'write_file', 'replace_text', 'generate_svg', 'fetch_url'], turns: 16, schema: 'decorations',
        description: 'Builds complex decorative elements (ornaments, flourishes, dividers, patterns, frames) as native HTML+CSS or standalone SVG and returns ready snippets.',
    },
    'image-processor': {
        tools: 'images', turns: 16, schema: null,
        description: 'Prepares images and visual assets: crops, splits, trims padding, generates or edits artwork, saves them under assets/.',
    },
    clicker: {
        tools: ['click', 'screenshot'], turns: 4, schema: null,
        description: 'Clicks one UI target on the screen.',
    },
    typer: {
        tools: ['type', 'screenshot'], turns: 4, schema: null,
        description: 'Types text or a key chord into the focused control.',
    },
    encoder: {
        tools: ['screenshot'], turns: 3, schema: 'batch',
        description: 'Turns a task into a desktop batch document and returns it without running it.',
    },
});

/** Names of the built-in executors, in registry order. */
export const EXECUTOR_NAMES = Object.freeze(Object.keys(EXECUTORS));

/**
 * Names a configuration may hand work to: the built-in executors plus every user-defined role.
 * A built-in pipeline role without an executor entry (planner, orchestrator, summarizer, …)
 * stays out: it has a job in the pipeline, not a free-form task.
 * @param {object} [config]
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function executorNames(config = null) {
    // config.roles always carries every built-in entry, so the name list, not presence, decides.
    const custom = Object.keys(config?.roles ?? {})
        .filter((name) => !BUILTIN_ROLE_NAMES.includes(name));
    return [...EXECUTOR_NAMES, ...custom];
}

/**
 * Does `name` name an executor this configuration may start?
 * @param {string} name
 * @param {object} [config]
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function isExecutor(name, config = null) {
    return EXECUTOR_NAMES.includes(name) || executorNames(config).includes(name);
}

/**
 * Spec of one executor. A user-defined role takes its tool list from `roles.<name>.tools`,
 * its turns from `roles.<name>.turns` (default 20), and its description from its instructions.
 * @param {string} name
 * @param {object} [config]
 * @returns {{ tools: string | string[], turns: number, schema: string | null, description: string } | null}
 * @exports
 * @ai.hint pure
 */
export function executorSpec(name, config = null) {
    if (Object.hasOwn(EXECUTORS, name)) return EXECUTORS[name];
    // A built-in pipeline role has a job in the pipeline, not a free-form task.
    if (BUILTIN_ROLE_NAMES.includes(name)) return null;
    const role = config?.roles?.[name];
    if (!role) return null;
    const instructions = typeof role.instructions === 'string' ? role.instructions.trim() : '';
    return {
        tools: Array.isArray(role.tools) && role.tools.length ? [...role.tools] : 'all',
        turns: Number.isSafeInteger(role.turns) && role.turns > 0 ? role.turns : 20,
        schema: null,
        description: instructions ? instructions.split('\n')[0].slice(0, 240) : `User-defined role ${name}.`,
    };
}

/**
 * Tool names of one executor, intersected with what the caller has enabled.
 * @param {{ tools: string | string[] }} spec
 * @param {string[]} allNames tool names the calling agent has
 * @param {{ nested?: boolean }} [options] `nested` drops the tools that would start another run
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function executorToolNames(spec, allNames, { nested = true } = {}) {
    const base = Array.isArray(spec.tools) ? spec.tools : (SLICES[spec.tools] ?? SLICES.all)(allNames);
    const forbidden = nested ? new Set(NESTED_FORBIDDEN) : new Set();
    return allNames.filter((name) => base.includes(name) && !forbidden.has(name));
}
