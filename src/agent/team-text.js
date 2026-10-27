/**
 * @file src/agent/team-text.js
 * @module agent/team-text
 * @purpose Render planner, architect, orchestrator, and measurer JSON as text the worker and reviewer can read.
 * @usedBy agent/team
 * @exports renderPlan, renderFindings, renderMeasurements, renderArchitecture, renderDecorations, bullets
 * @ai.tags team
 * @ai.hint pure
 * @changed 2026-10-27 Added the decorator report with ready snippets and files.
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
    const units = sheet.units ?? {};
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
    const confidence = (value) => value && value !== 'high' ? ` [${value} confidence]` : '';
    const elements = (sheet.elements ?? []).map((item) => {
        const bits = [rect(item.box)];
        const relative = cssRect(item.box);
        if (relative) bits.push(`canvas-relative: ${relative}`);
        if (Number.isFinite(item.rotation)) bits.push(`rotated ${item.rotation}°`);
        if (Number.isFinite(item.radius)) bits.push(`radius ${item.radius} ${unit}`);
        const crop = item.crop ? ` · crop: ${item.crop}` : '';
        const lines = [`- ${item.name}${item.kind ? ` (${item.kind})` : ''}: ${bits.join(' · ')}${crop}${confidence(item.confidence)}`];
        if (item.css) lines.push(`  css: ${item.css}`);
        const typography = item.typography;
        if (typography && (typography.role || typography.family || typography.fontSize != null || typography.weight != null || typography.lineHeight != null || typography.letterSpacing != null || typography.style)) {
            lines.push(`  typography: ${[typography.role, typography.family && `${typography.family} (${typography.familyConfidence || 'unknown'} confidence)`, Number.isFinite(typography.fontSize) && `size ${typography.fontSize} ${unit}`, Number.isFinite(typography.weight) && `weight ${typography.weight}`, Number.isFinite(typography.lineHeight) && `line-height ${typography.lineHeight} ${unit}`, Number.isFinite(typography.letterSpacing) && `letter-spacing ${typography.letterSpacing} ${unit}`, typography.style].filter(Boolean).join(', ')}`);
        }
        for (const [label, value] of [['padding', insets(item.padding)], ['margin', insets(item.margin)], ['gap', Number.isFinite(item.gap) ? `${item.gap} ${unit}` : ''], ['borders', item.borders], ['spacing', item.spacing], ['placement', item.placement]]) {
            if (value) lines.push(`  ${label}: ${value}`);
        }
        if (item.use) lines.push(`  use: ${item.use}`);
        if (item.notes) lines.push(`  notes: ${item.notes}`);
        return lines.join('\n');
    }).join('\n');
    const regions = (sheet.regions ?? []).map((item) => {
        const crop = item.crop ? ` · crop: ${item.crop}` : '';
        return `- ${item.name}${item.kind ? ` (${item.kind})` : ''}: ${rect(item.box)} — ${item.how}${item.use ? ` · use: ${item.use}` : ''}${crop}`;
    }).join('\n');
    const readyElements = (sheet.elements ?? []).filter((item) => item.crop).length;
    const readyRegions = (sheet.regions ?? []).filter((item) => item.crop).length;
    const ready = new Set([...(sheet.elements ?? []), ...(sheet.regions ?? [])]
        .map((item) => item.crop)
        .filter(Boolean)).size;
    const rules = (sheet.rules ?? []).map((item) => {
        const value = Number.isFinite(item.value) ? `${item.value} ${item.unit || unit}` : '(not measured)';
        return `- ${item.name}: ${value}${item.css ? ` → ${item.css}` : ''}${item.from ? ` (measured ${item.from})` : ''}`;
    }).join('\n');
    const canvasRatio = Number.isFinite(sheet.canvas?.width) && Number.isFinite(sheet.canvas?.height) && sheet.canvas.height > 0
        ? `${Number((sheet.canvas.width / sheet.canvas.height).toFixed(3))} / 1`
        : null;
    const unitBits = [
        `source ${units.source || unit}`,
        Number.isFinite(units.rootFontSize) && `1rem = ${units.rootFontSize} ${units.source || unit}`,
        Number.isFinite(units.scale) && `scale ${units.scale} CSS px per source unit`,
        Array.isArray(units.preferred) && units.preferred.length && `preferred CSS units: ${units.preferred.join(', ')}`,
        units.notes,
    ].filter(Boolean).join(' · ');
    const assumptions = Array.isArray(sheet.assumptions) ? sheet.assumptions.filter(Boolean) : [];
    return [
        sheet.summary ?? '',
        `Source: ${sheet.source || '(not named)'} · unit: ${unit} · canvas ${rect(sheet.canvas)}${canvasRatio ? ` · aspect-ratio ${canvasRatio}` : ''}`,
        unitBits && `Units: ${unitBits}`,
        sheet.confidence && `Overall confidence: ${sheet.confidence}.`,
        elements && `Elements:\n${elements}`,
        regions && `Regions and reusable fragments${ready ? ` (${ready} ready crop file(s); ${readyElements} element(s) and ${readyRegions} region(s) reference them; pass the path as a reference, do not crop again)` : ''}:\n${regions}`,
        rules && `Rules:\n${rules}`,
        assumptions.length && `Assumptions (verify these, do not treat them as measurements):\n${assumptions.map((item) => `- ${item}`).join('\n')}`,
        sheet.notes && `Notes:\n${sheet.notes}`,
        'Measurement discipline: measured numbers are evidence, not a design spec. Use the css values with their explicit units; low-confidence or inferred values are hypotheses and must be verified in the rendered result. Do not copy source pixels as viewport offsets.',
        'Crop workflow: the sheet is measured before fragments are used. Read the whole sheet first, then use a crop only for the element or region it names. Crops are shared evidence for the worker, architect, and image-processor; do not replace the global layout with a single fragment.',
        'Typography workflow: use measured font size, weight, line-height, and letter-spacing as the visual source of truth. Family confidence is only a visual estimate; do not treat an uncertain family as identified. Search for a matching candidate only when needed and report it separately from measurements.',
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

/**
 * Render the decorator's sheet as the text stored on the shared context.
 * Every item carries the exact snippet the page pastes and the files it links, so the author does not
 * rebuild the decoration by hand.
 * @param {object} report
 * @param {string} dir Project-relative work directory such as `.tmp/<id>`.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function renderDecorations(report, dir) {
    const items = (report.items ?? []).map((item) => {
        const lines = [`- ${item.name} (${item.approach || 'css'}): ${item.placement || '(no placement)'}`];
        if (item.files?.length) lines.push(`  files: ${item.files.join(', ')}`);
        if (item.snippet) lines.push(`  snippet: ${item.snippet}`);
        if (item.fallback) lines.push(`  fallback: ${item.fallback}`);
        if (item.notes) lines.push(`  notes: ${item.notes}`);
        return lines.join('\n');
    }).join('\n');
    return [
        report.summary ?? '',
        items && `Decorations (paste the snippet, link the files, do not rebuild them):\n${items}`,
        report.conventions?.length ? `Conventions:\n${bullets(report.conventions)}` : '',
        report.notes?.length ? `Notes:\n${bullets(report.notes)}` : '',
        `Decoration file: ${dir}/decorations.json`,
    ].filter(Boolean).join('\n\n');
}
