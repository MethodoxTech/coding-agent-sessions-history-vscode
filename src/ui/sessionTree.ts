/**
 * The Sessions tree in the activity bar.
 *
 * This is the navigation surface: it stays docked while you work, so it favours
 * a dense, scannable list over detail. Anything that needs room — full
 * transcripts, deep search, statistics — belongs in the browser panel instead.
 */

import * as vscode from "vscode";

import { BookmarkStore } from "../store/bookmarks";
import { SessionStore } from "../store/sessionStore";
import { SessionMeta } from "../claude/types";

type GroupBy = "date" | "project";

export class SessionTreeItem extends vscode.TreeItem {
	constructor(
		readonly session: SessionMeta,
		bookmarked: boolean,
	) {
		super(session.title || session.preview || session.id, vscode.TreeItemCollapsibleState.None);

		this.id = session.filePath;
		this.description = `${session.provider === "codex" ? "Codex" : "Claude"} · ${describeSession(session)}`;
		this.tooltip = buildTooltip(session);
		this.contextValue = bookmarked ? "session.bookmarked" : "session.plain";
		this.iconPath = new vscode.ThemeIcon(
			bookmarked
				? "star-full"
				: session.hasErrors
					? "comment-unresolved"
					: "comment-discussion",
		);
		this.command = {
			command: "codingAgentSessions.openSession",
			title: "Open session",
			arguments: [session],
		};
	}
}

class GroupTreeItem extends vscode.TreeItem {
	constructor(
		readonly key: string,
		label: string,
		readonly sessions: SessionMeta[],
		icon: string,
		contextValue: string,
		collapsed: boolean,
	) {
		super(
			label,
			collapsed
				? vscode.TreeItemCollapsibleState.Collapsed
				: vscode.TreeItemCollapsibleState.Expanded,
		);
		this.id = `group:${contextValue}:${key}`;
		this.description = `${sessions.length}`;
		this.iconPath = new vscode.ThemeIcon(icon);
		this.contextValue = contextValue;
	}
}

type TreeNode = GroupTreeItem | SessionTreeItem;

export class SessionTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<TreeNode | undefined>();
	readonly onDidChangeTreeData = this.changed.event;
	private readonly subscription: { dispose(): void };
	private started = false;

	private filterText = "";
	private bookmarksOnly = false;
	private collapsedGroups = new Set<string>();

	constructor(
		private readonly store: SessionStore,
		private readonly bookmarks: BookmarkStore,
	) {
		// Redraw with partial results while a scan runs, and with the final list.
		this.subscription = store.subscribe((event) => {
			if (event.type === "sessions") {
				this.refresh();
			}
		});
	}

	dispose(): void {
		this.subscription.dispose();
		this.changed.dispose();
	}

	get groupBy(): GroupBy {
		const configured = vscode.workspace
			.getConfiguration("codingAgentSessions")
			.get<string>("groupBy", "date");
		return configured === "project" ? "project" : "date";
	}

	get isFiltered(): boolean {
		return this.filterText.length > 0 || this.bookmarksOnly;
	}

	get filter(): string {
		return this.filterText;
	}

	setFilter(text: string): void {
		this.filterText = text.trim();
		this.refresh();
	}

	setBookmarksOnly(value: boolean): void {
		this.bookmarksOnly = value;
		void vscode.commands.executeCommand(
			"setContext",
			"codingAgentSessions.bookmarksOnly",
			value,
		);
		this.refresh();
	}

	get showingBookmarksOnly(): boolean {
		return this.bookmarksOnly;
	}

	/** Redraw from the sessions the store already has. */
	refresh(): void {
		this.changed.fire(undefined);
	}

	getTreeItem(element: TreeNode): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: TreeNode): Promise<TreeNode[]> {
		if (element instanceof SessionTreeItem) {
			return [];
		}

		if (element instanceof GroupTreeItem) {
			return element.sessions.map(
				(session) => new SessionTreeItem(session, this.bookmarks.has(session.id)),
			);
		}

		const sessions = this.visibleSessions(await this.currentSessions());
		if (sessions.length === 0) {
			return [];
		}

		return this.groupBy === "project"
			? this.groupByProject(sessions)
			: this.groupByDate(sessions);
	}

	/**
	 * The store's sessions as they stand — cached ones at first — rather than
	 * waiting for a full scan. The first call starts that scan.
	 */
	private async currentSessions(): Promise<SessionMeta[]> {
		if (!this.started) {
			this.started = true;
			void this.store.load();
		}
		// With nothing cached, wait for the scan's first results rather than
		// flash the "no sessions" welcome.
		if (this.store.sessions.length === 0 && this.store.isLoading) {
			await this.store.nextUpdate();
		}
		return this.store.sessions;
	}

	private visibleSessions(all: SessionMeta[]): SessionMeta[] {
		let sessions = all;
		if (this.bookmarksOnly) {
			sessions = sessions.filter((session) => this.bookmarks.has(session.id));
		}
		if (this.filterText) {
			sessions = this.store.filter(sessions, this.filterText);
		}
		return sessions;
	}

	private groupByDate(sessions: SessionMeta[]): GroupTreeItem[] {
		const groups = new Map<string, SessionMeta[]>();
		for (const session of sessions) {
			const date = session.lastTimestamp.slice(0, 10);
			const existing = groups.get(date);
			if (existing) {
				existing.push(session);
			} else {
				groups.set(date, [session]);
			}
		}

		return Array.from(groups.entries())
			.sort((a, b) => b[0].localeCompare(a[0]))
			.map(
				([date, group], index) =>
					new GroupTreeItem(
						date,
						formatDateHeading(date),
						group,
						"calendar",
						"date",
						// Today's sessions are what you almost always want; older
						// days stay folded unless a filter is narrowing the list.
						index > 0 && !this.isFiltered,
					),
			);
	}

	private groupByProject(sessions: SessionMeta[]): GroupTreeItem[] {
		const groups = new Map<string, SessionMeta[]>();
		for (const session of sessions) {
			const existing = groups.get(session.projectPath);
			if (existing) {
				existing.push(session);
			} else {
				groups.set(session.projectPath, [session]);
			}
		}

		return Array.from(groups.entries())
			.map(([projectPath, group]) => {
				const item = new GroupTreeItem(
					projectPath,
					group[0].projectName,
					group,
					"folder",
					"project",
					!this.isFiltered && this.collapsedGroups.has(projectPath),
				);
				item.tooltip = projectPath;
				item.resourceUri = vscode.Uri.file(projectPath);
				return item;
			})
			.sort((a, b) => String(a.label).localeCompare(String(b.label)));
	}
}

