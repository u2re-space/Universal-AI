# Choiceable completion models implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tab completion picks from one server catalog, defaults to `gpt-6-luna`, and the VS Code setting sends that choice on every ghost-text request.

**Architecture:** `src/complete/models.js` is the only catalog. Config load and `prepareCompletionRequest` both resolve through it. The row's wire model, reasoning effort, and output cap build the Responses body. The VS Code extension duplicates the choice ids in a setting enum and sends `model` on the completion frame, which overrides `completion.model` for that request.

**Tech Stack:** Node.js 26 ESM, `node:test` in Universal-AI, Mocha via `@vscode/test-cli` in the VS Code extension. No new dependencies.

## Global Constraints

- The catalog applies only to editor completion. Agent, chat, and run model selection stay unchanged.
- Do not load the model list from the proxy.
- The only new editor control is the VS Code setting enum `vext.agent.completion.model`.
- Gemini and DeepSeek stay selectable. They are labeled expensive and are not the default.
- A completion is one request. Do not request `reasoning.encrypted_content` and do not send it back.
- Resolution trims and matches a choice id or alias exactly. Matching is case-sensitive. Unknown or empty returns null.
- `defaults.completion.model` is `gpt-6-luna`.
- Config rejection text is `completion.model: gpt-6-luna | anthropic/claude-haiku-5-5 | qwen/qwen3.8-omni-flash | qwen/qwen3.8-flash | z-ai/glm-5.3-flash | x-ai/grok-4.7 | gemini-3.8-flash | deepseek/deepseek-v4.1-flash`.
- A non-empty unknown `request.model` is `CompletionError` 400, code `BAD_MODEL`, and does not call the provider. The message is that same `completion.model:` list.
- The Responses `model` is the row's wire model, not the alias.
- A row with an effort uses a non-empty `request.effort`, otherwise the row's effort. `completion.effort` does not replace a row effort. An effort outside `REASONING_EFFORTS` is rejected. Grok clamps `none` to `low`.
- A row marked omit never sends `reasoning`, even when `request.effort` or `completion.effort` names one.
- `request.maxOutputTokens` is used when the request includes it, within 16..4096. Otherwise the row cap is used. `completion.maxOutputTokens` does not replace a row cap.
- The rest of the body stays `store: false`, `stream: false`, no tools, and no `include` list.
- `text.verbosity: low` is sent only for the GPT-6 family, so only the Luna wire model sends it.
- An absent or unrecognized editor setting is `gpt-6-luna`.

---

## File structure

- Create `src/complete/models.js` — catalog rows and `resolveCompletionModel`.
- Create `test/completion-models.test.js` — resolver tests.
- Modify `src/core/config-defaults.js` — default model `gpt-6-luna`.
- Modify `src/core/config.js` — reject an unknown `completion.model`.
- Modify `src/complete/complete.js` — resolve the row and build the body from it.
- Modify `test/complete.test.js` — default Luna body, aliases, Grok, DeepSeek, and `BAD_MODEL`.
- Modify `C:\Projects\VSCodeExtension\package.json` — setting enum.
- Modify `C:\Projects\VSCodeExtension\src\agent\settings.mjs` — read the setting.
- Modify `C:\Projects\VSCodeExtension\src\agent\protocol.mjs` — put `model` on the completion frame.
- Modify `C:\Projects\VSCodeExtension\src\agent\complete.mjs` — pass the setting into the request.
- Modify `C:\Projects\VSCodeExtension\test\agent.test.js` — setting, frame, and provider tests.

### Task 1: Catalog resolver

Pure lookup. No config and no HTTP yet.

**Files:**
- Create: `src/complete/models.js`
- Test: `test/completion-models.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `COMPLETION_MODELS` (frozen array of `{ choice, aliases, wire, reasoning, maxOutputTokens, clampNone }`), `COMPLETION_MODEL_CHOICES` (frozen array of choice strings), `resolveCompletionModel(value) -> row | null`. `reasoning` is `'none'`, `'low'`, or `null`. `clampNone` is true only for Grok.

- [ ] **Step 1: Write the failing test**

Create `test/completion-models.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPLETION_MODEL_CHOICES, resolveCompletionModel } from '../src/complete/models.js';

