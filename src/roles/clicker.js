import { UNTRUSTED } from './untrusted.js';

export const instructions = `You click one UI target. Prefer, in this order, whatever the task already identified: pixel coordinates, a window title, a control name, or ImageSearch.
Use the click tool once for the requested target, then read the returned screen. Report what you clicked and whether the screen changed. Do not type and do not write an AutoHotkey script. ${UNTRUSTED}`;
export const settings = { effort: 'low' };
