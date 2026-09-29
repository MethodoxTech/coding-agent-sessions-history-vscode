/**
 * Narrowing an open session down to the messages you are looking for.
 *
 * A long session runs to several thousand messages, so scrolling is not a way
 * to find anything. Filtering happens here, over the whole parsed session held
 * by the extension host, rather than in the webview — the webview only ever
 * holds the pages that have been rendered, so anything it filtered would miss
 * everything below the fold.
 */

import { ConversationMessage, ToolCall } from "./types";

/** Which messages a filter considers, before any text matching. */
export type MessageScope = "all" | "user" | "assistant" | "tools" | "changes";

export const MESSAGE_SCOPES: MessageScope[] = ["all", "user", "assistant", "tools", "changes"];

export function isMessageScope(value: unknown): value is MessageScope {
	return typeof value === "string" && (MESSAGE_SCOPES as string[]).includes(value);
}

export interface FilterResult {
	messages: ConversationMessage[];
	/** Indices into the unfiltered list, so a match can be located later. */
	indices: number[];
}

/**
 * Split a query into terms that must all match.
 *
 * Terms are whitespace-separated and combine with AND, which is what makes a
 * filter usable on a long session: "edit package" finds the message that
 * mentions both, in either order, without needing to remember the phrasing.
 * A quoted run is kept together so an exact phrase is still possible.
 */
export function parseQuery(query: string): string[] {
	const terms: string[] = [];
	const pattern = /"([^"]*)"|(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(query)) !== null) {
		const term = (match[1] ?? match[2] ?? "").trim().toLowerCase();
		if (term) {
			terms.push(term);
		}
	}
	return terms;
}

function matchesScope(message: ConversationMessage, scope: MessageScope): boolean {
	switch (scope) {
		case "user":
			return message.role === "user";
		case "assistant":
			// Assistant turns that only carry tool calls are the tools scope;
			// this one is for what Claude actually said.
			return message.role === "assistant" && (message.text.length > 0 || !!message.thinking);
		case "tools":
			return !!message.toolCalls && message.toolCalls.length > 0;
		case "changes":
			return !!message.toolCalls && message.toolCalls.some(isChange);
		case "all":
		default:
			return true;
	}
}

function isChange(call: ToolCall): boolean {
	return (!!call.patch && call.patch.length > 0) || !!call.artifact;
}

/**
 * Every piece of a message a query is matched against, lower-cased once so a
 * multi-term query does not re-walk the message per term.
 */
function searchableText(message: ConversationMessage): string {
	const parts: string[] = [message.text];

	if (message.thinking) {
		parts.push(message.thinking);
	}
	if (message.model) {
		parts.push(message.model);
	}

	for (const call of message.toolCalls || []) {
		parts.push(call.name, call.summary, call.input);
		if (call.output) {
			parts.push(call.output);
		}
		if (call.stderr) {
			parts.push(call.stderr);
		}
		if (call.patchFile) {
			parts.push(call.patchFile);
		}
		for (const hunk of call.patch || []) {
			parts.push(hunk.lines.join("\n"));
		}
		if (call.artifact) {
			parts.push(call.artifact.fileName, call.artifact.filePath);
			if (call.artifact.description) {
				parts.push(call.artifact.description);
			}
		}
	}

	return parts.join("\n").toLowerCase();
}

/**
 * The messages matching `query` within `scope`, in their original order.
 *
 * An empty query with the default scope returns everything, so clearing the
 * box restores the conversation without a reload.
 */
export function filterMessages(
	messages: ConversationMessage[],
	query: string,
	scope: MessageScope = "all"
): FilterResult {
	const terms = parseQuery(query);
	if (terms.length === 0 && scope === "all") {
		return { messages, indices: messages.map((_, index) => index) };
	}

	const result: FilterResult = { messages: [], indices: [] };

	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (!matchesScope(message, scope)) {
			continue;
		}
		if (terms.length > 0) {
			const haystack = searchableText(message);
			if (!terms.every((term) => haystack.includes(term))) {
				continue;
			}
		}
		result.messages.push(message);
		result.indices.push(index);
	}

	return result;
}
