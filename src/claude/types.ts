/**
 * Shapes of the records Claude Code writes into its session transcripts, plus
 * the view models this extension derives from them.
 *
 * A transcript is a JSON Lines file at
 *   <claudeHome>/projects/<encoded-project-dir>/<sessionId>.jsonl
 * where every line is one independent JSON object carrying a `type` field.
 *
 * Claude Code has written many more record types over time than any one version
 * emits, and it adds new ones freely. Everything here is therefore treated as
 * optional and best-effort: unknown record types and unknown fields are ignored
 * rather than causing a parse failure.
 */

// === Raw transcript records ===

/** Every record type observed in Claude Code transcripts (v2.1.x and earlier). */
export type RecordType =
	| "user"
	| "assistant"
	| "system"
	| "summary"
	| "ai-title"
	| "attachment"
	| "last-prompt"
	| "pr-link"
	| "mode"
	| "permission-mode"
	| "queue-operation"
	| "file-history-snapshot"
	| "file-history-delta"
	| "bridge-session"
	| "atis-latch";

/** Fields common to the records that represent a point in the conversation. */
export interface BaseRecord {
	type?: string;
	uuid?: string;
	parentUuid?: string | null;
	sessionId?: string;
	timestamp?: string;
	/** Absolute working directory of the session. Authoritative project path. */
	cwd?: string;
	gitBranch?: string;
	/** Claude Code CLI version that wrote the record. */
	version?: string;
	/** True for messages belonging to a subagent (Task tool) thread. */
	isSidechain?: boolean;
	userType?: string;
	entrypoint?: string;
	slug?: string;
}

export interface TextBlock {
	type: "text";
	text: string;
}

export interface ThinkingBlock {
	type: "thinking";
	thinking: string;
	signature?: string;
}

export interface ToolUseBlock {
	type: "tool_use";
	id: string;
	name: string;
	input: Record<string, unknown>;
}

export interface ToolResultBlock {
	type: "tool_result";
	tool_use_id: string;
	content?: unknown;
	is_error?: boolean;
}

export interface ImageBlock {
	type: "image";
	source?: { type?: string; media_type?: string; data?: string; url?: string };
}

export type ContentBlock =
	| TextBlock
	| ThinkingBlock
	| ToolUseBlock
	| ToolResultBlock
	| ImageBlock
	| { type: string; [key: string]: unknown };

export interface TokenUsage {
	input_tokens?: number;
	output_tokens?: number;
	cache_creation_input_tokens?: number;
	cache_read_input_tokens?: number;
}

export interface ApiMessage {
	role?: "user" | "assistant";
	model?: string;
	content?: string | ContentBlock[];
	usage?: TokenUsage;
	stop_reason?: string | null;
}

export interface MessageRecord extends BaseRecord {
	type: "user" | "assistant";
	message?: ApiMessage;
	/**
	 * Structured result of the tool call this record answers. Richer than the
	 * `tool_result` content block: carries stdout/stderr, edit patches, file
	 * metadata and so on.
	 */
	toolUseResult?: unknown;
	requestId?: string;
	promptId?: string;
}

export interface SystemRecord extends BaseRecord {
	type: "system";
	subtype?: string;
	level?: string;
	content?: string;
	error?: { message?: string; formatted?: string };
	source?: string;
}

/** Legacy title record. Superseded by `ai-title` in current Claude Code. */
export interface SummaryRecord {
	type: "summary";
	summary?: string;
	leafUuid?: string;
}

/** Model-generated session title. */
export interface AiTitleRecord {
	type: "ai-title";
	aiTitle?: string;
	sessionId?: string;
}

export interface PrLinkRecord {
	type: "pr-link";
	sessionId?: string;
	prNumber?: number;
	prUrl?: string;
	prRepository?: string;
	timestamp?: string;
}

/** A file edited during the session, with a pointer to Claude Code's backup. */
export interface FileHistoryDeltaRecord {
	type: "file-history-delta";
	messageId?: string;
	trackingPath?: string;
	backup?: {
		backupFileName?: string;
		version?: number;
		backupTime?: string;
		realParentDir?: string;
	};
	timestamp?: string;
}

