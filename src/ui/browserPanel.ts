/**
 * The session browser: a full webview panel with the session list, the
 * conversation view, deep search and statistics.
 *
 * Parsed conversations stay in the extension host and are handed to the webview
 * one page at a time. A single session can hold tens of thousands of messages,
 * and posting all of them at once is what makes a transcript viewer freeze.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import { BookmarkStore } from "../store/bookmarks";
import { SessionStore } from "../store/sessionStore";
import { ConversationMessage, SessionMeta } from "../claude/types";
import { MessageScope, filterMessages, isMessageScope, parseQuery } from "../claude/filter";
import { anyDirname, fileExists } from "../claude/paths";
import { exportRange, exportSession, resumeSession } from "./actions";

/** Upper bound on messages sent to the webview in one batch. */
const MAX_BATCH = 500;

interface OpenSession {
	meta: SessionMeta;
	/** Every message in the session, in order. */
	messages: ConversationMessage[];
	/**
	 * What the webview is currently paging through: the whole session, or the
	 * subset a filter narrowed it to. Paging reads this rather than `messages`,
	 * so filtering needed no separate paging path.
	 */
	view: ConversationMessage[];
	query: string;
	scope: MessageScope;
}

export class BrowserPanel {
	private static instance: BrowserPanel | undefined;

	private readonly disposables: vscode.Disposable[] = [];
	private open?: OpenSession;
	private searchAbort?: AbortController;
	private ready = false;

	static show(
		context: vscode.ExtensionContext,
		store: SessionStore,
		bookmarks: BookmarkStore,
		session?: SessionMeta,
	): BrowserPanel {
		if (BrowserPanel.instance) {
			BrowserPanel.instance.panel.reveal(vscode.ViewColumn.Active);
			if (session) {
				void BrowserPanel.instance.openSession(session.filePath);
			}
			return BrowserPanel.instance;
		}

		const panel = vscode.window.createWebviewPanel(
			"codingAgentSessions.browser",
			"Coding Agent sessions",
			vscode.ViewColumn.Active,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
			},
		);

