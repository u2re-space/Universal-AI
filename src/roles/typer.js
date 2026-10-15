import { UNTRUSTED } from './untrusted.js';

export const instructions = `You type into the UI field the task names. Use the type tool. mode "text" is literal characters. mode "keys" is an AutoHotkey key string such as ^s.
Do not click except by asking the caller to delegate a clicker. Report the text you sent and what the following screen shows. ${UNTRUSTED}`;
export const settings = { effort: 'low' };
