import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolvePlatform, platformInstructions, PLATFORM_SOURCES, ENABLED_IN_157 } from '../src/generate/platform.js';
import { fidelityContract, effectiveFidelity, DEFAULT_FIDELITY, DEFAULT_CREATIVITY } from '../src/generate/fidelity.js';
import { buildGenerationBrief, GENERATION_KINDS } from '../src/generate/brief.js';
import { kindRules } from '../src/generate/scaffold.js';
import { loadConfig, redactConfig } from '../src/core/config.js';
import { overridesFrom } from '../src/commands/flags.js';
import { startMockServer, TINY_PNG } from './helpers/mock-server.js';
import { ensureLocalEnv } from './helpers/local-env.js';

const landing = fileURLToPath(new URL('../test-gen/landing.png', import.meta.url));
const bin = fileURLToPath(new URL('../bin/ai.js', import.meta.url));

test('chrome-157-beta is the default and keeps flags off', () => {
    const profile = resolvePlatform();
    assert.equal(profile.id, 'chrome-157-beta');
    assert.equal(profile.version, 157);
    assert.equal(profile.channel, 'beta');
    assert.equal(profile.experimentalFlags, false);
    assert.equal(profile.originTrials, false);
    assert.equal(profile.snapshot, '2026-10-15');
    assert.equal(profile.ecma.edition, 2026);
    assert.equal(profile.ecma.spec, 'https://262.ecma-international.org/');
    assert.equal(ENABLED_IN_157.length, 16);
    assert.deepEqual(profile.sources, [...PLATFORM_SOURCES]);
    assert.throws(() => resolvePlatform('ie6'), /Неизвестный профиль/);
});

test('platform instructions list the snapshot and withhold css-random', () => {
    const text = platformInstructions(resolvePlatform());
    assert.match(text, /Experimental flags: off/);
    assert.match(text, /Origin trials: off/);
    for (const feature of resolvePlatform().enabledIn157) assert.match(text, new RegExp(feature.id));
    for (const feature of resolvePlatform().withheld) assert.match(text, new RegExp(feature.id));
    for (const url of PLATFORM_SOURCES) assert.ok(text.includes(url), url);
    assert.match(text, /css-random/);
});

test('fidelity defaults to 87 and is not measured', () => {
    const contract = fidelityContract();
    assert.equal(contract.fidelity, DEFAULT_FIDELITY);
    assert.equal(DEFAULT_FIDELITY, 87);
    assert.equal(contract.creativity, DEFAULT_CREATIVITY);
    assert.equal(DEFAULT_CREATIVITY, 20);
    assert.equal(contract.measured, null);
    assert.equal(contract.method, 'unmeasured');
    assert.match(contract.reason, /не реализована/);
    assert.throws(() => fidelityContract({ fidelity: 101, creativity: 20 }), /fidelity/);
    assert.throws(() => fidelityContract({ fidelity: 87, creativity: 1.5 }), /creativity/);
});

test('effective fidelity scales with quality and stays unmeasured', () => {
    assert.equal(effectiveFidelity(100, 0), 60);
    assert.equal(effectiveFidelity(100, 40), 76);
    assert.equal(effectiveFidelity(87, 40), 66);
    assert.equal(effectiveFidelity(100, 100), 100);
    assert.equal(effectiveFidelity(0, 40), 0);
});

