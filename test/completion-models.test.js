import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPLETION_MODEL_CHOICES, resolveCompletionModel } from '../src/complete/models.js';

test('completion choices are the catalog ids', () => {
    assert.deepEqual(COMPLETION_MODEL_CHOICES, [
        'gpt-6-luna',
        'anthropic/claude-haiku-5-5',
        'qwen/qwen3.8-omni-flash',
        'qwen/qwen3.8-flash',
        'z-ai/glm-5.3-flash',
        'x-ai/grok-4.7',
        'gemini-3.8-flash',
        'deepseek/deepseek-v4.1-flash',
    ]);
});

test('aliases resolve to the same row and the wire model', () => {
    const luna = resolveCompletionModel('gpt-6-luna');
    assert.equal(resolveCompletionModel('openai/gpt-6-luna ').wire, luna.wire);
    assert.equal(luna.wire, 'gpt-6-luna');
    assert.equal(luna.reasoning, 'none');
    assert.equal(luna.maxOutputTokens, 160);
    const qwen = resolveCompletionModel('qwen3.8-flash');
    assert.equal(qwen.choice, 'qwen/qwen3.8-flash');
    assert.equal(qwen.wire, 'qwen/qwen3.8-flash');
    assert.equal(qwen.reasoning, null);
    assert.equal(qwen.maxOutputTokens, 160);
});

test('grok clamps none and deepseek keeps effort none', () => {
    const grok = resolveCompletionModel('x-ai/grok-4.7');
    assert.equal(grok.wire, 'x-ai/grok-4.7');
    assert.equal(grok.reasoning, 'low');
    assert.equal(grok.maxOutputTokens, 512);
    assert.equal(grok.clampNone, true);
    const deepseek = resolveCompletionModel('deepseek/deepseek-v4.1-flash');
    assert.equal(deepseek.reasoning, 'none');
    assert.equal(deepseek.maxOutputTokens, 160);
    assert.equal(deepseek.clampNone, false);
});

test('unknown, empty, and differently cased names do not resolve', () => {
    assert.equal(resolveCompletionModel('nope'), null);
    assert.equal(resolveCompletionModel(''), null);
    assert.equal(resolveCompletionModel('   '), null);
    assert.equal(resolveCompletionModel('GPT-6-LUNA'), null);
    assert.equal(resolveCompletionModel(null), null);
});
