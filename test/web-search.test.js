import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectWebSources, formatWebSources, webSearchTool } from '../src/openai/web-search.js';

test('webSearchTool matches ProxyAPI unless a context size is set', () => {
    assert.deepEqual(webSearchTool(null), { type: 'web_search' });
    assert.deepEqual(webSearchTool(undefined), { type: 'web_search' });
    assert.deepEqual(webSearchTool('medium'), { type: 'web_search', search_context_size: 'medium' });
});

test('collectWebSources keeps queries, action sources, and url citations', () => {
    const found = collectWebSources({
        output: [
            { type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'python news', queries: ['python news', 'python release'], sources: [{ type: 'url', url: 'https://example.com/py' }] } },
            { type: 'web_search_call', status: 'failed', action: { query: 'skip' } },
            { type: 'message', content: [{ type: 'output_text', text: 'см.', annotations: [{ type: 'url_citation', url: 'https://proxyapi.ru/docs/web-search', title: 'Поиск' }, { type: 'url_citation', url: 'https://example.com/py', title: 'повтор' }] }] },
        ],
    });
    assert.deepEqual(found.queries, ['python news', 'python release']);
    assert.equal(found.searches, 1);
    assert.deepEqual(found.sources, [
        { url: 'https://example.com/py', title: 'повтор' },
        { url: 'https://proxyapi.ru/docs/web-search', title: 'Поиск' },
    ]);
    assert.match(formatWebSources(found), /python news/);
    assert.match(formatWebSources(found), /Поиск — https:\/\/proxyapi.ru\/docs\/web-search/);
    assert.equal(formatWebSources({ queries: [], sources: [] }), '');
});
