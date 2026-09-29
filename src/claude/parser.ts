/**
 * Turning raw transcript records into the session metadata and conversation
 * messages the views render.
 *
 * Two passes exist because they have very different costs. `scanSessionMeta`
 * reads a transcript once and keeps only what a list row needs, so the whole
 * history can be indexed quickly. `parseSession` builds the full message list
 * and is run for one session at a time, on demand.
 */

import { readTranscript, ReadOptions } from "./jsonl";
import { anyBasename, fileExists, projectDisplayName, sessionIdFromPath } from "./paths";
import { decodeProjectDir } from "./paths";
import {
	ApiMessage,
	ContentBlock,
	ConversationMessage,
	FileArtifact,
	PatchHunk,
	SessionMeta,
	TextBlock,
	ThinkingBlock,
	TokenUsage,
	ToolCall,
	ToolResultBlock,
	ToolUseBlock,
	TranscriptRecord,
} from "./types";

// === Synthetic text ===

/**
 * Claude Code wraps a good deal of bookkeeping in user-role messages that
 * nobody typed: slash-command plumbing, IDE state, command output, injected
 * reminders. Showing these as "You" messages is the single most confusing thing
 * a naive transcript reader does, so any text block opening with one of these
 * tags is dropped.
 */
const SYNTHETIC_PREFIXES = [
	"<ide_",
	"<local-command",
	"<command-name",
	"<command-message",
	"<command-args",
	"<command-contents",
	"<system-reminder",
	"<user-prompt-submit-hook",
	"<session-start-hook",
	"<post-tool-use-hook",
	"<bash-input",
	"<bash-stdout",
	"<bash-stderr",
];

