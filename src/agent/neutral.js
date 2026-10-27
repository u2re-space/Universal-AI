/**
 * @file src/agent/neutral.js
 * @module agent/neutral
 * @purpose Drop country and nationality labels from text sent back to a model.
 * @usedBy agent/team
 * @exports neutralWording, neutralPlan, neutralProgress, neutralSession
 * @ai.tags prompt
 * @ai.hint pure
 * @changed 2026-10-17 Stored plans must not replay an English country or language name.
 */

const COUNTRY_LANGUAGE = /\bRussian(?:-language)?\b/gi;

/**
 * Replace an English country or language label with a neutral phrase.
 * @param {string} text
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function neutralWording(text) {
    return String(text ?? '').replace(COUNTRY_LANGUAGE, 'customer-language');
}

/**
 * @param {object} plan
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function neutralPlan(plan) {
    if (!plan || typeof plan !== 'object') return plan;
    const next = { ...plan };
    if (typeof next.summary === 'string') next.summary = neutralWording(next.summary);
    if (typeof next.imageNotes === 'string') next.imageNotes = neutralWording(next.imageNotes);
    for (const key of ['acceptanceCriteria', 'risks', 'questionsForCollector']) {
        if (Array.isArray(next[key])) next[key] = next[key].map((item) => typeof item === 'string' ? neutralWording(item) : item);
    }
    if (Array.isArray(next.steps)) {
        next.steps = next.steps.map((step) => ({
            ...step,
            goal: neutralWording(step?.goal),
            details: neutralWording(step?.details),
            verify: neutralWording(step?.verify),
        }));
    }
    if (Array.isArray(next.imageTasks)) {
        next.imageTasks = next.imageTasks.map((item) => ({
            ...item,
            goal: neutralWording(item?.goal),
            details: neutralWording(item?.details),
        }));
    }
    if (Array.isArray(next.decorationTasks)) {
        next.decorationTasks = next.decorationTasks.map((item) => ({
            ...item,
            goal: neutralWording(item?.goal),
            details: neutralWording(item?.details),
        }));
    }
    if (Array.isArray(next.taskMap)) {
        next.taskMap = next.taskMap.map((item) => item && typeof item === 'object'
            ? { ...item, reason: typeof item.reason === 'string' ? neutralWording(item.reason) : item.reason }
            : item);
    }
    return next;
}

/**
 * @param {object} progress
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function neutralProgress(progress) {
    if (!progress || typeof progress !== 'object') return progress;
    return {
        ...progress,
        task: typeof progress.task === 'string' ? neutralWording(progress.task) : progress.task,
        steps: (progress.steps ?? []).map((step) => ({
            ...step,
            goal: neutralWording(step?.goal),
            report: neutralWording(step?.report),
        })),
        imageProcessing: progress.imageProcessing && typeof progress.imageProcessing === 'object'
            ? {
                ...progress.imageProcessing,
                report: typeof progress.imageProcessing.report === 'string' ? neutralWording(progress.imageProcessing.report) : progress.imageProcessing.report,
                assets: Array.isArray(progress.imageProcessing.assets) ? progress.imageProcessing.assets.map((asset) => ({
                    ...asset,
                    use: typeof asset?.use === 'string' ? neutralWording(asset.use) : asset?.use,
                })) : progress.imageProcessing.assets,
            }
            : progress.imageProcessing,
    };
}

/**
 * Rewrite country and language labels already stored in a session.
 * @param {{ items?: object[] }} session
 * @returns {void}
 * @exports
 * @ai.hint pure
 */
export function neutralSession(session) {
    for (const item of session?.items ?? []) {
        if (!item || typeof item !== 'object') continue;
        if (typeof item.text === 'string') item.text = neutralWording(item.text);
        if (typeof item.output === 'string') item.output = neutralWording(item.output);
        if (typeof item.arguments === 'string') item.arguments = neutralWording(item.arguments);
        if (!Array.isArray(item.content)) continue;
        for (const part of item.content) {
            if (!part || typeof part !== 'object') continue;
            if (typeof part.text === 'string') part.text = neutralWording(part.text);
            if (typeof part.refusal === 'string') part.refusal = neutralWording(part.refusal);
        }
    }
}
