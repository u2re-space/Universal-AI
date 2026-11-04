import { test, after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createClient } from '../src/openai/client.js';
import { createSession } from '../src/core/session.js';
import { createLedger } from '../src/core/usage.js';
import { defaults, loadConfig, redactConfig } from '../src/core/config.js';
import { buildUserMessage } from '../src/core/attachments.js';
import { createToolset } from '../src/agent/tools.js';
import { runTurn } from '../src/agent/loop.js';
import { createFallbackClient, chatOptionsFor, providerDown, servesRoute, supportsRoute } from '../src/openai/fallback.js';
import { completionChannelList } from '../src/complete/channels.js';
import { chatGaps, createChatStreamReducer, droppedTools, fromChatCompletion, responsesRouteUnsupported, stripRejectedFields, toChatBody } from '../src/openai/chat.js';
import { startMockServer } from './helpers/mock-server.js';

/**
 * The chat transport: what a body looks like on the wire, how an answer comes back, and the
 * client switching routes when the host has none.
 */

let server;
let chatScript = () => ({ content: 'ok' });
let root;

before(async () => {
    server = await startMockServer({
        script: () => ({ text: 'never' }),
        noResponses: true,
        chatScript: (body, index) => chatScript(body, index),
    });
    root = await mkdtemp(path.join(os.tmpdir(), 'ai-agent-chat-'));
});
beforeEach(() => { server.reset(); chatScript = () => ({ content: 'ok' }); });
after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });

const client = (chat = null) => createClient({ apiKey: 'sk-test', baseURL: server.baseURL, chat });
const chatPosts = () => server.requests.filter((entry) => entry.path === '/v1/chat/completions');
const responsePosts = () => server.requests.filter((entry) => entry.path === '/v1/responses');

test('toChatBody: instructions, history, tools, and images become chat messages', () => {
    const body = toChatBody({
        model: 'mock-model',
        instructions: 'system prompt',
        input: [
            { type: 'message', role: 'user', content: [
                { type: 'input_text', text: 'посмотри картинку' },
                { type: 'input_image', image_url: 'data:image/png;base64,AAA', detail: 'high' },
            ] },
            { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc' },
            { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' },
            { type: 'function_call_output', call_id: 'call_1', output: 'содержимое' },
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'прочитал' }] },
        ],
        tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object' } }, { type: 'web_search' }],
        parallel_tool_calls: true,
        max_output_tokens: 64,
        reasoning: { effort: 'low' },
        text: { format: { type: 'json_schema', name: 'plan', strict: true, schema: { type: 'object' } }, verbosity: 'low' },
        store: true,
        background: true,
        include: ['reasoning.encrypted_content'],
        truncation: 'auto',
    });
    assert.deepEqual(body.messages[0], { role: 'system', content: 'system prompt' });
    const first = body.messages[1];
    assert.equal(first.role, 'user');
    assert.deepEqual(first.content, [
        { type: 'text', text: 'посмотри картинку' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA', detail: 'high' } },
    ]);
    assert.deepEqual(body.messages[2], {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
    });
    assert.deepEqual(body.messages[3], { role: 'tool', tool_call_id: 'call_1', content: 'содержимое' });
    assert.deepEqual(body.messages[4], { role: 'assistant', content: 'прочитал' });
    assert.deepEqual(body.tools.map((tool) => tool.function.name), ['read_file'], 'built-in tools are dropped');
    assert.equal(body.max_completion_tokens, 64);
    assert.equal(body.reasoning_effort, 'low');
    assert.deepEqual(body.response_format, { type: 'json_schema', json_schema: { name: 'plan', strict: true, schema: { type: 'object' } } });
    for (const key of ['store', 'background', 'include', 'truncation', 'previous_response_id']) {
        assert.ok(!(key in body), `${key} has no chat meaning`);
    }
});

test('toChatBody: an empty history still sends one user turn', () => {
    assert.deepEqual(toChatBody({ model: 'm', instructions: 'only system', input: [{ type: 'reasoning', id: 'r' }] }).messages, [
        { role: 'system', content: 'only system' },
        { role: 'user', content: '' },
    ]);
});

