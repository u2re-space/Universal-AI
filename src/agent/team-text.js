/**
 * @file src/agent/team-text.js
 * @module agent/team-text
 * @purpose Render planner and collector JSON as text the worker and reviewer can read.
 * @usedBy agent/team
 * @exports renderPlan, renderFindings, bullets
 * @ai.tags team
 * @ai.hint pure
 * @changed 2026-10-15 Split from agent/team.js.
 */
export function renderPlan(plan) {
    const steps = plan.steps.map((s, i) => `${i + 1}. ${s.goal}\n   details: ${s.details}\n   verify: ${s.verify}`).join('\n');
    return `${plan.summary}\nComplexity: ${plan.complexity}\n\nSteps:\n${steps}\n\nAcceptance criteria:\n${plan.acceptanceCriteria.map((c) => `- ${c}`).join('\n') || '- (none)'}` +
        `${plan.risks.length ? `\n\nRisks:\n${plan.risks.map((r) => `- ${r}`).join('\n')}` : ''}`;
}

export function renderFindings(report) {
    const files = report.findings.map((f) => `### ${f.path}\n${f.purpose}\n${f.relevant}`).join('\n\n');
    const answers = report.answers.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join('\n\n');
    const conventions = report.conventions.map((c) => `- ${c}`).join('\n');
    return [files, answers && `Answers:\n${answers}`, conventions && `Conventions:\n${conventions}`, report.notes && `Notes:\n${report.notes}`]
        .filter(Boolean).join('\n\n');
}

export const bullets = (items, empty = '- (none)') => (items.length ? items.map((i) => `- ${i}`).join('\n') : empty);
