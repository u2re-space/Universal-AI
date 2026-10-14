import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import Ajv from 'ajv';

/**
 * JSON filesystem protocol for Node.js 26 / ESM.
 * Authority stays in workspace.js: this module validates and dispatches data.
 * One envelope executes ONE operation. Only workspace.apply() is a file batch.
 * JSON cannot select a host root, alter limits, publish, execute code or shell.
 * executeFile() accepts only an explicitly host-selected external JSON file.
 */
const KiB = 1024;
const MiB = KiB * KiB;
const decoder = new TextDecoder('utf-8', { fatal: true });
const sizeOf = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const object = (properties) => ({
  type: 'object', properties, required: Object.keys(properties),
  additionalProperties: false,
});
const text = { type: 'string' };
const reason = { type: 'string', maxLength: 2048 };
const relativePath = { type: 'string', minLength: 1, maxLength: 512 };
const nullableText = { type: ['string', 'null'] };
const sha256 = { type: ['string', 'null'], pattern: '^[a-f0-9]{64}$' };
const change = object({
  operation: { enum: ['create_file', 'replace_text', 'delete_file'] },
  path: relativePath,
  baseSha256: sha256,
  search: nullableText,
  replacement: nullableText,
  content: nullableText,
});
const payloads = {
  tree: object({}),
  read: object({
    path: relativePath,
    startLine: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    endLine: { type: ['integer', 'null'], minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    reason,
  }),
  search: object({
    query: { type: 'string', minLength: 1, maxLength: 256 },
    pathPrefix: { type: 'string', maxLength: 512 },
    reason,
  }),
  apply: object({ changes: { type: 'array', items: change } }),
  diff: object({}),
};
const envelope = (operation, payload) => object({
  version: { type: 'integer', const: 1 },
  id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' },
  operation: { type: 'string', const: operation },
  payload,
});

/** JSON Schema usable by a producer; runtime limits are checked separately. */
export const fsRequestSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Local filesystem request v1',
  oneOf: Object.entries(payloads).map(([operation, payload]) => envelope(operation, payload)),
};