test('fromChatCompletion: text, tool calls, usage, and an incomplete answer', () => {
    const withCall = fromChatCompletion({
        id: 'chatcmpl_1', model: 'mock-model',
        choices: [{ message: { role: 'assistant', content: 'готово', tool_calls: [{ id: 'call_1', function: { name: 'read_file', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 40, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 8 } },
    });
    assert.equal(withCall.status, 'completed');
    assert.equal(withCall.output_text, 'готово');
    assert.deepEqual(withCall.output[1], { id: 'fc_call_1', type: 'function_call', status: 'completed', call_id: 'call_1', name: 'read_file', arguments: '{}' });
    assert.equal(withCall.usage.input_tokens, 40);
    assert.equal(withCall.usage.output_tokens, 12);
    const capped = fromChatCompletion({ id: 'c2', choices: [{ message: { content: 'обрезано' }, finish_reason: 'length' }] }, { model: 'mock-model' });
    assert.equal(capped.status, 'incomplete');
    assert.deepEqual(capped.incomplete_details, { reason: 'max_output_tokens' });
    assert.equal(capped.model, 'mock-model');
});

test('createChatStreamReducer folds chunks into a Responses-shaped answer', () => {
    const events = [];
    const reducer = createChatStreamReducer({ emit: (event) => events.push(event), model: 'mock-model' });
    for (const chunk of [
        { choices: [{ delta: { role: 'assistant', content: 'при' } }] },
        { choices: [{ delta: { content: 'вет' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'read_file', arguments: '{"a"' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } },
        { type: '__done' },
    ]) reducer.handle(chunk);
    assert.equal(reducer.response.status, 'completed');
    assert.equal(reducer.partialText(), 'привет');
    assert.equal(reducer.response.output[1].arguments, '{"a":1}');
    assert.equal(reducer.response.usage.input_tokens, 3);
    assert.deepEqual(events.map((event) => event.type).slice(0, 6), [
        'response.created', 'message.start', 'text.delta', 'text.delta', 'tool.call.start', 'tool.args.delta',
    ]);
});

test('responsesRouteUnsupported tells a missing route apart from a missing model', () => {
    assert.equal(responsesRouteUnsupported({ status: 404, message: 'Unrecognized request URL (POST: /v1/responses)' }), true);
    assert.equal(responsesRouteUnsupported({ status: 405, message: 'method not allowed' }), true);
    assert.equal(responsesRouteUnsupported({ status: 501, message: 'not implemented' }), true);
    assert.equal(responsesRouteUnsupported({ status: 400, message: 'the /responses endpoint is not supported here' }), true);
    assert.equal(responsesRouteUnsupported({ status: 404, apiCode: 'model_not_found', message: 'The model gpt-9 does not exist' }), false);
    assert.equal(responsesRouteUnsupported({ status: 400, message: 'max_output_tokens must be positive' }), false);
    assert.equal(responsesRouteUnsupported({ status: 500, message: 'boom' }), false);
});

test('stripRejectedFields drops the field the host named and keeps the output cap', () => {
    const { body, removed } = stripRejectedFields(
        { model: 'm', messages: [], max_completion_tokens: 32, stream_options: { include_usage: true }, reasoning_effort: 'low' },
        { status: 400, message: 'Extra fields not supported: max_completion_tokens, reasoning_effort' },
    );
    assert.deepEqual(removed, ['reasoning_effort', 'max_completion_tokens']);
    assert.equal(body.max_tokens, 32);
    assert.ok(!('reasoning_effort' in body));
    assert.deepEqual(stripRejectedFields({ model: 'm' }, { status: 400, message: 'bad messages' }).removed, []);
});

test('servesRoute keeps a chat-only backend in the responses chain', () => {
    const supports = { responses: false, chat: true };
    assert.equal(supportsRoute(supports, 'responses'), false);
    assert.equal(servesRoute(supports, 'responses'), true);
    assert.equal(servesRoute({ responses: false, chat: false }, 'responses'), false);
    assert.equal(servesRoute(null, 'responses'), true);
});

test('a host without /v1/responses is served through /v1/chat/completions once and remembered', async () => {
    const api = client();
    const events = [];
    const first = await api.responses.create({ model: 'mock-model', input: 'привет', stream: true }, { onEvent: (event) => events.push(event) });
    assert.equal(api.transport, 'chat');
    assert.equal(first.status, 'completed');
    assert.equal(first.output_text, 'ok');
    assert.equal(first.output[0].type, 'message');
    assert.equal(first.usage.input_tokens, 40);
    assert.equal(events.filter((event) => event.type === 'text.delta').map((event) => event.text).join(''), 'ok');
    assert.ok(events.some((event) => event.type === 'warning' && /chat\/completions/.test(event.message)));

    const second = await api.responses.create({ model: 'mock-model', input: 'ещё' }, {});
    assert.equal(second.output_text, 'ok');
    assert.equal(responsePosts().length, 1, 'the refused route is not retried on later turns');
    assert.equal(chatPosts().length, 2);
    assert.deepEqual(chatPosts()[1].body.messages, [{ role: 'user', content: 'ещё' }]);
    assert.ok(!('store' in chatPosts()[0].body) && !('previous_response_id' in chatPosts()[0].body));
    api.close();
});

test('chat.enabled: false keeps the missing route a hard error', async () => {
    const api = client({ enabled: false });
    await assert.rejects(() => api.responses.create({ model: 'mock-model', input: 'привет' }), (error) => {
        assert.equal(error.status, 404);
        assert.equal(error.code, 'HTTP_ERROR');
        return true;
    });
    assert.equal(chatPosts().length, 0);
    api.close();
});

test('chat.force starts on the chat route without a rejected Responses request', async () => {
    const api = client({ force: true });
    assert.equal(api.transport, 'chat', 'a forced client is on the chat transport before the first call');
    const result = await api.responses.create({ model: 'mock-model', input: 'привет' });
    assert.equal(result.output_text, 'ok');
    assert.equal(responsePosts().length, 0, 'the host is not probed with a request it cannot serve');
    assert.equal(chatPosts().length, 1);
    assert.ok(api.chat.isFallback);
    api.close();
});

test('a chat-only backend stays in the responses chain and is forced onto the chat transport', async () => {
    const config = {
        apiKey: 'sk-test', model: 'mock-model',
        backends: [{ baseURL: server.baseURL, apiKey: 'k', body: { useWalletBalance: true }, supports: { responses: false, chat: true } }],
    };
    const channels = completionChannelList(config, {});
    assert.equal(channels.length, 2, 'the host is not dropped for missing /v1/responses');
    assert.deepEqual(channels[1].supports, { responses: false, chat: true });
    assert.deepEqual(channels[1].body, { useWalletBalance: true }, 'the channel carries the host body fields too');

    const declared = { ...config, baseURL: server.baseURL, apiKey: 'sk-test' };
    declared.backends = [{ ...config.backends[0], apiKey: 'sk-test' }];
    const api = createFallbackClient(declared, { env: {}, create: createClient });
    const result = await api.responses.create({ model: 'mock-model', input: 'привет' });
    assert.equal(result.output_text, 'ok');
    assert.equal(api.transport, 'chat', 'the host that answered is on the chat transport');
    assert.ok(api.chat.isFallback);
    assert.equal(responsePosts().length, 0, 'the chat-only host is not probed with /v1/responses');
    assert.equal(chatPosts().length, 1);
    // The gateway flag belongs to the body, and a boolean stays a boolean on the wire.
    assert.equal(chatPosts()[0].body.useWalletBalance, true);
    api.close();
});

test('servesRoute and chatOptionsFor decide which transport a host gets', () => {
    assert.deepEqual(
        chatOptionsFor({ chat: { enabled: true, streamUsage: false } }, { responses: false, chat: true }),
        { enabled: true, force: true, streamUsage: false },
    );
    assert.deepEqual(chatOptionsFor({ chat: { enabled: true } }, { chat: true }), { enabled: true },
        'a host with both routes is not forced');
    assert.deepEqual(chatOptionsFor({ chat: { enabled: false } }, { responses: false, chat: true }), { enabled: false },
        'disabled chat stays disabled');
});

test('a chat host names the Responses-only tools it cannot carry', async () => {
    assert.deepEqual(
        droppedTools([{ type: 'function', name: 'read_file' }, { type: 'web_search' }, { type: 'mcp', server_label: 'figma' }, { type: 'mcp' }]),
        ['web_search', 'figma', 'mcp'],
    );
    const api = client({ force: true });
    const events = [];
    const onEvent = (event) => events.push(event);
    await api.responses.create({ model: 'mock-model', input: 'привет', tools: [{ type: 'mcp', server_label: 'figma' }] }, { onEvent });
    assert.equal(events.filter((event) => event.type === 'warning' && /figma/.test(event.message)).length, 1);
    await api.responses.create({ model: 'mock-model', input: 'ещё', tools: [{ type: 'mcp', server_label: 'figma' }] }, { onEvent });
    assert.equal(events.filter((event) => event.type === 'warning' && /figma/.test(event.message)).length, 1,
        'one warning per client, not one per turn');
    api.close();
});

test('a request the chat route cannot fully carry goes without those tools and says so once', async () => {
    const api = client({ force: true });
    const events = [];
    const onEvent = (event) => events.push(event);
    const tools = [{ type: 'function', name: 'read_file', parameters: { type: 'object' } }, { type: 'web_search' }];
    const result = await api.responses.create({ model: 'mock-model', input: 'привет', tools }, { onEvent });
    assert.equal(result.output_text, 'ok');
    assert.deepEqual(chatPosts()[0].body.tools.map((tool) => tool.function.name), ['read_file']);
    const warns = () => events.filter((event) => event.type === 'warning' && /web_search/.test(event.message));
    assert.equal(warns().length, 1, 'the lost capability is named once');
    await api.responses.create({ model: 'mock-model', input: 'ещё', tools }, { onEvent });
    assert.equal(warns().length, 1, 'one notice per client, not one per turn');
    api.close();
});

test('chat.strict keeps a request on the Responses route instead of dropping what it asked for', async () => {
    const api = client({ strict: true });
    await assert.rejects(
        () => api.responses.create({ model: 'mock-model', input: 'привет', tools: [{ type: 'web_search' }] }),
        (error) => {
            assert.equal(error.code, 'ROUTE_UNSUPPORTED');
            assert.equal(error.status, 404, 'a refused route advances the fallback chain');
            assert.match(error.message, /web_search/);
            assert.equal(providerDown(error), true, 'the next backend gets the request with the tool intact');
            return true;
        },
    );
    assert.equal(chatPosts().length, 0, 'no request leaves without the capability it asked for');

    const forced = client({ force: true, strict: true });
    await assert.rejects(
        () => forced.responses.create({ model: 'mock-model', input: 'привет', tools: [{ type: 'image_generation' }] }),
        (error) => {
            assert.equal(error.code, 'CHAT_CAPABILITY_MISSING');
            assert.match(error.message, /image_generation/);
            return true;
        },
    );

    const calm = client({ strict: true });
    const result = await calm.responses.create({
        model: 'mock-model', input: 'привет',
        tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object' } }],
    });
    assert.equal(result.output_text, 'ok', 'a portable request still moves to the chat transport');
    assert.equal(chatPosts().length, 1);
    api.close(); forced.close(); calm.close();
});

test('chatGaps counts only what the chat route cannot carry', () => {
    assert.deepEqual(chatGaps({ tools: [{ type: 'web_search' }, { type: 'image_generation' }] }), ['web_search', 'image_generation']);
    assert.deepEqual(chatGaps({ tools: [{ type: 'mcp', server_label: 'figma' }, { type: 'function', name: 'read_file' }] }), [],
        'an mcp server never stops a request');
    assert.deepEqual(chatGaps({ background: true }), ['background']);
    assert.deepEqual(chatGaps({ input: 'привет' }), []);
    // A gateway reasoning mode has no chat spelling: the loss is named, not silent.
    assert.deepEqual(chatGaps({ reasoning: { effort: 'low', mode: 'pro' } }), ['reasoning.mode']);
    assert.deepEqual(chatGaps({ reasoning: { effort: 'low', mode: 'off' } }), [], 'off sends no field, so nothing is lost');
    const modeBody = toChatBody({ model: 'm', input: 'привет', reasoning: { effort: 'low', mode: 'pro' } });
    assert.equal(modeBody.reasoning_effort, 'low');
    assert.ok(!('reasoning' in modeBody) && !('reasoning_mode' in modeBody), 'the mode itself never reaches the chat route');
});

test('a field the gateway refuses is dropped and the same request goes again', async () => {
    chatScript = (body, index) => (index === 0 && body.stream_options
        ? { httpStatus: 400, httpBody: { error: { message: 'Extra fields not supported: stream_options', type: 'invalid_request_error' } } }
        : { content: 'без usage' });
    const api = client();
    const events = [];
    const response = await api.responses.create({ model: 'mock-model', input: 'привет', stream: true }, { onEvent: (event) => events.push(event) });
    assert.equal(response.output_text, 'без usage');
    const posts = chatPosts();
    assert.equal(posts.length, 2);
    assert.ok(posts[0].body.stream_options);
    assert.ok(!('stream_options' in posts[1].body));
    assert.ok(events.some((event) => event.type === 'warning' && /stream_options/.test(event.message)));
    api.close();
});

test('responses-only routes say why they cannot answer on the chat transport', async () => {
    const api = client();
    await api.responses.create({ model: 'mock-model', input: 'привет' });
    await assert.rejects(() => api.responses.inputTokens({ model: 'mock-model', input: 'x' }), (error) => {
        assert.equal(error.code, 'ROUTE_UNAVAILABLE');
        assert.equal(error.status, 404);
        return true;
    });
    await assert.rejects(() => api.responses.compact({ model: 'mock-model', input: 'x' }), /Responses API/);
    await assert.rejects(() => api.responses.create({ model: 'mock-model', input: 'x', previous_response_id: 'resp_1' }), (error) => {
        assert.equal(error.code, 'CHAT_STATE_UNSUPPORTED');
        return true;
    });
    api.close();
});

test('runTurn completes a tool round-trip over the chat transport', async () => {
    await writeFile(path.join(root, 'a.txt'), 'содержимое файла\n', 'utf8');
    chatScript = (body, index) => {
        if (index === 0) return { toolCalls: [{ id: 'call_1', name: 'read_file', arguments: { path: 'a.txt' } }] };
        const toolTurn = body.messages.find((message) => message.role === 'tool');
        assert.equal(toolTurn.tool_call_id, 'call_1');
        assert.match(toolTurn.content, /содержимое файла/);
        assert.ok(body.messages.some((message) => message.role === 'assistant' && Array.isArray(message.tool_calls)));
        return { content: 'файл прочитан' };
    };
    const config = structuredClone({ ...defaults, model: 'mock-model', home: root, baseURL: server.baseURL, image: { ...defaults.image, outputDir: root } });
    const session = createSession({ store: false, model: 'mock-model' });
    session.addUserMessage(buildUserMessage({ text: 'прочитай a.txt' }));
    const ledger = createLedger({ prices: {} });
    const toolset = createToolset({ root, config, names: ['read_file'], approvalLevel: 'all' });
    const api = client();
    const events = [];
    const result = await runTurn({ client: api, config, session, ledger, toolset, emit: (event) => events.push(event) });
    assert.equal(result.status, 'completed', result.error?.message);
    assert.equal(result.turns, 2);
    assert.equal(result.text, 'файл прочитан');
    assert.equal(ledger.snapshot().requests, 2);
    assert.ok(ledger.snapshot().input > 0, 'streamed usage reaches the ledger');
    assert.ok(events.some((event) => event.type === 'tool.exec.done' && event.name === 'read_file' && event.ok));
    assert.ok(session.toJSON().items.some((item) => item.type === 'function_call' && item.call_id === 'call_1'));
    api.close();
});

test('config accepts the chat section and the chat route switch', async () => {
    const config = await loadConfig({
        env: { OPENAI_API_KEY: 'sk-test', AI_AGENT_HOME: root, WALLET_TOKEN: 'wt-1' },
        overrides: {
            chat: { enabled: false },
            backends: [{
                baseUrl: 'https://gw.example/v1',
                apiKey: 'k',
                body: { useWalletBalance: true, walletToken: '{{env:WALLET_TOKEN}}' },
                supports: { responses: false, chat: true },
            }],
        },
        ensureHome: false, cwd: root,
    });
    assert.equal(config.chat.enabled, false);
    assert.equal(config.chat.streamUsage, true);
    assert.deepEqual(config.backends[0].supports, { responses: false, chat: true });
    // A body flag keeps its JSON type, an env reference inside it is expanded, and a token-shaped
    // value of it is hidden from anything that prints the config.
    assert.deepEqual(config.backends[0].body, { useWalletBalance: true, walletToken: 'wt-1' });
    assert.equal(redactConfig(config).backends[0].body.walletToken, '…');
    assert.equal(redactConfig(config).backends[0].body.useWalletBalance, true);
    await assert.rejects(() => loadConfig({
        env: { OPENAI_API_KEY: 'sk-test', AI_AGENT_HOME: root }, overrides: { chat: { enabled: 'yes' } }, ensureHome: false, cwd: root,
    }), /chat\.enabled: true \| false/);
    await assert.rejects(() => loadConfig({
        env: { OPENAI_API_KEY: 'sk-test', AI_AGENT_HOME: root },
        overrides: { backends: [{ baseUrl: 'https://gw.example/v1', apiKey: 'k', supports: { chatapi: 'x' } }] },
        ensureHome: false, cwd: root,
    }), /supports\.chat/);
    await assert.rejects(() => loadConfig({
        env: { OPENAI_API_KEY: 'sk-test', AI_AGENT_HOME: root },
        overrides: { backends: [{ baseUrl: 'https://gw.example/v1', apiKey: 'k', body: 'useWalletBalance' }] },
        ensureHome: false, cwd: root,
    }), /body должен быть объектом/);
});
