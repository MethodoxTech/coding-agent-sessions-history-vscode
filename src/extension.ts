/**
 * Coding Agent Sessions History — entry point.
 *
 * Everything the extension shows comes from the JSON Lines transcripts the coding agent
 * already writes under its home directory. Nothing is sent anywhere, and
 * nothing is written back into that directory.
 */

import * as path from "path";
import * as vscode from "vscode";

import { BookmarkStore } from "./store/bookmarks";
import { BrowserPanel } from "./ui/browserPanel";
import { SessionStore } from "./store/sessionStore";
import { SessionMeta } from "./claude/types";
import { SessionTreeItem, SessionTreeProvider } from "./ui/sessionTree";
import { exportRange, exportSession, promptForRange, resumeSession } from "./ui/actions";
import { fileExists, resolveClaudeHome, resolveCodexHome } from "./claude/paths";

export function activate(context: vscode.ExtensionContext): void {
	const claudeHome = currentClaudeHome();
	const store = new SessionStore(
		path.join(context.globalStorageUri.fsPath, "session-index.json"),
		claudeHome,
		currentCodexHome(),
		currentAgentFilter(),
	);
	const bookmarks = new BookmarkStore(context.globalState);
	const tree = new SessionTreeProvider(store, bookmarks);

	// The tree is contributed behind a `when` clause on
	// codingAgentSessions.showInActivityBar, so it can be hidden without uninstalling
	// the extension. Registration is independent of that visibility, but if it
	// ever fails the browser panel should still work.
	let view: vscode.TreeView<unknown> | undefined;
	try {
		view = vscode.window.createTreeView("codingAgentSessions.tree", {
			treeDataProvider: tree,
			showCollapseAll: true,
		});
		context.subscriptions.push(view);
	} catch {
		view = undefined;
	}

	context.subscriptions.push(bookmarks);
	void vscode.commands.executeCommand("setContext", "codingAgentSessions.bookmarksOnly", false);

	context.subscriptions.push(bookmarks.onDidChange(() => tree.refresh()));

	// === Commands ===

	const register = (id: string, handler: (...args: never[]) => unknown): void => {
		context.subscriptions.push(
			vscode.commands.registerCommand(id, handler as (...args: unknown[]) => unknown),
		);
	};

	register("codingAgentSessions.selectAgent", async () => {
		const choice = await vscode.window.showQuickPick(
			[
				{ label: "Both", value: "both" },
				{ label: "Claude Code", value: "claude" },
				{ label: "Codex", value: "codex" },
			],
			{ title: "Show sessions from" },
		);
		if (choice)
			await vscode.workspace
				.getConfiguration("codingAgentSessions")
				.update("agentFilter", choice.value, vscode.ConfigurationTarget.Global);
	});
	register("codingAgentSessions.openBrowser", () => {
		BrowserPanel.show(context, store, bookmarks);
	});

	register("codingAgentSessions.openSession", async (target?: SessionMeta | SessionTreeItem) => {
		const session = resolveSession(target);
		if (session) {
			BrowserPanel.show(context, store, bookmarks, session);
		}
	});

	register("codingAgentSessions.refresh", async () => {
		tree.refresh();
		await BrowserPanel.current?.refresh();
	});

	register("codingAgentSessions.rescan", async () => {
		store.clearCache();
		tree.refresh();
		await BrowserPanel.current?.refresh();
		void vscode.window.showInformationMessage("Rescanning every transcript.");
	});

	register("codingAgentSessions.search", async () => {
		const query = await vscode.window.showInputBox({
			title: "Filter sessions",
			prompt: "Match a title, first message, project or branch. Leave empty to clear.",
			value: tree.filter,
		});
		if (query === undefined) {
			return;
		}
		tree.setFilter(query);
		if (view) {
			view.description = query ? `filtered: ${query}` : undefined;
		}
	});

	register("codingAgentSessions.toggleBookmarkFilter", () => {
		tree.setBookmarksOnly(true);
	});

	register("codingAgentSessions.clearBookmarkFilter", () => {
		tree.setBookmarksOnly(false);
	});

	register("codingAgentSessions.groupByDate", async () => {
		await setGroupBy("date");
		tree.refresh();
	});

	register("codingAgentSessions.groupByProject", async () => {
		await setGroupBy("project");
		tree.refresh();
	});

	register(
		"codingAgentSessions.toggleBookmark",
		async (target?: SessionMeta | SessionTreeItem) => {
			const session = resolveSession(target);
			if (session) {
				await bookmarks.toggle(session.id);
			}
		},
	);

	register(
		"codingAgentSessions.removeBookmark",
		async (target?: SessionMeta | SessionTreeItem) => {
			const session = resolveSession(target);
			if (session) {
				await bookmarks.remove(session.id);
			}
		},
	);

	register("codingAgentSessions.resume", async (target?: SessionMeta | SessionTreeItem) => {
		const session =
			resolveSession(target) ?? (await pickSession(store, "Resume which session?"));
		if (session) {
			resumeSession(session);
		}
	});

	register(
		"codingAgentSessions.exportMarkdown",
		async (target?: SessionMeta | SessionTreeItem) => {
			const session =
				resolveSession(target) ?? (await pickSession(store, "Export which session?"));
			if (session) {
				await exportSession(store, session);
			}
		},
	);

	register("codingAgentSessions.exportRange", async () => {
		const range = await promptForRange();
		if (range) {
			await exportRange(store, range.start, range.end);
		}
	});

	register("codingAgentSessions.showStats", () => {
		const panel = BrowserPanel.show(context, store, bookmarks);
		void panel;
		void vscode.commands.executeCommand("codingAgentSessions.openBrowser");
	});

	register("codingAgentSessions.copyTitle", async (target?: SessionMeta | SessionTreeItem) => {
		const session = resolveSession(target);
		if (!session) {
			return;
		}
		// A session with no generated title still shows its first message as
		// one, so copy whatever the list is actually displaying.
		const title = session.title || session.preview || session.id;
		await vscode.env.clipboard.writeText(title);
		void vscode.window.showInformationMessage(`Copied "${truncate(title, 60)}"`);
	});

	register(
		"codingAgentSessions.copySessionId",
		async (target?: SessionMeta | SessionTreeItem) => {
			const session = resolveSession(target);
			if (session) {
				await vscode.env.clipboard.writeText(session.nativeId || session.id);
				void vscode.window.showInformationMessage(`Copied ${session.id}`);
			}
		},
	);

	register(
		"codingAgentSessions.openTranscript",
		async (target?: SessionMeta | SessionTreeItem) => {
			const session = resolveSession(target);
			if (session) {
				await vscode.commands.executeCommand(
					"vscode.open",
					vscode.Uri.file(session.filePath),
				);
			}
		},
	);

	register(
		"codingAgentSessions.revealTranscript",
		async (target?: SessionMeta | SessionTreeItem) => {
			const session = resolveSession(target);
			if (session) {
				await vscode.commands.executeCommand(
					"revealFileInOS",
					vscode.Uri.file(session.filePath),
				);
			}
		},
	);

	register(
		"codingAgentSessions.openProjectFolder",
		async (target?: { resourceUri?: vscode.Uri }) => {
			const folder = target?.resourceUri;
			if (!folder || !fileExists(folder.fsPath)) {
				void vscode.window.showWarningMessage("That project folder no longer exists.");
				return;
			}
			await vscode.commands.executeCommand("revealFileInOS", folder);
		},
	);

	register("codingAgentSessions.openSettings", async () => {
		await vscode.commands.executeCommand(
			"workbench.action.openSettings",
			"@ext:methodox.coding-agent-sessions-history",
		);
	});

	// === Reacting to the outside world ===

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(async (event) => {
			if (
				event.affectsConfiguration("codingAgentSessions.claudeHome") ||
				event.affectsConfiguration("codingAgentSessions.codexHome") ||
				event.affectsConfiguration("codingAgentSessions.agentFilter")
			) {
				store.configure(currentClaudeHome(), currentCodexHome(), currentAgentFilter());
				watcher.reconfigure();
				tree.refresh();
				await BrowserPanel.current?.refresh();
			} else if (event.affectsConfiguration("codingAgentSessions.groupBy")) {
				tree.refresh();
			} else if (event.affectsConfiguration("codingAgentSessions.autoRefresh")) {
				watcher.reconfigure();
			}
		}),
	);

	const watcher = new TranscriptWatcher(store, () => {
		tree.refresh();
		void BrowserPanel.current?.refresh();
	});
	context.subscriptions.push(watcher);
	watcher.reconfigure();
}

