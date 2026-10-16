# Choiceable completion models

Tab completion uses one server catalog. `completion.model` and a completion request both name a row in that catalog. The VS Code setting sends the editor's choice on every ghost-text request, and that request wins over the config. The default is `gpt-6-luna`.

## Non-goals

- Loading the model list from the proxy.
- A completion UI other than the VS Code setting enum.
- Blocking Gemini or DeepSeek. They stay selectable and are labeled expensive.
- Changing agent, chat, or run model selection. The catalog applies only to editor completion.
- Multi-turn Grok state. A completion is one request. Encrypted reasoning is not requested and is not sent back.

## Catalog

`src/complete/models.js` exports the rows and `resolveCompletionModel(value)`. Resolution trims the string and matches the choice id or an alias exactly. Matching is case-sensitive. An unknown or empty string returns null.

| Choice | Alias | Wire model | Reasoning | Output cap |
|---|---|---|---|---|
| `gpt-6-luna` | `openai/gpt-6-luna` | `gpt-6-luna` | `none` | 160 |
| `anthropic/claude-haiku-5-5` | | `anthropic/claude-haiku-5-5` | omit | 160 |
| `qwen/qwen3.8-omni-flash` | | `qwen/qwen3.8-omni-flash` | omit | 160 |
| `qwen/qwen3.8-flash` | `qwen3.8-flash` | `qwen/qwen3.8-flash` | omit | 160 |
| `z-ai/glm-5.3-flash` | | `z-ai/glm-5.3-flash` | omit | 160 |
| `x-ai/grok-4.7` | | `x-ai/grok-4.7` | `low` | 512 |
| `gemini-3.8-flash` | | `gemini-3.8-flash` | omit | 160 |
| `deepseek/deepseek-v4.1-flash` | | `deepseek/deepseek-v4.1-flash` | `none` | 160 |

`defaults.completion.model` is `gpt-6-luna`. Config load rejects a `completion.model` that does not resolve. The error lists the choice ids in the same form as the other enum failures: `completion.model: gpt-6-luna | anthropic/claude-haiku-5-5 | ...`.

Grok 4.7 cannot disable thinking, and its default effort is high. Effort `low` and a 512-token cap keep the insertion from being consumed by reasoning. A request that asks this row for effort `none` is clamped to `low`. DeepSeek V4.1 Flash thinks unless effort is `none`; that row sends `none` and keeps the 160-token cap. Rows marked omit do not include a `reasoning` field, even when the request or `completion.effort` names one. `text.verbosity: low` stays limited to the GPT-6 family, so only the Luna row sends it.

## Request

`prepareCompletionRequest` resolves the model before it builds the Responses body.

1. A non-empty `request.model` is resolved. A value that does not resolve is `CompletionError` 400, code `BAD_MODEL`, and the message lists the choice ids. The provider is not called.
2. Otherwise `config.completion.model` is resolved. Config load already rejected an unknown value.
3. The Responses `model` is the row's wire model, not the alias that was typed.

Effort and the output cap:

- A row with an effort uses `request.effort` when that field is a non-empty string, otherwise the row's effort. An effort outside `REASONING_EFFORTS` is still rejected. `completion.effort` does not replace a row effort. Grok clamps `none` to `low`.
- A row marked omit never sends `reasoning`.
- `request.maxOutputTokens` is used when the request includes it, within the existing 16..4096 check. Otherwise the row's cap is used. `completion.maxOutputTokens` does not replace a row cap.

The rest of the body is unchanged: no tools, `store: false`, `stream: false`, and no `include` list.

## Editor

In the VS Code extension (`package.json`, `src/agent/settings.mjs`, `src/agent/protocol.mjs`, `src/agent/complete.mjs`), `vext.agent.completion.model` is a string enum of the choice column. The default is `gpt-6-luna`. The description for `gemini-3.8-flash` says it may be expensive. The description for `deepseek/deepseek-v4.1-flash` says it is expensive. An absent or unrecognized setting is treated as `gpt-6-luna`.

`completionRequest` adds `model` from that setting. The extension sends it on every ghost-text request, so the editor choice overrides `completion.model` for that request.

## Tests

Server tests:

- `gpt-6-luna` and `openai/gpt-6-luna` resolve to the Luna row, and the body uses wire model `gpt-6-luna`, effort `none`, and 160 output tokens.
- `qwen3.8-flash` resolves to wire model `qwen/qwen3.8-flash` and the body has no `reasoning` field.
- `x-ai/grok-4.7` sends effort `low` and 512 output tokens. Effort `none` on that row still sends `low`.
- `deepseek/deepseek-v4.1-flash` sends effort `none` and 160 output tokens.
- An unknown `completion.model` fails config validation.
- An unknown request `model` fails with `BAD_MODEL` and does not call the provider.
- The default config model is `gpt-6-luna`.

Extension tests:

- The setting enum defaults to `gpt-6-luna` and lists every choice id.
- A completion request includes the selected model.
- An unrecognized setting still sends `gpt-6-luna`.
