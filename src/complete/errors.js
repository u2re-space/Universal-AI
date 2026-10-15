/**
 * @file src/complete/errors.js
 * @module complete/errors
 * @purpose Error type for a rejected editor completion request.
 * @usedBy complete/context, complete/complete, complete/server, commands/complete
 * @exports CompletionError
 * @ai.tags complete
 * @ai.hint pure
 * @changed 2026-10-15 Editor completion errors.
 */

/**
 * The completion request cannot be served. `status` is the HTTP status for the IDE API.
 * @exports
 * @ai.hint pure
 */
export class CompletionError extends Error {
    /**
     * @param {string} message Text returned to the editor.
     * @param {{ status?: number, code?: string }} [options] HTTP status and stable code.
     * @returns {CompletionError}
     * @ai.hint pure
     */
    constructor(message, { status = 400, code = 'BAD_REQUEST' } = {}) {
        super(message);
        this.name = 'CompletionError';
        this.status = status;
        this.code = code;
    }
}