export function deactivate(): void {
	// Nothing to tear down beyond the disposables registered above.
}

function currentCodexHome(): string {
	return resolveCodexHome(
		vscode.workspace.getConfiguration("codingAgentSessions").get<string>("codexHome", ""),
	);
}
function currentAgentFilter(): "both" | "claude" | "codex" {
	return vscode.workspace
		.getConfiguration("codingAgentSessions")
		.get<"both" | "claude" | "codex">("agentFilter", "both");
}
function currentClaudeHome(): string {
	return resolveClaudeHome(
		vscode.workspace.getConfiguration("codingAgentSessions").get<string>("claudeHome", ""),
	);
}

async function setGroupBy(value: "date" | "project"): Promise<void> {
	await vscode.workspace
		.getConfiguration("codingAgentSessions")
		.update("groupBy", value, vscode.ConfigurationTarget.Global);
}

function truncate(text: string, limit: number): string {
	const flattened = text.replace(/\s+/g, " ").trim();
	return flattened.length > limit ? flattened.slice(0, limit - 1) + "…" : flattened;
}

function resolveSession(target?: SessionMeta | SessionTreeItem): SessionMeta | undefined {
	if (!target) {
		return undefined;
	}
	if (target instanceof SessionTreeItem) {
		return target.session;
	}
	return "filePath" in target ? target : undefined;
}

