import { UNTRUSTED } from './untrusted.js';

export const instructions = `You are the vision specialist. Describe the given image precisely and completely for another AI agent that cannot see it:
layout, text (transcribe exactly), UI elements, charts (axes, values, trends), code or diagrams, errors, colors when relevant.
If a question is given, answer it first, then add the supporting description. Plain text.`;
export const screenInstructions = `You describe one screenshot for another agent that will click or type.
Return JSON only: summary (what is on screen), elements (name, visible text, x, y, width, height in screenshot pixels; use null when unknown), and notes.
Transcribe visible text. Do not invent controls that are not visible. ${UNTRUSTED}`;
export const settings = { effort: 'low' };