test('completion choices are the catalog ids', () => {
    assert.deepEqual(COMPLETION_MODEL_CHOICES, [
        'gpt-6-luna',
        'anthropic/claude-haiku-5-5',
        'qwen/qwen3.8-omni-flash',
        'qwen/qwen3.8-flash',
        'z-ai/glm-5.3-flash',
        'x-ai/grok-4.7',
        'gemini-3.8-flash',
        'deepseek/deepseek-v4.1-flash',
    ]);
});

test('aliases resolve to the same row and the wire model', () => {
    const luna = resolveCompletionModel('gpt-6-luna');
    assert.equal(resolveCompletionModel(' openai/gpt-6-luna ').wire, luna.wire);
    assert.equal(luna.wire, 'gpt-6-luna');
    assert.equal(luna.reasoning, 'none');
    assert.equal(luna.maxOutputTokens, 160);
    const qwen = resolveCompletionModel('qwen3.8-flash');
    assert.equal(qwen.choice, 'qwen/qwen3.8-flash');
    assert.equal(qwen.wire, 'qwen/qwen3.8-flash');
    assert.equal(qwen.reasoning, null);
    assert.equal(qwen.maxOutputTokens, 160);
});

test('grok clamps none and deepseek keeps effort none', () => {
    const grok = resolveCompletionModel('x-ai/grok-4.7');
    assert.equal(grok.wire, 'x-ai/grok-4.7');
    assert.equal(grok.reasoning, 'low');
    assert.equal(grok.maxOutputTokens, 512);
    assert.equal(grok.clampNone, true);
    const deepseek = resolveCompletionModel('deepseek/deepseek-v4.1-flash');
    assert.equal(deepseek.reasoning, 'none');
    assert.equal(deepseek.maxOutputTokens, 160);
    assert.equal(deepseek.clampNone, false);
});