function describeSession(session: SessionMeta): string {
	const parts = [formatClock(session.lastTimestamp)];
	if (session.model) {
		parts.push(session.model);
	}
	parts.push(`${session.messageCount} msgs`);
	if (session.gitBranch && session.gitBranch !== "HEAD") {
		parts.push(session.gitBranch);
	}
	return parts.join(" · ");
}

function buildTooltip(session: SessionMeta): vscode.MarkdownString {
	const md = new vscode.MarkdownString();
	md.supportThemeIcons = true;

	if (session.title) {
		md.appendMarkdown(`**${escapeMarkdown(session.title)}**\n\n`);
	}
	if (session.preview && session.preview !== session.title) {
		md.appendMarkdown(`${escapeMarkdown(truncate(session.preview, 240))}\n\n`);
	}

	md.appendMarkdown(`$(folder) ${escapeMarkdown(session.projectPath)}\n\n`);
	md.appendMarkdown(`$(calendar) ${formatFull(session.timestamp)}`);
	if (session.lastTimestamp !== session.timestamp) {
		md.appendMarkdown(` → ${formatClock(session.lastTimestamp)}`);
	}
	md.appendMarkdown("\n\n");

	const facts = [
		`${session.userMessageCount} from you`,
		`${session.assistantMessageCount} from ${session.provider === "codex" ? "Codex" : "Claude"}`,
		`${session.toolCallCount} tool calls`,
		formatSize(session.fileSize),
	];
	md.appendMarkdown(`$(list-unordered) ${facts.join(" · ")}\n\n`);

	if (session.models.length > 0) {
		md.appendMarkdown(`$(hubot) ${session.models.join(", ")}\n\n`);
	}
	if (session.gitBranch) {
		md.appendMarkdown(`$(git-branch) ${escapeMarkdown(session.gitBranch)}\n\n`);
	}
	if (session.filesTouched.length > 0) {
		md.appendMarkdown(`$(edit) ${session.filesTouched.length} files edited\n\n`);
	}
	if (session.hasSidechains) {
		md.appendMarkdown("$(type-hierarchy) Includes subagent threads\n\n");
	}
	md.appendMarkdown(`$(key) \`${session.id}\``);

	return md;
}

function truncate(text: string, limit: number): string {
	const flattened = text.replace(/\s+/g, " ").trim();
	return flattened.length > limit ? flattened.slice(0, limit - 1) + "…" : flattened;
}

function escapeMarkdown(text: string): string {
	return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&");
}

export function formatDateHeading(date: string): string {
	const today = new Date();
	const todayKey = toLocalKey(today);
	if (date === todayKey) {
		return "Today";
	}
	const yesterday = new Date(today.getTime() - 86_400_000);
	if (date === toLocalKey(yesterday)) {
		return "Yesterday";
	}

	const parsed = new Date(date + "T00:00:00");
	if (Number.isNaN(parsed.getTime())) {
		return date;
	}
	const sameYear = parsed.getFullYear() === today.getFullYear();
	return parsed.toLocaleDateString(undefined, {
		weekday: "short",
		month: "short",
		day: "numeric",
		year: sameYear ? undefined : "numeric",
	});
}

function toLocalKey(date: Date): string {
	// The transcript stores UTC dates, and grouping on the UTC day keeps the
	// tree consistent with the timestamps shown on each row.
	return date.toISOString().slice(0, 10);
}

function formatClock(timestamp: string): string {
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) {
		return "";
	}
	return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function formatFull(timestamp: string): string {
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) {
		return timestamp;
	}
	return date.toLocaleString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

export function formatSize(bytes: number): string {
	if (!bytes) {
		return "0 B";
	}
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${Math.round(bytes / 1024)} KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
