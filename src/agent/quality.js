/**
 * @file src/agent/quality.js
 * @module agent/quality
 * @purpose Judge a finished task through POST /decisions instead of a full reviewer role.
 * @depends node:fs/promises, agent/paths, channels/decide, channels/questions, openai/errors, openai/images
 * @usedBy agent/team
 * @exports assessmentImages, assessQuality, verdictFromQuality
 * @ai.tags decisions, review, images
 * @ai.hint io
 * @changed 2026-10-21 Decisions and optional vision replace the first reviewer pass when they accept.
 */

import { readFile, stat } from 'node:fs/promises';
import { resolveInside } from './paths.js';
import { requestDecision } from '../channels/decide.js';
import { qualityQuestions } from '../channels/questions.js';
import { ApiError } from '../openai/errors.js';
import { sniffImage } from '../openai/images.js';

const VERDICTS = new Set(['accept', 'revise', 'fail']);

/**
 * True when the gateway rejected the pictures rather than the whole decisions route.
 * @param {Error} error
 * @returns {boolean}
 * @ai.hint pure
 */
function imageRejected(error) {
    if (!(error instanceof ApiError)) return false;
    if (![400, 413, 415, 422].includes(error.status)) return false;
    const text = `${error.message} ${error.apiCode ?? ''} ${error.apiType ?? ''}`.toLowerCase();
    return /image|asset|vision|picture|base64|media|multipart/.test(text);
}

/**
 * True when the gateway has no decisions route at all.
 * @param {Error} error
 * @returns {boolean}
 * @ai.hint pure
 */
function decisionsMissing(error) {
    if (!(error instanceof ApiError)) return false;
    if (error.code === 'DECISIONS_UNAVAILABLE') return true;
    return [404, 405, 501].includes(error.status);
}

/**
 * Collect the pictures a decision model may judge: the attached references first, then produced files.
 * Only PNG and JPEG are sent; other formats and oversized files are skipped.
 * @param {{ root: string, parts?: object[], produced?: string[], max?: number, maxBytes?: number }} request
 * @returns {Promise<object[]>} input_image parts
 * @exports
 * @ai.hint io
 */
export async function assessmentImages({ root, parts = [], produced = [], max = 3, maxBytes = 8 * 1024 * 1024 }) {
    const images = [];
    const add = (part) => { if (images.length < max) images.push(part); };
    for (const part of parts) {
        if (part?.type !== 'input_image' || typeof part.image_url !== 'string' || !part.image_url) continue;
        add({ type: 'input_image', image_url: part.image_url });
    }
    for (const rel of produced) {
        if (images.length >= max) break;
        try {
            const located = await resolveInside(root, rel, { allowRoot: false });
            const info = await stat(located.abs);
            if (!info.isFile() || info.size > maxBytes) continue;
            const bytes = await readFile(located.abs);
            const kind = sniffImage(bytes);
            if (kind.mime !== 'image/png' && kind.mime !== 'image/jpeg') continue;
            add({ type: 'input_image', image_url: `data:${kind.mime};base64,${bytes.toString('base64')}` });
        } catch { /* a missing or unreadable picture is not a reason to fail the run */ }
    }
    return images;
}

/**
 * Map quality answers to accept, revise, or fail plus reviewer-shaped issues.
 * A clearly negative required answer overrides an optimistic choice.
 * @param {object} answers Decisions answers.
 * @param {{ reviewAt?: number }} [thresholds]
 * @returns {{ verdict: 'accept'|'revise'|'fail', scores: object, confidence: number|null, issues: object[], summary: string }}
 * @exports
 * @ai.hint pure
 */
