# MCP sources and project generation

**Date:** 2026-10-15
**Status:** approved for implementation (user asked to skip further questions and implement)

## Goal

`ai` can take user-defined MCP servers as tool and resource sources, and can generate a landing page, a static site, a Node backend, or a small app from a prompt plus mockups, templates, and design examples.

The default visual-match target is 87%. The tool records that target and does not compute a score. The default platform is Chrome 157 Beta with experimental flags and origin trials off.

## Branch state

`feat/desktop-roles` (`a5ddc42`) and `feat/map-and-serve` (`8f9ca53`) are ancestors of `main` at `7f7f74c` (`shell commands`), which matches `origin/main`. The worktree was clean. This feature starts from that `main` and merges back with `--no-ff` so existing commits stay in history.

## Decisions

- Node.js built-in modules only. No new npm dependencies.
- One new command for generation: `ai gen <landing|site|backend|app>`. It builds a contract, writes `.ai/generation.json`, then runs the existing team (`ai run`).
- One new command for sources: `ai mcp list|add|remove|probe`. `add` and `remove` edit `~/.ai-agent/config.json`. They do not start the server. `probe`, `run`, and `gen` do.
- MCP transport is stdio with `Content-Length` framing (LSP-style). HTTP is rejected. Protocol versions accepted from the server: `2025-06-18`, `2025-03-26`, `2024-11-05`. The client requests `2025-06-18`.
- A failed MCP server is a warning. Other servers and the local tools still run.
- Exposed tool name: `mcp_<serverId>_<toolName>`, sanitized to `[A-Za-z0-9_-]`, at most 64 characters.
- MCP tool arguments are one strict string field, `arguments_json`, because server schemas are not strict. The handler parses that JSON object and calls `tools/call`.
- MCP tool calls use approval category `network` (same gate as `fetch_url`). `mcp_list_resources` and `mcp_read_resource` are category `read`.
- The worker receives every MCP extra. The collector and the reviewer receive only the read extras.
- `tools.mcp` defaults to true. With an empty server list that is a no-op. `--tools` and `--no-tools` can turn it off.
- Fidelity and creativity are integers 0..100. Defaults: fidelity 87, creativity 20. They are independent. Fidelity is how closely visible structure, text, palette, and order must follow the references. Creativity is how much may be added that is not in the references.
- `measured` stays `null` and `method` stays `unmeasured`. There is no pixel diff and no invented percentage. The model is told not to claim one.
- Platform id `chrome-157-beta` is the only profile. It freezes the 2026-10-15 snapshot: 16 features enabled by default in Chrome 157, origin trials off, flags off. ECMAScript edition is 2026, and only the syntax Chrome 157 runs without a flag is allowed. Features already default-on in earlier Chrome versions stay allowed. CSS `random()` is withheld because it is not in that default-enabled list.
- Sources stored on the profile: [CSS-Tricks](https://css-tricks.com/), [Chrome status roadmap](https://chromestatus.com/roadmap), [ECMA-262](https://262.ecma-international.org/), [caniuse](https://caniuse.com/). Those pages also describe experiments. Experiments are not allowed.
- Generated projects use no npm packages and no bundler. Backends and apps are Node.js 26 ESM on `node:http`, bound to `127.0.0.1`, port `PORT` or 3000.
- `test-gen/landing.png` is the landing fixture. Tests assert the brief, the contract, and that a mocked `ai gen landing` sends the image and the 87% target. They do not call a live model and do not score the picture.

## Units

| Unit | Responsibility |
| --- | --- |
| `src/generate/platform.js` | Frozen Chrome 157 Beta profile and the instruction text |
| `src/generate/fidelity.js` | Percent checks and the unmeasured contract |
| `src/generate/brief.js` | Task text, operator instructions, manifest, write `.ai/generation.json` |
| `src/mcp/frame.js` | Content-Length encode and parse |
| `src/mcp/client.js` | One stdio JSON-RPC session |
| `src/mcp/servers.js` | Normalize a server entry and build a tool name |
| `src/mcp/session.js` | Connect every enabled server and build tool extras |
| `src/commands/gen.js` | `ai gen` |
| `src/commands/mcp.js` | `ai mcp` |

`createToolset` gains an `extras` array so MCP tools go through the existing approval path. `runTeam` and the single-agent run open the session and close it when the run ends.
