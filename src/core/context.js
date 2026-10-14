import { byteSize, clipMiddle } from '../util/text.js';

/**
 * Shared context passed between roles of a team run. Sections are rendered as one document;
 * when the document exceeds the byte budget, lower-priority sections are clipped first.
 */
export function createSharedContext({ task, root } = {}) {
  const sections = new Map();   // name -> { title, text, priority }
  const log = [];               // chronological notes (who did what)

  function set(name, title, text, { priority = 5 } = {}) {
    const value = String(text ?? '').trim();
    if (!value) { sections.delete(name); return; }
    sections.set(name, { title, text: value, priority });
  }
  function append(name, title, text, { priority = 5, separator = '\n\n' } = {}) {
    const value = String(text ?? '').trim();
    if (!value) return;
    const existing = sections.get(name);
    sections.set(name, { title, text: existing ? `${existing.text}${separator}${value}` : value, priority });
  }
  function note(entry) { log.push({ at: new Date().toISOString(), ...entry }); }

  /** Render for a prompt; `exclude` names sections not relevant to a role. */
  function render({ maxBytes = 96 * 1024, exclude = [] } = {}) {
    const chosen = [...sections.entries()].filter(([name]) => !exclude.includes(name))
      .map(([name, section]) => ({ name, ...section }));
    const header = `# Shared context\nTask: ${task}\nWorking directory: ${root}\n`;
    let total = byteSize(header) + chosen.reduce((sum, s) => sum + byteSize(s.text) + byteSize(s.title) + 8, 0);
    // Clip the lowest-priority / largest sections until the document fits.
    const order = [...chosen].sort((a, b) => a.priority - b.priority || byteSize(b.text) - byteSize(a.text));
    for (const section of order) {
      if (total <= maxBytes) break;
      const size = byteSize(section.text);
      const allowed = Math.max(512, size - (total - maxBytes));
      if (allowed >= size) continue;
      section.text = clipMiddle(section.text, allowed);
      total -= size - byteSize(section.text);
    }
    const body = chosen.map((s) => `\n## ${s.title}\n${s.text}`).join('\n');
    return `${header}${body}`.trim();
  }

  return {
    set, append, note, render,
    get(name) { return sections.get(name)?.text ?? ''; },
    has(name) { return sections.has(name); },
    get task() { return task; }, get root() { return root; }, get log() { return [...log]; },
    toJSON() { return { task, root, sections: Object.fromEntries([...sections].map(([k, v]) => [k, v.text])), log }; },
  };
}