		BrowserPanel.instance = new BrowserPanel(panel, context, store, bookmarks, session);
		return BrowserPanel.instance;
	}

	static get current(): BrowserPanel | undefined {
		return BrowserPanel.instance;
	}

	private constructor(
		private readonly panel: vscode.WebviewPanel,
		private readonly context: vscode.ExtensionContext,
		private readonly store: SessionStore,
		private readonly bookmarks: BookmarkStore,
		private readonly pendingSession?: SessionMeta,
	) {
		this.panel.iconPath = {
			light: vscode.Uri.joinPath(context.extensionUri, "media", "activity-icon.svg"),
			dark: vscode.Uri.joinPath(context.extensionUri, "media", "activity-icon.svg"),
		};
		this.panel.webview.html = this.render(this.panel.webview);

		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
		this.panel.webview.onDidReceiveMessage(
			(message) => void this.handleMessage(message),
			null,
			this.disposables,
		);
		this.disposables.push(this.bookmarks.onDidChange(() => this.postBookmarks()));
	}

	/** Re-index and push the session list to the webview. */
	async refresh(): Promise<void> {
		this.searchAbort?.abort();
		if (!this.ready) {
			return;
		}
		await this.sendSessions();
	}

	async openSession(filePath: string): Promise<void> {
		this.post({ type: "busy", value: true, label: "Reading transcript" });
		try {
			const configuration = vscode.workspace.getConfiguration("codingAgentSessions");
			const messages = await this.store.openSession(filePath, {
				toolOutputLimit: configuration.get<number>("toolOutputLimit", 4000),
				includeSidechains: configuration.get<boolean>("showSidechains", true),
			});
			const meta =
				this.store.sessions.find((session) => session.filePath === filePath) ??
				(await this.store.load()).find((session) => session.filePath === filePath);

			if (!meta) {
				void vscode.window.showWarningMessage("That session is no longer on disk.");
				return;
			}

			this.open = { meta, messages, view: messages, query: "", scope: "all" };
			const pageSize = this.pageSize();
			this.post({
				type: "sessionOpened",
				meta,
				total: messages.length,
				messages: messages.slice(0, pageSize),
				bookmarked: this.bookmarks.has(meta.id),
			});
		} catch (error) {
			void vscode.window.showErrorMessage(
				`Could not read that transcript: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			this.post({ type: "busy", value: false });
		}
	}

	private pageSize(): number {
		return vscode.workspace.getConfiguration("codingAgentSessions").get<number>("pageSize", 60);
	}

	private async handleMessage(message: { type?: string; [key: string]: unknown }): Promise<void> {
		switch (message.type) {
			case "agentFilter": {
				if (["both", "claude", "codex"].includes(String(message.value))) {
					this.searchAbort?.abort();
					await vscode.workspace
						.getConfiguration("codingAgentSessions")
						.update("agentFilter", message.value, vscode.ConfigurationTarget.Global);
				}
				break;
			}
			case "ready": {
				this.ready = true;
				await this.sendSessions();
				if (this.pendingSession) {
					await this.openSession(this.pendingSession.filePath);
				}
				break;
			}

			case "reload": {
				this.store.clearCache();
				await this.sendSessions();
				break;
			}

			case "rescan": {
				await this.sendSessions();
				break;
			}

			case "openSession": {
				await this.openSession(String(message.filePath || ""));
				break;
			}

			case "loadMore": {
				if (!this.open) {
					break;
				}
				const offset = Number(message.offset) || 0;
				// "Load everything" asks for larger batches than a single page.
				// The cap keeps one batch small enough to render without the
				// view locking up, however large a number arrives.
				const requested = Number(message.chunk) || this.pageSize();
				const size = Math.min(Math.max(requested, 1), MAX_BATCH);
				this.post({
					type: "sessionPage",
					offset,
					messages: this.open.view.slice(offset, offset + size),
				});
				break;
			}

			case "jumpTo": {
				if (!this.open) {
					break;
				}
				// Deep-search results point at an index in the whole session, so
				// any filter is dropped before scrolling to one.
				this.open.view = this.open.messages;
				this.open.query = "";
				this.open.scope = "all";

				const target = Number(message.index) || 0;
				const end = Math.min(this.open.messages.length, target + this.pageSize());
				this.post({
					type: "sessionPage",
					offset: 0,
					replace: true,
					messages: this.open.messages.slice(0, end),
					scrollTo: target,
					total: this.open.messages.length,
					query: "",
					scope: "all",
				});
				break;
			}

			case "filterSession": {
				if (!this.open) {
					break;
				}
				const query = String(message.query || "");
				const scope: MessageScope = isMessageScope(message.scope) ? message.scope : "all";
				const { messages: matched } = filterMessages(this.open.messages, query, scope);

				this.open.view = matched;
				this.open.query = query;
				this.open.scope = scope;

				this.post({
					type: "sessionFiltered",
					query,
					scope,
					// The webview highlights matches, and parsing the query once
					// here keeps both ends agreeing on what a term is.
					terms: parseQuery(query),
					total: matched.length,
					sessionTotal: this.open.messages.length,
					messages: matched.slice(0, this.pageSize()),
				});
				break;
			}

			case "deepSearch": {
				await this.runDeepSearch(String(message.query || ""));
				break;
			}

			case "cancelSearch": {
				this.searchAbort?.abort();
				break;
			}

			case "stats": {
				const sessions = await this.store.load();
				this.post({ type: "stats", stats: this.store.computeStats(sessions) });
				break;
			}

			case "toggleBookmark": {
				const id = String(message.id || "");
				if (id) {
					await this.bookmarks.toggle(id);
				}
				break;
			}

			case "resume": {
				const meta = this.findSession(String(message.filePath || ""));
				if (meta) {
					resumeSession(meta);
				}
				break;
			}

			case "export": {
				const meta = this.findSession(String(message.filePath || ""));
				if (meta) {
					await exportSession(this.store, meta);
				}
				break;
			}

			case "exportRange": {
				await exportRange(
					this.store,
					String(message.start || ""),
					String(message.end || ""),
				);
				break;
			}

			case "openExternal": {
				const url = String(message.url || "");
				if (/^https?:\/\//i.test(url)) {
					void vscode.env.openExternal(vscode.Uri.parse(url));
				}
				break;
			}

			case "openFile": {
				const filePath = String(message.filePath || "");
				if (!fileExists(filePath)) {
					void vscode.window.showWarningMessage(
						`${path.basename(filePath)} is no longer on disk.`,
					);
					break;
				}
				await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(filePath));
				break;
			}

			case "revealFile": {
				const filePath = String(message.filePath || "");
				if (fileExists(filePath)) {
					await vscode.commands.executeCommand(
						"revealFileInOS",
						vscode.Uri.file(filePath),
					);
				}
				break;
			}

			case "previewFile": {
				this.previewFile(String(message.filePath || ""), String(message.title || ""));
				break;
			}

			case "copy": {
				await vscode.env.clipboard.writeText(String(message.text || ""));
				break;
			}

			default:
				break;
		}
	}

	private findSession(filePath: string): SessionMeta | undefined {
		return this.store.sessions.find((session) => session.filePath === filePath);
	}

	private async sendSessions(): Promise<void> {
		this.post({ type: "busy", value: true, label: "Indexing sessions" });
		const sessions = await this.store.load((progress) => {
			this.post({ type: "scanProgress", ...progress });
		});
		this.post({
			type: "sessions",
			agentFilter: this.store.sourceFilter,
			sessions,
			projects: this.store.projects(sessions),
			bookmarks: this.bookmarks.all,
			projectsDirectory: this.store.projectsDirectory,
		});
		this.post({ type: "busy", value: false });
	}

	private postBookmarks(): void {
		this.post({ type: "bookmarks", bookmarks: this.bookmarks.all });
	}

	private async runDeepSearch(query: string): Promise<void> {
		this.searchAbort?.abort();
		const controller = new AbortController();
		this.searchAbort = controller;

		this.post({ type: "searchStart", query });
		const includeToolCalls = vscode.workspace
			.getConfiguration("codingAgentSessions")
			.get<boolean>("deepSearchIncludesToolCalls", false);

		await this.store.deepSearch(query, {
			includeToolCalls,
			signal: controller.signal,
			onProgress: (current, total) => {
				if (!controller.signal.aborted) {
					this.post({ type: "searchProgress", current, total });
				}
			},
			onMatch: (match) => {
				if (!controller.signal.aborted) {
					this.post({ type: "searchMatch", match });
				}
			},
		});

		if (!controller.signal.aborted) {
			this.post({ type: "searchDone" });
		}
		if (this.searchAbort === controller) {
			this.searchAbort = undefined;
		}
	}

	/**
	 * Render a file the session produced.
	 *
	 * Markdown goes through VS Code's own preview. An artifact is a standalone
	 * HTML document, so it gets its own webview; scripts are enabled because an
	 * artifact without them is a blank page, and it is confined to the
	 * directory it was written into.
	 */
	private previewFile(filePath: string, title: string): void {
		if (!fileExists(filePath)) {
			void vscode.window.showWarningMessage(
				`${path.basename(filePath)} is no longer on disk. Artifacts are written to a temporary folder that is cleared when the machine restarts.`,
			);
			return;
		}

		if (/\.(md|markdown)$/i.test(filePath)) {
			void vscode.commands.executeCommand("markdown.showPreview", vscode.Uri.file(filePath));
			return;
		}

		let html: string;
		try {
			html = fs.readFileSync(filePath, "utf8");
		} catch (error) {
			void vscode.window.showErrorMessage(
				`Could not read that file: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}

		const directory = anyDirname(filePath);
		const preview = vscode.window.createWebviewPanel(
			"codingAgentSessions.artifact",
			title ? `Preview — ${title.slice(0, 40)}` : "Preview",
			vscode.ViewColumn.Beside,
			{
				enableScripts: true,
				localResourceRoots: directory ? [vscode.Uri.file(directory)] : [],
			},
		);

		preview.webview.html = /^\s*<(!doctype|html)/i.test(html)
			? html
			: `<!DOCTYPE html><html><head><meta charset="utf-8">` +
				`<meta name="viewport" content="width=device-width, initial-scale=1">` +
				`</head><body>${html}</body></html>`;
	}

	private post(message: unknown): void {
		void this.panel.webview.postMessage(message);
	}

	private render(webview: vscode.Webview): string {
		const media = (file: string): vscode.Uri =>
			webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", file));

		const nonce = crypto.randomBytes(16).toString("base64");
		const csp = [
			"default-src 'none'",
			`img-src ${webview.cspSource} data:`,
			`style-src ${webview.cspSource} 'unsafe-inline'`,
			`font-src ${webview.cspSource}`,
			`script-src 'nonce-${nonce}'`,
		].join("; ");

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<link href="${media("browser.css")}" rel="stylesheet">
	<title>Coding Agent sessions</title>
</head>
<body>
	<div class="app">
		<header class="toolbar">
			<div class="tabs" role="tablist">
				<button class="tab is-active" data-tab="sessions" role="tab">Sessions</button>
				<button class="tab" data-tab="stats" role="tab">Statistics</button>
			</div>
			<div class="toolbar-actions">
				<label class="search" for="search">
					<span class="search-icon" aria-hidden="true"></span>
					<input id="search" type="search" placeholder="Filter sessions" spellcheck="false" autocomplete="off">
				</label>
				<label class="toggle" title="Search inside every message rather than titles only">
					<input id="deep" type="checkbox">
					<span>Deep search</span>
				</label>
				<select id="agent-filter" aria-label="Filter by coding agent"><option value="both">Both agents</option><option value="claude">Claude Code</option><option value="codex">Codex</option></select>
				<select id="project" aria-label="Filter by project">
					<option value="">All projects</option>
				</select>
				<button id="bookmarks" class="icon-button" type="button" title="Show bookmarked sessions only" aria-pressed="false"></button>
				<button id="reload" class="icon-button" type="button" title="Rescan every transcript"></button>
			</div>
		</header>
		<div class="progress" id="progress" hidden><div class="progress-fill" id="progress-fill"></div></div>
		<main class="main">
			<aside class="sidebar" id="sidebar">
				<div class="sidebar-status" id="sidebar-status" hidden></div>
				<div class="list" id="list" role="list"></div>
			</aside>
			<section class="detail" id="detail">
				<div class="empty" id="welcome">
					<h1>Coding Agent sessions</h1>
					<p>Local Claude Code and Codex sessions, read straight from your local transcripts.</p>
					<p class="muted">Pick a session on the left to read it.</p>
				</div>
				<article class="conversation" id="conversation" hidden></article>
				<section class="stats" id="stats" hidden></section>
			</section>
		</main>
	</div>
	<div class="menu" id="menu" role="menu" hidden></div>
	<script nonce="${nonce}" src="${media("markdown.js")}"></script>
	<script nonce="${nonce}" src="${media("browser.js")}"></script>
</body>
</html>`;
	}

	dispose(): void {
		BrowserPanel.instance = undefined;
		this.searchAbort?.abort();
		this.panel.dispose();
		while (this.disposables.length) {
			this.disposables.pop()?.dispose();
		}
	}
}