export interface AttachmentRecord extends BaseRecord {
	type: "attachment";
	attachment?: { type?: string; [key: string]: unknown };
}

/** Any transcript line, before narrowing on `type`. */
export type TranscriptRecord = BaseRecord & Record<string, unknown>;

// === Derived view models ===

/** A file written or edited during the session, surfaced as a card. */
export interface FileArtifact {
	filePath: string;
	/** Basename, computed with platform-aware splitting. */
	fileName: string;
	kind: "artifact" | "markdown" | "file";
	description?: string;
	favicon?: string;
	/** Published claude.ai URL, recovered from the tool result. */
	url?: string;
	exists: boolean;
}

/** A single unified diff hunk, as Claude Code records it for Edit/Write. */
export interface PatchHunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: string[];
}

export interface ToolCall {
	id: string;
	name: string;
	/** One-line summary of the tool input, for the collapsed header. */
	summary: string;
	/** Pretty-printed full input. */
	input: string;
	output?: string;
	/** True when the output was cut at the configured limit. */
	outputTruncated?: boolean;
	stderr?: string;
	isError?: boolean;
	/** Structured diff for Edit/Write calls. */
	patch?: PatchHunk[];
	patchFile?: string;
	artifact?: FileArtifact;
}

export type MessageRole = "user" | "assistant" | "system";

export interface ConversationMessage {
	index: number;
	role: MessageRole;
	text: string;
	thinking?: string;
	toolCalls?: ToolCall[];
	timestamp?: string;
	model?: string;
	/** Subagent thread depth: 0 for the main thread, 1 for Task sidechains. */
	sidechain?: boolean;
	/** For system records: the subtype, e.g. "api_error" or "compact_boundary". */
	subtype?: string;
	level?: string;
	usage?: TokenUsage;
}

/** Everything the list views need, without parsing the whole transcript. */
export interface SessionMeta {
	provider?: "claude" | "codex";
	nativeId?: string;
	/** Session id — the transcript filename without its extension. */
	id: string;
	filePath: string;
	/** Encoded folder name under `projects/`. */
	projectDir: string;
	/** Real absolute project path, taken from the transcript's `cwd`. */
	projectPath: string;
	/** Last path segment of `projectPath`, for compact display. */
	projectName: string;
	/** Best available title: model-generated, else legacy summary, else slug. */
	title?: string;
	titleSource?: "ai-title" | "summary" | "slug" | "first-message";
	/** First real user message, used as a subtitle and as a title fallback. */
	preview: string;
	timestamp: string;
	lastTimestamp: string;
	model?: string;
	models: string[];
	gitBranch?: string;
	cliVersion?: string;
	messageCount: number;
	userMessageCount: number;
	assistantMessageCount: number;
	toolCallCount: number;
	fileSize: number;
	hasSidechains: boolean;
	hasErrors: boolean;
	prLinks: { url: string; number?: number; repository?: string }[];
	/** Files edited during the session, from file-history-delta records. */
	filesTouched: string[];
	totalTokens?: number;
}

export interface SearchMatch {
	meta: SessionMeta;
	messageIndex: number;
	role: MessageRole | "tool";
	matchText: string;
	timestamp?: string;
}

export interface SessionStats {
	totalSessions: number;
	totalMessages: number;
	totalToolCalls: number;
	totalSizeBytes: number;
	totalTokens: number;
	averageMessageCount: number;
	dailyFrequency: { date: string; count: number; messages: number }[];
	modelDistribution: { model: string; count: number; percentage: number }[];
	projectActivity: { project: string; name: string; count: number; messages: number }[];
	branchActivity: { branch: string; count: number }[];
	busiestDay: { date: string; count: number } | null;
	longestSession: { id: string; filePath: string; title: string; messageCount: number } | null;
	firstSession?: string;
	lastSession?: string;
}
