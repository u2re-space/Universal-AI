/**
 * @file src/openai/errors.js
 * @module openai/errors
 * @purpose Error types for API failures, budget stops, and cancellation.
 * @usedBy cli, openai/client, openai/http, openai/sse, openai/stream, core/background, core/usage, agent/loop, agent/tools, agent/team
 * @exports ApiError, BudgetError, CancelledError, isAbortError
 * @ai.tags errors
 * @ai.hint pure
 * @changed 2026-10-15 JSDoc card, 4-space indent.
 */

/** Error raised for any failure while talking to the OpenAI API. */
export class ApiError extends Error {
    /**
     * Copy status, request ids, and retry metadata onto the error. The response body is kept only when passed in.
     * @param {string} message
     * @param {object} [options]
     * @returns {void}
     * @ai.hint pure
     */
    constructor(message, {
        code = 'API_ERROR', status = null, requestId = null, clientRequestId = null, responseId = null,
        retryAfter = null, apiCode = null, apiType = null, param = null, retryable = false, cause, response,
        details = null,
    } = {}) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = 'ApiError';
        Object.assign(this, { code, status, requestId, clientRequestId, responseId, retryAfter, apiCode, apiType,
            param, retryable, details });
        if (response) this.response = response;
    }

    /** Response bodies and prompts are deliberately excluded from the log representation. */
    toJSON() {
        return {
            name: this.name, code: this.code, message: this.message, status: this.status,
            requestId: this.requestId, clientRequestId: this.clientRequestId, responseId: this.responseId,
            retryAfter: this.retryAfter, apiCode: this.apiCode, apiType: this.apiType, param: this.param,
            retryable: this.retryable,
        };
    }
}

/**
 * Raised when a token or USD budget blocks another request.
 * @exports
 * @ai.hint pure
 */
export class BudgetError extends Error {
    /**
     * @param {string} message
     * @param {object} [details] kind, used, and limit are copied onto the error.
     * @returns {void}
     * @ai.hint pure
     */
    constructor(message, details = {}) {
        super(message);
        this.name = 'BudgetError';
        this.code = 'BUDGET_EXCEEDED';
        Object.assign(this, details);
    }
}

/**
 * Raised when the user or a signal stops the current operation.
 * @exports
 * @ai.hint pure
 */
export class CancelledError extends Error {
    /**
     * @param {string} [message]
     * @returns {void}
     * @ai.hint pure
     */
    constructor(message = 'Операция отменена.') {
        super(message);
        this.name = 'CancelledError';
        this.code = 'CANCELLED';
    }
}

/**
 * True for an AbortError, ABORT_ERR, or CancelledError.
 * @param {*} error
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export const isAbortError = (error) =>
    error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || error instanceof CancelledError;