test('landing.png becomes a brief at 87% for chrome-157-beta', async () => {
    const bytes = await readFile(landing).catch(() => Buffer.from(TINY_PNG, 'base64'));
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    const brief = buildGenerationBrief({
        kind: 'landing',
        prompt: 'Повтори макет Tilda Publishing',
        fidelity: 87,
        creativity: 20,
        platform: resolvePlatform('chrome-157-beta'),
        references: { images: [landing], files: [], templates: ['templates/base'], examples: ['https://css-tricks.com/'] },
    });
    assert.equal(brief.manifest.fidelity, 87);
    assert.equal(brief.manifest.effectiveFidelity, 66);
    assert.equal(brief.manifest.creativity, 20);
    assert.equal(brief.manifest.measured, null);
    assert.equal(brief.manifest.method, 'unmeasured');
    assert.equal(brief.manifest.platform, 'chrome-157-beta');
    assert.equal(brief.manifest.experimentalFlags, false);
    assert.deepEqual(brief.manifest.outputs, [
        'package.json', 'vite.config.js', 'index.html', 'src/main.js', 'src/styles.scss', 'scripts/generate.js',
        '.rules/stack.md', '.rules/files.md', '.skills/scaffold/SKILL.md',
    ]);
    assert.match(brief.task, /87%/);
    assert.match(brief.task, /Requested fidelity 87% at quality 40 works as 66%/);
    assert.match(brief.instructions, /66%/);
    assert.match(brief.task, /landing\.png/);
    assert.match(brief.task, /templates\/base/);
    assert.match(brief.task, /https:\/\/css-tricks\.com\//);
    assert.match(brief.task, /Plan the work before changing files/);
    assert.match(brief.task, /```md\nПовтори макет Tilda Publishing\n```/);
    assert.match(brief.task, /lucide/);
    assert.match(brief.task, /Already written/);
    assert.match(brief.task, /Do not plan a step/);
    assert.doesNotMatch(brief.task, /process\.exit/);
    assert.doesNotMatch(brief.task, /tailwindcss/);
    assert.equal(brief.manifest.measured, null);
    assert.equal(brief.manifest.stack.kind, 'landing');
    assert.equal(brief.manifest.recommendations.libraries.some((item) => item.name === 'lucide'), true);
    assert.match(brief.instructions, /Experimental flags: off/);
    assert.doesNotMatch(brief.instructions, /No framework, no bundler, no npm/);
    assert.match(brief.instructions, /Vite, SCSS/);
    assert.match(brief.instructions, /compare a suitable Lucide or Phosphor icon/);
    assert.match(brief.instructions, /After npm run build, inspect the rendered page/);
    assert.match(brief.instructions, /raster or SVG artwork/);
    assert.match(brief.instructions, /Do not pass --force/);
    assert.match(brief.instructions, /at most 4 steps/);
    assert.match(brief.instructions, /Leave measured null|Leave measured null|measured null/);
    assert.match(brief.task, /image_generation/);
    assert.match(brief.task, /Do not use a reference image as the page background/);
    assert.match(brief.instructions, /generate_image/);
    assert.deepEqual(GENERATION_KINDS, ['landing', 'site', 'backend', 'app']);
    const backend = buildGenerationBrief({ kind: 'backend', prompt: 'api', fidelity: 87, creativity: 0, platform: resolvePlatform(), references: {} });
    assert.match(backend.instructions, /node:http/);
    assert.match(backend.instructions, /127\.0\.0\.1/);
    assert.equal(backend.manifest.recommendations.libraries.some((item) => item.include && item.name === 'fastify'), false);
    assert.throws(() => buildGenerationBrief({ kind: 'mobile', prompt: 'x', fidelity: 87, creativity: 20, platform: resolvePlatform() }), /Вид генерации/);
});

test('config defaults and flag bounds', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-gen-home-'));
    try {
        const config = await loadConfig({ env: { AI_AGENT_HOME: home, AI_MODEL: 'mock-model', OPENAI_API_KEY: 'sk-test' }, ensureHome: false });
        assert.equal(config.generate.fidelity, 87);
        assert.equal(config.generate.creativity, 20);
        assert.equal(config.generate.platform, 'chrome-157-beta');
        assert.equal(config.tools.mcp, true);
        assert.deepEqual(config.mcp.servers, []);
        const shown = redactConfig({ ...config, mcp: { servers: [{ id: 'design', env: { TOKEN: 'secret' } }] } });
        assert.equal(shown.mcp.servers[0].env.TOKEN, '…');
    } finally {
        await rm(home, { recursive: true, force: true });
    }
    assert.equal(overridesFrom({ fidelity: '87', creativity: '20', platform: 'chrome-157-beta' }).generate.fidelity, 87);
    assert.throws(() => overridesFrom({ fidelity: '101' }), /--fidelity/);
    assert.throws(() => overridesFrom({ platform: 'ie6' }), /--platform/);
    assert.equal(overridesFrom({ tools: 'fs,mcp' }).tools.mcp, true);
    assert.equal(overridesFrom({ tools: 'fs,mcp' }).tools.shell, false);
    assert.equal(overridesFrom({ 'no-tools': true }).tools.mcp, false);
    assert.equal(overridesFrom({ 'no-web': true }).tools.web, false);
});

