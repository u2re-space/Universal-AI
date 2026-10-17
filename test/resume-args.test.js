import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseResumeRequest } from '../src/commands/resume-args.js';

test('ai resume arguments choose a response, a step, or a revision', () => {
    assert.deepEqual(parseResumeRequest([]), { kind: 'work', step: null, revision: '' });
    assert.deepEqual(parseResumeRequest(['resp_abc123']), { kind: 'response', id: 'resp_abc123' });
    assert.deepEqual(parseResumeRequest(['поправь вёрстку', 'и картинки']), { kind: 'work', step: null, revision: 'поправь вёрстку и картинки' });
    assert.deepEqual(parseResumeRequest(['2', 'добавь подпись']), { kind: 'work', step: '2', revision: 'добавь подпись' });
    assert.deepEqual(parseResumeRequest(['s02']), { kind: 'work', step: 's02', revision: '' });
    assert.throws(() => parseResumeRequest(['resp_abc', 'ещё текст']), /без текста доработки/);
});
