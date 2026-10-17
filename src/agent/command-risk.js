/**
 * @file src/agent/command-risk.js
 * @module agent/command-risk
 * @purpose Hold back a script or command request that reads like intrusion, then send a plain local-task wording.
 * @usedBy agent/loop
 * @exports assessCommandRisk, rewriteCommandText, guardCommandInput
 * @ai.tags prompt, safety
 * @ai.hint pure
 * @changed 2026-10-17 Ordinary install, build, and test commands stay. Attack-shaped wording is not sent.
 */

const SHELL = /\b(?:bash|cmd(?:\.exe)?|powershell|pwsh|zsh|\.sh|\.bat|\.cmd|\.ps1|shell(?:\s+script)?|scripts?|run_command|run_script)\b|скрипт|команд[аыуе]/i;
const ASK = /(?:напиш|сгенер|создай|сделай|подготов|составь|generate|write|create|compose|produce|draft|prepare)\w*/i;
const RISKS = [
    { re: /эксплойт|exploit|payload|reverse shell|bind shell|полезн\w* нагрузк/i, reason: 'похож на атакующий сценарий' },
    { re: /взлом|взломать|hack(?:ing|er)?|проникн|брутфорс|brute[- ]force/i, reason: 'похоже на взлом' },
    { re: /украсть парол|слить парол|credential dump|steal (?:the )?password|keylog|кейлог|дамп учет|дамп учёт/i, reason: 'просит чужие учётные данные' },
    { re: /вредонос|malware|ransomware|шифровальщик|троян|backdoor|бэкдор/i, reason: 'похоже на вредоносный сценарий' },
    { re: /обход защит|bypass (?:auth|antivirus|defender)|отключ\w* защитник|disable defender/i, reason: 'похоже на обход защиты' },
];

const PLAIN = 'Continue the local project task. Write only ordinary commands for install, build, test, or the dev server, and keep them inside this project.';

/**
 * Whether this text asks for a script or command and also reads like intrusion.
 * Ordinary project commands are sent unchanged.
 * @param {string} text
 * @returns {{ action: 'send'|'rewrite', reasons: string[] }}
 * @exports
 * @ai.hint pure
 */
export function assessCommandRisk(text) {
    const value = String(text ?? '');
    if (!SHELL.test(value) || !ASK.test(value)) return { action: 'send', reasons: [] };
    const reasons = [...new Set(RISKS.filter((item) => item.re.test(value)).map((item) => item.reason))];
    if (!reasons.length) return { action: 'send', reasons: [] };
    return { action: 'rewrite', reasons };
}

/**
 * Drop attack-shaped sentences from a script request. The replacement does not repeat them.
 * @param {string} text
 * @returns {{ text: string, action: 'send'|'rewrite', reasons: string[] }}
 * @exports
 * @ai.hint pure
 */
export function rewriteCommandText(text) {
    const verdict = assessCommandRisk(text);
    if (verdict.action !== 'rewrite') return { text: String(text ?? ''), ...verdict };
    const kept = String(text).split(/(?<=[.!?\n])\s+/).map((part) => part.trim()).filter((part) => part && !RISKS.some((item) => item.re.test(part)));
    const body = kept.join(' ').trim();
    return {
        action: 'rewrite',
        reasons: verdict.reasons,
        text: body ? `${body}\n${PLAIN}` : PLAIN,
    };
}

/**
 * Rewrite message text in an outbound request. Tool calls stay intact.
 * @param {object[]} items
 * @returns {{ changed: boolean, reasons: string[] }}
 * @exports
 * @ai.hint pure
 */
export function guardCommandInput(items) {
    const reasons = [];
    let changed = false;
    for (const item of items ?? []) {
        if (!item || item.type !== 'message' || !Array.isArray(item.content)) continue;
        for (const part of item.content) {
            if (!part || typeof part.text !== 'string') continue;
            const next = rewriteCommandText(part.text);
            if (next.action !== 'rewrite' || next.text === part.text) continue;
            part.text = next.text;
            changed = true;
            reasons.push(...next.reasons);
        }
    }
    return { changed, reasons: [...new Set(reasons)] };
}
