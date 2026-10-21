/**
 * @file src/agent/assets.js
 * @module agent/assets
 * @purpose Generate SVG files, download fonts from Google Fonts, and download icon sets (Phosphor, Lucide).
 * @depends node:path, node:fs/promises, util/text, agent/paths
 * @usedBy agent/tools
 * @exports generateSvg, downloadFont, downloadIcons
 * @ai.tags svg, fonts, icons, cdn
 * @ai.hint io
 * @changed 2026-10-22 Initial implementation.
 */

import path from 'node:path';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { resolveInside } from './paths.js';
import { formatBytes } from '../util/text.js';

const MAX_FONT_BYTES = 32 * 1024 * 1024;
const MAX_ICON_BYTES = 2 * 1024 * 1024;
const MAX_CSS_BYTES = 256 * 1024;

/**
 * Read a fetch body with a hard byte cap.
 * @param {Response} res
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 * @ai.hint io
 */
async function readCapped(res, maxBytes) {
    const reader = res.body?.getReader();
    if (!reader) {
        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.length > maxBytes) throw new Error(`Ответ больше лимита ${formatBytes(maxBytes)}.`);
        return buffer;
    }
    const chunks = [];
    let total = 0;
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (total + value.length > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new Error(`Ответ больше лимита ${formatBytes(maxBytes)}.`);
        }
        chunks.push(Buffer.from(value));
        total += value.length;
    }
    return Buffer.concat(chunks, total);
}

// ─── SVG Generation ─────────────────────────────────────────────────────────────

/**
 * Write a valid SVG file from SVG markup or a short text label.
 * Markup is completed into a document; plain text is escaped and rendered in a simple frame.
 * @param {{ prompt: string, width?: number, height?: number, output?: string, cwd: string, signal?: AbortSignal }} opts
 * @returns {Promise<{ rel: string, bytes: number }>}
 * @exports
 * @ai.hint io
 */
export async function generateSvg({ prompt, width = 512, height = 512, output = '', cwd, signal }) {
    signal?.throwIfAborted();

    // Check if prompt already contains SVG-like content
    const hasSvgTag = /<svg[\s>]/i.test(prompt);
    let svgContent;

    if (hasSvgTag) {
        // Use the prompt as-is, but ensure it's a complete SVG document
        svgContent = prompt.trimStart().startsWith('<svg') ? prompt : `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n${prompt}\n</svg>`;
    } else {
        // Generate a simple SVG with the prompt as text
        const escaped = prompt.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="#f0f0f0" rx="8"/>
  <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="24" fill="#333">${escaped}</text>
</svg>`;
    }

    // Ensure valid SVG structure
    if (!svgContent.includes('<svg')) {
        svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n${svgContent}\n</svg>`;
    }
    if (!svgContent.includes('</svg>')) {
        svgContent += '\n</svg>';
    }

    let requested = String(output ?? '').trim();
    if (requested && !/\.svg$/i.test(requested)) requested += '.svg';
    if (!requested) requested = `assets/svg-${Date.now()}.svg`;
    const { abs, rel } = await resolveInside(cwd, requested, { forWrite: true, allowRoot: false });
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, svgContent, 'utf8');
    const info = await stat(abs);

    return { rel, bytes: info.size };
}

// ─── Font Download ──────────────────────────────────────────────────────────────

/**
 * Map a style name to a Google Fonts weight and italic flag.
 * @param {string} style
 * @returns {{ weight: number, italic: boolean }}
 * @ai.hint pure
 */
function fontStyle(style) {
    const text = String(style ?? '').trim();
    const italic = /italic|oblique/i.test(text);
    const numeric = /^\d{3}$/.test(text) ? Number(text) : null;
    const weight = numeric ?? (/black|heavy/i.test(text) ? 900
        : /extra-?bold|ultra-?bold/i.test(text) ? 800
            : /semi-?bold|demi-?bold/i.test(text) ? 600
                : /bold/i.test(text) ? 700
                    : /medium/i.test(text) ? 500
                        : /light/i.test(text) ? 300
                            : /extra-?light/i.test(text) ? 200
                                : /thin|hairline/i.test(text) ? 100
                                    : 400);
    return { weight, italic };
}

