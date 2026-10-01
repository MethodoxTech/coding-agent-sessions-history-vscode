/** Codex rollout adapter. Unknown records and partially written lines are ignored. */
import * as fs from "fs";
import * as path from "path";
import { parseRecord, readLines, ReadOptions, STOP } from "../claude/jsonl";
import { ConversationMessage, SessionMeta, ToolCall, TranscriptRecord } from "../claude/types";
import { projectDisplayName } from "../claude/paths";
import { ParseOptions } from "../claude/parser";

type Obj = Record<string, unknown>;
function obj(value: unknown): Obj {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {};
}
function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}
function content(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value
		.map((v) => {
			const b = obj(v);
			return str(b.text) || (b.type === "input_image" ? "[Image]" : "");
		})
		.filter(Boolean)
		.join("\n");
}
/**
 * A failed command in tool output. Newer rollouts hold the result as JSON inside
 * the output string, so the key can arrive escaped as `exit_code\\":1`.
 */
const TOOL_ERROR = /(?:Process exited with code|exit_code[\\"\s:]*)\s*[1-9]/i;
/** Text of a tool result, which newer rollouts record as content parts. */
function toolOutput(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return content(value);
	return JSON.stringify(value ?? "");
}

// === Images ===

/**
 * Screenshots and pasted images are stored inline as base64 data URIs, often
 * hundreds of kilobytes each. Nothing here can show them, so they are cut out
 * of the raw line before it is parsed: that keeps them out of memory, out of
 * the conversation view and out of search matches. The JSON stays valid
 * because base64 holds no quotes or backslashes.
 */
const DATA_URI = /data:image\/[^"\\]*/g;
const DATA_URI_MARKER = Buffer.from("data:image/");
/** Below this a line is parsed as it is; an image cannot fit. */
const IMAGE_SCAN_BYTES = 4096;

function parseCodexLine(line: Buffer): TranscriptRecord | undefined {
	if (line.length < IMAGE_SCAN_BYTES || !line.includes(DATA_URI_MARKER)) return parseRecord(line);
	return parseRecord(Buffer.from(line.toString("utf8").replace(DATA_URI, "[Image]"), "utf8"));
}

async function readCodexRecords(
	filePath: string,
	visit: (record: TranscriptRecord) => void,
	options: ReadOptions,
): Promise<void> {
	const { signal } = options;
	await readLines(
		filePath,
		(line) => {
			if (signal?.aborted) return STOP;
			const record = parseCodexLine(line);
			if (record) visit(record);
			return undefined;
		},
		{ signal, includeTrailing: true },
	);
}

function userText(text: string): string {
	// These are injected setup messages, not prompts typed by a person.
	if (
		/^\s*(# AGENTS\.md instructions|<environment_context>|<permissions instructions>|<system-reminder>)/i.test(
			text,
		)
	)
		return "";
	return text.trim();
}

async function read(
	filePath: string,
	options: ParseOptions,
	onMessage: (message: ConversationMessage) => void,
): Promise<SessionMeta | undefined> {
	let id = path
		.basename(filePath, ".jsonl")
		.replace(/^rollout-.*?([0-9a-f]{8}-[0-9a-f-]{27})$/i, "$1");
	let cwd = "",
		cliVersion = "",
		gitBranch = "",
		first = "",
		last = "",
		model = "",
		preview = "";
	let users = 0,
		assistants = 0,
		tools = 0,
		index = 0,
		totalTokens = 0,
		hasErrors = false,
		sidechain = false;
	const models = new Set<string>(),
		pending = new Map<string, ToolCall>();
	const limit = options.toolOutputLimit ?? 4000;
	// Modern rollouts repeat messages in event_msg. Only use events for roles
	// with no response_item messages, avoiding duplicate turns and search hits.
	const fallback: { role: "user" | "assistant"; text: string; timestamp?: string }[] = [];
	const responseRoles = new Set<string>();
	const push = (m: Omit<ConversationMessage, "index">): void => {
		if (options.includeSidechains === false && sidechain) return;
		if (m.role === "user") {
			users++;
			if (!preview) preview = m.text;
		}
		if (m.role === "assistant") assistants++;
		onMessage({
			...m,
			index: index++,
			model: model || undefined,
			sidechain: sidechain || undefined,
		});
	};
	await readCodexRecords(
		filePath,
		(record) => {
			const p = obj(record.payload),
				timestamp = str(record.timestamp) || undefined;
			if (timestamp) {
				first ||= timestamp;
				last = timestamp;
			}
			if (record.type === "session_meta") {
				id = str(p.id) || str(p.session_id) || id;
				cwd = str(p.cwd);
				cliVersion = str(p.cli_version);
				gitBranch = str(obj(p.git).branch);
				sidechain = !!obj(p.source).subagent || !!obj(p.thread_source).subagent;
			} else if (record.type === "turn_context") {
				cwd ||= str(p.cwd);
				model = str(p.model) || model;
				if (model) models.add(model);
			} else if (record.type === "event_msg") {
				if (p.type === "token_count")
					totalTokens = Math.max(
						totalTokens,
						Number(obj(obj(p.info).total_token_usage).total_tokens) || 0,
					);
				if (
					(p.type === "user_message" && !responseRoles.has("user")) ||
					(p.type === "agent_message" && !responseRoles.has("assistant"))
				)
					fallback.push({
						role: p.type === "user_message" ? "user" : "assistant",
						text: str(p.message),
						timestamp,
					});
				if (p.type === "turn_aborted" || p.type === "error") {
					hasErrors = true;
					push({
						role: "system",
						text: str(p.message) || str(p.reason) || String(p.type),
						timestamp,
						level: "error",
					});
				}
			} else if (record.type === "compacted") {
				push({
					role: "system",
					text: "Context compacted",
					subtype: "compact_boundary",
					timestamp,
				});
			} else if (record.type === "response_item") {
				if (p.type === "message" && (p.role === "user" || p.role === "assistant")) {
					responseRoles.add(p.role);
					const text =
						p.role === "user"
							? userText(content(p.content))
							: content(p.content).trim();
					if (text) push({ role: p.role, text, timestamp });
				} else if (p.type === "reasoning") {
					const thinking = content(p.summary) || content(p.content);
					if (thinking) push({ role: "assistant", text: "", thinking, timestamp });
				} else if (
					p.type === "function_call" ||
					p.type === "custom_tool_call" ||
					p.type === "local_shell_call"
				) {
					const input =
						str(p.arguments) || str(p.input) || JSON.stringify(p.action ?? {});
					const call: ToolCall = {
						id: str(p.call_id) || str(p.id),
						name: str(p.name) || "local_shell",
						input,
						summary: input.slice(0, 160),
					};
					tools++;
					pending.set(call.id, call);
					push({ role: "assistant", text: "", toolCalls: [call], timestamp });
				} else if (
					p.type === "function_call_output" ||
					p.type === "custom_tool_call_output"
				) {
					const call = pending.get(str(p.call_id));
					if (call) {
						const output = toolOutput(p.output);
						call.output = output.slice(0, limit);
						call.outputTruncated = output.length > limit;
						call.isError =
							obj(p.output).is_error === true ||
							TOOL_ERROR.test(output);
						hasErrors ||= call.isError;
						pending.delete(call.id);
					}
				}
			}
		},
		options,
	);
	for (const event of fallback)
		if (!responseRoles.has(event.role)) {
			const text = event.role === "user" ? userText(event.text) : event.text;
			if (text) push({ ...event, text });
		}
	if (options.signal?.aborted || users + assistants === 0) return undefined;
	return {
		id: "codex:" + id,
		nativeId: id,
		provider: "codex",
		filePath,
		projectDir: cwd,
		projectPath: cwd,
		projectName: projectDisplayName(cwd) || "Unknown project",
		title: preview.split("\n")[0].slice(0, 90) || "Codex session",
		titleSource: "first-message",
		preview,
		timestamp: first || new Date(0).toISOString(),
		lastTimestamp: last || first || new Date(0).toISOString(),
		model: models.values().next().value,
		models: [...models],
		cliVersion,
		gitBranch,
		messageCount: users + assistants,
		userMessageCount: users,
		assistantMessageCount: assistants,
		toolCallCount: tools,
		fileSize: 0,
		hasSidechains: sidechain,
		hasErrors,
		prLinks: [],
		filesTouched: [],
		totalTokens: totalTokens || undefined,
	};
}
// === Index scan ===

/**
 * Everything the index keeps about a rollout while scanning it. It is plain
 * data so it can be cached and the scan resumed when the rollout grows: a
 * running session appends to its rollout constantly, and re-reading a hundred
 * megabytes on every change is what made indexing crawl.
 */
export interface CodexScanState {
	id: string;
	cwd: string;
	cliVersion: string;
	gitBranch: string;
	first: string;
	last: string;
	model: string;
	models: string[];
	preview: string;
	users: number;
	assistants: number;
	tools: number;
	totalTokens: number;
	hasErrors: boolean;
	sidechain: boolean;
	responseRoles: string[];
	/** Non-empty event_msg messages, counted only for roles with no response_item messages. */
	fallbackUsers: number;
	fallbackAssistants: number;
	fallbackPreview: string;
}

export interface CodexScanResume {
	/** Offset just past the last complete line scanned. */
	offset: number;
	/** The rollout's first bytes, to notice a file replaced rather than appended to. */
	head: string;
	state: CodexScanState;
}

const HEAD_BYTES = 64;
const PREFIX_BYTES = 512;
const TOP_LEVEL_TYPE = /"type":"(session_meta|turn_context|event_msg|response_item|compacted)"/;
const PAYLOAD_TYPE = /"payload":\{"type":"([A-Za-z_]+)"/;
const TIMESTAMP = /"timestamp":"([^"\\]*)"/;
const TIMESTAMP_ALL = /"timestamp":"([^"\\]*)"/g;
/** event_msg payloads the index reads. The rest — mostly item_completed — are skipped unparsed. */
const INDEXED_EVENTS = new Set(["token_count", "user_message", "agent_message", "turn_aborted", "error"]);
const TOOL_CALLS = new Set(["function_call", "custom_tool_call", "local_shell_call"]);
const TOOL_OUTPUTS = new Set(["function_call_output", "custom_tool_call_output"]);
/** The same test against the raw JSON line, so tool output need not be parsed. */
const RAW_TOOL_ERROR = /"is_error":\s*true|(?:Process exited with code|exit_code[\\"\s:]*)\s*[1-9]/i;

function initialState(filePath: string): CodexScanState {
	return {
		id: path
			.basename(filePath, ".jsonl")
			.replace(/^rollout-.*?([0-9a-f]{8}-[0-9a-f-]{27})$/i, "$1"),
		cwd: "",
		cliVersion: "",
		gitBranch: "",
		first: "",
		last: "",
		model: "",
		models: [],
		preview: "",
		users: 0,
		assistants: 0,
		tools: 0,
		totalTokens: 0,
		hasErrors: false,
		sidechain: false,
		responseRoles: [],
		fallbackUsers: 0,
		fallbackAssistants: 0,
		fallbackPreview: "",
	};
}

/**
 * Builds the index entry for a rollout, matching what `read` derives, but
 * without parsing the lines the index has no use for. Tool output and
 * item_completed events are most of a rollout's bytes; those lines are
 * recognised from their first few hundred bytes and skipped.
 */
class CodexMetaScanner {
	constructor(readonly state: CodexScanState) {}

	visitLine(line: Buffer): void {
		if (line.length === 0) return;
		const head = line.toString("latin1", 0, Math.min(line.length, PREFIX_BYTES));
		const top = TOP_LEVEL_TYPE.exec(head);
		const payloadAt = head.indexOf('"payload"');
		// Anything unusual — an unknown record, or keys in an unexpected
		// order — takes the slow, exact path.
		if (!top || (payloadAt !== -1 && top.index > payloadAt)) return this.visitParsed(line);

		const kind = top[1];
		if (kind === "session_meta" || kind === "turn_context") return this.visitParsed(line);
		if (kind === "compacted") return this.stamp(line, head, payloadAt);

		const payloadType = PAYLOAD_TYPE.exec(head)?.[1];
		if (!payloadType) return this.visitParsed(line);
		if (kind === "event_msg") {
			return INDEXED_EVENTS.has(payloadType)
				? this.visitParsed(line)
				: this.stamp(line, head, payloadAt);
		}
		if (payloadType === "message" || payloadType === "reasoning") return this.visitParsed(line);
		this.stamp(line, head, payloadAt);
		if (TOOL_CALLS.has(payloadType)) {
			this.state.tools++;
			this.state.assistants++;
		} else if (TOOL_OUTPUTS.has(payloadType) && !this.state.hasErrors) {
			this.state.hasErrors = RAW_TOOL_ERROR.test(line.toString("latin1"));
		}
	}

	/** Record the timestamp of a line that is otherwise skipped. */
	private stamp(line: Buffer, head: string, payloadAt: number): void {
		const match = TIMESTAMP.exec(head);
		if (match && (payloadAt === -1 || match.index < payloadAt)) return this.time(match[1]);
		// Written after the payload, so it is at the end of the line.
		const tail = line.toString("latin1", Math.max(0, line.length - 160));
		let last: string | undefined;
		for (const m of tail.matchAll(TIMESTAMP_ALL)) last = m[1];
		if (last) this.time(last);
	}

	private time(timestamp: string): void {
		if (!timestamp) return;
		this.state.first ||= timestamp;
		this.state.last = timestamp;
	}

	private visitParsed(line: Buffer): void {
		const record = parseCodexLine(line);
		if (!record) return;
		const s = this.state;
		const p = obj(record.payload);
		this.time(str(record.timestamp));
		if (record.type === "session_meta") {
			s.id = str(p.id) || str(p.session_id) || s.id;
			s.cwd = str(p.cwd);
			s.cliVersion = str(p.cli_version);
			s.gitBranch = str(obj(p.git).branch);
			s.sidechain = !!obj(p.source).subagent || !!obj(p.thread_source).subagent;
		} else if (record.type === "turn_context") {
			s.cwd ||= str(p.cwd);
			s.model = str(p.model) || s.model;
			if (s.model && !s.models.includes(s.model)) s.models.push(s.model);
		} else if (record.type === "event_msg") {
			if (p.type === "token_count")
				s.totalTokens = Math.max(
					s.totalTokens,
					Number(obj(obj(p.info).total_token_usage).total_tokens) || 0,
				);
			if (p.type === "user_message") {
				const text = userText(str(p.message));
				if (text) {
					s.fallbackUsers++;
					s.fallbackPreview ||= text;
				}
			} else if (p.type === "agent_message") {
				if (str(p.message)) s.fallbackAssistants++;
			} else if (p.type === "turn_aborted" || p.type === "error") {
				s.hasErrors = true;
			}
		} else if (record.type === "response_item") {
			if (p.type === "message" && (p.role === "user" || p.role === "assistant")) {
				if (!s.responseRoles.includes(p.role)) s.responseRoles.push(p.role);
				const text =
					p.role === "user" ? userText(content(p.content)) : content(p.content).trim();
				if (!text) return;
				if (p.role === "user") {
					s.users++;
					s.preview ||= text;
				} else {
					s.assistants++;
				}
			} else if (p.type === "reasoning") {
				if (content(p.summary) || content(p.content)) s.assistants++;
			} else if (TOOL_CALLS.has(str(p.type))) {
				s.tools++;
				s.assistants++;
			} else if (TOOL_OUTPUTS.has(str(p.type)) && !s.hasErrors) {
				const output = toolOutput(p.output);
				s.hasErrors =
					obj(p.output).is_error === true ||
					TOOL_ERROR.test(output);
			}
		}
	}
}

function metaFromState(filePath: string, s: CodexScanState, fileSize: number): SessionMeta | undefined {
	// Event messages stand in only for a role that has no response_item messages.
	const fallbackUsers = s.responseRoles.includes("user") ? 0 : s.fallbackUsers;
	const fallbackAssistants = s.responseRoles.includes("assistant") ? 0 : s.fallbackAssistants;
	const users = s.users + fallbackUsers;
	const assistants = s.assistants + fallbackAssistants;
	if (users + assistants === 0) return undefined;
	const preview = s.preview || (fallbackUsers ? s.fallbackPreview : "");
	return {
		id: "codex:" + s.id,
		nativeId: s.id,
		provider: "codex",
		filePath,
		projectDir: s.cwd,
		projectPath: s.cwd,
		projectName: projectDisplayName(s.cwd) || "Unknown project",
		title: preview.split("\n")[0].slice(0, 90) || "Codex session",
		titleSource: "first-message",
		preview,
		timestamp: s.first || new Date(0).toISOString(),
		lastTimestamp: s.last || s.first || new Date(0).toISOString(),
		model: s.models[0],
		models: [...s.models],
		cliVersion: s.cliVersion,
		gitBranch: s.gitBranch,
		messageCount: users + assistants,
		userMessageCount: users,
		assistantMessageCount: assistants,
		toolCallCount: s.tools,
		fileSize,
		hasSidechains: s.sidechain,
		hasErrors: s.hasErrors,
		prLinks: [],
		filesTouched: [],
		totalTokens: s.totalTokens || undefined,
	};
}

/** The first bytes of a file, and whether `offset` falls just after a newline. */
async function probe(filePath: string, offset: number): Promise<{ head: string; atLineStart: boolean }> {
	const handle = await fs.promises.open(filePath, "r");
	try {
		const buffer = Buffer.alloc(HEAD_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
		let atLineStart = offset === 0;
		if (offset > 0) {
			const byte = Buffer.alloc(1);
			atLineStart = (await handle.read(byte, 0, 1, offset - 1)).bytesRead === 1 && byte[0] === 10;
		}
		return { head: buffer.toString("latin1", 0, bytesRead), atLineStart };
	} finally {
		await handle.close();
	}
}

/**
 * Index a rollout, continuing from `resume` when the rollout has only been
 * appended to since. Returns the entry plus the state to resume from next time.
 */
export async function scanCodexRollout(
	filePath: string,
	fileSize: number,
	resume?: CodexScanResume,
	options: ReadOptions = {},
): Promise<{ meta: SessionMeta | undefined; resume: CodexScanResume }> {
	let start = 0;
	let state = initialState(filePath);
	const { head, atLineStart } = await probe(filePath, resume?.offset ?? 0);
	if (resume && fileSize >= resume.offset && resume.head === head && atLineStart) {
		start = resume.offset;
		state = structuredClone(resume.state);
	}
	const scanner = new CodexMetaScanner(state);
	// A last line with no newline yet may still be being written. It counts
	// for this result, but not for the saved state, so the next scan reads it
	// again — whole, if it was cut short — without counting it twice.
	let final = state;
	const offset = await readLines(
		filePath,
		(line, complete) => {
			if (complete) return scanner.visitLine(line);
			final = structuredClone(state);
			new CodexMetaScanner(final).visitLine(line);
		},
		{ signal: options.signal, start, includeTrailing: true },
	);
	const meta = options.signal?.aborted ? undefined : metaFromState(filePath, final, fileSize);
	return { meta, resume: { offset, head, state } };
}

export async function scanCodexMeta(
	filePath: string,
	_projectDir: string,
	fileSize: number,
	options: ReadOptions = {},
): Promise<SessionMeta | undefined> {
	return (await scanCodexRollout(filePath, fileSize, undefined, options)).meta;
}
export async function parseCodexSession(
	filePath: string,
	options: ParseOptions = {},
): Promise<ConversationMessage[]> {
	const messages: ConversationMessage[] = [];
	await read(filePath, options, (message) => messages.push(message));
	// Event-only transcripts can interleave system records and fallback messages.
	messages.sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));
	return messages.map((m, index) => ({ ...m, index }));
}
