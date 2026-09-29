/**
 * Tests for the transcript parsing layer.
 *
 * These cover the modules that never touch the `vscode` API, so they run under
 * plain Node with `npm test` rather than needing an Extension Host.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

import { extractMatchContext, extractUserText, parseSession, scanSessionMeta, simplifyModelName } from "../claude/parser";
import { anyBasename, anyDirname, sessionIdFromPath } from "../claude/paths";
import { sessionToMarkdown } from "../ui/markdownExport";

let workspace: string;

function writeTranscript(name: string, records: unknown[]): string {
	const filePath = path.join(workspace, name);
	fs.writeFileSync(filePath, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
	return filePath;
}

before(() => {
	workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-sessions-test-"));
});

after(() => {
	fs.rmSync(workspace, { recursive: true, force: true });
});

describe("paths", () => {
	it("takes the basename from either separator", () => {
		// Transcripts written on one platform are often read on another, so a
		// Windows path has to resolve correctly on Linux and vice versa.
		assert.equal(anyBasename("C:\\Projects\\app\\notes.md"), "notes.md");
		assert.equal(anyBasename("/home/me/app/notes.md"), "notes.md");
		assert.equal(anyDirname("C:\\Projects\\app\\notes.md"), "C:\\Projects\\app");
	});

	it("derives the session id from the transcript filename on every platform", () => {
		const id = "0fd2adc5-e818-4cfc-b246-cbb6f3104dd2";
		assert.equal(sessionIdFromPath(`C:\\Users\\me\\.claude\\projects\\p\\${id}.jsonl`), id);
		assert.equal(sessionIdFromPath(`/home/me/.claude/projects/p/${id}.jsonl`), id);
	});
});

describe("model names", () => {
	it("shortens current and historical model ids", () => {
		assert.equal(simplifyModelName("claude-opus-5"), "Opus 5");
		assert.equal(simplifyModelName("claude-fable-5-1"), "Fable 5.1");
		assert.equal(simplifyModelName("claude-haiku-4-5-20251001"), "Haiku 4.5");
		assert.equal(simplifyModelName("claude-3-5-sonnet-20241022"), "Sonnet 3.5");
		assert.equal(simplifyModelName("claude-opus-5[1m]"), "Opus 5");
		assert.equal(simplifyModelName("<synthetic>"), "Synthetic");
	});
});

describe("user text", () => {
	it("drops the bookkeeping Claude Code writes as user messages", () => {
		assert.equal(extractUserText("<command-name>/model</command-name>"), "");
		assert.equal(extractUserText("<local-command-stdout>Set model</local-command-stdout>"), "");
		assert.equal(extractUserText("<system-reminder>be nice</system-reminder>"), "");
		assert.equal(extractUserText("Real question"), "Real question");
	});

	it("strips ANSI escapes from captured output", () => {
		assert.equal(extractUserText("Set model to \u001B[1mOpus\u001B[22m"), "Set model to Opus");
	});

	it("keeps only the text blocks a person typed", () => {
		const text = extractUserText([
			{ type: "text", text: "<system-reminder>ignore</system-reminder>" },
			{ type: "text", text: "Do the thing" },
		]);
		assert.equal(text, "Do the thing");
	});
});

describe("match context", () => {
	it("windows around the hit and marks both elisions", () => {
		const haystack = "a".repeat(200) + " needle " + "b".repeat(200);
		const context = extractMatchContext(haystack, "needle", 20);
		assert.ok(context.startsWith("…"), "leading ellipsis");
		assert.ok(context.endsWith("…"), "trailing ellipsis");
		assert.ok(context.includes("needle"));
	});
});

describe("scanSessionMeta", () => {
	it("prefers the model-generated title over the first message", async () => {
		const filePath = writeTranscript("titled.jsonl", [
			{ type: "queue-operation", operation: "enqueue" },
			{
				type: "user",
				timestamp: "2026-09-01T10:00:00.000Z",
				cwd: "C:\\Projects\\App_2025",
				gitBranch: "main",
				version: "2.1.273",
				message: { role: "user", content: [{ type: "text", text: "Fix the build" }] },
			},
			{
				type: "assistant",
				timestamp: "2026-09-01T10:00:05.000Z",
				message: {
					role: "assistant",
					model: "claude-opus-5",
					content: [{ type: "text", text: "On it." }],
					usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 900000 },
				},
			},
			{ type: "ai-title", aiTitle: "Build pipeline repair" },
			{ type: "pr-link", prUrl: "https://github.com/x/y/pull/7", prNumber: 7, prRepository: "x/y" },
			{ type: "file-history-delta", trackingPath: "src\\build.ts" },
		]);

		const meta = await scanSessionMeta(filePath, "C--Projects-App-2025", 1234);
		assert.ok(meta);
		assert.equal(meta.title, "Build pipeline repair");
		assert.equal(meta.titleSource, "ai-title");
		assert.equal(meta.preview, "Fix the build");
		assert.equal(meta.id, "titled");
		assert.equal(meta.messageCount, 2);
		assert.equal(meta.model, "Opus 5");
		assert.equal(meta.gitBranch, "main");
		assert.equal(meta.cliVersion, "2.1.273");
		assert.equal(meta.prLinks.length, 1);
		assert.deepEqual(meta.filesTouched, ["src\\build.ts"]);

		// The cwd recorded in the transcript wins over the encoded folder name,
		// which cannot be decoded losslessly: "App_2025" and "App\2025" encode
		// to exactly the same string.
		assert.equal(meta.projectPath, "C:\\Projects\\App_2025");

		// Cache reads re-report the whole prefix each turn, so they are excluded.
		assert.equal(meta.totalTokens, 15);
	});

	it("keeps one entry per pull request, however often it was recorded", async () => {
		// Claude Code re-writes the pr-link record on every turn after a pull
		// request is opened, so a long session accumulates hundreds of copies
		// of the same few links.
		const records: unknown[] = [
			{
				type: "user",
				timestamp: "2026-09-01T10:00:00.000Z",
				message: { role: "user", content: "Open a pull request" },
			},
			{
				type: "assistant",
				message: { role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "Done." }] },
			},
		];
		for (let i = 0; i < 40; i++) {
			records.push({ type: "pr-link", prUrl: "https://example.com/o/r/pull/8", prNumber: 8, prRepository: "o/r" });
			records.push({ type: "pr-link", prUrl: "https://example.com/o/r/pull/3", prNumber: 3, prRepository: "o/r" });
		}

		const meta = await scanSessionMeta(writeTranscript("prs.jsonl", records), "p", 10);
		assert.ok(meta);
		assert.equal(meta.prLinks.length, 2);
		// Sorted by number, so the header reads in a predictable order.
		assert.deepEqual(
			meta.prLinks.map((pr) => pr.number),
			[3, 8]
		);
	});

	it("falls back to the first real message when no title was generated", async () => {
		const filePath = writeTranscript("untitled.jsonl", [
			{
				type: "user",
				timestamp: "2026-09-01T10:00:00.000Z",
				message: { role: "user", content: "<command-name>/clear</command-name>" },
			},
			{
				type: "user",
				timestamp: "2026-09-01T10:01:00.000Z",
				message: { role: "user", content: "Actually explain this regex" },
			},
			{
				type: "assistant",
				timestamp: "2026-09-01T10:01:02.000Z",
				message: { role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "Sure." }] },
			},
		]);

		const meta = await scanSessionMeta(filePath, "-home-me-app", 10);
		assert.ok(meta);
		assert.equal(meta.titleSource, "first-message");
		assert.equal(meta.title, "Actually explain this regex");
		// The slash command is not something a person typed, so it is not counted.
		assert.equal(meta.userMessageCount, 1);
	});

	it("returns nothing for a transcript with no messages", async () => {
		const filePath = writeTranscript("empty.jsonl", [
			{ type: "queue-operation", operation: "enqueue" },
			{ type: "atis-latch", atis: "v1.abc" },
		]);
		assert.equal(await scanSessionMeta(filePath, "p", 5), undefined);
	});

	it("survives malformed and truncated lines", async () => {
		const filePath = path.join(workspace, "broken.jsonl");
		fs.writeFileSync(
			filePath,
			[
				"not json at all",
				JSON.stringify({
					type: "user",
					timestamp: "2026-09-01T10:00:00.000Z",
					message: { role: "user", content: "Hello" },
				}),
				JSON.stringify({
					type: "assistant",
					message: { role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "Hi" }] },
				}),
				'{"type":"user","message":{"role":"user","content":"trunc', // a session still being written
			].join("\n"),
			"utf8"
		);

		const meta = await scanSessionMeta(filePath, "p", 100);
		assert.ok(meta);
		assert.equal(meta.messageCount, 2);
	});
});

describe("parseSession", () => {
	const transcript = [
		{
			type: "user",
			timestamp: "2026-09-01T10:00:00.000Z",
			message: { role: "user", content: [{ type: "text", text: "Rename the field" }] },
		},
		{
			type: "assistant",
			timestamp: "2026-09-01T10:00:03.000Z",
			message: {
				role: "assistant",
				model: "claude-opus-5",
				content: [
					{ type: "thinking", thinking: "Consider the call sites." },
					{ type: "text", text: "Editing now." },
					{
						type: "tool_use",
						id: "tool_1",
						name: "Edit",
						input: { file_path: "C:\\app\\model.ts", old_string: "a", new_string: "b" },
					},
				],
			},
		},
		{
			type: "user",
			timestamp: "2026-09-01T10:00:04.000Z",
			toolUseResult: {
				filePath: "C:\\app\\model.ts",
				structuredPatch: [
					{ oldStart: 10, oldLines: 1, newStart: 10, newLines: 1, lines: ["-  a: string", "+  b: string"] },
				],
			},
			message: {
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "tool_1", content: "Edited 1 line" }],
			},
		},
		{
			type: "assistant",
			timestamp: "2026-09-01T10:00:09.000Z",
			message: {
				role: "assistant",
				model: "claude-opus-5",
				content: [
					{ type: "tool_use", id: "tool_2", name: "Bash", input: { command: "npm test" } },
				],
			},
		},
		{
			type: "user",
			timestamp: "2026-09-01T10:00:20.000Z",
			toolUseResult: { stdout: "2 passing", stderr: "a warning", interrupted: false },
			message: {
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "tool_2", content: "2 passing", is_error: false }],
			},
		},
		{
			type: "system",
			subtype: "compact_boundary",
			level: "info",
			timestamp: "2026-09-01T10:01:00.000Z",
			content: "Conversation compacted",
			compactMetadata: { trigger: "auto", preTokens: 900000 },
		},
		{
			type: "attachment",
			timestamp: "2026-09-01T10:02:00.000Z",
			attachment: {
				type: "queued_command",
				prompt: [{ type: "text", text: "Also update the docs" }],
			},
		},
	];

	it("pairs tool results with their calls and keeps structured output", async () => {
		const filePath = writeTranscript("full.jsonl", transcript);
		const messages = await parseSession(filePath);

		const assistant = messages.find((message) => message.toolCalls?.[0]?.name === "Edit");
		assert.ok(assistant);
		assert.equal(assistant.thinking, "Consider the call sites.");
		assert.equal(assistant.text, "Editing now.");

		const edit = assistant.toolCalls![0];
		assert.equal(edit.summary, "C:\\app\\model.ts");
		assert.equal(edit.output, "Edited 1 line");
		assert.ok(edit.patch, "structured patch is kept");
		assert.equal(edit.patch![0].lines[1], "+  b: string");

		const bash = messages.flatMap((message) => message.toolCalls || []).find((call) => call.name === "Bash");
		assert.ok(bash);
		assert.equal(bash.summary, "npm test");
		// stdout and stderr come from toolUseResult, which the content block lacks.
		assert.equal(bash.output, "2 passing");
		assert.equal(bash.stderr, "a warning");
	});

	it("does not render tool-result plumbing as messages from you", async () => {
		const filePath = writeTranscript("full2.jsonl", transcript);
		const messages = await parseSession(filePath);
		const userTexts = messages.filter((message) => message.role === "user").map((message) => message.text);
		assert.deepEqual(userTexts, ["Rename the field", "Also update the docs"]);
	});

	it("keeps a prompt that was queued while Claude was busy", async () => {
		const filePath = writeTranscript("full3.jsonl", transcript);
		const messages = await parseSession(filePath);
		const queued = messages.find((message) => message.subtype === "queued");
		assert.ok(queued, "a queued prompt is still something you asked for");
		assert.equal(queued.text, "Also update the docs");
	});

	it("labels a compaction boundary", async () => {
		const filePath = writeTranscript("full4.jsonl", transcript);
		const messages = await parseSession(filePath);
		const system = messages.find((message) => message.role === "system");
		assert.ok(system);
		assert.equal(system.text, "Context compacted (auto)");
	});

	it("truncates long tool output at the configured limit", async () => {
		const filePath = writeTranscript("long.jsonl", [
			{
				type: "assistant",
				message: {
					role: "assistant",
					model: "claude-opus-5",
					content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "ls" } }],
				},
			},
			{
				type: "user",
				toolUseResult: { stdout: "x".repeat(5000) },
				message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x" }] },
			},
		]);

		const messages = await parseSession(filePath, { toolOutputLimit: 100 });
		const call = messages[0].toolCalls![0];
		assert.equal(call.output!.length, 100);
		assert.equal(call.outputTruncated, true);
	});

	it("recovers the published URL for an artifact", async () => {
		const filePath = writeTranscript("artifact.jsonl", [
			{
				type: "assistant",
				message: {
					role: "assistant",
					model: "claude-opus-5",
					content: [
						{
							type: "tool_use",
							id: "a1",
							name: "Artifact",
							input: { file_path: "/tmp/page.html", description: "Sales dashboard", favicon: "x" },
						},
					],
				},
			},
			{
				type: "user",
				message: {
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "a1",
							content: "Published to https://claude.ai/public/artifacts/abc123.",
						},
					],
				},
			},
		]);

		const messages = await parseSession(filePath);
		const artifact = messages[0].toolCalls![0].artifact;
		assert.ok(artifact);
		assert.equal(artifact.kind, "artifact");
		assert.equal(artifact.description, "Sales dashboard");
		// The trailing full stop belongs to the sentence, not the URL.
		assert.equal(artifact.url, "https://claude.ai/public/artifacts/abc123");
	});
});

describe("markdown export", () => {
	it("writes a document that stands on its own", async () => {
		const filePath = writeTranscript("export.jsonl", [
			{
				type: "user",
				timestamp: "2026-09-01T10:00:00.000Z",
				cwd: "/home/me/app",
				message: { role: "user", content: "Explain the cache" },
			},
			{
				type: "assistant",
				timestamp: "2026-09-01T10:00:02.000Z",
				message: {
					role: "assistant",
					model: "claude-opus-5",
					content: [
						{ type: "thinking", thinking: "Keep it short." },
						{ type: "text", text: "It is keyed on mtime." },
					],
				},
			},
			{ type: "ai-title", aiTitle: "Cache explanation" },
		]);

		const meta = await scanSessionMeta(filePath, "-home-me-app", 500);
		const messages = await parseSession(filePath);
		const markdown = sessionToMarkdown(messages, meta);

		assert.ok(markdown.startsWith("## Cache explanation"));
		assert.ok(markdown.includes("- Project: `/home/me/app`"));
		assert.ok(markdown.includes("### You"));
		assert.ok(markdown.includes("### Claude — Opus 5"));
		assert.ok(markdown.includes("<summary>Thinking</summary>"));
		assert.ok(markdown.includes("It is keyed on mtime."));
	});
});
