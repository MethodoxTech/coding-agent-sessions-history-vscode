# Coding Agent Sessions History

Browse, search, bookmark, resume and export local Claude Code and Codex conversations in VS Code. Based on Methodox's Claude Code Sessions History, with the same browser and local-only design. No telemetry or account connection.

## Getting started

Download `coding-agent-sessions-history-0.1.0.vsix` from [GitHub Releases](https://github.com/MethodoxTech/coding-agent-sessions-history-vscode/releases/latest) and install it with **Extensions: Install from VSIX**, then open **Coding Agent Sessions: Open Session Browser** from the command palette or use the activity bar.

Choose **Both agents**, **Claude Code**, or **Codex** in the browser dropdown. The tree toolbar also offers **Select Agent**. This selection applies to the session list, search, statistics and date-range exports, and persists in settings. Agent badges identify each session.

## Local data and settings

- `codingAgentSessions.codexHome`: explicit Codex home; otherwise `CODEX_HOME`, then `~/.codex`.
- Codex transcripts: `sessions/**/*.jsonl` and `archived_sessions/**/*.jsonl`. The full rollout transcripts are used, not the prompt-only `history.jsonl`.
- `codingAgentSessions.codexResumeCommand`: defaults to `codex resume {sessionId}`.
- `codingAgentSessions.claudeHome`: explicit Claude home; otherwise `CLAUDE_CONFIG_DIR`, then `~/.claude`. Reads `projects/*/*.jsonl`.
- `codingAgentSessions.resumeCommand`: defaults to `claude --resume {sessionId}`.
- `codingAgentSessions.agentFilter`: `both`, `claude`, or `codex`.
- Settings also control grouping, automatic refresh, page size, tool output length, and visibility of thinking/tool calls.

The extension reads transcripts without modifying them. Its cache and bookmarks use its own VS Code storage. Separate command, view and configuration identifiers allow all three history extensions to coexist. New variants do not register a default keyboard shortcut, avoiding conflict with the original extension.

## Features

Search session titles or full messages, inspect tool inputs/results, view recorded reasoning summaries, bookmark sessions, group by date/project, inspect statistics, open raw transcripts, export Markdown or date ranges, and resume in a terminal in the recorded working directory. Deep search follows the same message indexes as the viewer.

## Format support and limits

Codex support was checked against local rollout files. It reads `session_meta`, `turn_context`, `response_item`, token-count events and compaction markers; supports function/custom tool calls and results; and avoids duplicate event messages. Event-only message records are supported as a fallback. Unknown records and incomplete JSON lines are skipped. Encrypted reasoning is not decoded. Injected environment/AGENTS setup messages are excluded from prompts. Tool results are displayed as text; Codex-specific artifact cards and edited-file statistics are not yet inferred. Codex storage is an internal format and may evolve.

Only locally available transcripts are shown; this does not fetch cloud history. Archived sessions are included in browsing; whether an archived session can resume depends on the installed Codex client. Large uncached histories can take time to index.

[Official OpenAI configuration documentation](https://learn.chatgpt.com/docs/config-file/config-advanced) describes Codex home configuration.

## Development

```sh
npm ci
npm test
npx @vscode/vsce package --no-dependencies
```

Press F5 to launch an Extension Development Host. Source tests run with Node and require no agent account. CI runs on Windows, Linux and macOS. MIT license; publisher `methodox`.