export function verdictFromQuality(answers, { reviewAt = 0.5 } = {}) {
    const score = (name) => (answers?.[name]?.type === 'noul' && typeof answers[name].noul === 'number' ? answers[name].noul : null);
    const scores = {
        meets_task: score('meets_task'),
        complete: score('complete'),
        verified: score('verified'),
        visual_match: score('visual_match'),
    };
    const choice = answers?.verdict?.type === 'choice' ? answers.verdict.choice : null;
    const confidence = typeof answers?.verdict?.confidence === 'number' ? answers.verdict.confidence : null;
    let verdict = VERDICTS.has(choice) ? choice : 'revise';
    if (!VERDICTS.has(choice)) {
        const task = scores.meets_task;
        const complete = scores.complete ?? 1;
        verdict = task !== null && task >= reviewAt && complete >= reviewAt ? 'accept' : 'revise';
    }
    if (verdict === 'accept' && ((scores.meets_task ?? 1) < reviewAt || (scores.complete ?? 1) < reviewAt)) verdict = 'revise';
    if (verdict !== 'fail' && scores.meets_task !== null && scores.meets_task < reviewAt / 2) verdict = 'fail';
    const issues = [];
    if ((scores.meets_task ?? 1) < reviewAt) {
        issues.push({ severity: 'high', path: null, message: 'Результат не решает задачу', requestedChange: 'Сверьтесь с задачей и критериями приёмки и выполните пропущенное.' });
    }
    if ((scores.complete ?? 1) < reviewAt) {
        issues.push({ severity: 'high', path: null, message: 'Не все обязательные части готовы', requestedChange: 'Допишите отсутствующие файлы и разделы, уберите заглушки.' });
    }
    if ((scores.verified ?? 1) < reviewAt) {
        issues.push({ severity: 'medium', path: null, message: 'Результат не проверен', requestedChange: 'Запустите сборку или тесты, исправьте ошибки и перечитайте результат.' });
    }
    if ((scores.visual_match ?? 1) < reviewAt) {
        issues.push({ severity: 'medium', path: null, message: 'Результат визуально расходится с референсом', requestedChange: 'Приблизьте композицию, типографику и палитру к референсу.' });
    }
    const parts = Object.entries(scores)
        .filter(([, value]) => value !== null)
        .map(([name, value]) => `${name} ${value.toFixed(2)}`);
    const summary = `decisions: ${verdict}${confidence === null ? '' : ` (уверенность ${confidence.toFixed(2)})`}${parts.length ? ` · ${parts.join(' · ')}` : ''}`;
    return { verdict, scores, confidence, issues, summary };
}

/**
 * Ask the decision model to judge the result. Returns null when the route or the model is unavailable,
 * so the caller can keep the ordinary reviewer.
 * @param {{ client: object, config: object, ledger?: object, state: object, images?: object[], signal?: AbortSignal, notify?: Function }} request
 * @returns {Promise<object|null>}
 * @exports
 * @ai.hint io
 */
export async function assessQuality({ client, config, ledger = null, state, images = [], signal, notify = () => {} }) {
    if (!client?.decisions || config?.decisions?.assess === false) return null;
    const model = config?.decisions?.model;
    if (typeof model !== 'string' || !model.trim()) return null;
    const withVision = config?.decisions?.vision !== false;
    let pictures = withVision ? images.slice(0, 3) : [];

    /** One decisions call with or without pictures. */
    const ask = () => requestDecision(client, {
        model,
        state: pictures.length ? { ...state, images: pictures } : state,
        questions: qualityQuestions({ hasImages: pictures.length > 0 }),
        signal,
        extraHeaders: pictures.length ? { 'TypeSafe-Danger-Zone-Images': 'true' } : null,
    });

    let raw;
    try {
        raw = await ask();
    } catch (error) {
        if (pictures.length && imageRejected(error)) {
            notify({ type: 'warning', message: `Решения с картинками недоступны (${error.message}); оценка без картинок.` });
            pictures = [];
            try { raw = await ask(); } catch (second) { error = second; }
        }
        if (!raw) {
            if (!decisionsMissing(error)) notify({ type: 'warning', message: `Оценка качества через decisions пропущена: ${error.message}` });
            return null;
        }
    }
    ledger?.record({ model: raw.model, usage: raw.usage, kind: 'decision', responseId: raw.id });
    return { ...verdictFromQuality(raw.answers, { reviewAt: config?.decisions?.reviewAt ?? 0.5 }), model: raw.model, vision: pictures.length > 0 };
}
