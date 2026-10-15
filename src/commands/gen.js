/**
 * @file src/commands/gen.js
 * @module commands/gen
 * @purpose `ai gen` — write a generation contract, then run the existing team.
 * @depends commands/run, commands/shared, generate/brief, generate/platform
 * @usedBy cli
 * @exports gen
 * @ai.tags cli, generate
 * @ai.hint io
 * @changed 2026-10-15 Landing, site, backend, and app generation.
 */
import { run } from './run.js';
import { UsageError, readStdin, resolveTextArg } from './shared.js';
import { GENERATION_KINDS, buildGenerationBrief, writeGenerationManifest } from '../generate/brief.js';
import { resolvePlatform } from '../generate/platform.js';

/**
 * `ai gen <landing|site|backend|app> [task]`.
 * Fidelity defaults to 87 and is recorded, not measured.
 * @param {object} ctx Command context from cli.main.
 * @returns {Promise<number>} Exit code from the team run.
 * @exports
 * @ai.hint io
 */
export async function gen(ctx) {
    const { config, values, positionals, renderer } = ctx;
    const kind = positionals[0];
    if (!GENERATION_KINDS.includes(kind)) throw new UsageError(`Укажите вид: ai gen ${GENERATION_KINDS.join('|')} "задача"`);
    const stdinText = await readStdin({ maxBytes: config.limits.maxStdinBytes });
    let prompt = positionals.slice(1).join(' ').trim();
    if (prompt.startsWith('@') && positionals.length === 2) prompt = (await resolveTextArg(prompt, { cwd: ctx.cwd, what: 'задачу' })).trim();
    if (stdinText && prompt && prompt !== stdinText) prompt = `${prompt}\n\n--- stdin ---\n${stdinText}`;
    else if (!prompt && stdinText) prompt = stdinText;
    const images = values.image ?? [];
    const files = values.file ?? [];
    const templates = values.template ?? [];
    const examples = values.example ?? [];
    if (!prompt && !images.length && !files.length && !templates.length && !examples.length) {
        throw new UsageError('Укажите задачу или референс: текст, --image, --file, --template или --example.');
    }
    const platform = resolvePlatform(config.generate.platform);
    const brief = buildGenerationBrief({
        kind, prompt, fidelity: config.generate.fidelity, creativity: config.generate.creativity, platform,
        references: { images, files, templates, examples },
    });
    const manifestPath = await writeGenerationManifest(ctx.cwd, brief.manifest);
    renderer.line('info', `Контракт генерации: ${manifestPath} · точность ${brief.manifest.fidelity}% (не измеряется) · креативность ${brief.manifest.creativity}% · ${platform.id}`, { dim: true });
    const userExtra = await resolveTextArg(values.instructions, { cwd: ctx.cwd, what: 'инструкции' });
    ctx.values = { ...values, instructions: [brief.instructions, userExtra].filter(Boolean).join('\n\n') };
    ctx.positionals = [brief.task];
    return run(ctx);
}
