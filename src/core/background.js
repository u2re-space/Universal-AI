import { setTimeout as sleep } from 'node:timers/promises';
import { ApiError } from '../openai/errors.js';

export const TERMINAL_STATUSES = new Set(['completed', 'failed', 'incomplete', 'cancelled']);

/**
 * Poll a background response (created with background:true) until it reaches a terminal state.
 * Emits response.status on every poll so the UI can show "queued / in_progress".
 */
export async function awaitBackground({ client, id, signal, emit = () => {}, pollIntervalMs = 2000, include }) {
  for (;;) {
    signal?.throwIfAborted();
    const response = await client.responses.retrieve(id, { signal, include });
    emit({ type: 'response.status', status: response.status, responseId: response.id, polled: true });
    if (TERMINAL_STATUSES.has(response.status)) return response;
    await sleep(pollIntervalMs, undefined, { signal });
  }
}

/**
 * Re-attach to a streaming background response. Replays events from `startingAfter`
 * (or from the beginning) and resolves with the final response. Reconnects on transport
 * failures a few times, continuing from the last sequence number seen.
 */
export async function attachBackground({ client, id, signal, onEvent, startingAfter = null, maxReconnects = 5, include }) {
  let after = startingAfter;
  let attempt = 0;
  for (;;) {
    try {
      return await client.responses.retrieve(id, { stream: true, startingAfter: after, signal, onEvent, include });
    } catch (error) {
      const transient = error instanceof ApiError && ['STREAM_TRUNCATED', 'NETWORK_ERROR', 'TIMEOUT', 'CONNECT_TIMEOUT'].includes(error.code);
      if (!transient || signal?.aborted || attempt >= maxReconnects) throw error;
      if (Number.isSafeInteger(error.details?.lastSequence)) after = error.details.lastSequence;
      attempt++;
      onEvent?.({ type: 'request.retry', attempt, delayMs: 1000 * attempt, reason: `переподключение к фоновому ответу: ${error.message}` });
      await sleep(1000 * attempt, undefined, { signal });
    }
  }
}
