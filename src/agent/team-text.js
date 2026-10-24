/**
 * @file src/agent/team-text.js
 * @module agent/team-text
 * @purpose Render planner, architect, orchestrator, and measurer JSON as text the worker and reviewer can read.
 * @usedBy agent/team
 * @exports renderPlan, renderFindings, renderMeasurements, renderArchitecture, bullets
 * @ai.tags team
 * @ai.hint pure
 * @changed 2026-10-24 Added the architect structure and design brief.
 */

/**
 * Render a planner object as the text stored on the shared context.
 * `runTeam` calls this after the planner returns.
 * @param {object} plan
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function renderPlan(plan) {
    const steps = plan.steps.map((s, i) => `${i + 1}. ${s.goal}\n   details: ${s.details}\n   verify: ${s.verify}`).join('\n');
    return `${plan.summary}\nComplexity: ${plan.complexity}\n\nSteps:\n${steps}\n\nAcceptance criteria:\n${plan.acceptanceCriteria.map((c) => `- ${c}`).join('\n') || '- (none)'}` +
        `${plan.risks.length ? `\n\nRisks:\n${plan.risks.map((r) => `- ${r}`).join('\n')}` : ''}`;
}

/**
 * Render a context report from the orchestrator as findings, answers, conventions, and notes.
 * `runTeam` calls this when context collection completes.
 * @param {object} report
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function renderFindings(report) {
    const files = report.findings.map((f) => `### ${f.path}\n${f.purpose}\n${f.relevant}`).join('\n\n');
    const answers = report.answers.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join('\n\n');
    const conventions = report.conventions.map((c) => `- ${c}`).join('\n');
    return [files, answers && `Answers:\n${answers}`, conventions && `Conventions:\n${conventions}`, report.notes && `Notes:\n${report.notes}`]
        .filter(Boolean).join('\n\n');
}

/**
 * Render `items` as markdown bullets, or `empty` when the list has no items.
 * `runTeam` uses this for criteria, files, and review notes.
 * @param {string[]} items
 * @param {string} empty Used when `items` is empty.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export const bullets = (items, empty = '- (none)') => (items.length ? items.map((i) => `- ${i}`).join('\n') : empty);

/**
 * Render one measurer sheet as the text stored on the shared context.
 * `runTeam` calls this when the measurer completes.
 * @param {object} sheet
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function renderMeasurements(sheet) {
    const unit = sheet.unit || 'px';
    const side = (value) => (Number.isFinite(value) ? `${value}` : '?');
    const rect = (value) => `x ${side(value?.x)} y ${side(value?.y)} · ${side(value?.width)}×${side(value?.height)} ${unit}`;
    const percent = (value, dimension) => Number.isFinite(value) && Number.isFinite(dimension) && dimension > 0
        ? `${Number((value / dimension * 100).toFixed(2))}%`
        : null;
    const cssRect = (value) => {
        const left = percent(value?.x, sheet.canvas?.width);
        const top = percent(value?.y, sheet.canvas?.height);
        const width = percent(value?.width, sheet.canvas?.width);
        const height = percent(value?.height, sheet.canvas?.height);
        return [left && `left ${left}`, top && `top ${top}`, width && `width ${width}`, height && `height ${height}`].filter(Boolean).join('; ');
    };
    const insets = (value) => value && ['top', 'right', 'bottom', 'left']
        .filter((key) => Number.isFinite(value[key]))
        .map((key) => `${key} ${value[key]} ${unit}`).join(', ');
    const elements = (sheet.elements ?? []).map((item) => {
        const bits = [rect(item.box)];
        const relative = cssRect(item.box);
        if (relative) bits.push(`canvas-relative: ${relative}`);
        if (Number.isFinite(item.rotation)) bits.push(`rotated ${item.rotation}°`);
        if (Number.isFinite(item.radius)) bits.push(`radius ${item.radius} ${unit}`);
        const crop = item.crop ? ` · crop: ${item.crop}` : '';
        const lines = [`- ${item.name}: ${bits.join(' · ')}${crop}`];
        for (const [label, value] of [['padding', insets(item.padding)], ['margin', insets(item.margin)], ['gap', Number.isFinite(item.gap) ? `${item.gap} ${unit}` : ''], ['borders', item.borders], ['spacing', item.spacing], ['placement', item.placement]]) {
            if (value) lines.push(`  ${label}: ${value}`);
        }
        return lines.join('\n');
    }).join('\n');
    const regions = (sheet.regions ?? []).map((item) => {
        const crop = item.crop ? ` · crop: ${item.crop}` : '';
        return `- ${item.name}: ${rect(item.box)} — ${item.how}${crop}`;
    }).join('\n');
    const ready = (sheet.regions ?? []).filter((item) => item.crop).length;
    const rules = (sheet.rules ?? []).map((item) => `- ${item.name}: ${Number.isFinite(item.value) ? `${item.value} ${item.unit || unit}` : '(not measured)'}${item.from ? ` (measured ${item.from})` : ''}`).join('\n');
    const canvasRatio = Number.isFinite(sheet.canvas?.width) && Number.isFinite(sheet.canvas?.height) && sheet.canvas.height > 0
        ? `${Number((sheet.canvas.width / sheet.canvas.height).toFixed(3))} / 1`
        : null;
    return [
        sheet.summary ?? '',
        `Source: ${sheet.source || '(not named)'} · unit: ${sheet.unit || 'px'} · canvas ${rect(sheet.canvas)}${canvasRatio ? ` · aspect-ratio ${canvasRatio}` : ''}`,
        elements && `Elements:\n${elements}`,
        regions && `Regions to cut out${ready ? ` (${ready} ready crop(s); pass the path as generate_image reference, do not crop again)` : ''}:\n${regions}`,
        rules && `Rules:\n${rules}`,
        sheet.notes && `Notes:\n${sheet.notes}`,
        'Artwork workflow: reuse existing image candidates. If any stage already produced a PNG with a real alpha channel, keep it; do not regenerate, repaint, or flatten it. An optional SVG conversion may be tried on a copy. If a WebP copy is useful, convert it locally and keep the PNG; never use image generation or editing just to change the format. For flat marks without a suitable existing alpha image, prefer a real SVG made with vectorize_image / Recraft.',
        'For artwork comparison and atlas packing, do not call generate_image, edit_image, or image_generation: use local image operations on existing files. Compare candidates in a common aspect-ratio frame, fitting proportionally with transparent/neutral padding or a deliberate crop; never stretch an image. Keep originals unchanged. Check suitable Lucide or Phosphor icons available to the project (in dependencies or local files), lightweight HTML/CSS drawings, and existing raster or SVG candidates. After the page is built, compare the options in the rendered page and keep the clearest, best-fitting result.',
    ].filter(Boolean).join('\n\n');
}

/**
 * Render the architect's structure and design brief as the text stored on the shared context.
 * `runTeam` calls this when the architect completes and when a saved run resumes.
 * @param {object} architecture
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function renderArchitecture(architecture) {
    const structure = (architecture.structure ?? []).map((item) => {
        const lines = [`- ${item.path} (${item.kind || 'file'}): ${item.purpose}`];
        if (item.responsibilities) lines.push(`  responsibilities: ${item.responsibilities}`);
        if (item.dependsOn?.length) lines.push(`  depends on: ${item.dependsOn.join(', ')}`);
        if (item.notes) lines.push(`  notes: ${item.notes}`);
        return lines.join('\n');
    }).join('\n');
    const design = [
        ['layout', architecture.design?.layout],
        ['typography', architecture.design?.typography],
        ['color', architecture.design?.color],
        ['motion', architecture.design?.motion],
        ['assets', architecture.design?.assets],
    ].filter(([, value]) => value).map(([name, value]) => `- ${name}: ${value}`).join('\n');
    const guidance = (architecture.stepGuidance ?? []).map((item) => {
        const files = item.files?.length ? ` · files: ${item.files.join(', ')}` : '';
        return `- ${item.stepId}${files}: ${item.guidance}`;
    }).join('\n');
    return [
        architecture.summary ?? '',
        structure && `Structure (build order):\n${structure}`,
        design && `Design:\n${design}`,
        architecture.conventions?.length ? `Conventions:\n${bullets(architecture.conventions)}` : '',
        guidance && `Step guidance:\n${guidance}`,
        architecture.questionsForOrchestrator?.length ? `Questions for the orchestrator:\n${bullets(architecture.questionsForOrchestrator)}` : '',
        architecture.risks?.length ? `Risks:\n${bullets(architecture.risks)}` : '',
    ].filter(Boolean).join('\n\n');
}
