import { createSession } from '../core/session.js';
import { buildUserMessage } from '../core/attachments.js';
import { resolveRole } from '../core/config.js';
import { clipMiddle } from '../util/text.js';
import { ROLE_INSTRUCTIONS } from '../commands/instructions.js';
import { encodeToon } from '../util/toon.js';
import { runTurn } from './loop.js';
import { SCREEN_SCHEMA } from './schemas.js';

/**
 * Runs requests on behalf of a named role with that role's model / reasoning settings.
 * Every call is a fresh, stateless conversation (shared context is passed in explicitly).
 */
export function createRoleRunner({ client, config, ledger, emit = () => {}, signal }) {
  const notify = (event) => { try { emit(event); } catch { /* observer */ } };
  const resolve = (name) => resolveRole(config, name);

  /**
   * One role request. With `schema`, the final message is strict JSON and `result.data` is the parsed object.
   * Tool loops are allowed (toolset + maxTurns); events flow to `emit` as usual.
   */
  async function run(name, {
    text, parts = [], instructions = '', toolset = null, builtin = [], schema = null, schemaName = 'result',
    maxTurns = 1, imageTarget = config.image.outputDir, session = null, silent = Boolean(schema),
  }) {
    const role = resolve(name);
    const conversation = session ?? createSession({ store: false, model: role.model });
    conversation.addUserMessage(buildUserMessage({ text, parts }));
    const fullInstructions = [instructions, role.instructions].filter((part) => part && part.trim()).join('\n\n');
    const previousRole = ledger.role;
    ledger.setRole(name);
    notify({ type: 'role.start', role: name, model: role.model, effort: role.effort });
    // Structured (JSON) replies and helper roles are not streamed to the terminal as answer text.
    const roleEmit = silent ? (event) => { if (event.type !== 'text.delta' && event.type !== 'text.done') emit(event); } : emit;
    let result;
    try {
      result = await runTurn({
        client, config: role.config, session: conversation, ledger, toolset, builtin, instructions: fullInstructions, model: role.model,
        textFormat: schema ? { type: 'json_schema', name: schemaName, strict: true, schema } : null, maxTurns, signal, emit: roleEmit, imageTarget,
      });
    } finally {
      ledger.setRole(previousRole);
    }
    if (schema && result.status === 'completed') {
      try { result.data = JSON.parse(result.text); }
      catch (error) { result.status = 'failed'; result.error = new Error(`Роль ${name} вернула некорректный JSON: ${error.message}`); }
    }
    notify({ type: 'role.done', role: name, model: role.model, status: result.status, turns: result.turns, toolCalls: result.toolCalls });
    return result;
  }

  /** Should view_image delegate to the vision role when used by `currentRole`? */
  function shouldDelegateVision(currentRole = 'default') {
    const mode = config.agent.visionDelegate;
    if (mode === 'never') return false;
    if (mode === 'always') return true;
    return resolve('vision').model !== resolve(currentRole).model;
  }

  /** Describe an image through the vision role; returns plain text. */
  async function describeImage({ part, question = null, rel = 'image' }) {
    const prompt = question ? `Image: ${rel}\nQuestion: ${question}` : `Image: ${rel}\nDescribe it in detail.`;
    const result = await run('vision', { text: prompt, parts: [part], instructions: ROLE_INSTRUCTIONS.vision, silent: true });
    if (result.status !== 'completed' || !result.text.trim()) throw new Error(result.error?.message ?? `Роль vision не вернула описание (${result.status}).`);
    return result.text.trim();
  }

  /** Describe a screenshot through the vision role; returns structured data and its TOON form. */
  async function describeScreen({ part, rel = 'screenshot' }) {
    const prompt = `Screenshot: ${rel}\nDescribe the screen.`;
    const result = await run('vision', {
      text: prompt, parts: [part], instructions: ROLE_INSTRUCTIONS.visionScreen,
      schema: SCREEN_SCHEMA, schemaName: 'screen', silent: true,
    });
    if (result.status !== 'completed' || !result.data) throw new Error(result.error?.message ?? `Роль vision не вернула описание (${result.status}).`);
    return { data: result.data, toon: encodeToon(result.data) };
  }

  /** Summarize a text file through the summarizer role. */
  async function summarizeFile({ rel, text, focus = null }) {
    const body = clipMiddle(text, 400 * 1024);
    const prompt = `File: ${rel}${focus ? `\nFocus: ${focus}` : ''}\n\n\`\`\`\n${body}\n\`\`\``;
    const result = await run('summarizer', { text: prompt, instructions: ROLE_INSTRUCTIONS.summarizerFile, silent: true });
    if (result.status !== 'completed' || !result.text.trim()) throw new Error(result.error?.message ?? `Роль summarizer не вернула сводку (${result.status}).`);
    return { summary: result.text.trim(), model: resolve('summarizer').model };
  }

  return { resolve, run, describeImage, describeScreen, summarizeFile, shouldDelegateVision };
}
