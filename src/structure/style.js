/**
 * @file src/structure/style.js
 * @module structure/style
 * @purpose Restructure CSS and SCSS: sort, group, dedupe, merge, and wrap layers.
 * @usedBy structure/structure
 * @exports styleTasks, parseStyle, printStyle
 * @ai.tags structure, css, scss
 * @ai.hint pure
 * @changed 2026-10-15 Structural edits for style sheets.
 */

/** Declaration groups used when the request does not name its own. */
const DEFAULT_GROUPS = [
    ['position', 'inset', 'top', 'right', 'bottom', 'left', 'z-index'],
    ['display', 'flex', 'flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'align-content', 'grid', 'grid-template', 'grid-template-columns', 'grid-template-rows', 'gap', 'row-gap', 'column-gap'],
    ['width', 'height', 'min-width', 'min-height', 'max-width', 'max-height', 'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'box-sizing', 'overflow'],
    ['font', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-align', 'text-decoration', 'color'],
    ['background', 'background-color', 'border', 'border-radius', 'opacity', 'box-shadow', 'transform', 'transition', 'animation'],
];

/**
 * Index just after a quoted string that starts at `from`.
 * @param {string} text
 * @param {number} from
 * @param {number} end
 * @returns {number}
 * @ai.hint pure
 */
function skipString(text, from, end) {
    const quote = text[from];
    for (let i = from + 1; i < end; i++) {
        if (text[i] === '\\') { i++; continue; }
        if (text[i] === quote) return i + 1;
    }
    return end;
}

/**
 * Index of the `}` that closes the `{` at `open`.
 * @param {string} text
 * @param {number} open
 * @param {number} end
 * @returns {number}
 * @ai.hint pure
 */
function findClose(text, open, end) {
    let depth = 0;
    for (let i = open; i < end; i++) {
        if (text[i] === '/' && text[i + 1] === '*') {
            const close = text.indexOf('*/', i + 2);
            i = close === -1 ? end : close + 1;
            continue;
        }
        if (text[i] === '"' || text[i] === "'") { i = skipString(text, i, end) - 1; continue; }
        if (text[i] === '{') depth++;
        else if (text[i] === '}') {
            depth--;
            if (depth === 0) return i;
        }
    }
    return end;
}

/**
 * One statement that ends with a semicolon: a declaration, or raw at-rule text.
 * @param {string} statement
 * @returns {object}
 * @ai.hint pure
 */
function parseStatement(statement) {
    const trimmed = statement.trim();
    if (!trimmed) return { type: 'space', text: statement };
    if (trimmed.startsWith('@') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return { type: 'raw', text: trimmed.endsWith(';') ? trimmed : `${trimmed};` };
    const colon = trimmed.indexOf(':');
    if (colon <= 0) return { type: 'raw', text: trimmed };
    const prop = trimmed.slice(0, colon).trim();
    let value = trimmed.slice(colon + 1).trim().replace(/;$/, '').trim();
    const important = /!important\s*$/i.test(value);
    if (important) value = value.replace(/!important\s*$/i, '').trim();
    return { type: 'decl', prop, value, important };
}

/**
 * Parse a stylesheet into comments, declarations, rules, and at-rules. Nesting is kept.
 * @param {string} text
 * @param {number} [start]
 * @param {number} [end]
 * @returns {object[]}
 * @ai.hint pure
 */
function parseList(text, start = 0, end = text.length) {
    const nodes = [];
    let i = start;
    let chunkStart = start;
    /**
     * Store the text accumulated since the last node, when it is not only whitespace.
     * @param {number} to
     * @returns {void}
     * @ai.hint pure
     */
    const flush = (to) => {
        const raw = text.slice(chunkStart, to);
        if (raw.trim()) nodes.push(parseStatement(raw));
        chunkStart = to;
    };
    while (i < end) {
        const pair = text.slice(i, i + 2);
        if (pair === '/*') {
            flush(i);
            const close = text.indexOf('*/', i + 2);
            const next = close === -1 ? end : close + 2;
            nodes.push({ type: 'comment', text: text.slice(i, next).trim() });
            i = next;
            chunkStart = i;
            continue;
        }
        if (pair === '//') {
            flush(i);
            const nl = text.indexOf('\n', i);
            const next = nl === -1 ? end : nl + 1;
            nodes.push({ type: 'comment', text: text.slice(i, nl === -1 ? end : nl).trim() });
            i = next;
            chunkStart = i;
            continue;
        }
        if (text[i] === '"' || text[i] === "'") { i = skipString(text, i, end); continue; }
        if (text[i] === '{') {
            const prelude = text.slice(chunkStart, i).trim();
            const close = findClose(text, i, end);
            const body = parseList(text, i + 1, close);
            if (prelude.startsWith('@')) {
                const name = prelude.slice(1).split(/[\s:(]/)[0].toLowerCase();
                nodes.push({ type: 'at', name, prelude, body });
            } else if (prelude) nodes.push({ type: 'rule', selector: prelude.replace(/\s+/g, ' ').trim(), body });
            i = Math.min(end, close + 1);
            chunkStart = i;
            continue;
        }
        if (text[i] === '}') {
            flush(i);
            return nodes;
        }
        if (text[i] === ';') {
            flush(i + 1);
            i++;
            continue;
        }
        i++;
    }
    flush(end);
    return nodes;
}

/**
 * Parse a style sheet.
 * @param {string} text
 * @returns {object[]}
 * @exports
 * @ai.hint pure
 */
export function parseStyle(text) {
    return parseList(text);
}

/**
 * Print nodes with a two-space indent.
 * @param {object[]} nodes
 * @param {number} [indent]
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function printStyle(nodes, indent = 0) {
    const pad = '  '.repeat(indent);
    const lines = [];
    for (const node of nodes) {
        if (!node) continue;
        if (node.type === 'decl') lines.push(`${pad}${node.prop}: ${node.value}${node.important ? ' !important' : ''};`);
        else if (node.type === 'comment') lines.push(`${pad}${node.text}`);
        else if (node.type === 'raw') lines.push(`${pad}${node.text}`);
        else if (node.type === 'space') continue;
        else if (node.type === 'rule' || node.type === 'at') {
            const head = node.type === 'rule' ? node.selector : node.prelude;
            const inner = printStyle(node.body ?? [], indent + 1);
            lines.push(`${pad}${head} {`);
            if (inner) lines.push(inner);
            lines.push(`${pad}}`);
        }
    }
    return lines.join('\n');
}

/**
 * @param {object[]} nodes
 * @param {(nodes: object[], rules: object) => object[]} visit
 * @param {object} rules
 * @returns {object[]}
 * @ai.hint pure
 */
function mapTree(nodes, visit, rules) {
    const mapped = nodes.map((node) => {
        if (node.type === 'rule' || node.type === 'at') return { ...node, body: mapTree(node.body ?? [], visit, rules) };
        return node;
    });
    return visit(mapped, rules);
}

/**
 * @param {object[]} nodes
 * @returns {object[]}
 * @ai.hint pure
 */
function onlyDecls(nodes) {
    return nodes.filter((node) => node.type === 'decl');
}

/**
 * Drop duplicate properties inside one block. The later declaration wins.
 * @param {object[]} nodes
 * @returns {object[]}
 * @ai.hint pure
 */
function dedupeNodes(nodes) {
    const seen = new Map();
    const drop = new Set();
    nodes.forEach((node, index) => {
        if (node.type !== 'decl') return;
        const key = node.prop.toLowerCase();
        if (seen.has(key)) drop.add(seen.get(key));
        seen.set(key, index);
    });
    return nodes.filter((_, index) => !drop.has(index));
}

/**
 * @param {string} selector
 * @returns {string}
 * @ai.hint pure
 */
function normalSelector(selector) {
    return selector.replace(/\s+/g, ' ').trim();
}

/**
 * Merge sibling rules that share a selector. Later properties win.
 * @param {object[]} nodes
 * @returns {object[]}
 * @ai.hint pure
 */
function mergeNodes(nodes) {
    const result = [];
    const indexOf = new Map();
    for (const node of nodes) {
        if (node.type !== 'rule') { result.push(node); continue; }
        const key = normalSelector(node.selector);
        if (!indexOf.has(key)) {
            indexOf.set(key, result.length);
            result.push({ ...node, selector: key, body: [...(node.body ?? [])] });
            continue;
        }
        const target = result[indexOf.get(key)];
        target.body = dedupeNodes([...(target.body ?? []), ...(node.body ?? [])]);
    }
    return result;
}

/**
 * Combine rules whose declarations are identical into one selector list.
 * Nested rules stay separate.
 * @param {object[]} nodes
 * @returns {object[]}
 * @ai.hint pure
 */
function groupSelectors(nodes) {
    const signature = (node) => {
        const body = node.body ?? [];
        if (body.some((child) => child.type === 'rule' || child.type === 'at')) return null;
        const decls = onlyDecls(body).map((decl) => [decl.prop.toLowerCase(), decl.value, decl.important]);
        decls.sort((a, b) => a[0].localeCompare(b[0]));
        return JSON.stringify(decls);
    };
    const result = [];
    const indexOf = new Map();
    for (const node of nodes) {
        if (node.type !== 'rule') { result.push(node); continue; }
        const key = signature(node);
        if (!key || key === '[]') { result.push(node); continue; }
        if (!indexOf.has(key)) {
            indexOf.set(key, result.length);
            result.push({ ...node });
            continue;
        }
        const target = result[indexOf.get(key)];
        const selectors = new Set(`${target.selector}, ${node.selector}`.split(',').map((part) => normalSelector(part)).filter(Boolean));
        target.selector = [...selectors].sort((a, b) => a.localeCompare(b)).join(', ');
    }
    return result;
}

/**
 * @param {object[]} nodes
 * @param {object} rules
 * @returns {object[]}
 * @ai.hint pure
 */
function groupProperties(nodes, rules) {
    const groups = Array.isArray(rules.propertyGroups) && rules.propertyGroups.length ? rules.propertyGroups : DEFAULT_GROUPS;
    const rank = new Map();
    groups.forEach((group, index) => group.forEach((prop) => rank.set(String(prop).toLowerCase(), index)));
    const decls = onlyDecls(nodes);
    const rest = nodes.filter((node) => node.type !== 'decl');
    decls.sort((a, b) => {
        const left = rank.has(a.prop.toLowerCase()) ? rank.get(a.prop.toLowerCase()) : groups.length;
        const right = rank.has(b.prop.toLowerCase()) ? rank.get(b.prop.toLowerCase()) : groups.length;
        if (left !== right) return left - right;
        return a.prop.localeCompare(b.prop);
    });
    return [...decls, ...rest];
}

/**
 * Sort sibling style rules by selector. Contiguous runs stay around at-rules.
 * @param {object[]} nodes
 * @returns {object[]}
 * @ai.hint pure
 */
function sortRules(nodes) {
    const hoisted = [];
    const rest = [];
    for (const node of nodes) {
        if (node.type === 'raw' && /^@(charset|import|use|forward)\b/i.test(node.text.trim())) hoisted.push(node);
        else rest.push(node);
    }
    hoisted.sort((a, b) => a.text.localeCompare(b.text));
    const rules = rest.filter((node) => node.type === 'rule').sort((a, b) => a.selector.localeCompare(b.selector));
    let ruleIndex = 0;
    const ordered = rest.map((node) => (node.type === 'rule' ? rules[ruleIndex++] : node));
    return [...hoisted, ...ordered];
}

/**
 * @param {string} selector
 * @param {object} rules
 * @returns {string}
 * @ai.hint pure
 */
function layerFor(selector, rules) {
    const layers = Array.isArray(rules.layers) && rules.layers.length ? rules.layers : ['base', 'components', 'utilities'];
    const matches = Array.isArray(rules.layerMatch) ? rules.layerMatch : [
        { layer: layers[0], pattern: '^(html|body|:root|\\*|h[1-6]|p|a|button|input|textarea|select)\\b' },
        { layer: layers[layers.length - 1] === layers[0] ? layers[0] : layers[layers.length - 1], pattern: '^\\.u-|^%u-' },
    ];
    for (const match of matches) {
        if (!match?.pattern || !layers.includes(match.layer)) continue;
        try {
            if (new RegExp(match.pattern).test(selector)) return match.layer;
        } catch { /* a bad user pattern does not stop the other rules */ }
    }
    return layers[Math.min(1, layers.length - 1)] ?? layers[0];
}

/**
 * Wrap top-level style rules in `@layer` buckets. Imports stay above the layer order.
 * @param {object[]} nodes
 * @param {object} rules
 * @returns {object[]}
 * @ai.hint pure
 */
function applyLayers(nodes, rules) {
    const layers = Array.isArray(rules.layers) && rules.layers.length ? rules.layers : ['base', 'components', 'utilities'];
    const buckets = new Map(layers.map((name) => [name, []]));
    const head = [];
    const tail = [];
    for (const node of nodes) {
        if (node.type === 'raw' && /^@(charset|import|use|forward)\b/i.test(node.text.trim())) { head.push(node); continue; }
        if (node.type === 'at' && node.name === 'layer') { tail.push(node); continue; }
        if (node.type === 'rule') {
            const name = layerFor(node.selector, { ...rules, layers });
            buckets.get(name)?.push(node) ?? tail.push(node);
            continue;
        }
        tail.push(node);
    }
    const layered = layers.filter((name) => (buckets.get(name) ?? []).length).map((name) => ({
        type: 'at', name: 'layer', prelude: `@layer ${name}`, body: buckets.get(name),
    }));
    if (!layered.length) return nodes;
    return [...head, { type: 'raw', text: `@layer ${layers.join(', ')};` }, ...layered, ...tail];
}

/**
 * Remove empty rules and exact duplicate comments that sit on top of each other.
 * @param {object[]} nodes
 * @returns {object[]}
 * @ai.hint pure
 */
function cleanNodes(nodes) {
    const result = [];
    for (const node of nodes) {
        if (node.type === 'rule' || node.type === 'at') {
            const body = cleanNodes(node.body ?? []);
            if (!body.length) continue;
            result.push({ ...node, body });
            continue;
        }
        if (node.type === 'space') continue;
        result.push(node);
    }
    return result;
}

/** Task name → tree transform. */
export const styleTasks = {
    /**
     * @param {object[]} nodes
     * @returns {object[]}
     * @ai.hint pure
     */
    dedupe: (nodes) => mapTree(nodes, dedupeNodes, {}),
    /**
     * @param {object[]} nodes
     * @returns {object[]}
     * @ai.hint pure
     */
    merge: (nodes) => mapTree(nodes, mergeNodes, {}),
    /**
     * @param {object[]} nodes
     * @returns {object[]}
     * @ai.hint pure
     */
    'group-selectors': (nodes) => mapTree(nodes, groupSelectors, {}),
    /**
     * @param {object[]} nodes
     * @param {object} rules
     * @returns {object[]}
     * @ai.hint pure
     */
    'group-properties': (nodes, rules) => mapTree(nodes, groupProperties, rules),
    /**
     * @param {object[]} nodes
     * @returns {object[]}
     * @ai.hint pure
     */
    'sort-properties': (nodes) => mapTree(nodes, (list) => {
        const decls = onlyDecls(list).sort((a, b) => a.prop.localeCompare(b.prop));
        return [...decls, ...list.filter((node) => node.type !== 'decl')];
    }, {}),
    /**
     * @param {object[]} nodes
     * @returns {object[]}
     * @ai.hint pure
     */
    'sort-rules': (nodes) => mapTree(nodes, sortRules, {}),
    /**
     * @param {object[]} nodes
     * @param {object} rules
     * @returns {object[]}
     * @ai.hint pure
     */
    layers: (nodes, rules) => applyLayers(cleanNodes(nodes), rules),
    /**
     * @param {object[]} nodes
     * @returns {object[]}
     * @ai.hint pure
     */
    clean: (nodes) => cleanNodes(nodes),
};
