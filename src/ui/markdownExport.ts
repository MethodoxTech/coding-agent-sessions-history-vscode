/**
 * Rendering a parsed session back out as Markdown.
 *
 * The output is meant to be readable on its own — in a notes app, a PR
 * description, an issue — so tool calls and thinking are folded into
 * `<details>` blocks rather than dropped, and file edits keep their diffs.
 */

import { anyBasename } from "../claude/paths";
import { ConversationMessage, PatchHunk, SessionMeta, ToolCall } from "../claude/types";

export interface ExportOptions {
	includeThinking?: boolean;
	includeToolCalls?: boolean;
}

export function sessionToMarkdown(
	messages: ConversationMessage[],
	meta: SessionMeta | undefined,
	options: ExportOptions = {},
): string {
	const { includeThinking = true, includeToolCalls = true } = options;
	const out: string[] = [];

	if (meta) {
		out.push(`## ${meta.title || meta.preview.slice(0, 100) || "Session"}`, "");
		const facts: string[] = [
			`- Date: ${formatDate(meta.timestamp)}`,
			`- Project: \`${meta.projectPath}\``,
			`- Session: \`${meta.nativeId || meta.id}\``,
			`- Messages: ${meta.messageCount}`,
		];
		if (meta.models.length > 0) {
			facts.splice(1, 0, `- Model: ${meta.models.join(", ")}`);
		}
		if (meta.gitBranch) {
			facts.push(`- Branch: \`${meta.gitBranch}\``);
		}
		if (meta.cliVersion) {
			facts.push(
				`- ${meta.provider === "codex" ? "Codex" : "Claude Code"}: ${meta.cliVersion}`,
			);
		}
		for (const pr of meta.prLinks) {
			facts.push(`- Pull request: ${pr.url}`);
		}
		out.push(...facts, "");
	}

	for (const message of messages) {
		if (message.role === "system") {
			out.push(`> ${message.text}`, "");
			continue;
		}

		const heading =
			message.role === "user"
				? "### You"
				: meta?.provider === "codex"
					? "### Codex"
					: "### Claude";
		const model = message.model ? ` — ${message.model}` : "";
		const queued = message.subtype === "queued" ? " (queued)" : "";
		const sidechain = message.sidechain ? " (subagent)" : "";
		out.push(`${heading}${model}${queued}${sidechain}`, "");

		if (message.thinking && includeThinking) {
			out.push(
				"<details>",
				"<summary>Thinking</summary>",
				"",
				message.thinking,
				"",
				"</details>",
				"",
			);
		}

		if (message.text) {
			out.push(message.text, "");
		}

		if (message.toolCalls && includeToolCalls) {
			for (const call of message.toolCalls) {
				out.push(...toolCallToMarkdown(call));
			}
		}
	}

	return (
		out
			.join("\n")
			.replace(/\n{3,}/g, "\n\n")
			.trimEnd() + "\n"
	);
}

function toolCallToMarkdown(call: ToolCall): string[] {
	const out: string[] = [];

	if (call.artifact) {
		const artifact = call.artifact;
		const label = artifact.description || artifact.fileName;
		const noun = artifact.kind === "artifact" ? "Artifact" : "File";
		out.push(
			artifact.url ? `> ${noun}: [${label}](${artifact.url})` : `> ${noun}: ${label}`,
			"",
		);
		return out;
	}

	const summary = call.summary ? ` — ${truncate(call.summary, 90)}` : "";
	out.push("<details>", `<summary>${call.name}${summary}</summary>`, "");
	out.push("```json", call.input, "```", "");

	if (call.patch && call.patch.length > 0) {
		const file = call.patchFile ? anyBasename(call.patchFile) : "diff";
		out.push(`Changes to \`${file}\`:`, "", "```diff", patchToText(call.patch), "```", "");
	}

	if (call.output) {
		out.push(
			"Output:",
			"",
			"```",
			call.output + (call.outputTruncated ? "\n… truncated" : ""),
			"```",
			"",
		);
	}
	if (call.stderr) {
		out.push("Stderr:", "", "```", call.stderr, "```", "");
	}
	if (call.isError) {
		out.push("> This call returned an error.", "");
	}

	out.push("</details>", "");
	return out;
}

export function patchToText(hunks: PatchHunk[]): string {
	return hunks
		.map((hunk) => {
			const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
			return [header, ...hunk.lines].join("\n");
		})
		.join("\n");
}

/** Combine several sessions into one document, newest first. */
export function sessionsToMarkdown(
	entries: { meta: SessionMeta; messages: ConversationMessage[] }[],
	heading: string,
	options: ExportOptions = {},
): string {
	const out: string[] = [`# ${heading}`, "", `${entries.length} sessions.`, "", "---", ""];
	for (const entry of entries) {
		out.push(sessionToMarkdown(entry.messages, entry.meta, options), "", "---", "");
	}
	return (
		out
			.join("\n")
			.replace(/\n{3,}/g, "\n\n")
			.trimEnd() + "\n"
	);
}

function truncate(text: string, limit: number): string {
	return text.length > limit ? text.slice(0, limit - 1) + "…" : text;
}

function formatDate(timestamp: string): string {
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) {
		return timestamp;
	}
	return date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}
