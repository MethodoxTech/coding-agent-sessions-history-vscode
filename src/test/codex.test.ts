import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { parseCodexSession, scanCodexMeta, scanCodexRollout } from "../codex/parser";
import { SessionStore } from "../store/sessionStore";
import { sessionToMarkdown } from "../ui/markdownExport";
import { resolveCodexHome } from "../claude/paths";

const stamp = "2026-09-01T10:00:00.000Z";
const row = (type: string, payload: unknown) => ({ type, timestamp: stamp, payload });
const records = [
	row("session_meta", {
		id: "shared-id",
		cwd: "C:\\Projects\\demo",
		cli_version: "1.0",
		git: { branch: "main" },
	}),
	row("turn_context", { model: "test-model" }),
	row("response_item", {
		type: "message",
		role: "user",
		content: [{ type: "input_text", text: "# AGENTS.md instructions for demo" }],
	}),
	row("event_msg", { type: "user_message", message: "Find the needle" }),
	row("response_item", {
		type: "message",
		role: "user",
		content: [{ type: "input_text", text: "Find the needle" }],
	}),
	row("response_item", {
		type: "function_call",
		call_id: "call-1",
		name: "exec_command",
		arguments: '{"cmd":"needle"}',
	}),
	row("response_item", {
		type: "function_call_output",
		call_id: "call-1",
		output: "output needle and more",
	}),
	row("response_item", {
		type: "custom_tool_call",
		call_id: "call-2",
		name: "apply_patch",
		input: "patch needle",
	}),
	row("response_item", { type: "custom_tool_call_output", call_id: "call-2", output: "done" }),
	row("response_item", {
		type: "reasoning",
		summary: [{ type: "summary_text", text: "Recorded summary" }],
		encrypted_content: "never display",
	}),
	row("response_item", {
		type: "message",
		role: "assistant",
		content: [{ type: "output_text", text: "Found needle" }],
	}),
	row("event_msg", { type: "agent_message", message: "Found needle" }),
	row("event_msg", { type: "token_count", info: { total_token_usage: { total_tokens: 123 } } }),
	row("event_msg", { type: "token_count", info: { total_token_usage: { total_tokens: 123 } } }),
	row("future_record", { whatever: true }),
];
function fixture(rows: unknown[] = records) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-history-"));
	const file = path.join(dir, "rollout.jsonl");
	fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + '\n{"partial":');
	return { dir, file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
test("Codex parses metadata, messages and tool results without duplicate events", async () => {
	const f = fixture();
	try {
		const meta = await scanCodexMeta(f.file, "", 100);
		assert.equal(meta?.nativeId, "shared-id");
		assert.equal(meta?.id, "codex:shared-id");
		assert.equal(meta?.provider, "codex");
		assert.equal(meta?.projectName, "demo");
		assert.equal(meta?.userMessageCount, 1);
		assert.equal(meta?.toolCallCount, 2);
		assert.equal(meta?.totalTokens, 123);
		const messages = await parseCodexSession(f.file, { toolOutputLimit: 6 });
		assert.equal(messages.filter((m) => m.text === "Found needle").length, 1);
		assert.equal(messages.filter((m) => m.role === "user").length, 1);
		assert.equal(messages[1].toolCalls?.[0].output, "output");
		assert.equal(messages[1].toolCalls?.[0].outputTruncated, true);
		assert.ok(messages.some((m) => m.thinking === "Recorded summary"));
		assert.ok(!JSON.stringify(messages).includes("never display"));
		const markdown = sessionToMarkdown(messages, meta);
		assert.ok(markdown.includes("### Codex"));
		assert.ok(!markdown.includes("### Claude"));
	} finally {
		f.cleanup();
	}
});
test("event-only rollouts, missing fields, cancellation and sidechain options", async () => {
	const f = fixture([
		row("event_msg", { type: "user_message", message: "hello" }),
		row("event_msg", { type: "agent_message", message: "hi" }),
		row("response_item", null),
	]);
	try {
		assert.deepEqual(
			(await parseCodexSession(f.file)).map((m) => m.text),
			["hello", "hi"],
		);
		const abort = new AbortController();
		abort.abort();
		assert.equal(await scanCodexMeta(f.file, "", 1, { signal: abort.signal }), undefined);
		fs.writeFileSync(
			f.file,
			[row("session_meta", { id: "child", source: { subagent: {} } }), ...records.slice(1)]
				.map((r) => JSON.stringify(r))
				.join("\n"),
		);
		assert.equal((await parseCodexSession(f.file, { includeSidechains: false })).length, 0);
	} finally {
		f.cleanup();
	}
});
test("store discovers active/archived Codex, isolates IDs, filters and searches exact viewer indexes", async () => {
	const f = fixture();
	try {
		const claude = path.join(f.dir, "claude"),
			codex = path.join(f.dir, "codex");
		fs.mkdirSync(path.join(claude, "projects", "demo"), { recursive: true });
		fs.mkdirSync(path.join(codex, "sessions", "2026", "09"), { recursive: true });
		fs.mkdirSync(path.join(codex, "archived_sessions"), { recursive: true });
		fs.copyFileSync(f.file, path.join(codex, "sessions", "2026", "09", "rollout.jsonl"));
		fs.writeFileSync(
			path.join(codex, "archived_sessions", "archived.jsonl"),
			[
				row("session_meta", { id: "archive", cwd: "/demo" }),
				row("event_msg", { type: "user_message", message: "archived" }),
			]
				.map((r) => JSON.stringify(r))
				.join("\n"),
		);
		fs.writeFileSync(
			path.join(claude, "projects", "demo", "shared-id.jsonl"),
			JSON.stringify({
				type: "user",
				cwd: "/demo",
				timestamp: stamp,
				message: { role: "user", content: "Claude needle" },
			}),
		);
		const store = new SessionStore(path.join(f.dir, "cache.json"), claude, codex, "both");
		assert.equal((await store.load()).length, 3);
		assert.equal(new Set(store.sessions.map((s) => s.id)).size, 3);
		const initial = store.load();
		store.configure(claude, codex, "codex");
		await initial;
		assert.equal((await store.load()).length, 2);
		assert.ok(store.sessions.every((s) => s.provider === "codex"));
		const matches = await store.deepSearch("needle", { includeToolCalls: true });
		assert.ok(matches.some((m) => m.role === "tool"));
		for (const hit of matches) {
			const messages = await store.openSession(hit.meta.filePath);
			const m = messages[hit.messageIndex];
			assert.ok(
				m.text.includes("needle") ||
					m.toolCalls?.some((c) => (c.input + " " + c.output).includes("needle")),
			);
		}
		store.configure(claude, codex, "claude");
		assert.equal((await store.load()).length, 1);
		assert.equal(store.computeStats().totalSessions, 1);
		store.configure(claude, codex, "both");
		assert.equal((await store.load()).length, 3);
		const cold = new SessionStore(path.join(f.dir, "cache.json"), claude, codex, "both");
		let parsed = 0;
		await cold.load((p) => (parsed = p.parsed));
		assert.equal(parsed, 0);
		assert.equal(resolveCodexHome(f.dir), f.dir);
	} finally {
		f.cleanup();
	}
});
test("configuration switch during the first scan returns only the final source", async () => {
	const f = fixture();
	try {
		const codex = path.join(f.dir, "codex");
		fs.mkdirSync(path.join(codex, "sessions"), { recursive: true });
		fs.copyFileSync(f.file, path.join(codex, "sessions", "a.jsonl"));
		const store = new SessionStore(
			path.join(f.dir, "cache.json"),
			path.join(f.dir, "missing"),
			codex,
			"both",
		);
		const loading = store.load();
		store.configure(path.join(f.dir, "missing"), codex, "claude");
		assert.deepEqual(await loading, []);
		assert.deepEqual(store.sessions, []);
	} finally {
		f.cleanup();
	}
});
test("a growing rollout resumes where the last scan stopped and matches a full scan", async () => {
	const f = fixture();
	try {
		// Longer than one read chunk, so lines straddle chunk boundaries.
		const big = row("response_item", {
			type: "custom_tool_call_output",
			call_id: "call-3",
			output: "x".repeat(1_500_000) + " exit_code: 2",
		});
		const later = row("response_item", {
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: "Second prompt" }],
		});
		const call = row("response_item", { type: "custom_tool_call", call_id: "call-3", name: "shell" });
		const full = [...records, call, big, later].map((r) => JSON.stringify(r) + "\n").join("");
		// Cut inside the big line: the first scan sees it partially written.
		const cut = full.indexOf("xxxx") + 1000;
		fs.writeFileSync(f.file, full.slice(0, cut));
		const first = await scanCodexRollout(f.file, cut);
		assert.equal(first.meta?.userMessageCount, 1);
		assert.equal(first.meta?.hasErrors, false);
		assert.ok(first.resume.offset > 0 && first.resume.offset < cut);

		fs.writeFileSync(f.file, full);
		const resumed = await scanCodexRollout(f.file, full.length, first.resume);
		const fresh = await scanCodexRollout(f.file, full.length);
		assert.deepEqual(resumed.meta, fresh.meta);
		assert.equal(resumed.resume.offset, full.length);
		assert.equal(fresh.meta?.userMessageCount, 2);
		assert.equal(fresh.meta?.hasErrors, true);
		assert.equal(fresh.meta?.title, "Find the needle");

		// The viewer agrees with the index about the failed tool call.
		const messages = await parseCodexSession(f.file);
		assert.ok(messages.some((m) => m.toolCalls?.some((c) => c.isError)));

		// A file replaced rather than appended to is scanned from the start.
		const replaced = [row("session_meta", { id: "other" }), later]
			.map((r) => JSON.stringify(r) + "\n")
			.join("")
			.padEnd(full.length + 10, " ");
		fs.writeFileSync(f.file, replaced);
		const rescanned = await scanCodexRollout(f.file, replaced.length, resumed.resume);
		assert.equal(rescanned.meta?.nativeId, "other");
		assert.equal(rescanned.meta?.userMessageCount, 1);
	} finally {
		f.cleanup();
	}
});
test("the index matches the full parse when key order differs from Codex's own", async () => {
	const reorder = (r: { type: string; timestamp: string; payload: unknown }) => ({
		payload: r.payload,
		timestamp: r.timestamp,
		type: r.type,
	});
	const f = fixture(records.map(reorder));
	try {
		const meta = await scanCodexMeta(f.file, "", 100);
		assert.equal(meta?.userMessageCount, 1);
		assert.equal(meta?.toolCallCount, 2);
		assert.equal(meta?.messageCount, 5);
		assert.equal(meta?.timestamp, stamp);
		const messages = await parseCodexSession(f.file);
		assert.equal(meta?.messageCount, messages.filter((m) => m.role !== "system").length);
	} finally {
		f.cleanup();
	}
});
test("cached sessions are available before the first scan finishes", async () => {
	const f = fixture();
	try {
		const codex = path.join(f.dir, "codex");
		fs.mkdirSync(path.join(codex, "sessions"), { recursive: true });
		fs.copyFileSync(f.file, path.join(codex, "sessions", "a.jsonl"));
		const cache = path.join(f.dir, "cache.json");
		const missing = path.join(f.dir, "missing");
		await new SessionStore(cache, missing, codex, "both").load();

		const store = new SessionStore(cache, missing, codex, "both");
		assert.equal(store.sessions.length, 1);
		const events: string[] = [];
		store.subscribe((e) => events.push(e.type === "sessions" ? `sessions:${e.final}` : e.type));
		await store.load();
		assert.equal(events[events.length - 1], "sessions:true");
		// Out of scope for the current filter, even though it is cached.
		store.configure(missing, codex, "claude");
		assert.equal(store.sessions.length, 0);
		assert.equal((await store.metaFor(path.join(codex, "sessions", "a.jsonl")))?.nativeId, "shared-id");
	} finally {
		f.cleanup();
	}
});
test("inline images are left out of messages, tool output and search", async () => {
	const image = "data:image/png;base64," + "iVBORw0KGgo".repeat(300_000);
	const f = fixture([
		row("session_meta", { id: "pictures", cwd: "/demo" }),
		row("event_msg", { type: "user_message", message: "What is on screen?", images: [image] }),
		row("response_item", {
			type: "message",
			role: "user",
			content: [
				{ type: "input_text", text: "What is on screen?" },
				{ type: "input_image", image_url: image },
			],
		}),
		row("response_item", { type: "custom_tool_call", call_id: "shot", name: "exec", input: "screenshot" }),
		row("response_item", {
			type: "custom_tool_call_output",
			call_id: "shot",
			output: [
				{ type: "input_text", text: "Script completed" },
				{ type: "input_image", image_url: image },
			],
		}),
		row("response_item", {
			type: "message",
			role: "assistant",
			content: [{ type: "output_text", text: "A login form" }],
		}),
	]);
	try {
		const meta = await scanCodexMeta(f.file, "", 100);
		assert.equal(meta?.userMessageCount, 1);
		assert.equal(meta?.toolCallCount, 1);
		assert.equal(meta?.title, "What is on screen?");
		assert.ok(!meta?.preview.includes("base64"));

		const messages = await parseCodexSession(f.file, { toolOutputLimit: 100000 });
		assert.ok(!JSON.stringify(messages).includes("iVBORw0KGgo"));
		assert.equal(messages[0].text, "What is on screen?\n[Image]");
		assert.equal(messages[1].toolCalls?.[0].output, "Script completed\n[Image]");
	} finally {
		f.cleanup();
	}
});
