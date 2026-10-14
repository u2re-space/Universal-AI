/**
 * Public programmatic API (Node.js 26+, ESM).
 *
 * The CLI (bin/ai.js) is built on top of exactly these primitives:
 *   - createClient      — OpenAI Responses API over node:https (streaming SSE, background mode)
 *   - createSession     — local conversation history (stateless store:false or previous_response_id)
 *   - createLedger      — token / cost accounting with budgets
 *   - createToolset     — local tools (filesystem, shell, fetch, images) with an approval policy
 *   - runTurn           — one user turn: model ⇄ tools loop until the model stops calling tools
 *   - buildUserMessage  — text + image / file attachments as Responses input content
 */
export { createClient, ApiError } from './src/openai/client.js';
export { createSession } from './src/core/session.js';
export { createLedger } from './src/core/usage.js';
export { loadConfig, defaults as configDefaults, resolveRole } from './src/core/config.js';
export { buildUserMessage, loadImageAttachment, loadFileAttachment } from './src/core/attachments.js';
export { openMemory, projectKey } from './src/core/memory.js';
export { createSharedContext } from './src/core/context.js';
export { createToolset } from './src/agent/tools.js';
export { runTurn } from './src/agent/loop.js';
export { createRoleRunner } from './src/agent/roles.js';
export { runTeam } from './src/agent/team.js';
export { createRenderer } from './src/ui/renderer.js';
export { createJobManager } from './src/jobs/manager.js';
export { loadProjectMap } from './src/agent/map.js';
export { draftTaskMap } from './src/agent/task-map.js';
