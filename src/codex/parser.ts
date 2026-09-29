/** Codex rollout adapter. Unknown records and partially written lines are ignored. */
import * as path from "path";
import { readTranscript, ReadOptions } from "../claude/jsonl";
import { ConversationMessage, SessionMeta, ToolCall } from "../claude/types";
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
	await readTranscript(
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
						const output =
							typeof p.output === "string"
								? p.output
								: JSON.stringify(p.output ?? "");
						call.output = output.slice(0, limit);
						call.outputTruncated = output.length > limit;
						call.isError =
							obj(p.output).is_error === true ||
							/(?:Process exited with code|exit_code["\s:]*)\s*[1-9]/i.test(output);
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
export async function scanCodexMeta(
	filePath: string,
	_projectDir: string,
	fileSize: number,
	options: ReadOptions = {},
): Promise<SessionMeta | undefined> {
	const meta = await read(filePath, { ...options, toolOutputLimit: 0 }, () => {});
	return meta ? { ...meta, fileSize } : undefined;
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
