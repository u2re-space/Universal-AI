import { test } from 'node:test';
import assert from 'node:assert/strict';
import { neutralPlan, neutralSession, neutralWording } from '../src/agent/neutral.js';

test('country and language labels become the customer language', () => {
    const source = 'Build a Russian-language calendar. Use Intl for Russian display formatting.';
    const text = neutralWording(source);
    assert.equal(/\bRussian\b/i.test(text), false);
    assert.match(text, /customer-language calendar/);
    assert.match(text, /customer-language display formatting/);
    const plan = neutralPlan({
        summary: source,
        steps: [{ goal: 'Russian document metadata', details: '', verify: '' }],
        acceptanceCriteria: ['Russian display'],
        taskMap: [{ path: 'index.html', reason: 'Russian document metadata' }],
        imageTasks: [{ goal: 'Russian logo', details: 'Use Russian colors' }],
    });
    assert.equal(/\bRussian\b/i.test(JSON.stringify(plan)), false);
    assert.equal(/\bRussian\b/i.test(JSON.stringify(plan.imageTasks)), false);
    const session = { items: [{ type: 'message', content: [{ type: 'input_text', text: source }] }] };
    neutralSession(session);
    assert.equal(/\bRussian\b/i.test(session.items[0].content[0].text), false);
});
