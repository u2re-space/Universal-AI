/**
 * @file src/agent/team-text.js
 * @module agent/team-text
 * @purpose Render planner, orchestrator, and measurer JSON as text the worker and reviewer can read.
 * @usedBy agent/team
 * @exports renderPlan, renderFindings, renderMeasurements, bullets
 * @ai.tags team
 * @ai.hint pure
 * @changed 2026-10-22 Added the measurer sheet.
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
    const side = (value) => (Number.isFinite(value) ? `${value}` : '?');
    const rect = (value) => `x ${side(value?.x)} y ${side(value?.y)} · ${side(value?.width)}×${side(value?.height)}`;
    const elements = (sheet.elements ?? []).map((item) => {
        const bits = [rect(item.box)];
        if (Number.isFinite(item.rotation)) bits.push(`rotated ${item.rotation}°`);
        if (Number.isFinite(item.radius)) bits.push(`radius ${item.radius}`);
        const crop = item.crop ? ` · crop: ${item.crop}` : '';
        const lines = [`- ${item.name}: ${bits.join(' · ')}${crop}`];
        for (const [label, value] of [['borders', item.borders], ['spacing', item.spacing], ['placement', item.placement]]) {
            if (value) lines.push(`  ${label}: ${value}`);
        }
        return lines.join('\n');
    }).join('\n');
    const regions = (sheet.regions ?? []).map((item) => {
        const crop = item.crop ? ` · crop: ${item.crop}` : '';
        return `- ${item.name}: ${rect(item.box)} — ${item.how}${crop}`;
    }).join('\n');
    const ready = (sheet.regions ?? []).filter((item) => item.crop).length;
    const rules = (sheet.rules ?? []).map((item) => `- ${item.name}: ${item.value}${item.from ? ` (measured ${item.from})` : ''}`).join('\n');
    return [
        sheet.summary ?? '',
        `Source: ${sheet.source || '(not named)'} · unit: ${sheet.unit || 'px'} · canvas ${rect(sheet.canvas)}`,
        elements && `Elements:\n${elements}`,
        regions && `Regions to cut out${ready ? ` (${ready} ready crop(s); pass the path as generate_image reference, do not crop again)` : ''}:\n${regions}`,
        rules && `Rules:\n${rules}`,
        sheet.notes && `Notes:\n${sheet.notes}`,
    ].filter(Boolean).join('\n\n');
}
