/**
 * @file src/agent/work-plan.js
 * @module agent/work-plan
 * @purpose Split a plan into file steps, and store the plan and its progress under `.tmp`.
 * @depends node:path, node:crypto, node:fs/promises, util/text
 * @usedBy agent/team, index.js
 * @exports pathsIn, expandPlan, parsePlanUpdate, applyPlanUpdate, createProgress, recordStep, syncProgress, briefPlan, briefProgress, continuationText, revisionClause, applyFromStep, resolveResumeStep, newWorkId, saveWork, loadWork, findResumable, findLatestResumable
 * @ai.tags team, plan, tmp
 * @ai.hint io
 * @changed 2026-10-17 Resume continues an interrupted step, phase, and saved turn.
 */

import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { clipMiddle } from '../util/text.js';

const PATH_RE = /(?:^|[\s`'"(])((?:[\w.+-]+\/)*[\w.+-]+\.[\w.+-]+)/g;
const EXT_RE = /^(js|mjs|cjs|ts|tsx|jsx|json|md|css|html|glsl|py|txt|vue|svelte|scss|yml|yaml|toml|rs|go|java|kt|php|rb|sh|ps1|xml|svg)$/;
const RESUMABLE = new Set(['running', 'incomplete', 'failed', 'budget', 'cancelled', 'max_turns']);
const ID_RE = /^[0-9a-f]{8}$/;
const COMPLEXITY_RANK = Object.freeze({ trivial: 0, normal: 1, complex: 2 });

/**
 * One of the three plan complexities, or null.
 * @param {unknown} value
 * @returns {'trivial'|'normal'|'complex'|null}
 * @ai.hint pure
 */
function complexityOf(value) {
    return value === 'trivial' || value === 'normal' || value === 'complex' ? value : null;
}

/**
 * The hardest complexity in a list. `fallback` is used when no item names one.
 * @param {object[]} steps
 * @param {'trivial'|'normal'|'complex'|null} [fallback]
 * @returns {'trivial'|'normal'|'complex'|null}
 * @ai.hint pure
 */
function hardestComplexity(steps, fallback = null) {
    let best = null;
    for (const step of steps) {
        const value = complexityOf(step?.complexity);
        if (value && (!best || COMPLEXITY_RANK[value] > COMPLEXITY_RANK[best])) best = value;
    }
    return best ?? fallback;
}

/**
 * Collapse whitespace so two copies of a task still match.
 * @param {string} task
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function normalizeTask(task) {
    return String(task ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Eight hex characters for a new `.tmp` directory.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function newWorkId() {
    return randomBytes(4).toString('hex');
}

/**
 * Extension of the final path segment, without the dot.
 * @param {string} token
 * @returns {string}
 * @ai.hint pure
 */
function extensionOf(token) {
    const base = token.split('/').at(-1) ?? '';
    const dot = base.lastIndexOf('.');
    if (dot <= 0 || dot === base.length - 1) return '';
    return base.slice(dot + 1).toLowerCase();
}

/**
 * Whether `token` is one relative project file.
 * @param {string} token
 * @returns {boolean}
 * @ai.hint pure
 */
function isProjectPath(token) {
    if (!token || token.includes('://') || token.split('/').includes('..')) return false;
    const ext = extensionOf(token);
    if (!/^[a-z][a-z0-9]{0,7}$/.test(ext)) return false;
    return EXT_RE.test(ext) || token.includes('/');
}

/**
 * Relative file paths mentioned in `text`, in order, without duplicates.
 * @param {string} text
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function pathsIn(text) {
    const found = [];
    const seen = new Set();
    for (const match of String(text ?? '').matchAll(PATH_RE)) {
        const token = match[1].replace(/[.,;:)]+$/g, '');
        if (!isProjectPath(token) || seen.has(token)) continue;
        seen.add(token);
        found.push(token);
    }
    return found;
}

/**
 * Copy a planner step and attach the files named in its text.
 * @param {object} step
 * @param {string} [kind]
 * @returns {object}
 * @ai.hint pure
 */
function asStep(step, kind = 'work') {
    const goal = String(step?.goal ?? '');
    const details = String(step?.details ?? '');
    const verify = String(step?.verify ?? '');
    const complexity = complexityOf(step?.complexity);
    return {
        ...(step?.id ? { id: step.id } : {}),
        kind: step?.kind === 'compat' ? 'compat' : kind,
        ...(complexity ? { complexity } : {}),
        goal, details, verify,
        files: Array.isArray(step?.files) && step.files.length ? [...step.files] : pathsIn(`${goal}\n${details}`),
    };
}

/**
 * Next `sNN` id that is not already used.
 * @param {object[]} steps
 * @returns {string}
 * @ai.hint pure
 */
function freshId(steps) {
    const used = new Set(steps.map((step) => step.id).filter(Boolean));
    let n = steps.length + 1;
    let id = '';
    do {
        id = `s${String(n).padStart(2, '0')}`;
        n += 1;
    } while (used.has(id));
    return id;
}

/**
 * Split a step that names several files, then add one compatibility step when more than one file is involved.
 * The result never grows past `maxSteps`.
 * @param {object} plan
 * @param {{ maxSteps?: number }} [options]
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function expandPlan(plan, { maxSteps = 12, splitFiles = true } = {}) {
    const source = Array.isArray(plan?.steps) ? plan.steps : [];
    const steps = [];
    let split = false;
    for (const step of source) {
        if (steps.length >= maxSteps) break;
        const files = pathsIn(`${step?.goal ?? ''}\n${step?.details ?? ''}`);
        const complexity = complexityOf(step?.complexity);
        const room = maxSteps - steps.length;
        if (splitFiles && step?.kind !== 'compat' && files.length >= 2 && files.length <= room) {
            split = true;
            for (const file of files) {
                steps.push({
                    kind: 'work',
                    ...(complexity ? { complexity } : {}),
                    goal: `${step.goal} — ${file}`,
                    details: `Work only on ${file}.\n${step.details ?? ''}`,
                    verify: step.verify || `Re-read ${file}.`,
                    files: [file],
                });
            }
        } else {
            steps.push(asStep(step));
        }
    }
    const fileCount = new Set(steps.flatMap((step) => step.files ?? [])).size;
    const hasCompat = steps.some((step) => step.kind === 'compat');
    if (splitFiles && (split || fileCount >= 2) && !hasCompat && steps.length < maxSteps) {
        const files = [...new Set(steps.flatMap((step) => step.files ?? []))];
        const complexity = hardestComplexity(steps, complexityOf(plan?.complexity));
        steps.push({
            kind: 'compat',
            ...(complexity ? { complexity } : {}),
            goal: 'Reconcile generated files',
            details: `Read ${files.join(', ')} and fix imports, exports, names, and call sites so they agree. Do not add features.`,
            verify: 'Re-read each touched file and confirm every import names an export that exists.',
            files,
        });
    }
    const assigned = [];
    for (const step of steps) {
        const next = { ...step };
        if (!next.id || assigned.some((item) => item.id === next.id)) next.id = freshId(assigned);
        assigned.push(next);
    }
    return { ...plan, steps: assigned };
}

/**
 * Read a `plan-update` fence from a worker report.
 * @param {string} report
 * @returns {{ note: string, addSteps: object[], revise: object[] } | null}
 * @exports
 * @ai.hint pure
 */
export function parsePlanUpdate(report) {
    const match = /```plan-update\s*\n([\s\S]*?)```/i.exec(String(report ?? ''));
    if (!match) return null;
    let data;
    try { data = JSON.parse(match[1]); }
    catch { return null; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const addSteps = Array.isArray(data.addSteps) ? data.addSteps.flatMap((step) => {
        if (!step || typeof step.goal !== 'string' || !step.goal.trim()) return [];
        const complexity = complexityOf(step.complexity);
        return [{
            goal: step.goal.trim(),
            details: typeof step.details === 'string' ? step.details : '',
            verify: typeof step.verify === 'string' ? step.verify : '',
            ...(complexity ? { complexity } : {}),
        }];
    }) : [];
    const revise = Array.isArray(data.revise) ? data.revise.flatMap((step) => {
        if (!step || typeof step.id !== 'string' || !step.id.trim()) return [];
        const item = { id: step.id.trim() };
        if (typeof step.goal === 'string') item.goal = step.goal;
        if (typeof step.details === 'string') item.details = step.details;
        if (typeof step.verify === 'string') item.verify = step.verify;
        return [item];
    }) : [];
    if (!addSteps.length && !revise.length && typeof data.note !== 'string') return null;
    return { note: typeof data.note === 'string' ? data.note : '', addSteps, revise };
}

/**
 * Revise pending step text and insert new steps ahead of the compatibility step.
 * @param {object} plan
 * @param {{ note?: string, addSteps?: object[], revise?: object[] }} update
 * New steps are inserted after `afterId` and before the compatibility step.
 * @param {{ maxSteps?: number, afterId?: string | null }} [options]
 * @returns {{ plan: object, note: string }}
 * @exports
 * @ai.hint pure
 */
export function applyPlanUpdate(plan, update, { maxSteps = 12, afterId = null } = {}) {
    const steps = (plan.steps ?? []).map((step) => ({ ...step, files: [...(step.files ?? [])] }));
    for (const rev of update.revise ?? []) {
        const step = steps.find((item) => item.id === rev.id);
        if (!step) continue;
        if (typeof rev.goal === 'string' && rev.goal.trim()) step.goal = rev.goal.trim();
        if (typeof rev.details === 'string') step.details = rev.details;
        if (typeof rev.verify === 'string') step.verify = rev.verify;
        step.files = pathsIn(`${step.goal}\n${step.details}`);
    }
    const after = afterId ? steps.findIndex((step) => step.id === afterId) : -1;
    let insertAt = steps.findIndex((step) => step.kind === 'compat');
    if (after >= 0 && steps[after].kind === 'compat') insertAt = after + 1;
    else if (after >= 0) insertAt = insertAt < 0 ? after + 1 : Math.min(insertAt, after + 1);
    else if (insertAt < 0) insertAt = steps.length;
    for (const extra of update.addSteps ?? []) {
        if (steps.length >= maxSteps) break;
        const goal = extra.goal.trim();
        const details = extra.details ?? '';
        const complexity = complexityOf(extra.complexity) ?? complexityOf(plan?.complexity);
        steps.splice(insertAt, 0, {
            id: freshId(steps),
            kind: 'work',
            ...(complexity ? { complexity } : {}),
            goal,
            details,
            verify: extra.verify || 'Re-read the result.',
            files: pathsIn(`${goal}\n${details}`),
        });
        insertAt += 1;
    }
    return { plan: { ...plan, steps }, note: update.note ?? '' };
}

/**
 * Empty progress document for a plan that has not started.
 * @param {{ id: string, task: string, plan: object }} input
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function createProgress({ id, task, plan }) {
    return {
        id, task, status: 'running', stage: 'plan', cursor: 0,
        steps: (plan.steps ?? []).map((step, index) => ({
            id: step.id, index: index + 1, goal: step.goal, kind: step.kind ?? 'work',
            status: 'pending', phase: 'pending', report: '', files: [],
        })),
        files: [], notes: [], updatedAt: new Date().toISOString(),
    };
}

/**
 * Keep completed step records when the plan gains or revises steps.
 * @param {object} progress
 * @param {object} plan
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function syncProgress(progress, plan) {
    const prev = new Map((progress.steps ?? []).map((step) => [step.id, step]));
    const steps = plan.steps.map((step, index) => {
        const old = prev.get(step.id);
        if (old) return { ...old, index: index + 1, goal: step.goal, kind: step.kind ?? old.kind ?? 'work' };
        return {
            id: step.id, index: index + 1, goal: step.goal, kind: step.kind ?? 'work',
            status: 'pending', phase: 'pending', report: '', files: [],
        };
    });
    return { ...progress, steps };
}

/**
 * Store one step's outcome and the files it touched.
 * A completed step advances `cursor`. Any other status leaves `cursor` on that step.
 * @param {object} progress
 * @param {{ index: number, status: string, report: string, files?: string[] }} outcome
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function recordStep(progress, { index, status, report, files = [], phase = null }) {
    const steps = progress.steps.map((step, i) => {
        if (i !== index) return step;
        const merged = [...new Set([...(step.files ?? []), ...files])];
        return {
            ...step, status, report, files: merged,
            phase: status === 'completed' ? 'done' : (phase ?? step.phase ?? 'pending'),
        };
    });
    const known = new Set((progress.files ?? []).map((file) => file.path));
    const added = [];
    for (const file of steps[index]?.files ?? []) {
        if (!file || known.has(file)) continue;
        known.add(file);
        added.push({ path: file, stepId: steps[index].id });
    }
    const open = steps.findIndex((step) => step.status !== 'completed');
    return {
        ...progress,
        steps,
        files: [...(progress.files ?? []), ...added],
        cursor: open < 0 ? steps.length : open,
        status: status === 'completed' ? 'running' : status,
        stage: 'work',
    };
}

/**
 * Prompt for a step that already started. A saved session only needs the short form.
 * @param {object} step
 * @param {object} [progressStep]
 * @param {{ resumeSession?: boolean }} [options]
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function continuationText(step, progressStep = {}, { resumeSession = false, revision = '' } = {}) {
    const rules = 'Finish only what is still missing. Do not repeat a finished tool call, do not regenerate an image that already exists, and do not rewrite a file that already satisfies the step.';
    const goal = `Goal: ${step?.goal ?? ''}\nDetails: ${step?.details ?? ''}\nVerify: ${step?.verify ?? ''}`;
    const extra = revisionClause(revision);
    if (resumeSession) return `Continue this step from the interrupted turn. The conversation above is the work already done.\n${rules}\n${goal}${extra}`;
    const files = (progressStep?.files ?? []).join(', ') || '(none)';
    const report = clipMiddle(progressStep?.report ?? '', 4000);
    return [
        'Continue this step from the interrupted turn. Finish the current phase.',
        rules,
        goal,
        `Phase: ${progressStep?.phase && progressStep.phase !== 'pending' ? progressStep.phase : 'body'}`,
        `Files already written: ${files}`,
        report ? `Report so far:\n${report}` : '',
        extra,
    ].filter(Boolean).join('\n');
}

/**
 * English note appended when the operator asked to add, fix, or adjust something.
 * @param {string} [revision]
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function revisionClause(revision) {
    const text = String(revision ?? '').trim();
    if (!text) return '';
    return `\nOperator revision:\n${text}\nAdd, fix, or adjust what this asks. Do not redo work that already satisfies the step.`;
}

/**
 * Start at `index`. Completed steps from there are opened again. An interrupted step stays interrupted.
 * @param {object} progress
 * @param {number} index
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function applyFromStep(progress, index) {
    const steps = (progress.steps ?? []).map((step, i) => {
        if (i < index || step.status !== 'completed') return step;
        return { ...step, status: 'pending', phase: 'pending' };
    });
    return { ...progress, steps, cursor: index, stage: 'work' };
}

/**
 * Zero-based step index for `2` or `s02`. `-1` when the token is not in the plan.
 * @param {object} plan
 * @param {string|number} token
 * @returns {number}
 * @exports
 * @ai.hint pure
 */
export function resolveResumeStep(plan, token) {
    const steps = Array.isArray(plan?.steps) ? plan.steps : [];
    const text = String(token ?? '').trim();
    const ident = /^s(\d+)$/i.exec(text);
    if (ident) {
        const id = `s${ident[1].padStart(2, '0')}`.toLowerCase();
        return steps.findIndex((step) => String(step.id).toLowerCase() === id);
    }
    const number = Number(text);
    if (Number.isInteger(number) && number >= 1 && number <= steps.length) return number - 1;
    return -1;
}

/**
 * Short plan for the shared context. Step details stay in `plan.json`.
 * @param {object} plan
 * @param {object} progress
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function briefPlan(plan, progress) {
    const steps = (plan.steps ?? []).map((step, index) => {
        const status = progress?.steps?.[index]?.status ?? 'pending';
        return `${index + 1}. [${status}] ${step.goal}`;
    }).join('\n');
    const criteria = Array.isArray(plan.acceptanceCriteria) ? plan.acceptanceCriteria : [];
    return [
        `Plan file: .tmp/${progress.id}/plan.json`,
        `Progress file: .tmp/${progress.id}/progress.json`,
        plan.summary ?? '',
        `Complexity: ${plan.complexity ?? 'normal'}`,
        `Steps:\n${steps || '(none)'}`,
        `Acceptance criteria:\n${criteria.map((item) => `- ${item}`).join('\n') || '- (none)'}`,
    ].join('\n');
}

/**
 * The last step reports only. The full text is in `progress.json`.
 * @param {object} progress
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function briefProgress(progress) {
    const recent = (progress.steps ?? []).filter((step) => step.report).slice(-2)
        .map((step) => `### Step ${step.index}: ${step.goal}\nStatus: ${step.status}\n${clipMiddle(step.report, 1500)}`);
    const notes = (progress.notes ?? []).slice(-2)
        .map((note) => `### ${note.kind}${note.round ? ` ${note.round}` : ''}\n${note.status ? `Status: ${note.status}\n` : ''}${clipMiddle(note.report || note.note || '', 1500)}`);
    if (progress.imageProcessing?.report) notes.push(`### Image processing\nStatus: ${progress.imageProcessing.status}\n${clipMiddle(progress.imageProcessing.report, 3000)}`);
    const files = (progress.files ?? []).map((file) => file.path).join(', ');
    const body = [...recent, ...notes].filter(Boolean).join('\n\n');
    if (!body && !files) return '';
    return `${body}${files ? `\n\nFiles: ${files}` : ''}\n\nFull progress: .tmp/${progress.id}/progress.json`;
}

/**
 * Write `plan.json` and `progress.json` under `.tmp/<id>/`.
 * @param {string} root
 * @param {{ id: string, plan: object, progress: object }} work
 * @returns {Promise<{ plan: object, progress: object }>}
 * @exports
 * @ai.hint io
 */
export async function saveWork(root, work) {
    const dir = path.join(root, '.tmp', work.id);
    await mkdir(dir, { recursive: true });
    const plan = { ...work.plan, id: work.id, task: work.progress.task };
    const progress = { ...work.progress, id: work.id, updatedAt: new Date().toISOString() };
    await writeFile(path.join(dir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
    await writeFile(path.join(dir, 'progress.json'), `${JSON.stringify(progress, null, 2)}\n`, 'utf8');
    return { plan, progress };
}

/**
 * Read a stored plan and its progress.
 * @param {string} root
 * @param {string} id
 * @returns {Promise<{ id: string, plan: object, progress: object }>}
 * @exports
 * @ai.hint io
 */
export async function loadWork(root, id) {
    const dir = path.join(root, '.tmp', id);
    const plan = JSON.parse(await readFile(path.join(dir, 'plan.json'), 'utf8'));
    const progress = JSON.parse(await readFile(path.join(dir, 'progress.json'), 'utf8'));
    return { id, plan, progress };
}

/**
 * Newest unfinished plan for this task, or null.
 * @param {string} root
 * @param {string} task
 * @returns {Promise<{ id: string, plan: object, progress: object } | null>}
 * @exports
 * @ai.hint io
 */
export async function findResumable(root, task) {
    const wanted = normalizeTask(task);
    const works = await readWorks(root);
    return newest(works.filter((work) => normalizeTask(work.progress.task) === wanted && isOpenWork(work)));
}

/**
 * Newest unfinished plan in this directory. With `includeDone`, a finished plan is used when nothing is open.
 * @param {string} root
 * @param {{ includeDone?: boolean }} [options]
 * @returns {Promise<{ id: string, plan: object, progress: object } | null>}
 * @exports
 * @ai.hint io
 */
export async function findLatestResumable(root, { includeDone = false } = {}) {
    const works = await readWorks(root);
    return newest(works.filter((work) => isOpenWork(work))) ?? (includeDone ? newest(works) : null);
}

/**
 * @param {string} root
 * @returns {Promise<{ id: string, plan: object, progress: object }[]>}
 * @ai.hint io
 */
async function readWorks(root) {
    const dir = path.join(root, '.tmp');
    let entries = [];
    try { entries = await readdir(dir); }
    catch { return []; }
    const works = [];
    for (const id of entries) {
        if (!ID_RE.test(id)) continue;
        let progress;
        let plan;
        try {
            progress = JSON.parse(await readFile(path.join(dir, id, 'progress.json'), 'utf8'));
            plan = JSON.parse(await readFile(path.join(dir, id, 'plan.json'), 'utf8'));
        } catch { continue; }
        if (!progress || !plan || !Array.isArray(plan.steps)) continue;
        works.push({ id, plan, progress });
    }
    return works;
}

/**
 * @param {{ plan: object, progress: object }} work
 * @returns {boolean}
 * @ai.hint pure
 */
function isOpenWork(work) {
    const { plan, progress } = work;
    if (!RESUMABLE.has(progress.status)) return false;
    const reviewOpen = progress.stage === 'review' || progress.stage === 'fix';
    return progress.cursor < plan.steps.length || reviewOpen;
}

/**
 * @param {{ id: string, plan: object, progress: object }[]} works
 * @returns {{ id: string, plan: object, progress: object } | null}
 * @ai.hint pure
 */
function newest(works) {
    let best = null;
    for (const work of works) {
        if (!best || String(work.progress.updatedAt) > String(best.progress.updatedAt)) best = work;
    }
    return best;
}
