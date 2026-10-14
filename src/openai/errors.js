/** Error raised for any failure while talking to the OpenAI API. */
export class ApiError extends Error {
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

export class BudgetError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'BudgetError';
    this.code = 'BUDGET_EXCEEDED';
    Object.assign(this, details);
  }
}

export class CancelledError extends Error {
  constructor(message = 'Операция отменена.') {
    super(message);
    this.name = 'CancelledError';
    this.code = 'CANCELLED';
  }
}

export const isAbortError = (error) =>
  error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || error instanceof CancelledError;