test('unknown, empty, and differently cased names do not resolve', () => {
    assert.equal(resolveCompletionModel('nope'), null);
    assert.equal(resolveCompletionModel(''), null);
    assert.equal(resolveCompletionModel('   '), null);
    assert.equal(resolveCompletionModel('GPT-6-LUNA'), null);
    assert.equal(resolveCompletionModel(null), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/completion-models.test.js`

Expected: FAIL because `src/complete/models.js` does not exist.

- [ ] **Step 3: Write the catalog**

Create `src/complete/models.js`:

```javascript
/**
 * @file src/complete/models.js
 * @module complete/models
 * @purpose Catalog of editor completion models. Config and requests resolve through this list.
 * @usedBy core/config, complete/complete, test/completion-models.test.js
 * @exports COMPLETION_MODELS, COMPLETION_MODEL_CHOICES, resolveCompletionModel
 * @ai.tags complete
 * @ai.hint pure
 * @changed 2026-10-16 Choiceable tab-completion models. Default is gpt-6-luna.
 */

/** @type {readonly { choice: string, aliases: readonly string[], wire: string, reasoning: 'none'|'low'|null, maxOutputTokens: number, clampNone: boolean }[]} */
export const COMPLETION_MODELS = Object.freeze([
    { choice: 'gpt-6-luna', aliases: Object.freeze(['openai/gpt-6-luna']), wire: 'gpt-6-luna', reasoning: 'none', maxOutputTokens: 160, clampNone: false },
    { choice: 'anthropic/claude-haiku-5-5', aliases: Object.freeze([]), wire: 'anthropic/claude-haiku-5-5', reasoning: null, maxOutputTokens: 160, clampNone: false },
    { choice: 'qwen/qwen3.8-omni-flash', aliases: Object.freeze([]), wire: 'qwen/qwen3.8-omni-flash', reasoning: null, maxOutputTokens: 160, clampNone: false },
    { choice: 'qwen/qwen3.8-flash', aliases: Object.freeze(['qwen3.8-flash']), wire: 'qwen/qwen3.8-flash', reasoning: null, maxOutputTokens: 160, clampNone: false },
    { choice: 'z-ai/glm-5.3-flash', aliases: Object.freeze([]), wire: 'z-ai/glm-5.3-flash', reasoning: null, maxOutputTokens: 160, clampNone: false },
    { choice: 'x-ai/grok-4.7', aliases: Object.freeze([]), wire: 'x-ai/grok-4.7', reasoning: 'low', maxOutputTokens: 512, clampNone: true },
    { choice: 'gemini-3.8-flash', aliases: Object.freeze([]), wire: 'gemini-3.8-flash', reasoning: null, maxOutputTokens: 160, clampNone: false },
    { choice: 'deepseek/deepseek-v4.1-flash', aliases: Object.freeze([]), wire: 'deepseek/deepseek-v4.1-flash', reasoning: 'none', maxOutputTokens: 160, clampNone: false },
]);

/** Choice ids, in catalog order. */
export const COMPLETION_MODEL_CHOICES = Object.freeze(COMPLETION_MODELS.map((row) => row.choice));

/**
 * Resolve a choice id or alias. Empty and unknown values return null.
 * @param {unknown} value
 * @returns {{ choice: string, aliases: readonly string[], wire: string, reasoning: 'none'|'low'|null, maxOutputTokens: number, clampNone: boolean }|null}
 * @exports
 * @ai.hint pure
 */
export function resolveCompletionModel(value) {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name) return null;
    return COMPLETION_MODELS.find((row) => row.choice === name || row.aliases.includes(name)) ?? null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/completion-models.test.js`

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/complete/models.js test/completion-models.test.js
git commit -m "Add the editor completion model catalog"
```

### Task 2: Config and completion requests use the catalog

**Files:**
- Modify: `src/core/config-defaults.js` (completion.model)
- Modify: `src/core/config.js` (completion.model validation)
- Modify: `src/complete/complete.js` (`prepareCompletionRequest`, `buildCompletionBody`)
- Test: `test/complete.test.js`

**Interfaces:**
- Consumes: `resolveCompletionModel`, `COMPLETION_MODEL_CHOICES` from `src/complete/models.js`
- Produces: `prepareCompletionRequest` puts the wire model on `model`, the resolved effort or `null` on `effort`, and the row or request cap on `maxOutputTokens`. `buildCompletionBody` sends `reasoning` only when `effort` is a non-empty string. `loadConfig` rejects an unknown `completion.model`.

- [ ] **Step 1: Write the failing tests**

In `test/complete.test.js`, import `loadConfig` from `../src/core/config.js` next to the existing `defaults` import.

Replace the script and result assertions in `completeCode calls the fast model at low effort and returns the insertion` so they expect Luna, including verbosity:

```javascript
script = (body) => {
    assert.equal(body.model, 'gpt-6-luna');
    assert.equal(body.reasoning.effort, 'none');
    assert.equal(body.stream, false);
    assert.equal(body.store, false);
    assert.equal(body.tools, undefined);
    assert.equal(body.include, undefined);
    assert.equal(body.text.verbosity, 'low');
    assert.equal(body.max_output_tokens, 160);
    assert.match(body.input, /const a = \|/);
    assert.equal(body.input.includes('SECRET_BASE64'), false);
    return { text: '```js\n1;\n```' };
};
```

and `assert.equal(result.model, 'gpt-6-luna');`. Delete the commented `gpt-6-luna` lines in that test.

In `HTTP completion requires the token and returns the insertion`, replace the model assertion with `assert.equal(body.model, 'gpt-6-luna');` and delete the commented line.

In `ai complete --json prints the insertion from stdin`, expect `body.model` `gpt-6-luna`, `body.reasoning.effort` `'none'`, and `result.model` `gpt-6-luna`. Delete the commented lines.

Add these tests after the fast-model test:

```javascript
test('an alias is sent as the wire model and an explicit output cap is kept', async () => {
    script = (body) => {
        assert.equal(body.model, 'gpt-6-luna');
        assert.equal(body.max_output_tokens, 200);
        return { text: 'n' };
    };
    const http = client();
    try {
        const result = await completeCode({
            client: http,
            config: config(),
            request: { content: 'const n = |', model: 'openai/gpt-6-luna', maxOutputTokens: 200 },
        });
        assert.equal(result.model, 'gpt-6-luna');
        assert.equal(result.text, 'n');
    } finally { http.close(); }
});

test('qwen omits reasoning even when the request names an effort', async () => {
    script = (body) => {
        assert.equal(body.model, 'qwen/qwen3.8-flash');
        assert.equal(body.reasoning, undefined);
        assert.equal(body.text, undefined);
        assert.equal(body.max_output_tokens, 160);
        return { text: '1' };
    };
    const http = client();
    try {
        const next = config();
        next.completion = { ...next.completion, effort: 'high' };
        await completeCode({
            client: http, config: next,
            request: { content: 'const n = |', model: 'qwen3.8-flash', effort: 'high' },
        });
    } finally { http.close(); }
});

test('grok uses low effort and 512 tokens even when config asks for none and 80', async () => {
    script = (body) => {
        assert.equal(body.model, 'x-ai/grok-4.7');
        assert.equal(body.reasoning.effort, 'low');
        assert.equal(body.max_output_tokens, 512);
        assert.equal(body.include, undefined);
        return { text: '1' };
    };
    const http = client();
    try {
        const next = config();
        next.completion = { ...next.completion, effort: 'none', maxOutputTokens: 80 };
        await completeCode({
            client: http, config: next,
            request: { content: 'const n = |', model: 'x-ai/grok-4.7', effort: 'none' },
        });
    } finally { http.close(); }
});

test('deepseek completion sends effort none and 160 tokens', async () => {
    script = (body) => {
        assert.equal(body.model, 'deepseek/deepseek-v4.1-flash');
        assert.equal(body.reasoning.effort, 'none');
        assert.equal(body.max_output_tokens, 160);
        assert.equal(body.text, undefined);
        return { text: '1' };
    };
    const http = client();
    try {
        await completeCode({
            client: http, config: config(),
            request: { content: 'const n = |', model: 'deepseek/deepseek-v4.1-flash' },
        });
    } finally { http.close(); }
});

test('an unknown completion model does not call the provider', async () => {
    let calls = 0;
    script = () => { calls += 1; return { text: 'x' }; };
    const http = client();
    try {
        await assert.rejects(
            () => completeCode({ client: http, config: config(), request: { content: 'const n = |', model: 'nope' } }),
            (error) => error instanceof CompletionError && error.code === 'BAD_MODEL' && /gpt-6-luna/.test(error.message),
        );
        assert.equal(calls, 0);
    } finally { http.close(); }
});

test('the default completion model is gpt-6-luna and an unknown config model is rejected', async () => {
    assert.equal(defaults.completion.model, 'gpt-6-luna');
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-complete-config-'));
    try {
        await assert.rejects(
            () => loadConfig({ env: { AI_AGENT_HOME: home }, ensureHome: false, overrides: { completion: { model: 'nope' } } }),
            /completion\.model: gpt-6-luna \| anthropic\/claude-haiku-5-5 \|/,
        );
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-timeout=60000 --test-name-pattern "fast model|alias is sent|qwen omits|grok uses|deepseek completion|unknown completion model|default completion model" test/complete.test.js`

Expected: FAIL. The fast-model test still sees `deepseek/deepseek-v4.1-flash`. The new tests fail because Grok is not clamped and unknown models are sent to the mock.

- [ ] **Step 3: Use the catalog**

In `src/core/config-defaults.js`, replace the completion model and the sentence that says to set `completion.effort` to low:

```javascript
     * A fast model at effort none so a ghost text can arrive before the next key.
     * The model must be a completion catalog choice. Each choice sets its own
     * effort and output cap. completion.effort does not replace a choice that
     * already has an effort.
```

```javascript
    completion: {
        model: 'gpt-6-luna',
        effort: 'none',
```

Delete the commented `//model: 'gpt-6-luna'` line and the DeepSeek model line.

In `src/core/config.js`, import `COMPLETION_MODEL_CHOICES` and `resolveCompletionModel` from `../complete/models.js`. Replace the string check:

```javascript
    if (typeof c.completion.model !== 'string' || !resolveCompletionModel(c.completion.model)) {
        fail(`completion.model: ${COMPLETION_MODEL_CHOICES.join(' | ')}`);
    }
```

In `src/complete/complete.js`, replace the `isReasoningModel` import with `resolveCompletionModel` and `COMPLETION_MODEL_CHOICES` from `./models.js`. Keep `supportsVerbosity` and `REASONING_EFFORTS`.

Replace the effort, model, and max-output lines in `prepareCompletionRequest` with:

```javascript
    const namedModel = typeof request.model === 'string' ? request.model.trim() : '';
    const row = resolveCompletionModel(namedModel || limits.model);
    if (!row) throw new CompletionError(`completion.model: ${COMPLETION_MODEL_CHOICES.join(' | ')}`, { status: 400, code: 'BAD_MODEL' });
    const namedEffort = typeof request.effort === 'string' ? request.effort.trim() : '';
    if (namedEffort && !REASONING_EFFORTS.includes(namedEffort)) throw new CompletionError(`effort: ${REASONING_EFFORTS.join(' | ')}`);
    let effort = null;
    if (row.reasoning !== null) {
        effort = namedEffort || row.reasoning;
        if (row.clampNone && effort === 'none') effort = 'low';
    }
    const maxOutputTokens = request.maxOutputTokens == null
        ? row.maxOutputTokens
        : pickInt(request.maxOutputTokens, row.maxOutputTokens, 16, 4096, 'maxOutputTokens');
```

Return `model: row.wire` instead of `model`.

In `buildCompletionBody`, send reasoning only when effort is present:

```javascript
    if (effort) body.reasoning = { effort };
    else if (config.temperature != null) body.temperature = config.temperature;
```

Remove the `isReasoningModel(model)` branch. Leave `supportsVerbosity(model)` as it is.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test --test-timeout=60000 test/completion-models.test.js test/complete.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/config-defaults.js src/core/config.js src/complete/complete.js test/complete.test.js
git commit -m "Resolve tab completion models through the catalog"
```

### Task 3: VS Code setting sends the choice

The extension is `C:\Projects\VSCodeExtension`. It does not import the server catalog. The choice list is copied into the setting enum and the settings reader.

**Files:**
- Modify: `C:\Projects\VSCodeExtension\package.json` (configuration property)
- Modify: `C:\Projects\VSCodeExtension\src\agent\settings.mjs`
- Modify: `C:\Projects\VSCodeExtension\src\agent\protocol.mjs` (`buildBody`, `completionRequest`)
- Modify: `C:\Projects\VSCodeExtension\src\agent\complete.mjs` (`provideInlineCompletionItems`)
- Test: `C:\Projects\VSCodeExtension\test\agent.test.js`

**Interfaces:**
- Consumes: the choice ids from Task 1, in the same order
- Produces: `readAgentSettings(...).completionModel` is one of those ids. `completionRequest({ model })` sets `body.model`. The inline provider passes `settings.completionModel`.

- [ ] **Step 1: Write the failing tests**

In `test/agent.test.js`, import `registerAgentCompletion` from `../src/agent/complete.mjs`.

Add to the small-document completion test:

```javascript
assert.strictEqual(completionRequest({
    id: '1', language: 'javascript', path: 'C:\\a.js', text: 'let a = ', cursor: { line: 0, character: 8 },
    model: 'x-ai/grok-4.7',
}).model, 'x-ai/grok-4.7');
```

In the settings test `reads defaults and spawn inputs`, the map has no completion model. Assert `assert.strictEqual(settings.completionModel, 'gpt-6-luna');`. Add:

```javascript
test('an unrecognized completion model setting falls back to gpt-6-luna', () => {
    const settings = readAgentSettings((key) => (key === 'vext.agent.completion.model' ? 'nope' : undefined));
    assert.strictEqual(settings.completionModel, 'gpt-6-luna');
});
```

In `package.json contributes the agent view, commands, and settings`:

```javascript
const completionModel = pkg.contributes.configuration.properties['vext.agent.completion.model'];
assert.strictEqual(completionModel.default, 'gpt-6-luna');
assert.deepStrictEqual(completionModel.enum, [
    'gpt-6-luna',
    'anthropic/claude-haiku-5-5',
    'qwen/qwen3.8-omni-flash',
    'qwen/qwen3.8-flash',
    'z-ai/glm-5.3-flash',
    'x-ai/grok-4.7',
    'gemini-3.8-flash',
    'deepseek/deepseek-v4.1-flash',
]);
assert.match(completionModel.description, /gemini-3\.8-flash may be expensive/);
assert.match(completionModel.description, /deepseek\/deepseek-v4\.1-flash is expensive/);
```

Add a provider test in the settings suite:

```javascript
test('ghost text sends the selected completion model', async () => {
    let sent = null;
    const client = { request(body) { sent = body; return Promise.resolve('next'); } };
    let provider = null;
    const vscode = {
        languages: {
            registerInlineCompletionItemProvider(_selector, value) {
                provider = value;
                return { dispose() {} };
            },
        },
    };
    registerAgentCompletion(vscode, client, () => ({
        completionEnabled: true, debounceMs: 1000, completionModel: 'x-ai/grok-4.7',
    }));
    const items = await provider.provideInlineCompletionItems(
        { languageId: 'javascript', uri: { scheme: 'untitled' }, getText: () => 'const n = ' },
        { line: 0, character: 10 },
        {},
        { isCancellationRequested: false },
    );
    assert.strictEqual(sent.model, 'x-ai/grok-4.7');
    assert.strictEqual(items.items[0].insertText, 'next');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run from `C:\Projects\VSCodeExtension`: `npm test`

Expected: FAIL. `completionModel` is missing, the package property is missing, and `completionRequest` does not copy `model`.

- [ ] **Step 3: Send the setting**

In `package.json`, after `vext.agent.completion.debounceMs`, add:

```json
"vext.agent.completion.model": {
    "type": "string",
    "enum": [
        "gpt-6-luna",
        "anthropic/claude-haiku-5-5",
        "qwen/qwen3.8-omni-flash",
        "qwen/qwen3.8-flash",
        "z-ai/glm-5.3-flash",
        "x-ai/grok-4.7",
        "gemini-3.8-flash",
        "deepseek/deepseek-v4.1-flash"
    ],
    "default": "gpt-6-luna",
    "description": "Model for ghost-text completion. gemini-3.8-flash may be expensive. deepseek/deepseek-v4.1-flash is expensive."
}
```

In `src/agent/settings.mjs`, add the same ids:

```javascript
const COMPLETION_MODELS = new Set([
    'gpt-6-luna',
    'anthropic/claude-haiku-5-5',
    'qwen/qwen3.8-omni-flash',
    'qwen/qwen3.8-flash',
    'z-ai/glm-5.3-flash',
    'x-ai/grok-4.7',
    'gemini-3.8-flash',
    'deepseek/deepseek-v4.1-flash',
]);
```

Inside `readAgentSettings`, before the return:

```javascript
const modelValue = get('vext.agent.completion.model');
const completionModel = COMPLETION_MODELS.has(modelValue) ? modelValue : 'gpt-6-luna';
```

Add `completionModel` to the returned object.

In `src/agent/protocol.mjs`, add `model` to `buildBody` and copy it when it is a non-empty string:

```javascript
function buildBody({ id, language, path: filePath, content, cursor, model }) {
    const body = {
        type: 'complete',
        id,
        language,
        content,
        cursor: { line: cursor.line, character: cursor.character },
    };
    if (filePath) {
        body.path = filePath;
    }
    if (typeof model === 'string' && model.trim()) {
        body.model = model.trim();
    }
    return body;
}
```

Pass `model` from `completionRequest({ id, language, path: filePath, text, cursor, model })` into both `buildBody` calls (the full-document call and the windowed call).

In `src/agent/complete.mjs`, add `model: settings.completionModel` to the `completionRequest({...})` call.

- [ ] **Step 4: Run the tests to verify they pass**

Run from `C:\Projects\VSCodeExtension`: `npm test`

Expected: PASS. The provider test waits one second for the debounce.

- [ ] **Step 5: Commit**

From `C:\Projects\VSCodeExtension`:

```bash
git add package.json src/agent/settings.mjs src/agent/protocol.mjs src/agent/complete.mjs test/agent.test.js
git commit -m "Choose the ghost-text model from a setting"
```
