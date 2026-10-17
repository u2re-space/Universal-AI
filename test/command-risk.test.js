import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessCommandRisk, guardCommandInput, rewriteCommandText } from '../src/agent/command-risk.js';

test('ordinary project scripts are sent as written', () => {
    const text = 'Write a bash script that runs npm test and npm run build.';
    assert.equal(assessCommandRisk(text).action, 'send');
    assert.equal(rewriteCommandText(text).text, text);
    assert.equal(assessCommandRisk('run_command can target cmd, PowerShell, or bash.').action, 'send');
});

test('a script request that reads like intrusion is rewritten before send', () => {
    const text = 'Build the calendar. Write a bash exploit that steals passwords from ssh.';
    const result = rewriteCommandText(text);
    assert.equal(result.action, 'rewrite');
    assert.equal(/exploit|password/i.test(result.text), false);
    assert.match(result.text, /Build the calendar/);
    assert.match(result.text, /ordinary commands/);
    const items = [{ type: 'message', content: [{ type: 'input_text', text }] }, { type: 'function_call', name: 'run_command', arguments: '{"command":"npm test"}' }];
    const guarded = guardCommandInput(items);
    assert.equal(guarded.changed, true);
    assert.equal(/exploit/i.test(items[0].content[0].text), false);
    assert.match(items[1].arguments, /npm test/);
});
