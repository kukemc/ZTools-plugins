# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Kuke AI Agent — a **ZTools** plugin that renders a chat UI and lets an OpenAI-compatible model drive local tools (shell, file ops, web fetch, Tavily search). Declared in `plugin.json` (`main: dist/index.html`, `preload: preload.js`). Dev host loads `http://localhost:5173` (see `plugin.json#development.main`).

## Commands

- `npm run dev` — Vite dev server on port 5173. ZTools points the plugin at this URL in development.
- `npm run build` — `vue-tsc -b && vite build`. Always typechecks before emitting.
- `npm test` — `node --test tests/*.test.cjs`. The Tavily test is skipped unless `TAVILY_API_KEY` is in the env.
- Single test: `node --test tests/local-tools.test.cjs` (file-level; no per-name filter configured).
- `npm run pack` — runs `scripts/pack.js` then PowerShell `Compress-Archive` to produce `kuke-ai-agent.zip`. Requires PowerShell and writable `pack/`; runs `npm install` inside `pack/`.

Vite is configured with `base: './'` — relative asset paths are **required** by the ZTools host; do not change this.

## Architecture

The codebase is effectively **two files** plus glue:

### `preload.js` — Node/CommonJS surface exposed as `window.localTools`

Loaded by the ZTools host in a Node context. Must stay valid CommonJS (no TS, no ESM imports). It exposes:

- `chat(config, messages, tools, handlers, { requestId })` — wraps `openai.chat.completions.create`. Streams via `handlers.onEvent({ type: 'content_delta' | 'tool_calls_delta' | 'finish', ... })` when an `onEvent` handler is passed; otherwise runs non-streaming. Returns `{ success, data: assistantMessage }` or `{ success: false, aborted?, error }`.
- `cancelChat(requestId)` — aborts the in-flight chat via an `AbortController` tracked in `activeChatControllers`.
- `getModels(config)` — `openai.models.list()`.
- Tool implementations (paired 1:1 with `toolCatalog` in App.vue): `BashTool`, `BashOutputTool`, `KillShellTool`, `WebFetchTool`, `WebSearchTool`, `FileReadTool`, `FileEditTool`, `FileWriteTool`, `FileDeleteTool`, `NotebookEditTool`, `GlobTool`, `GrepTool`, `TodoWriteTool`. Legacy aliases (`readFile`, `writeFile`, `execCommand`, `readDir`) still exist for backward compatibility — keep them when renaming.
- `listBackgroundBashes()` — renderer-only helper used by the header chip to poll `activeBashProcesses` state.
- `getDebugLogs(limit)` / `clearDebugLogs()` — read the in-memory ring buffer (`MAX_DEBUG_LOGS = 800`).

Safety invariants baked into preload:
- `WebFetchTool` blocks `localhost`, `127.*`, `10.*`, `192.168.*`, `172.16–31.*`, `169.254.*`, `*.local`, `::1`. Runs an optional secondary LLM call for `prompt` summarization using the `llmConfig` supplied by the dispatcher.
- `FileEditTool` refuses a single-replace when `old_string`/`search` matches more than once unless `replaceAll: true`. Accepts `oldText/newText`, `old_string/new_string`, and legacy `search/replace` aliases.
- `BashTool` synchronous mode caps timeout (default 120s, max 600s) and stdout buffer at 8 MB. Background mode (`runInBackground: true`) spawns with `child_process.spawn`, returns a `bashId`, and tracks output in an 8 MB ring buffer; read via `BashOutputTool`, terminate via `KillShellTool`.
- `shouldTreatAsTextFile` skips binary extensions and files > 2 MB during grep/glob.
- The OpenAI client is created with `dangerouslyAllowBrowser: true` because preload runs in the plugin renderer process.

### `src/App.vue` — the whole UI (~5000 lines, deliberately monolithic)

Holds the tool catalog, session/provider/settings state, streaming renderer, and the tool-call loop.

- **Tool catalog** (`toolCatalog`) is the source of truth for tool schemas, labels, categories (`environment` / `file` / `task`), and legacy-name mapping shown to the user. When adding/renaming a tool you must touch **both** `toolCatalog` (App.vue) and the implementation in preload.js — they are paired by `name`.
- **Tool-call loop** lives in `sendMessage`. Each round: call `chat` → if `tool_calls` present, dispatch each through `executeLocalTool`, push `{ role: 'tool', tool_call_id, name, content }` back, repeat. Bounded by `appSettings.maxToolCallRounds` when `enableToolRoundLimit` is on (default off; safety cap 24). If `stopWhenToolError` is on, the loop halts on the first failed tool.
- **`executeLocalTool` dispatcher** — normalizes arguments (camelCase + snake_case aliases via `getArgumentByAliases`), triggers snapshot for `FILE_MUTATING_TOOLS` (includes `NotebookEditTool`), runs the safety gate (`decideToolGate`), and then shapes the call for each tool. `WebFetchTool` receives the current provider/model as `llmConfig` so its prompt summarizer can call the user's LLM. `TodoWriteTool` results are piped into the session runtime via `applySessionTodos` so the header drawer stays in sync.
- **Streaming** is opt-in via `appSettings.enableStreamResponse`; `onEvent.content_delta` appends to the current assistant message block, `tool_calls_delta` is emitted but the UI waits for the round to close before rendering tool blocks.
- **Persistence** — everything is in `localStorage`: `kuke_sessions`, `kuke_providers`, `kuke_provider_id`, `kuke_model`, `kuke_system`, `kuke_settings`. No backend. Per-session runtime state (`isLoading`, `activeRequestId`, `stopRequested`, `todos`) is kept separate in memory and not persisted.
- Assistant messages use a `blocks: (TextMessageBlock | ToolMessageBlock)[]` structure; `content` and `toolInvocations` are derived via `syncAssistantMessageState`. When mutating a message, go through `updateMessageById` / `updateToolInvocation` so derived fields stay in sync.
- The header exposes two chips: a Todo drawer (bound to `currentSessionTodos`) and a Background Bash popover (populated by polling `listBackgroundBashes` every 3s through `bashShellsPollTimer`).

## Packaging contract (`scripts/pack.js`)

The zip must contain exactly: `dist/`, `plugin.json`, `preload.js`, `logo.png`, a minimal `package.json` with `type: "commonjs"`, and an installed `node_modules/` holding only production deps. The prod `package.json` is synthesized from the root `package.json`'s `openai` + `@tavily/core` versions — if preload starts `require(...)`-ing a new package, add it to the `dependencies` block in `scripts/pack.js` (not just the root). The `"commonjs"` type is load-bearing: without it preload cannot `require`.

## Tests

`tests/local-tools.test.cjs` loads `preload.js` into a `vm.runInNewContext` sandbox with a fake `window`, because preload assigns to `window.localTools` and would otherwise fail under plain Node. When you change preload's export shape or touch `window.localTools`, re-check this harness.
