/**
 * Bookmarked sessions, kept in the extension's global state so they follow the
 * user across workspaces.
 */

import * as vscode from "vscode";

const STORAGE_KEY = "codingAgentSessions.bookmarks";

export class BookmarkStore {
	private ids: Set<string>;
	private readonly changed = new vscode.EventEmitter<void>();

	/** Fires whenever the bookmark set changes, so views can re-render. */
	readonly onDidChange = this.changed.event;

	constructor(private readonly memento: vscode.Memento) {
		this.ids = new Set(memento.get<string[]>(STORAGE_KEY, []));
	}

	has(sessionId: string): boolean {
		return this.ids.has(sessionId);
	}

	get all(): string[] {
		return Array.from(this.ids);
	}

	get size(): number {
		return this.ids.size;
	}

	async toggle(sessionId: string): Promise<boolean> {
		if (this.ids.has(sessionId)) {
			this.ids.delete(sessionId);
		} else {
			this.ids.add(sessionId);
		}
		await this.persist();
		return this.ids.has(sessionId);
	}

	async remove(sessionId: string): Promise<void> {
		if (this.ids.delete(sessionId)) {
			await this.persist();
		}
	}

	private async persist(): Promise<void> {
		await this.memento.update(STORAGE_KEY, Array.from(this.ids));
		this.changed.fire();
	}

	dispose(): void {
		this.changed.dispose();
	}
}
