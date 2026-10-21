/**
 * @file index.js
 * @module index
 * @purpose Public programmatic API: client, session, ledger, tools, and one-turn runs.
 * @depends openai/client, core/session, core/usage, core/config, core/attachments, core/memory, core/context, agent/tools, agent/loop, agent/roles, agent/team, ui/renderer, jobs/manager, agent/map, agent/task-map, complete/complete, complete/channels, complete/server, complete/context, channels/decide, channels/moderate, channels/reply, channels/handle, channels/server, telegram/client, telegram/update
 * @usedBy external
 * @exports createClient, ApiError, createSession, createLedger, loadConfig, configDefaults, resolveRole, buildUserMessage, loadImageAttachment, loadFileAttachment, openMemory, projectKey, createSharedContext, createToolset, runTurn, createRoleRunner, runTeam, createRenderer, createJobManager, loadProjectMap, draftTaskMap, scanWorkspace, formatWorkspace, buildCompletionContext, completeCode, createCompletionChannels, startCompletionServer, structureText, structureCode, STRUCTURE_TASKS, buildGenerationBrief, resolvePlatform, connectMcp, openMcpSources, requestDecision, moderateText, draftReply, handleInbound, startChannelServer, listenProtocol, createHub, createTelegram, normalizeUpdate
 * @ai.tags api, exports
 * @ai.hint keep
 * @changed 2026-10-15 Export the workspace scanner.
 *
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
export { expandPlan, findResumable } from './src/agent/work-plan.js';
export { createRenderer } from './src/ui/renderer.js';
export { createJobManager } from './src/jobs/manager.js';
export { loadProjectMap } from './src/agent/map.js';
export { draftTaskMap } from './src/agent/task-map.js';
export { scanWorkspace, formatWorkspace } from './src/agent/workspace-scan.js';
export { buildCompletionContext } from './src/complete/context.js';
export { completeCode } from './src/complete/complete.js';
export { createCompletionChannels } from './src/complete/channels.js';
export { startCompletionServer } from './src/complete/server.js';
export { structureText, structureCode, STRUCTURE_TASKS } from './src/structure/structure.js';
export { buildGenerationBrief } from './src/generate/brief.js';
export { resolvePlatform } from './src/generate/platform.js';
export { connectMcp } from './src/mcp/client.js';
export { openMcpSources } from './src/mcp/session.js';
export { requestDecision } from './src/channels/decide.js';
export { moderateText } from './src/channels/moderate.js';
export { draftReply } from './src/channels/reply.js';
export { handleInbound } from './src/channels/handle.js';
export { startChannelServer } from './src/channels/server.js';
export { listenProtocol } from './src/server/protocol.js';
export { createHub } from './src/server/hub.js';
export { createTelegram } from './src/telegram/client.js';
export { normalizeUpdate } from './src/telegram/update.js';