test('pace defaults to speed 10 and quality 40 and a file can pin a role', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-pace-home-'));
    const extra = path.join(home, 'extra.json');
    await writeFile(path.join(home, 'config.json'), JSON.stringify({ roles: { summarizer: { model: 'gpt-6-luna-nano' } }, agent: { maxSteps: 12 } }));
    await writeFile(extra, JSON.stringify({ pace: { models: ['gpt-6-luna', 'gpt-6-luna'] } }));
    try {
        const config = await loadConfig({ env: { AI_AGENT_HOME: home, AI_MODEL: 'mock-model', OPENAI_API_KEY: 'sk-test' }, ensureHome: false });
        assert.equal(config.pace.speed, 10);
        assert.equal(config.pace.quality, 40);
        assert.equal(config.pace.mode, 'auto');
        assert.deepEqual(config.pace.models, ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra']);
        assert.equal(config.rolePins.summarizer.model, true);
        assert.equal(config.rolePins.summarizer.effort, false);
        assert.equal(config.stepCapPinned, true);
        await assert.rejects(
            () => loadConfig({ configPath: extra, env: { AI_AGENT_HOME: home, AI_MODEL: 'mock-model', OPENAI_API_KEY: 'sk-test' }, ensureHome: false }),
            /pace\.models/,
        );
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test('speed, quality, and pace flags parse and image quality stays a word', () => {
    assert.equal(overridesFrom({ speed: '10' }, { command: 'run' }).pace.speed, 10);
    assert.equal(overridesFrom({ quality: '40' }, { command: 'run' }).pace.quality, 40);
    assert.equal(overridesFrom({ quality: 'high' }, { command: 'run' }).image.quality, 'high');
    assert.equal(overridesFrom({ pace: 'c' }, { command: 'gen' }).pace.mode, 'c');
    assert.equal(overridesFrom({ 'max-steps': '8' }, { command: 'run' }).agent.maxSteps, 8);
    assert.equal(overridesFrom({ speed: '150', quality: '50' }, { command: 'run' }).pace.speed, 150);
    assert.equal(overridesFrom({ speed: '150', quality: '50' }, { command: 'run' }).pace.quality, 50);
    assert.throws(() => overridesFrom({ speed: '-1' }, { command: 'run' }), /pace\.speed/);
    assert.throws(() => overridesFrom({ quality: '201' }, { command: 'run' }), /pace\.quality/);
    assert.throws(() => overridesFrom({ speed: '100', quality: '101' }, { command: 'run' }), /pace\.speed/);
    assert.throws(() => overridesFrom({ quality: '40' }, { command: 'image' }), /Для image --quality/);
    assert.throws(() => overridesFrom({ quality: 'nope' }, { command: 'run' }), /0\.\.200 или low/);
    assert.throws(() => overridesFrom({ pace: 'z' }, { command: 'run' }), /--pace/);
    assert.equal(overridesFrom({ quality: '40' }, { command: 'serve' }).pace, undefined);
});

test('config rejects a pace pair outside the shared budget', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-pace-budget-'));
    const file = path.join(home, 'bad.json');
    const load = () => loadConfig({
        configPath: file,
        env: { AI_AGENT_HOME: home, AI_MODEL: 'mock-model', OPENAI_API_KEY: 'sk-test' },
        ensureHome: false,
    });
    try {
        await writeFile(file, JSON.stringify({ pace: { quality: 201 } }));
        await assert.rejects(() => load(), /pace\.quality: целое 0\.\.200/);
        await writeFile(file, JSON.stringify({ pace: { speed: -1 } }));
        await assert.rejects(() => load(), /pace\.speed/);
        await writeFile(file, JSON.stringify({ pace: { speed: 100, quality: 101 } }));
        await assert.rejects(() => load(), /pace\.speed/);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test('loadConfig rejects a bad server id and a bad fidelity', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-gen-home-'));
    const file = path.join(home, 'bad.json');
    await import('node:fs/promises').then((fs) => fs.writeFile(file, JSON.stringify({ generate: { fidelity: 101 } })));
    await assert.rejects(
        () => loadConfig({ configPath: file, env: { AI_AGENT_HOME: home, AI_MODEL: 'mock-model' }, ensureHome: false }),
        /fidelity/,
    );
    await import('node:fs/promises').then((fs) => fs.writeFile(file, JSON.stringify({ mcp: { servers: [{ id: 'Bad', command: 'node' }] } })));
    await assert.rejects(
        () => loadConfig({ configPath: file, env: { AI_AGENT_HOME: home, AI_MODEL: 'mock-model' }, ensureHome: false }),
        /mcp\.servers\.id/,
    );
    await rm(home, { recursive: true, force: true });
});

test('ai gen landing sends the mockup and records an unmeasured 87% contract', async () => {
    let planner = '';
    let sawImageTool = false;
    const server = await startMockServer({
        script: (body) => {
            if (body.tools?.some((tool) => tool.type === 'image_generation')) sawImageTool = true;
            const role = body.text?.format?.name ?? 'worker';
            if (role === 'task_label') return { text: JSON.stringify({ label: 'trivial' }) };
            if (role === 'plan') {
                planner = JSON.stringify(body.input);
                return { text: JSON.stringify({ summary: 'лендинг', complexity: 'trivial', steps: [{ goal: 'страница', details: '', verify: '' }], filesOfInterest: [], searchQueries: [], questionsForCollector: [], acceptanceCriteria: [], needsReview: false, imageNotes: 'tilda', risks: [] }) };
            }
            return { text: 'готово' };
        },
    });
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-gen-home-'));
    const work = await mkdtemp(path.join(os.tmpdir(), 'ai-gen-work-'));
    try {
        await writeFile(path.join(work, '.env'), '');
        const image = await readFile(landing).then(() => landing, async () => {
            const file = path.join(work, 'landing.png');
            await writeFile(file, Buffer.from(TINY_PNG, 'base64'));
            return file;
        });
        const child = spawn(process.execPath, [bin, 'gen', 'landing', 'Повтори макет', '--image', image, '--no-memory', '--approve', 'write', '--json'], {
            cwd: work,
            env: { ...process.env, OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: server.baseURL, AI_AGENT_HOME: home, AI_MODEL: 'mock-model', NO_COLOR: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        const code = await new Promise((resolve) => child.once('close', resolve));
        assert.equal(code, 0, stderr);
        assert.match(planner, /87%/);
        assert.match(planner, /Plan the work before changing files/);
        assert.match(planner, /Customer task:/);
        assert.match(planner, /chrome-157-beta/);
        assert.match(planner, /landing\.png/);
        assert.match(planner, /image_generation/);
        assert.equal(sawImageTool, true);
        assert.match(stdout, /готово/);
        const manifest = JSON.parse(await readFile(path.join(work, '.ai', 'generation.json'), 'utf8'));
        assert.equal(manifest.kind, 'landing');
        assert.equal(manifest.fidelity, 87);
        assert.equal(manifest.effectiveFidelity, 66);
        assert.equal(manifest.creativity, 20);
        assert.equal(manifest.measured, null);
        assert.equal(manifest.method, 'unmeasured');
        assert.equal(manifest.platform, 'chrome-157-beta');
        assert.equal(manifest.references.images[0], image);
    } finally {
        await server.close();
        await rm(home, { recursive: true, force: true });
        await rm(work, { recursive: true, force: true });
    }
});

test('ai gen without a kind or a reference exits 2', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-gen-home-'));
    const work = await mkdtemp(path.join(os.tmpdir(), 'ai-gen-work-'));
    await ensureLocalEnv(work);
    try {
        const run = (args) => new Promise((resolve) => {
            const child = spawn(process.execPath, [bin, ...args], {
                cwd: work,
                env: { ...process.env, OPENAI_API_KEY: 'sk-test', AI_AGENT_HOME: home, AI_MODEL: 'mock-model', NO_COLOR: '1' },
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
            let stderr = '';
            child.stderr.on('data', (chunk) => { stderr += chunk; });
            child.once('close', (code) => resolve({ code, stderr }));
        });
        const missing = await run(['gen']);
        assert.equal(missing.code, 2);
        const range = await run(['gen', 'landing', 'x', '--fidelity', '101']);
        assert.equal(range.code, 2);
        assert.match(range.stderr, /fidelity/);
    } finally {
        await rm(home, { recursive: true, force: true });
        await rm(work, { recursive: true, force: true });
    }
});

test('config init writes pace and does not pin the default step cap', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-init-home-'));
    try {
        const child = spawn(process.execPath, [bin, 'config', 'init'], {
            env: { ...process.env, OPENAI_API_KEY: 'sk-test', AI_AGENT_HOME: home, AI_MODEL: 'mock-model', NO_COLOR: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        const code = await new Promise((resolve) => child.once('close', resolve));
        assert.equal(code, 0, stderr);
        const saved = JSON.parse(await readFile(path.join(home, 'config.json'), 'utf8'));
        assert.deepEqual(saved.pace.models, ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra']);
        assert.equal(saved.agent?.maxSteps, undefined);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});
