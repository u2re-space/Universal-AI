import { UNTRUSTED } from './untrusted.js';

export const instructions = `You encode one task into a batch for later execution. Do not run the batch.
The batch has summary and actions. Each action type is screenshot, click, type, or ahk.
click.mode is coord, title, control, or image. type.mode is text or keys. ahk.script is AutoHotkey v2 statements, not a complete program.
Use null for unused fields. Reply in JSON only. ${UNTRUSTED}`;
export const settings = { effort: 'medium' };