async function pickSession(store: SessionStore, title: string): Promise<SessionMeta | undefined> {
	const sessions = await store.load();
	if (sessions.length === 0) {
		void vscode.window.showWarningMessage("No coding agent sessions found yet.");
		return undefined;
	}

	const picked = await vscode.window.showQuickPick(
		sessions.map((session) => ({
			label: session.title || session.preview.slice(0, 80) || session.id,
			description: `${session.projectName} · ${session.messageCount} msgs`,
			detail: new Date(session.lastTimestamp).toLocaleString(),
			session,
		})),
		{ title, matchOnDescription: true, matchOnDetail: true },
	);

	return picked?.session;
}

/**
 * Watch the transcripts folder so the list keeps up with a running session.
 *
 * The agent appends to the active transcript continuously, so change events
 * are debounced hard; refreshing on every write would rescan constantly.
 */
class TranscriptWatcher implements vscode.Disposable {
	private watchers: vscode.FileSystemWatcher[] = [];
	private timer?: NodeJS.Timeout;

	constructor(
		private readonly store: SessionStore,
		private readonly onChange: () => void,
	) {}

	reconfigure(): void {
		this.stop();
		const enabled = vscode.workspace
			.getConfiguration("codingAgentSessions")
			.get<boolean>("autoRefresh", true);
		if (!enabled) {
			return;
		}

		for (const directory of this.store.transcriptDirectories) {
			const watcher = vscode.workspace.createFileSystemWatcher(
				new vscode.RelativePattern(directory, "**/*.jsonl"),
			);
			this.watchers.push(watcher);
			const schedule = (): void => this.schedule();
			watcher.onDidCreate(schedule);
			watcher.onDidChange(schedule);
			watcher.onDidDelete(schedule);
		}
	}

	private schedule(): void {
		if (this.timer) {
			clearTimeout(this.timer);
		}
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.onChange();
		}, 4000);
	}

	private stop(): void {
		for (const watcher of this.watchers) watcher.dispose();
		this.watchers = [];
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	dispose(): void {
		this.stop();
	}
}
