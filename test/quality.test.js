import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { qualityQuestions } from '../src/channels/questions.js';
import { assessmentImages, assessQuality, verdictFromQuality } from '../src/agent/quality.js';
import { ApiError } from '../src/openai/errors.js';
import { TINY_PNG } from './helpers/mock-server.js';

test('quality questions add the visual one only with an image', () => {
    const text = qualityQuestions();
    assert.deepEqual(Object.keys(text), ['meets_task', 'complete', 'verified', 'verdict']);
    const visual = qualityQuestions({ hasImages: true });
    assert.equal(visual.visual_match.type, 'noul');
    assert.equal(visual.verdict.type, 'choice');
});

test('quality answers become accept, revise, or fail with reviewer-shaped issues', () => {
    const accept = verdictFromQuality({
        meets_task: { type: 'noul', noul: 0.95 },
        complete: { type: 'noul', noul: 0.9 },
        verified: { type: 'noul', noul: 0.8 },
        verdict: { type: 'choice', choice: 'accept', confidence: 0.88 },
    });
    assert.equal(accept.verdict, 'accept');
    assert.equal(accept.issues.length, 0);
    assert.match(accept.summary, /accept/);
    assert.equal(accept.confidence, 0.88);

    const optimistic = verdictFromQuality({
        meets_task: { type: 'noul', noul: 0.2 },
        complete: { type: 'noul', noul: 0.9 },
        verdict: { type: 'choice', choice: 'accept' },
    });
    assert.equal(optimistic.verdict, 'fail');
    assert.ok(optimistic.issues.some((issue) => issue.message.includes('не решает задачу')));

    const revise = verdictFromQuality({
        meets_task: { type: 'noul', noul: 0.8 },
        complete: { type: 'noul', noul: 0.7 },
        verified: { type: 'noul', noul: 0.1 },
        visual_match: { type: 'noul', noul: 0.2 },
        verdict: { type: 'choice', choice: 'revise' },
    });
    assert.equal(revise.verdict, 'revise');
    assert.equal(revise.issues.length, 2);
});

test('assessment images keep references and PNG/JPEG results only', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-quality-'));
    try {
        await writeFile(path.join(root, 'shot.png'), Buffer.from(TINY_PNG, 'base64'));
        await writeFile(path.join(root, 'shot.webp'), Buffer.from('RIFF0000WEBPVP8L', 'latin1'));
        const images = await assessmentImages({
            root,
            parts: [{ type: 'input_text', text: 'x' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }],
            produced: ['shot.png', 'shot.webp', '../escape.png'],
        });
        assert.equal(images.length, 2);
        assert.equal(images[0].image_url, 'data:image/png;base64,AAAA');
        assert.match(images[1].image_url, /^data:image\/png;base64,/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('assessQuality retries without pictures and skips a missing decisions route', async () => {
    const answers = {
        meets_task: { type: 'noul', noul: 0.95 },
        complete: { type: 'noul', noul: 0.9 },
        verified: { type: 'noul', noul: 0.8 },
        verdict: { type: 'choice', choice: 'accept', confidence: 0.9 },
    };
    const calls = [];
    let failImages = true;
    const client = {
        decisions: {
            create: async (body, options) => {
                calls.push({ body, options });
                if (failImages && body.state?.images) throw new ApiError('images are not enabled', { status: 400, code: 'HTTP_ERROR' });
                return { id: 'dec_1', model: 'mock-decisions', answers, usage: { input_tokens: 10 } };
            },
        },
    };
    const config = { decisions: { model: 'mock-decisions', reviewAt: 0.5, assess: true, vision: true } };
    const ledger = { record() {} };
    const result = await assessQuality({
        client, config, ledger, state: { task: 'x' },
        images: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }],
    });
    assert.equal(result.verdict, 'accept');
    assert.equal(result.vision, false);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.extraHeaders['TypeSafe-Danger-Zone-Images'], 'true');
    assert.equal(calls[1].body.state.images, undefined);
    assert.equal(calls[1].options.extraHeaders, undefined);

    failImages = false;
    const missing = await assessQuality({
        client: { decisions: { create: async () => { throw new ApiError('not found', { status: 404, code: 'HTTP_ERROR' }); } } },
        config, ledger, state: { task: 'x' },
    });
    assert.equal(missing, null);
});