/**
 * Resolve the first font file URL from the Google Fonts CSS response.
 * @param {string} name Family name.
 * @param {string} style Regular, Bold, Italic, or a numeric weight.
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}
 * @ai.hint io
 */
async function googleFontFileUrl(name, style, signal) {
    const { weight, italic } = fontStyle(style);
    const family = String(name).trim().replace(/\s+/g, '+');
    const axis = italic ? `ital,wght@1,${weight}` : `wght@${weight}`;
    const cssUrl = `https://fonts.googleapis.com/css2?family=${family}:${axis}&display=swap`;
    const res = await fetch(cssUrl, {
        signal, redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36' },
    });
    if (!res.ok) throw new Error(`Google Fonts: HTTP ${res.status} для "${name}".`);
    const css = (await readCapped(res, MAX_CSS_BYTES)).toString('utf8');
    const urls = [...css.matchAll(/url\((https:\/\/[^)]+)\)/g)].map((match) => match[1]);
    if (!urls.length) throw new Error(`Шрифт "${name}" не найден в Google Fonts.`);
    return urls[0];
}

/**
 * Download a font file from Google Fonts or a direct URL.
 * @param {{ name?: string, style?: string, url?: string | null, output?: string, cwd: string, signal?: AbortSignal }} opts
 * @returns {Promise<{ rel: string, bytes: number, family: string }>}
 * @exports
 * @ai.hint io
 */
