/**
 * Tests for filtering an open session down to the messages you want.
 */

import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import { filterMessages, isMessageScope, parseQuery } from "../claude/filter";
import { ConversationMessage, ToolCall } from "../claude/types";

function message(partial: Partial<ConversationMessage>): ConversationMessage {
	return {
		index: 0,
		role: "assistant",
		text: "",
		...partial,
	};
}

function tool(partial: Partial<ToolCall>): ToolCall {
	return { id: "t", name: "Bash", summary: "", input: "{}", ...partial };
}

const conversation: ConversationMessage[] = [
	message({ index: 0, role: "user", text: "Please rename the cache field" }),
	message({
		index: 1,
		role: "assistant",
		text: "Renaming it now.",
		thinking: "The call sites matter here.",
		model: "Opus 5",
	}),
	message({
		index: 2,
		role: "assistant",
		text: "",
		toolCalls: [tool({ name: "Bash", summary: "npm test", output: "2 passing" })],
	}),
	message({
		index: 3,
		role: "assistant",
		text: "",
		toolCalls: [
			tool({
				name: "Edit",
				summary: "src/store/cache.ts",
				patchFile: "src/store/cache.ts",
				patch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new"] }],
			}),
		],
	}),
	message({ index: 4, role: "system", text: "Context compacted (auto)" }),
	message({
		index: 5,
		role: "assistant",
		text: "",
		toolCalls: [
			tool({
				name: "Artifact",
				summary: "Report",
				artifact: {
					filePath: "/tmp/report.html",
					fileName: "report.html",
					kind: "artifact",
					exists: true,
				},
			}),
		],
	}),
];

describe("parseQuery", () => {
	it("splits on whitespace and lower-cases", () => {
		assert.deepEqual(parseQuery("Cache Field"), ["cache", "field"]);
	});

	it("keeps a quoted phrase together", () => {
		assert.deepEqual(parseQuery('"rename the cache" now'), ["rename the cache", "now"]);
	});

	it("ignores empty input", () => {
		assert.deepEqual(parseQuery("   "), []);
	});
});

describe("scopes", () => {
	it("recognises only the scopes it defines", () => {
		assert.equal(isMessageScope("tools"), true);
		assert.equal(isMessageScope("everything"), false);
		assert.equal(isMessageScope(7), false);
	});

	it("returns the whole session for an empty filter", () => {
		const { messages } = filterMessages(conversation, "", "all");
		assert.equal(messages.length, conversation.length);
	});

	it("narrows to your own messages", () => {
		const { messages } = filterMessages(conversation, "", "user");
		assert.deepEqual(
			messages.map((m) => m.index),
			[0]
		);
	});

	it("separates what Claude said from what it ran", () => {
		// An assistant turn carrying only tool calls belongs to the tools
		// scope, not to what Claude actually said.
		assert.deepEqual(
			filterMessages(conversation, "", "assistant").messages.map((m) => m.index),
			[1]
		);
		assert.deepEqual(
			filterMessages(conversation, "", "tools").messages.map((m) => m.index),
			[2, 3, 5]
		);
	});

	it("narrows to messages that changed something", () => {
		// An edit with a patch and a produced artifact, but not a shell command.
		assert.deepEqual(
			filterMessages(conversation, "", "changes").messages.map((m) => m.index),
			[3, 5]
		);
	});
});

describe("filterMessages", () => {
	it("requires every term to match, in any order", () => {
		assert.deepEqual(
			filterMessages(conversation, "rename cache", "all").messages.map((m) => m.index),
			[0]
		);
		assert.deepEqual(
			filterMessages(conversation, "cache rename", "all").messages.map((m) => m.index),
			[0]
		);
		assert.deepEqual(filterMessages(conversation, "rename missing", "all").messages.length, 0);
	});

	it("is case insensitive", () => {
		assert.equal(filterMessages(conversation, "RENAME", "all").messages.length, 1);
	});

	it("searches thinking, tool calls, diffs and artifacts", () => {
		assert.deepEqual(
			filterMessages(conversation, "call sites", "all").messages.map((m) => m.index),
			[1]
		);
		assert.deepEqual(
			filterMessages(conversation, "npm test", "all").messages.map((m) => m.index),
			[2]
		);
		assert.deepEqual(
			filterMessages(conversation, "2 passing", "all").messages.map((m) => m.index),
			[2]
		);
		assert.deepEqual(
			filterMessages(conversation, "cache.ts", "all").messages.map((m) => m.index),
			[3]
		);
		assert.deepEqual(
			filterMessages(conversation, "report.html", "all").messages.map((m) => m.index),
			[5]
		);
	});

	it("combines a scope with a query", () => {
		assert.deepEqual(
			filterMessages(conversation, "cache", "changes").messages.map((m) => m.index),
			[3]
		);
		assert.equal(filterMessages(conversation, "cache", "user").messages.length, 1);
		assert.equal(filterMessages(conversation, "npm", "user").messages.length, 0);
	});

	it("reports where each match sits in the unfiltered session", () => {
		const { indices } = filterMessages(conversation, "", "tools");
		assert.deepEqual(indices, [2, 3, 5]);
	});

	it("keeps matches in conversation order", () => {
		const { messages } = filterMessages(conversation, "", "all");
		const order = messages.map((m) => m.index);
		assert.deepEqual(order, [...order].sort((a, b) => a - b));
	});
});
