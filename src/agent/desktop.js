/** Desktop tools. AutoHotkey is started only by performAction, and only when no performDesktop is injected. */
import { readFile } from 'node:fs/promises';
import { detectImageMime } from '../core/attachments.js';
import { executeBatch, normalizeBatch, parseBatch } from '../interact/batch.js';
import { findAhk, performAction } from '../interact/filesystem.js';
import { errorMessage, truncate } from '../util/text.js';
import { resolveInside } from './paths.js';

export const DESKTOP_TOOL_NAMES = Object.freeze(['screenshot', 'click', 'type', 'run_ahk', 'run_batch', 'delegate_role']);

const BATCH_SOURCES = ['batch_json', 'batch_toon', 'path'];

function emptyToNull(value) {
  if (value == null) return null;
  if (typeof value !== 'string') return value;
  return value.trim() === '' ? null : value;
}

/** One approval line: type, mode, and coordinates, title, or a 120-character clip. */
function actionPreview(action) {
  const mode = action.mode ? ` ${action.mode}` : '';
  if (action.type === 'click' && action.mode === 'coord') return `click coord ${action.x},${action.y}`;
  if (action.type === 'click' && action.title) return `click${mode} ${truncate(action.title, 120)}`;
  if (action.type === 'click' && action.image) return `click${mode} ${truncate(action.image, 120)}`;
  if (action.text) return `${action.type}${mode} ${truncate(action.text, 120)}`;
  if (action.script) return `${action.type}${mode} ${truncate(action.script, 120)}`;
  return `${action.type}${mode}`.trim();
}

/**
 * Handlers for DESKTOP_TOOL_NAMES. `performDesktop`, when set, replaces findAhk and performAction.
 * `delegate` is supplied by the team runner; this module does not run specialists.
 */
export function createDesktopHandlers(ctx) {
  const { root, config, decide, describeScreen = null, performDesktop = null, delegate = null } = ctx;

  async function perform(action) {
    if (performDesktop) return performDesktop(action);
    const executable = await findAhk({ ahkPath: config.desktop?.ahkPath ?? null });
    return performAction({
      root,
      executable,
      action,
      shotAfterAction: config.desktop.shotAfterAction,
      timeoutMs: config.limits.commandTimeoutMs,
    });
  }

  async function runOne(action) {
    const batch = normalizeBatch({ summary: 'tool', actions: [action] });
    return perform(batch.actions[0]);
  }

  async function screenToon(abs, rel) {
    const buffer = await readFile(abs);
    const mime = detectImageMime(buffer, abs);
    if (!mime) throw new Error('Не изображение (нужны PNG, JPEG, GIF или WebP).');
    const part = { type: 'input_image', image_url: `data:${mime};base64,${buffer.toString('base64')}`, detail: 'auto' };
    const described = await describeScreen({ part, rel });
    if (typeof described === 'string') return described;
    if (described && typeof described === 'object' && typeof described.toon === 'string') return described.toon;
    throw new Error('vision не вернул TOON.');
  }

  async function renderText(result) {
    const lines = ['status: ok', `message: ${result?.message ?? ''}`];
    if (result?.screenshotRel) lines.push(`screenshot: ${result.screenshotRel}`);
    if (describeScreen && result?.screenshotAbs) {
      try {
        lines.push(`screen:\n${await screenToon(result.screenshotAbs, result.screenshotRel)}`);
      } catch (error) {
        lines.push(`vision: ${errorMessage(error)}`);
      }
    }
    return lines.join('\n');
  }

  async function render(result) {
    const output = await renderText(result);
    const summary = result?.screenshotRel ? `${result.message} ${result.screenshotRel}` : String(result?.message ?? '');
    return { output, summary, ok: true };
  }

  async function screenshot() {
    return render(await runOne({ type: 'screenshot' }));
  }

  async function click(args) {
    const image = emptyToNull(args.image);
    return render(await runOne({
      type: 'click',
      mode: args.mode,
      x: args.x ?? null,
      y: args.y ?? null,
      button: emptyToNull(args.button),
      clicks: args.clicks ?? null,
      title: emptyToNull(args.title),
      control: emptyToNull(args.control),
      image: image ? (await resolveInside(root, image, { allowRoot: false })).abs : null,
    }));
  }

  async function type(args) {
    return render(await runOne({ type: 'type', mode: args.mode, text: args.text }));
  }

  async function run_ahk(args) {
    return render(await runOne({ type: 'ahk', script: args.script }));
  }

  async function batchText(args) {
    const present = BATCH_SOURCES.filter((key) => typeof args?.[key] === 'string' && args[key].trim() !== '');
    if (present.length !== 1) throw new Error('Нужен ровно один из batch_json, batch_toon или path.');
    const key = present[0];
    let text = args[key];
    if (key === 'path') {
      const { abs } = await resolveInside(root, text, { allowRoot: false });
      text = await readFile(abs, 'utf8');
    }
    return text.replace(/^\uFEFF/, '');
  }

  async function run_batch(args) {
    const batch = parseBatch(await batchText(args));
    const results = await executeBatch({
      batch,
      perform,
      approveAction: async (action, index) => {
        const allowed = await decide(action.type, 'exec', action, actionPreview(action));
        if (allowed === false) throw new Error(`действие ${index + 1} отклонено`);
        return true;
      },
    });
    const output = (await Promise.all(results.map((result) => renderText(result)))).join('\n\n');
    return { output, summary: truncate(batch.summary, 80), ok: true };
  }

  async function delegate_role(args) {
    if (typeof delegate !== 'function') throw new Error('delegate_role недоступен.');
    const result = await delegate(args.role, args.task);
    if (result == null || typeof result !== 'object') {
      const output = result == null ? '' : String(result);
      return { output, summary: truncate(output, 80) };
    }
    let output = result.output == null ? '' : String(result.output);
    if (result.data !== null && typeof result.data === 'object') {
      const encoded = JSON.stringify(result.data);
      output = output ? `${output}\n${encoded}` : encoded;
    }
    const summary = result.summary == null || result.summary === '' ? truncate(output, 80) : String(result.summary);
    return { output, summary };
  }

  return { screenshot, click, type, run_ahk, run_batch, delegate_role };
}