export async function downloadFont({ name = '', style = '', url = null, output = '', cwd, signal }) {
    signal?.throwIfAborted();
    let fontUrl;
    let family = String(name || 'font').trim();

    if (url) {
        if (!/^https?:\/\//i.test(String(url))) throw new Error(`URL шрифта должен начинаться с http(s)://: ${url}`);
        fontUrl = url;
        try {
            const urlObj = new URL(url);
            family = path.basename(urlObj.pathname).replace(/\.(ttf|otf|woff2?)$/i, '').replace(/[-_]/g, ' ') || family;
        } catch { throw new Error(`Некорректный URL шрифта: ${url}`); }
    } else if (name) {
        fontUrl = await googleFontFileUrl(name, style || 'Regular', signal);
    } else {
        throw new Error('Укажите name и style, или url для загрузки шрифта.');
    }

    let fontData;
    try {
        const res = await fetch(fontUrl, { signal, headers: { 'User-Agent': 'ai-agent-cli/1.0' }, redirect: 'follow' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        fontData = await readCapped(res, MAX_FONT_BYTES);
    } catch (error) {
        throw new Error(`Не удалось загрузить шрифт: ${error.message}`);
    }

    // Detect the format by magic bytes; the URL extension is not always reliable.
    const head = fontData.subarray(0, 4).toString('latin1');
    const ext = head === 'wOF2' ? 'woff2' : head === 'wOFF' ? 'woff' : head === 'OTTO' ? 'otf' : 'ttf';
    const { weight, italic } = fontStyle(style);
    const slug = family.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'font';
    const outPath = output || `fonts/${slug}-${weight}${italic ? 'italic' : ''}.${ext}`;
    const { abs, rel } = await resolveInside(cwd, outPath, { forWrite: true, allowRoot: false });
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, fontData);
    const info = await stat(abs);

    return { rel, bytes: info.size, family };
}

// ─── Icon Download ──────────────────────────────────────────────────────────────

/**
 * Download icon sets from CDN (Phosphor, Lucide).
 * @param {{ name?: string, icon?: string | null, variant?: string, output?: string, cwd: string, signal?: AbortSignal }} opts
 * @returns {Promise<{ count: number, paths: string[] }>}
 * @exports
 * @ai.hint io
 */
export async function downloadIcons({ name = '', icon = null, variant = 'regular', output = '', cwd, signal }) {
    signal?.throwIfAborted();

    const iconSets = {
        phosphor: {
            cdn: 'https://cdn.jsdelivr.net/npm/@phosphor-icons/core@2.1.1/assets',
            variants: ['thin', 'light', 'regular', 'bold', 'duotone', 'fill'],
            ext: 'svg',
        },
        lucide: {
            cdn: 'https://cdn.jsdelivr.net/npm/lucide-static@latest/icons',
            variants: ['default'],
            ext: 'svg',
        },
    };

    const setName = name.toLowerCase();
    const setConfig = iconSets[setName];

    if (!setConfig && !setName) {
        throw new Error('Укажите name: phosphor или lucide.');
    }

    if (!setConfig) {
        throw new Error(`Неизвестный набор иконок: "${name}". Поддерживаются: phosphor, lucide.`);
    }

    const outDir = (output || `assets/icons/${setName}/`).split(path.win32.sep).join('/').replace(/\/?$/, '/');
    const { abs: outAbs } = await resolveInside(cwd, outDir, { forWrite: true, allowRoot: false });
    await mkdir(outAbs, { recursive: true });

    const paths = [];

    if (icon) {
        // Download a single icon
        const iconName = String(icon).replace(/\.svg$/i, '').toLowerCase();
        const iconUrl = setConfig.cdn.includes('phosphor')
            ? `${setConfig.cdn}/${variant}/${iconName}.svg`
            : `${setConfig.cdn}/${iconName}.svg`;

        try {
            const res = await fetch(iconUrl, { signal, headers: { 'User-Agent': 'ai-agent-cli/1.0' } });
            if (!res.ok) throw new Error(`HTTP ${res.status} для иконки ${icon}`);
            const svg = (await readCapped(res, MAX_ICON_BYTES)).toString('utf8');
            const rel = `${outDir}${iconName}.svg`;
            const { abs } = await resolveInside(cwd, rel, { forWrite: true, allowRoot: false });
            await writeFile(abs, svg, 'utf8');
            const info = await stat(abs);
            paths.push(rel);
            return { count: 1, paths };
        } catch (error) {
            throw new Error(`Не удалось скачать иконку ${icon}: ${error.message}`);
        }
    }

    // Download entire set (limit to avoid huge downloads)
    // For Phosphor, download common icons; for Lucide, download common icons
    const commonIcons = [
        'home', 'user', 'settings', 'search', 'menu', 'x', 'check', 'plus', 'minus', 'arrow-right',
        'arrow-left', 'arrow-up', 'arrow-down', 'star', 'heart', 'bell', 'mail', 'camera', 'image',
        'file', 'folder', 'trash', 'edit', 'copy', 'download', 'upload', 'share', 'link', 'lock',
        'unlock', 'eye', 'eye-off', 'sun', 'moon', 'zap', 'shield', 'globe', 'code', 'terminal',
        'github', 'twitter', 'linkedin', 'youtube', 'chat', 'message', 'calendar', 'clock', 'map',
        'map-pin', 'phone', 'star', 'tag', 'tool', 'bookmark', 'bookmark-minus', 'grid', 'list',
        'layers', 'layout', 'maximize', 'minimize', 'pause', 'play', 'skip-back', 'skip-forward',
        'volume', 'volume-off', 'wifi', 'battery', 'battery-charging', 'cable', 'hard-drive',
        'keyboard', 'monitor', 'mouse', 'printer', 'smartphone', 'tablet', 'tv', 'watch',
    ];

    const maxIcons = setName === 'lucide' ? 50 : 100; // Lucide has ~2000 icons, limit download
    const iconsToDownload = commonIcons.slice(0, maxIcons);

    for (const iconName of iconsToDownload) {
        try {
            const iconUrl = setConfig.cdn.includes('phosphor')
                ? `${setConfig.cdn}/${variant}/${iconName.toLowerCase()}.svg`
                : `${setConfig.cdn}/${iconName.toLowerCase()}.svg`;

            const res = await fetch(iconUrl, { signal, headers: { 'User-Agent': 'ai-agent-cli/1.0' }, redirect: 'follow' });
            if (!res.ok) continue; // Skip missing icons
            const svg = (await readCapped(res, MAX_ICON_BYTES)).toString('utf8');
            const rel = `${outDir}${iconName}.svg`;
            const { abs } = await resolveInside(cwd, rel, { forWrite: true, allowRoot: false });
            await writeFile(abs, svg, 'utf8');
            paths.push(rel);
        } catch {
            // Skip failed downloads
        }
    }

    return { count: paths.length, paths };
}
