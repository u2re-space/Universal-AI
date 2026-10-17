/**
 * @file src/commands/resume-args.js
 * @module commands/resume-args
 * @purpose Split `ai resume` arguments into a background response id or a local plan resume.
 * @exports parseResumeRequest
 * @ai.tags cli
 * @ai.hint pure
 * @changed 2026-10-17 A bare resume continues the unfinished step; other words are a revision.
 */

const RESPONSE_ID = /^resp_[A-Za-z0-9]+$/;
const STEP = /^(?:s\d+|\d+)$/i;

/**
 * `resp_…` reattaches a background response. Anything else continues local work.
 * A leading step token (`2` or `s02`) chooses where to start. The remaining words are the revision.
 * @param {string[]} [positionals]
 * @returns {{ kind: 'response', id: string } | { kind: 'work', step: string|null, revision: string }}
 * @exports
 * @ai.hint pure
 */
export function parseResumeRequest(positionals = []) {
    const tokens = positionals.map((token) => String(token ?? '').trim()).filter(Boolean);
    if (tokens.length === 1 && RESPONSE_ID.test(tokens[0])) return { kind: 'response', id: tokens[0] };
    if (tokens[0] && RESPONSE_ID.test(tokens[0])) {
        throw new Error('Идентификатор resp_… указывается без текста доработки.');
    }
    let step = null;
    let rest = tokens;
    if (tokens[0] && STEP.test(tokens[0])) {
        step = tokens[0];
        rest = tokens.slice(1);
    }
    return { kind: 'work', step, revision: rest.join(' ').trim() };
}