function isSyntheticText(text: string): boolean {
	const trimmed = text.trimStart();
	return SYNTHETIC_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/** Strip ANSI escape sequences, which appear in captured command output. */
function stripAnsi(text: string): string {
	// eslint-disable-next-line no-control-regex
	return text.replace(/\[[0-9;]*[A-Za-z]/g, "");
}

/** Text a person actually typed, or "" if this message is pure bookkeeping. */
export function extractUserText(content: ApiMessage["content"]): string {
	if (typeof content === "string") {
		return isSyntheticText(content) ? "" : stripAnsi(content).trim();
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter((block): block is TextBlock => block?.type === "text" && typeof (block as TextBlock).text === "string")
		.map((block) => block.text)
		.filter((text) => !isSyntheticText(text))
		.map(stripAnsi)
		.join("\n")
		.trim();
}

/** Plain text of an assistant message, ignoring thinking and tool calls. */
function extractAssistantText(content: ApiMessage["content"]): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter((block): block is TextBlock => block?.type === "text" && typeof (block as TextBlock).text === "string")
		.map((block) => block.text)
		.join("");
}

// === Models ===

/**
 * Short, human-readable model name.
 *
 * Model ids are not stable in shape — `claude-3-5-sonnet-20241022`,
 * `claude-opus-5`, `claude-fable-5-1` and `claude-opus-5[1m]` have all appeared
 * — so the family name is matched rather than the position of a segment.
 */
export function simplifyModelName(model: string): string {
	if (!model) {
		return "";
	}
	const id = model.toLowerCase();
	if (id === "<synthetic>") {
		return "Synthetic";
	}
	const families: [string, string][] = [
		["opus", "Opus"],
		["sonnet", "Sonnet"],
		["haiku", "Haiku"],
		["fable", "Fable"],
	];

	for (const [needle, label] of families) {
		const at = id.indexOf(needle);
		if (at === -1) {
			continue;
		}

		// Newer ids put the version after the family: claude-opus-5,
		// claude-fable-5-1, claude-haiku-4-5-20251001. The negative lookahead
		// keeps a trailing date stamp from being read as a version number.
		const after = id.slice(at + needle.length).match(/^-(\d{1,2}(?:[-.]\d{1,2})?)(?!\d)/);
		if (after) {
			return `${label} ${after[1].replace("-", ".")}`;
		}

		// Older ids put it before: claude-3-5-sonnet-20241022.
		const before = id.slice(0, at).match(/(\d{1,2}(?:[-.]\d{1,2})?)-$/);
		if (before) {
			return `${label} ${before[1].replace("-", ".")}`;
		}

		return label;
	}

	return model.replace(/^claude-/, "");
}

// === Tool calls ===

/** One-line description of what a tool call is doing, for collapsed headers. */
function summarizeToolInput(name: string, input: Record<string, unknown>): string {
	const str = (key: string): string => {
		const value = input[key];
		return typeof value === "string" ? value : value === undefined ? "" : String(value);
	};

	switch (name) {
		case "Read":
		case "Write":
		case "Edit":
		case "NotebookEdit":
			return str("file_path") || str("notebook_path");
		case "Bash":
		case "PowerShell":
			return collapseWhitespace(str("command"));
		case "Grep":
			return [str("pattern"), str("path"), str("glob")].filter(Boolean).join("  ");
		case "Glob":
			return [str("pattern"), str("path")].filter(Boolean).join("  ");
		case "WebFetch":
			return str("url");
		case "WebSearch":
			return str("query");
		case "Task":
		case "Agent":
			return str("description") || str("subagent_type");
		case "Skill":
			return [str("skill"), str("args")].filter(Boolean).join(" ");
		case "Artifact":
			return str("description") || str("title") || str("file_path") || str("action");
		case "TodoWrite":
			return "Update todo list";
		case "SendMessage":
			return str("to");
		default: {
			const summary = JSON.stringify(input);
			return summary === undefined ? "" : summary;
		}
	}
}

function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function prettyInput(input: Record<string, unknown>): string {
	try {
		return JSON.stringify(input, null, 2);
	} catch {
		return String(input);
	}
}

/** The `tool_result` content block's payload flattened to text. */
function toolResultToText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.map((block) => {
				if (block && typeof block === "object") {
					const typed = block as { type?: string; text?: string };
					if (typeof typed.text === "string") {
						return typed.text;
					}
					if (typed.type === "image") {
						return "[image]";
					}
				}
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}
	if (content === null || content === undefined) {
		return "";
	}
	if (typeof content === "object") {
		try {
			return JSON.stringify(content, null, 2);
		} catch {
			return "";
		}
	}
	return String(content);
}

interface StructuredResult {
	text: string;
	stderr?: string;
	patch?: PatchHunk[];
	patchFile?: string;
}

/**
 * Read Claude Code's `toolUseResult` field, which carries far more than the
 * `tool_result` content block: real stdout and stderr streams for shell calls,
 * and a structured patch for every Edit and Write.
 */
function readStructuredResult(result: unknown): StructuredResult | undefined {
	if (!result || typeof result !== "object") {
		return typeof result === "string" ? { text: result } : undefined;
	}

	const record = result as Record<string, unknown>;
	const parts: string[] = [];
	let stderr: string | undefined;

	if (typeof record.stdout === "string" && record.stdout) {
		parts.push(stripAnsi(record.stdout));
	}
	if (typeof record.stderr === "string" && record.stderr) {
		stderr = stripAnsi(record.stderr);
	}
	if (typeof record.content === "string" && record.content) {
		parts.push(record.content);
	} else if (Array.isArray(record.content)) {
		const flattened = toolResultToText(record.content);
		if (flattened) {
			parts.push(flattened);
		}
	}
	if (Array.isArray(record.filenames)) {
		parts.push(record.filenames.filter((f) => typeof f === "string").join("\n"));
	}
	if (typeof record.interrupted === "boolean" && record.interrupted) {
		parts.push("[interrupted]");
	}

	const patch = readPatch(record.structuredPatch);
	const patchFile =
		typeof record.filePath === "string"
			? record.filePath
			: typeof record.file === "object" && record.file !== null
				? ((record.file as Record<string, unknown>).filePath as string | undefined)
				: undefined;

	if (parts.length === 0 && !patch && !stderr) {
		// An unrecognised shape — show it rather than dropping information.
		const fallback = toolResultToText(record);
		return fallback ? { text: fallback } : undefined;
	}

	const structured: StructuredResult = { text: parts.join("\n").trim() };
	if (stderr) {
		structured.stderr = stderr;
	}
	if (patch) {
		structured.patch = patch;
	}
	if (patchFile) {
		structured.patchFile = patchFile;
	}
	return structured;
}

function readPatch(value: unknown): PatchHunk[] | undefined {
	if (!Array.isArray(value) || value.length === 0) {
		return undefined;
	}
	const hunks: PatchHunk[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object") {
			continue;
		}
		const hunk = entry as Record<string, unknown>;
		if (!Array.isArray(hunk.lines)) {
			continue;
		}
		hunks.push({
			oldStart: Number(hunk.oldStart) || 0,
			oldLines: Number(hunk.oldLines) || 0,
			newStart: Number(hunk.newStart) || 0,
			newLines: Number(hunk.newLines) || 0,
			lines: hunk.lines.filter((line): line is string => typeof line === "string"),
		});
	}
	return hunks.length > 0 ? hunks : undefined;
}

/**
 * Recognise tool calls that produced something worth offering as a card:
 * a published artifact, or a document written to disk.
 */
function readArtifact(block: ToolUseBlock): FileArtifact | undefined {
	const input = block.input || {};
	const filePath = typeof input.file_path === "string" ? input.file_path : "";

	if (block.name === "Artifact") {
		if (!filePath) {
			return undefined;
		}
		return {
			filePath,
			fileName: anyBasename(filePath),
			kind: "artifact",
			description: typeof input.description === "string" ? input.description : undefined,
			favicon: typeof input.favicon === "string" ? input.favicon : undefined,
			exists: fileExists(filePath),
		};
	}

	if (block.name === "Write" && filePath && /\.(md|markdown)$/i.test(filePath)) {
		return {
			filePath,
			fileName: anyBasename(filePath),
			kind: "markdown",
			exists: fileExists(filePath),
		};
	}

	return undefined;
}

/** Recover the published artifact URL that the Artifact tool reports back. */
function findArtifactUrl(text: string): string | undefined {
	const match = text.match(/https:\/\/claude\.ai\/\S+/);
	return match ? match[0].replace(/[).,\]"'>]+$/, "") : undefined;
}

// === Titles ===

/** The first line of a message, trimmed to a usable title length. */
function titleFromText(text: string, limit = 90): string {
	const firstLine = text.split("\n").find((line) => line.trim().length > 0) || text;
	const cleaned = collapseWhitespace(firstLine);
	return cleaned.length > limit ? cleaned.slice(0, limit - 1).trimEnd() + "…" : cleaned;
}

/** Turn a Claude Code session slug ("greedy-roaming-gem") into a readable title. */
function titleFromSlug(slug: string): string {
	const words = slug.split("-").filter(Boolean);
	if (words.length === 0) {
		return "";
	}
	return words.join(" ").replace(/^./, (c) => c.toUpperCase());
}

// === Pass 1: metadata ===

export async function scanSessionMeta(
	filePath: string,
	projectDir: string,
	fileSize: number,
	options: ReadOptions = {}
): Promise<SessionMeta | undefined> {
	let firstTimestamp: string | undefined;
	let lastTimestamp: string | undefined;
	let aiTitle: string | undefined;
	let legacySummary: string | undefined;
	let slug: string | undefined;
	let preview = "";
	let cwd: string | undefined;
	let gitBranch: string | undefined;
	let cliVersion: string | undefined;

	let userMessageCount = 0;
	let assistantMessageCount = 0;
	let toolCallCount = 0;
	let hasSidechains = false;
	let hasErrors = false;
	let totalTokens = 0;

	const models: string[] = [];
	const filesTouched = new Set<string>();
	// Claude Code re-writes the `pr-link` record on every subsequent turn, so a
	// long session can hold hundreds of copies of the same handful of pull
	// requests. Key on the URL and keep the first sighting of each.
	const prLinks = new Map<string, SessionMeta["prLinks"][number]>();

	await readTranscript(
		filePath,
		(record) => {
			const type = record.type;

			if (typeof record.timestamp === "string") {
				if (!firstTimestamp) {
					firstTimestamp = record.timestamp;
				}
				lastTimestamp = record.timestamp;
			}
			if (!cwd && typeof record.cwd === "string" && record.cwd) {
				cwd = record.cwd;
			}
			if (!gitBranch && typeof record.gitBranch === "string" && record.gitBranch) {
				gitBranch = record.gitBranch;
			}
			if (typeof record.version === "string" && record.version) {
				cliVersion = record.version;
			}
			if (!slug && typeof record.slug === "string" && record.slug) {
				slug = record.slug;
			}
			if (record.isSidechain === true) {
				hasSidechains = true;
			}

			switch (type) {
				case "ai-title": {
					if (typeof record.aiTitle === "string" && record.aiTitle.trim()) {
						aiTitle = record.aiTitle.trim();
					}
					break;
				}
				case "summary": {
					if (typeof record.summary === "string" && record.summary.trim()) {
						legacySummary = record.summary.trim();
					}
					break;
				}
				case "pr-link": {
					if (typeof record.prUrl === "string" && !prLinks.has(record.prUrl)) {
						prLinks.set(record.prUrl, {
							url: record.prUrl,
							number: typeof record.prNumber === "number" ? record.prNumber : undefined,
							repository: typeof record.prRepository === "string" ? record.prRepository : undefined,
						});
					}
					break;
				}
				case "file-history-delta": {
					if (typeof record.trackingPath === "string" && record.trackingPath) {
						filesTouched.add(record.trackingPath);
					}
					break;
				}
				case "system": {
					if (record.level === "error") {
						hasErrors = true;
					}
					break;
				}
				case "user": {
					const message = record.message as ApiMessage | undefined;
					if (message?.role !== "user") {
						break;
					}
					if (isToolResultMessage(message.content)) {
						break;
					}
					const text = extractUserText(message.content);
					if (!text) {
						// Slash-command plumbing and other synthetic entries are
						// not messages a person sent, so they are not counted.
						break;
					}
					userMessageCount++;
					if (!preview) {
						preview = text;
					}
					break;
				}
				case "assistant": {
					const message = record.message as ApiMessage | undefined;
					if (message?.role !== "assistant") {
						break;
					}
					assistantMessageCount++;
					// `<synthetic>` marks a message the CLI produced locally —
					// an API error placeholder, not a model that ran.
					if (
						typeof message.model === "string" &&
						message.model &&
						message.model !== "<synthetic>" &&
						!models.includes(message.model)
					) {
						models.push(message.model);
					}
					if (Array.isArray(message.content)) {
						for (const block of message.content) {
							if (block?.type === "tool_use") {
								toolCallCount++;
							}
						}
					}
					totalTokens += countTokens(message.usage);
					break;
				}
				default:
					break;
			}
		},
		options
	);

	if (options.signal?.aborted) {
		return undefined;
	}

	const messageCount = userMessageCount + assistantMessageCount;
	if (messageCount === 0) {
		return undefined;
	}

	const projectPath = cwd || decodeProjectDir(projectDir);
	const timestamp = firstTimestamp || new Date(0).toISOString();

	let title = aiTitle;
	let titleSource: SessionMeta["titleSource"] = "ai-title";
	if (!title && legacySummary) {
		title = legacySummary;
		titleSource = "summary";
	}
	if (!title && preview) {
		title = titleFromText(preview);
		titleSource = "first-message";
	}
	if (!title && slug) {
		title = titleFromSlug(slug);
		titleSource = "slug";
	}

	return {
		id: sessionIdFromPath(filePath),
		filePath,
		projectDir,
		projectPath,
		projectName: projectDisplayName(projectPath),
		title,
		titleSource: title ? titleSource : undefined,
		preview,
		timestamp,
		lastTimestamp: lastTimestamp || timestamp,
		model: models.length > 0 ? simplifyModelName(models[0]) : undefined,
		models: models.map(simplifyModelName),
		gitBranch,
		cliVersion,
		messageCount,
		userMessageCount,
		assistantMessageCount,
		toolCallCount,
		fileSize,
		hasSidechains,
		hasErrors,
		prLinks: Array.from(prLinks.values()).sort((a, b) => (a.number || 0) - (b.number || 0)),
		filesTouched: Array.from(filesTouched),
		totalTokens: totalTokens > 0 ? totalTokens : undefined,
	};
}

/**
 * Tokens genuinely processed by a turn.
 *
 * `cache_read_input_tokens` is deliberately excluded: it re-reports the entire
 * cached prefix on every single turn, so summing it across a long session
 * produces a number in the billions that describes nothing. What is left —
 * fresh input, cache writes and output — adds up to the work actually done.
 */
function countTokens(usage: TokenUsage | undefined): number {
	if (!usage) {
		return 0;
	}
	return (
		(usage.input_tokens || 0) +
		(usage.output_tokens || 0) +
		(usage.cache_creation_input_tokens || 0)
	);
}

function isToolResultMessage(content: ApiMessage["content"]): boolean {
	return (
		Array.isArray(content) &&
		content.length > 0 &&
		content.every((block) => block?.type === "tool_result")
	);
}

// === Pass 2: full conversation ===

export interface ParseOptions extends ReadOptions {
	/** Characters of tool output kept per call. */
	toolOutputLimit?: number;
	includeSidechains?: boolean;
}

export async function parseSession(
	filePath: string,
	options: ParseOptions = {}
): Promise<ConversationMessage[]> {
	const outputLimit = options.toolOutputLimit ?? 4000;
	const includeSidechains = options.includeSidechains ?? true;

	const messages: ConversationMessage[] = [];
	const pendingToolCalls = new Map<string, ToolCall>();

	await readTranscript(
		filePath,
		(record) => {
			const isSidechain = record.isSidechain === true;
			if (isSidechain && !includeSidechains) {
				return;
			}

			switch (record.type) {
				case "user":
					handleUserRecord(record, messages, pendingToolCalls, outputLimit, isSidechain);
					break;
				case "assistant":
					handleAssistantRecord(record, messages, pendingToolCalls, isSidechain);
					break;
				case "system":
					handleSystemRecord(record, messages);
					break;
				case "attachment":
					handleAttachmentRecord(record, messages);
					break;
				default:
					break;
			}
		},
		options
	);

	return messages.map((message, index) => ({ ...message, index }));
}

function handleUserRecord(
	record: TranscriptRecord,
	messages: ConversationMessage[],
	pendingToolCalls: Map<string, ToolCall>,
	outputLimit: number,
	isSidechain: boolean
): void {
	const message = record.message as ApiMessage | undefined;
	if (message?.role !== "user") {
		return;
	}

	const content = message.content;
	if (Array.isArray(content)) {
		const toolResults = content.filter(
			(block): block is ToolResultBlock => block?.type === "tool_result"
		);
		if (toolResults.length > 0) {
			for (const result of toolResults) {
				attachToolResult(result, record.toolUseResult, pendingToolCalls, outputLimit);
			}
			// A message that is purely tool results is plumbing, not a turn.
			if (toolResults.length === content.length) {
				return;
			}
		}
	}

	const text = extractUserText(content);
	if (!text) {
		return;
	}

	messages.push({
		index: messages.length,
		role: "user",
		text,
		timestamp: typeof record.timestamp === "string" ? record.timestamp : undefined,
		sidechain: isSidechain || undefined,
	});
}

function attachToolResult(
	result: ToolResultBlock,
	toolUseResult: unknown,
	pendingToolCalls: Map<string, ToolCall>,
	outputLimit: number
): void {
	const call = pendingToolCalls.get(result.tool_use_id);
	if (!call) {
		return;
	}

	const structured = readStructuredResult(toolUseResult);
	const blockText = toolResultToText(result.content);
	// The structured field is richer, but it is absent for some tools and for
	// transcripts written by older versions, so the block is the fallback.
	const text = structured?.text || blockText;

	if (text.length > outputLimit) {
		call.output = text.slice(0, outputLimit);
		call.outputTruncated = true;
	} else {
		call.output = text;
	}
	if (structured?.stderr) {
		call.stderr = structured.stderr.slice(0, outputLimit);
	}
	if (structured?.patch) {
		call.patch = structured.patch;
		call.patchFile = structured.patchFile;
	}
	call.isError = result.is_error === true;

	if (call.artifact && !call.isError) {
		const url = findArtifactUrl(blockText || text);
		if (url) {
			call.artifact.url = url;
		}
	}

	pendingToolCalls.delete(result.tool_use_id);
}

function handleAssistantRecord(
	record: TranscriptRecord,
	messages: ConversationMessage[],
	pendingToolCalls: Map<string, ToolCall>,
	isSidechain: boolean
): void {
	const message = record.message as ApiMessage | undefined;
	if (message?.role !== "assistant") {
		return;
	}

	const blocks: ContentBlock[] = Array.isArray(message.content) ? message.content : [];
	let text = extractAssistantText(message.content);
	let thinking = "";
	const toolCalls: ToolCall[] = [];

	for (const block of blocks) {
		if (block?.type === "thinking") {
			thinking += (block as ThinkingBlock).thinking || "";
		} else if (block?.type === "tool_use") {
			const toolUse = block as ToolUseBlock;
			const input = toolUse.input || {};
			const call: ToolCall = {
				id: toolUse.id,
				name: toolUse.name,
				summary: summarizeToolInput(toolUse.name, input),
				input: prettyInput(input),
			};
			const artifact = readArtifact(toolUse);
			if (artifact) {
				call.artifact = artifact;
			}
			toolCalls.push(call);
			pendingToolCalls.set(toolUse.id, call);
		}
	}

	if (!text && toolCalls.length === 0 && !thinking) {
		return;
	}
	// Streaming can split one turn across records; an empty text block with
	// only whitespace is noise.
	text = text.trim();

	messages.push({
		index: messages.length,
		role: "assistant",
		text,
		thinking: thinking.trim() || undefined,
		toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
		timestamp: typeof record.timestamp === "string" ? record.timestamp : undefined,
		model: typeof message.model === "string" ? simplifyModelName(message.model) : undefined,
		sidechain: isSidechain || undefined,
		usage: message.usage,
	});
}

function handleSystemRecord(record: TranscriptRecord, messages: ConversationMessage[]): void {
	const subtype = typeof record.subtype === "string" ? record.subtype : undefined;
	let text = "";

	if (typeof record.content === "string" && record.content) {
		text = record.content;
	} else if (record.error && typeof record.error === "object") {
		const error = record.error as { formatted?: string; message?: string };
		text = error.formatted || error.message || "";
	}

	if (subtype === "compact_boundary") {
		const metadata = record.compactMetadata as { trigger?: string; preTokens?: number } | undefined;
		const trigger = metadata?.trigger ? ` (${metadata.trigger})` : "";
		text = `Context compacted${trigger}`;
	}

	if (!text) {
		return;
	}

	messages.push({
		index: messages.length,
		role: "system",
		text,
		subtype,
		level: typeof record.level === "string" ? record.level : undefined,
		timestamp: typeof record.timestamp === "string" ? record.timestamp : undefined,
	});
}

/**
 * Surface the one attachment that represents a person's intent: a prompt they
 * typed while Claude was still working, which is queued rather than sent as a
 * normal user message and would otherwise vanish from the transcript.
 */
function handleAttachmentRecord(record: TranscriptRecord, messages: ConversationMessage[]): void {
	const attachment = record.attachment as { type?: string; prompt?: unknown } | undefined;
	if (attachment?.type !== "queued_command") {
		return;
	}

	const text = extractUserText(attachment.prompt as ApiMessage["content"]);
	if (!text) {
		return;
	}

	messages.push({
		index: messages.length,
		role: "user",
		text,
		subtype: "queued",
		timestamp: typeof record.timestamp === "string" ? record.timestamp : undefined,
	});
}

// === Search helpers ===

/** A window of text around the first match, for search result rows. */
export function extractMatchContext(text: string, query: string, contextChars = 90): string {
	const flattened = collapseWhitespace(text);
	const index = flattened.toLowerCase().indexOf(query.toLowerCase());
	if (index === -1) {
		return flattened.slice(0, contextChars * 2);
	}
	const start = Math.max(0, index - contextChars);
	const end = Math.min(flattened.length, index + query.length + contextChars);
	return (start > 0 ? "…" : "") + flattened.slice(start, end) + (end < flattened.length ? "…" : "");
}

export { extractAssistantText, isToolResultMessage, titleFromText };
