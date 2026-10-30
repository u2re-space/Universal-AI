import http from 'node:http';
import { randomUUID } from 'node:crypto';

/**
 * A small fake of the OpenAI Responses API for tests.
 *
 * script(body, index) → scenario, where scenario is:
 *   { text?, reasoning?, calls?: [{ name, arguments }], images?: [{ b64, partials? }],
 *     status?: 'completed'|'incomplete'|'failed', usage?, error?, httpStatus?, httpBody?, background?: 'queued' }
 * Every POST /responses produces SSE when body.stream is true, JSON otherwise.
 * Background responses stay 'queued' for `backgroundPolls` GETs, then complete.
 */
export async function startMockServer({ script, imageScript, backgroundPolls = 2, decisions = null } = {}) {
    const requests = [];
    const responses = new Map();   // id -> { body, scenario, polls }
    let counter = 0;

    function usageOf(scenario) {
        return scenario.usage ?? { input_tokens: 100, input_tokens_details: { cached_tokens: 20 }, output_tokens: 30,
            output_tokens_details: { reasoning_tokens: 10 }, total_tokens: 130 };
    }

    function outputItems(scenario, id) {
        const items = [];
        if (scenario.reasoning) items.push({ id: `rs_${id}`, type: 'reasoning', summary: [{ type: 'summary_text', text: scenario.reasoning }], encrypted_content: `enc_${id}` });
        for (const [i, image] of (scenario.images ?? []).entries()) {
            items.push({ id: `ig_${id}_${i}`, type: 'image_generation_call', status: 'completed', result: image.b64, output_format: image.format ?? 'png', revised_prompt: image.revisedPrompt ?? null });
        }
        for (const [i, search] of (scenario.searches ?? []).entries()) {
            items.push({
                id: `ws_${id}_${i}`, type: 'web_search_call', status: search.status ?? 'completed',
                action: {
                    type: search.type ?? 'search', query: search.query ?? null, queries: search.queries ?? null,
                    url: search.url ?? null, sources: search.sources ?? null,
                },
            });
        }
        for (const [i, call] of (scenario.calls ?? []).entries()) {
            items.push({ id: `fc_${id}_${i}`, type: 'function_call', status: 'completed', name: call.name, call_id: `call_${id}_${i}`, arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}) });
        }
        if (scenario.text !== undefined) items.push({ id: `msg_${id}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: scenario.text, annotations: scenario.annotations ?? [] }] });
        if (scenario.refusal) items.push({ id: `msg_${id}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: scenario.refusal }] });
        return items;
    }

    function finalResponse(body, scenario, id, status = scenario.status ?? 'completed') {
        return {
            id, object: 'response', created_at: Math.floor(Date.now() / 1000), status, model: body.model ?? 'mock-model',
            output: status === 'queued' ? [] : outputItems(scenario, id), usage: status === 'queued' ? null : usageOf(scenario),
            error: status === 'failed' ? (scenario.error ?? { code: 'server_error', message: 'mock failure' }) : null,
            incomplete_details: status === 'incomplete' ? { reason: scenario.reason ?? 'max_output_tokens' } : null,
            background: Boolean(body.background), previous_response_id: body.previous_response_id ?? null,
        };
    }

    function writeSSE(res, body, scenario, id, { from = -1 } = {}) {
        let seq = -1;
        const send = (type, payload) => {
            seq++;
            if (seq <= from) return;
            res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq, ...payload })}\n\n`);
        };
        const inProgress = finalResponse(body, scenario, id, 'in_progress');
        inProgress.output = [];
        inProgress.usage = null;
        send('response.created', { response: inProgress });
        send('response.in_progress', { response: inProgress });
        const items = outputItems(scenario, id);
        items.forEach((item, index) => {
            const added = { ...item, status: 'in_progress' };
            if (item.type === 'message') added.content = [];
            if (item.type === 'function_call') added.arguments = '';
            if (item.type === 'image_generation_call') { added.result = null; added.status = 'generating'; }
            send('response.output_item.added', { output_index: index, item: added });
            if (item.type === 'reasoning') {
                const text = item.summary[0].text;
                send('response.reasoning_summary_part.added', { item_id: item.id, output_index: index, summary_index: 0, part: { type: 'summary_text', text: '' } });
                for (const piece of text.match(/.{1,7}/gs) ?? []) send('response.reasoning_summary_text.delta', { item_id: item.id, output_index: index, summary_index: 0, delta: piece });
                send('response.reasoning_summary_text.done', { item_id: item.id, output_index: index, summary_index: 0, text });
                send('response.reasoning_summary_part.done', { item_id: item.id, output_index: index, summary_index: 0, part: { type: 'summary_text', text } });
            } else if (item.type === 'message') {
                const part = item.content[0];
                send('response.content_part.added', { item_id: item.id, output_index: index, content_index: 0, part: { ...part, text: '' } });
                if (part.type === 'output_text') {
                    for (const piece of part.text.match(/.{1,5}/gs) ?? []) send('response.output_text.delta', { item_id: item.id, output_index: index, content_index: 0, delta: piece, logprobs: [] });
                    send('response.output_text.done', { item_id: item.id, output_index: index, content_index: 0, text: part.text, logprobs: [] });
                } else {
                    send('response.refusal.delta', { item_id: item.id, output_index: index, content_index: 0, delta: part.refusal });
                    send('response.refusal.done', { item_id: item.id, output_index: index, content_index: 0, refusal: part.refusal });
                }
                send('response.content_part.done', { item_id: item.id, output_index: index, content_index: 0, part });
            } else if (item.type === 'function_call') {
                for (const piece of item.arguments.match(/.{1,9}/gs) ?? []) send('response.function_call_arguments.delta', { item_id: item.id, output_index: index, delta: piece });
                send('response.function_call_arguments.done', { item_id: item.id, output_index: index, name: item.name, arguments: item.arguments });
            } else if (item.type === 'image_generation_call') {
                send('response.image_generation_call.in_progress', { item_id: item.id, output_index: index });
                send('response.image_generation_call.generating', { item_id: item.id, output_index: index });
                const image = (scenario.images ?? [])[Number(item.id.split('_').at(-1))] ?? {};
                for (const [i, partial] of (image.partials ?? []).entries()) {
                    send('response.image_generation_call.partial_image', { item_id: item.id, output_index: index, partial_image_index: i, partial_image_b64: partial, output_format: item.output_format, size: '1024x1024' });
                }
                send('response.image_generation_call.completed', { item_id: item.id, output_index: index });
            }
            send('response.output_item.done', { output_index: index, item });
        });
        if (scenario.streamError) {
            send('error', { error: scenario.streamError });
        }
        const terminal = scenario.status ?? 'completed';
        send(`response.${terminal}`, { response: finalResponse(body, scenario, id, terminal) });
        res.end();
    }

    const server = http.createServer(async (req, res) => {
        res.on('error', () => {});
        req.on('error', () => {});
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = raw ? JSON.parse(raw) : null;
        const url = new URL(req.url, 'http://localhost');
        const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'x-request-id': `req_${randomUUID().slice(0, 8)}` }); res.end(JSON.stringify(data)); };
        requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });

        if (req.method === 'GET' && url.pathname === '/v1/models') return json(200, { object: 'list', data: [{ id: 'mock-model' }, { id: 'gpt-6.1-terra' }, { id: 'recraft/recraft-v4.1-utility' }] });
        if (req.method === 'POST' && url.pathname === '/v1/images/generations') {
            const scenario = typeof imageScript === 'function' ? await imageScript(body) : null;
            if (scenario?.httpStatus) return json(scenario.httpStatus, scenario.httpBody ?? { error: { message: 'mock image error', type: 'server_error' } });
            return json(200, { created: Math.floor(Date.now() / 1000), data: scenario?.data ?? [{ b64_json: TINY_PNG }] });
        }
        if (req.method === 'POST' && url.pathname === '/v1/images/edits') {
            return json(200, { created: Math.floor(Date.now() / 1000), data: [{ b64_json: TINY_PNG }] });
        }
        if (req.method === 'POST' && url.pathname === '/v1/decisions') {
            const answer = typeof decisions === 'function' ? await decisions(body) : decisions;
            if (!answer) return json(404, { error: { message: 'no decisions route', type: 'invalid_request_error', code: 'not_found' } });
            if (answer.httpStatus) return json(answer.httpStatus, answer.httpBody ?? { error: { message: 'decisions error', type: 'invalid_request_error' } });
            return json(200, {
                id: `dec_${++counter}`, model: body?.model ?? 'mock-decisions',
                answers: answer.answers ?? answer, usage: { input_tokens: 50, output_tokens: 0 },
            });
        }
        if (req.method === 'POST' && url.pathname === '/v1/responses/input_tokens') return json(200, { object: 'response.input_tokens', input_tokens: JSON.stringify(body.input).length });
        if (req.method === 'POST' && url.pathname === '/v1/responses/compact') {
            return json(200, { id: `cmp_${++counter}`, object: 'response.compaction', output: [{ type: 'compaction', id: `cmp_item_${counter}`, encrypted_content: 'enc_compacted' }], usage: usageOf({}) });
        }
        const match = /^\/v1\/responses\/([^/]+)(\/cancel)?$/.exec(url.pathname);
        if (match) {
            const stored = responses.get(match[1]);
            if (!stored) return json(404, { error: { message: 'not found', type: 'invalid_request_error', code: 'not_found' } });
            if (match[2]) { stored.cancelled = true; return json(200, finalResponse(stored.body, stored.scenario, match[1], 'cancelled')); }
            stored.polls++;
            if (url.searchParams.get('stream') === 'true') {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                const from = url.searchParams.has('starting_after') ? Number(url.searchParams.get('starting_after')) : -1;
                return writeSSE(res, stored.body, stored.scenario, match[1], { from });
            }
            const ready = stored.polls > backgroundPolls || !stored.body.background;
            return json(200, finalResponse(stored.body, stored.scenario, match[1], ready ? (stored.scenario.status ?? 'completed') : stored.polls === 1 ? 'queued' : 'in_progress'));
        }
        if (req.method === 'POST' && url.pathname === '/v1/responses') {
            const index = requests.filter((r) => r.path === '/v1/responses' && r.method === 'POST').length - 1;
            let scenario;
            try { scenario = await script(body, index); }
            catch (error) {
                // An assertion inside a test script must fail the test quickly, not hang the client.
                return json(500, { error: { message: `mock script error: ${error.message}`, type: 'server_error', code: 'mock_script_error' } });
            }
            if (scenario.delayMs) await new Promise((resolve) => setTimeout(resolve, scenario.delayMs));
            if (res.destroyed) return;
            if (scenario.httpStatus) return json(scenario.httpStatus, scenario.httpBody ?? { error: { message: 'mock http error', type: 'server_error', code: 'mock_error' } });
            const id = `resp_${++counter}`;
            responses.set(id, { body, scenario, polls: 0 });
            if (body.background && !body.stream) return json(200, finalResponse(body, scenario, id, 'queued'));
            if (!body.stream) return json(200, finalResponse(body, scenario, id));
            res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'x-request-id': `req_${id}` });
            if (scenario.truncateAfterEvents) {
                // Simulate a dropped connection: flush a few events, then destroy the socket.
                let seq = -1;
                const frames = [];
                const send = (type, payload) => { seq++; frames.push(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq, ...payload })}\n\n`); };
                send('response.created', { response: finalResponse(body, scenario, id, 'in_progress') });
                send('response.in_progress', { response: finalResponse(body, scenario, id, 'in_progress') });
                for (let i = 0; i < scenario.truncateAfterEvents; i++) send('response.output_text.delta', { item_id: `msg_${id}`, output_index: 0, content_index: 0, delta: 'x' });
                res.write(frames.join(''), () => setTimeout(() => res.socket.destroy(), 20));
                return;
            }
            return writeSSE(res, body, scenario, id);
        }
        json(404, { error: { message: `no route ${req.method} ${url.pathname}`, type: 'invalid_request_error' } });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    return {
        baseURL: `http://127.0.0.1:${port}/v1/`,
        requests,
        /** Forget recorded requests so scenario indexes restart from 0 (call at the start of a test). */
        reset: () => { requests.length = 0; },
        close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
    };
}

export const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