class EngineError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'FsEngineError';
    this.code = code;
  }
}
function integer(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name}: expected an integer in 1..${maximum}`);
  }
  return value;
}
function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' &&
    !relative.startsWith(`..${path.sep}`));
}
function reportError(error, fallback = 'FS_OPERATION_FAILED') {
  let code = error instanceof EngineError ? error.code : fallback;
  if (error?.name === 'AbortError') code = 'FS_CANCELLED';
  const message = error instanceof Error ? error.message : String(error);
  // Never embed request content or prompts in diagnostics.
  return { code, message: message.slice(0, 2048) };
}
function signalCheck(signal) {
  if (signal?.aborted) {
    throw new EngineError('FS_CANCELLED', 'Filesystem request cancelled.', { cause: signal.reason });
  }
}

/**
 * Explicitly selected local JSON input, not a model-facing filesystem operation.
 * lstat every component, then O_NOFOLLOW + descriptor checks + bounded reads.
 * This is not an OS sandbox: concurrent hostile directory replacement requires
 * OS-level isolation. Keep the input directory trusted and not concurrently edited.
 */
export async function loadFsRequestFile(filename, {
  maxBytes = 160 * KiB, signal, forbiddenRoots = [],
} = {}) {
  integer(maxBytes, 'maxBytes', 2 * MiB);
  signalCheck(signal);
  if (typeof filename !== 'string' || !filename || filename.includes('\0')) {
    throw new EngineError('FS_INPUT_INVALID', 'Specify a local JSON filename.');
  }
  const absolute = path.resolve(filename);
  if (path.extname(absolute).toLowerCase() !== '.json') {
    throw new EngineError('FS_INPUT_INVALID', 'The request file must have a .json extension.');
  }
  for (const root of forbiddenRoots) {
    if (within(path.resolve(root), absolute)) {
      throw new EngineError('FS_INPUT_FORBIDDEN', 'Request files must be outside the project and session directories.');
    }
  }
  const anchor = path.parse(absolute).root;
  const parts = absolute.slice(anchor.length).split(path.sep).filter(Boolean);
  let cursor = anchor;
  let expected;
  for (let i = 0; i < parts.length; i++) {
    signalCheck(signal);
    cursor = path.join(cursor, parts[i]);
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink()) {
      throw new EngineError('FS_INPUT_FORBIDDEN', 'Symlinks in the JSON input path are not supported.');
    }
    if (i < parts.length - 1 && !stat.isDirectory()) {
      throw new EngineError('FS_INPUT_INVALID', 'A JSON input parent is not a directory.');
    }
    if (i === parts.length - 1) expected = stat;
  }
  if (!expected?.isFile() || expected.size > maxBytes) {
    throw new EngineError('FS_INPUT_LIMIT', `A regular JSON file of at most ${maxBytes} bytes is required.`);
  }
  const handle = await open(absolute, constants.O_RDONLY |
    (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  let buffer;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== expected.dev || before.ino !== expected.ino || before.size > maxBytes) {
      throw new EngineError('FS_INPUT_CHANGED', 'The JSON input changed before reading.');
    }
    // Read one extra byte to detect growth; never use unbounded readFile().
    const storage = Buffer.allocUnsafe(maxBytes + 1);
    let used = 0;
    while (used < storage.length) {
      signalCheck(signal);
      const { bytesRead } = await handle.read(storage, used, Math.min(64 * KiB, storage.length - used), used);
      if (bytesRead === 0) break;
      used += bytesRead;
      if (used > maxBytes) throw new EngineError('FS_INPUT_LIMIT', 'The JSON input exceeded its byte limit.');
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        used !== after.size) {
      throw new EngineError('FS_INPUT_CHANGED', 'The JSON input changed while reading.');
    }
    buffer = storage.subarray(0, used);
  } finally {
    await handle.close();
  }
  signalCheck(signal);
  try {
    // TextDecoder permits a UTF-8 BOM; UTF-16 and invalid UTF-8 are rejected.
    return JSON.parse(decoder.decode(buffer));
  } catch {
    throw new EngineError('FS_INPUT_INVALID', 'The request must contain valid UTF-8 JSON.');
  }
}

/**
 * workspace must be made by createWorkspace(config, { signal, emit, approve }).
 * Use the SAME AbortSignal for workspace and engine.
 * emit is observational only: exceptions in the event sink cannot undo a commit.
 * A repeated request ID is always refused; no automatic replay or retry.
 * IDs are session-local, not a persistent exactly-once journal.
 */
export function createFsEngine({
  workspace, limits, signal, emit = () => {}, projectRoot,
  allowedOperations = ['tree', 'read', 'search', 'apply', 'diff'],
  maxJsonBytes, maxRequests = 200,
}) {
  if (!workspace || !limits) throw new TypeError('workspace and limits are required.');
  for (const operation of Object.keys(payloads)) {
    if (typeof workspace[operation] !== 'function') throw new TypeError(`workspace.${operation}() is required.`);
  }
  const contextCap = integer(limits.maxContextBytesPerCall, 'maxContextBytesPerCall', 64 * MiB);
  const patchCap = integer(limits.maxPatchBytesPerAttempt, 'maxPatchBytesPerAttempt', 2 * MiB);
  const fileCap = integer(limits.maxChangedFilesPerAttempt, 'maxChangedFilesPerAttempt', 10000);
  const jsonCap = integer(maxJsonBytes ?? Math.min(2 * MiB, patchCap + 32 * KiB), 'maxJsonBytes', 2 * MiB);
  const requestCap = integer(maxRequests, 'maxRequests', 10000);
  if (!Array.isArray(allowedOperations) || allowedOperations.some((op) => !Object.hasOwn(payloads, op))) {
    throw new TypeError('allowedOperations contains an unknown operation.');
  }
  const permitted = new Set(allowedOperations);
  const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
  const validators = new Map(Object.entries(payloads).map(([op, payload]) =>
    [op, ajv.compile(envelope(op, payload))]));
  const seen = new Set();
  let queue = Promise.resolve();
  let closed = false;
  let completed = 0;
  let succeeded = 0;
  let changedFiles = 0;
  const events = (event) => { try { emit(event); } catch { /* observer only */ } };
  const forbiddenRoots = [projectRoot, workspace.root, workspace.sessionDir].filter(Boolean);

  function prepare(value) {
    let serialized;
    try { serialized = JSON.stringify(value); }
    catch { throw new EngineError('FS_REQUEST_INVALID', 'The request is not JSON-serializable.'); }
    if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > jsonCap) {
      throw new EngineError('FS_REQUEST_LIMIT', `A JSON request of at most ${jsonCap} bytes is required.`);
    }
    const request = JSON.parse(serialized);
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw new EngineError('FS_REQUEST_INVALID', 'The request must be a JSON object.');
    }
    const validate = validators.get(request.operation);
    if (!validate) throw new EngineError('FS_REQUEST_INVALID', 'Unknown filesystem operation.');
    if (!validate(request)) {
      const details = validate.errors.slice(0, 5).map((e) => `${e.instancePath || '/'}: ${e.message}`).join('; ');
      throw new EngineError('FS_REQUEST_INVALID', `JSON Schema validation failed: ${details}`);
    }
    if (!permitted.has(request.operation)) {
      throw new EngineError('FS_OPERATION_FORBIDDEN', 'The operation is disabled by the host policy.');
    }
    if (request.operation === 'read' && request.payload.endLine !== null &&
        request.payload.endLine < request.payload.startLine) {
      throw new EngineError('FS_REQUEST_INVALID', 'endLine must not precede startLine.');
    }
    if (request.operation === 'apply') {
      const changes = request.payload.changes;
      if (changes.length > fileCap || sizeOf(changes) > patchCap) {
        throw new EngineError('FS_REQUEST_LIMIT', 'The change set exceeded its file-count or byte limit.');
      }
      const paths = new Set();
      for (const item of changes) {
        if (paths.has(item.path)) throw new EngineError('FS_REQUEST_INVALID', 'Only one change per path is allowed.');
        paths.add(item.path);
        const creating = item.operation === 'create_file';
        const deleting = item.operation === 'delete_file';
        if (creating && (typeof item.content !== 'string' || item.baseSha256 !== null || item.search !== null || item.replacement !== null) ||
            !creating && (item.baseSha256 === null || item.content !== null) ||
            deleting && (item.search !== null || item.replacement !== null) ||
            item.operation === 'replace_text' && (typeof item.search !== 'string' || !item.search || typeof item.replacement !== 'string')) {
          throw new EngineError('FS_REQUEST_INVALID', 'Invalid fields for the selected change operation.');
        }
      }
    }
    return request;
  }

  /** Schema/limits only: this does NOT preflight file hashes or permissions. */
  function validate(value) {
    try { prepare(value); return { ok: true }; }
    catch (error) { return { ok: false, error: reportError(error, 'FS_REQUEST_INVALID') }; }
  }

  async function dispatch(request, remainingBytes) {
    switch (request.operation) {
      case 'tree': return workspace.tree();
      case 'read': return workspace.read(request.payload, { remainingBytes });
      case 'search': return workspace.search(request.payload, { remainingBytes });
      case 'apply': {
        const paths = await workspace.apply(request.payload.changes);
        changedFiles += paths.length;
        return { changedPaths: paths };
      }
      case 'diff': return workspace.diff();
      default: throw new EngineError('FS_REQUEST_INVALID', 'Unknown filesystem operation.');
    }
  }

  function execute(value, { remainingBytes = contextCap } = {}) {
    let request;
    try {
      if (closed) throw new EngineError('FS_ENGINE_CLOSED', 'The filesystem engine is closed.');
      signalCheck(signal);
      integer(remainingBytes, 'remainingBytes', contextCap);
      // Clone and validate before enqueueing; caller mutation cannot change the job.
      request = prepare(value);
      if (seen.has(request.id)) throw new EngineError('FS_DUPLICATE_ID', 'This request ID has already been submitted.');
      if (seen.size >= requestCap) throw new EngineError('FS_REQUEST_LIMIT', 'The session request-count limit was reached.');
      seen.add(request.id);
    } catch (error) {
      return Promise.resolve({ version: 1, id: request?.id ?? null, operation: request?.operation ?? null,
        ok: false, error: reportError(error, 'FS_REQUEST_INVALID') });
    }
    const run = async () => {
      const started = Date.now();
      events({ type: 'fs.started', id: request.id, operation: request.operation });
      try {
        signalCheck(signal);
        if (workspace.broken) throw new EngineError('FS_WORKSPACE_BROKEN', 'The workspace requires manual recovery.');
        const result = await dispatch(request, remainingBytes);
        succeeded++;
        events({ type: 'fs.completed', id: request.id, operation: request.operation, durationMs: Date.now() - started });
        return { version: 1, id: request.id, operation: request.operation, ok: true, result };
      } catch (error) {
        const failure = reportError(error);
        events({ type: 'fs.failed', id: request.id, operation: request.operation, code: failure.code,
          durationMs: Date.now() - started });
        return { version: 1, id: request.id, operation: request.operation, ok: false, error: failure };
      } finally { completed++; }
    };
    const job = queue.then(run);
    queue = job.then(() => undefined, () => undefined);
    return job;
  }

  /** Convenient host API, returning result or throwing. Not arbitrary RPC. */
  async function request(operation, payload = {}, options = {}) {
    const response = await execute({ version: 1, id: randomUUID(), operation, payload }, options);
    if (!response.ok) throw new EngineError(response.error.code, response.error.message);
    return response.result;
  }

  async function executeFile(filename, options = {}) {
    try {
      if (closed) throw new EngineError('FS_ENGINE_CLOSED', 'The filesystem engine is closed.');
      const value = await loadFsRequestFile(filename, { maxBytes: jsonCap, signal, forbiddenRoots });
      return execute(value, options);
    } catch (error) {
      return { version: 1, id: null, operation: null, ok: false,
        error: reportError(error, 'FS_INPUT_FAILED') };
    }
  }

  return Object.freeze({
    validate, execute, executeFile, request,
    stats: () => ({ submitted: seen.size, completed, succeeded, failed: completed - succeeded,
      changedFiles, queued: seen.size - completed, closed }),
    // Drain accepted jobs; cancellation is controlled by the shared AbortSignal.
    async close() { closed = true; await queue; },
  });
}
