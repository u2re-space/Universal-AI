import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solverChoice } from '../src/roles/solver.js';
import { imageLongSide, visionChoice } from '../src/roles/vision.js';

test('solver effort and model follow the step complexity', () => {
    assert.deepEqual(solverChoice('trivial'), { model: 'gpt-6-luna', effort: 'medium' });
    assert.deepEqual(solverChoice('normal'), { model: 'gpt-6-luna', effort: 'high' });
    assert.deepEqual(solverChoice('complex'), { model: 'gpt-6.1-sol', effort: 'high' });
    assert.deepEqual(solverChoice('complex', { model: 'gpt-6-luna', effort: 'low' }), { model: 'gpt-6-luna', effort: 'low' });
    assert.deepEqual(solverChoice('unknown'), solverChoice('normal'));
});

function png(width, height) {
    const bytes = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
    bytes.write('IHDR', 12);
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    return bytes;
}

test('vision effort and model follow the long side, and a screenshot stays complex', () => {
    assert.equal(imageLongSide(png(400, 120)), 400);
    assert.equal(imageLongSide(png(1920, 1080)), 1920);
    assert.equal(imageLongSide(Buffer.from('nope')), null);
    assert.deepEqual(visionChoice(400), { model: 'gpt-6-luna', effort: 'medium' });
    assert.deepEqual(visionChoice(512), { model: 'gpt-6-luna', effort: 'medium' });
    assert.deepEqual(visionChoice(800), { model: 'gpt-6-luna', effort: 'high' });
    assert.deepEqual(visionChoice(1280), { model: 'gpt-6-luna', effort: 'high' });
    assert.deepEqual(visionChoice(1281), { model: 'gpt-6.1-sol', effort: 'high' });
    assert.deepEqual(visionChoice(null), visionChoice(800));
    assert.deepEqual(visionChoice(80, {}, { screen: true }), { model: 'gpt-6.1-sol', effort: 'high' });
    assert.deepEqual(visionChoice(1920, { model: 'gpt-6-luna', effort: 'low' }), { model: 'gpt-6-luna', effort: 'low' });
});
