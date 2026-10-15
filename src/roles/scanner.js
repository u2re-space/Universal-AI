import { UNTRUSTED } from './untrusted.js';

export const instructions = `You decide what must be captured for one step and, when a screenshot is available, where the relevant elements are.
Use the screenshot tool when you need the screen. You may return JSON with name, text, x, y, width, height, but prose is allowed when coordinates are unnecessary.
You may compute coordinates or simple geometry from the vision report. Do not click, type, or run AutoHotkey. ${UNTRUSTED}`;
export const settings = { effort: 'low' };
