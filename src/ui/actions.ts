/**
 * Actions shared by the tree view, the command palette and the browser panel,
 * so a session behaves the same however it was reached.
 */

import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import { SessionStore } from "../store/sessionStore";
import { SessionMeta } from "../claude/types";
import { fileExists } from "../claude/paths";
import { sessionToMarkdown, sessionsToMarkdown } from "./markdownExport";

/**
 * Reopen a session in a terminal.
 *
 * Claude Code resolves `--resume` against the session store for the current
 * working directory, so the terminal has to start in the project the session
 * belongs to — otherwise the id will not be found.
 */
export function resumeSession(session: SessionMeta): void {
	const configuration = vscode.workspace.getConfiguration("codingAgentSessions");
	const template = configuration.get<string>(
		session.provider === "codex" ? "codexResumeCommand" : "resumeCommand",
		session.provider === "codex" ? "codex resume {sessionId}" : "claude --resume {sessionId}",
	);

	const projectExists = fileExists(session.projectPath);
	const terminal = vscode.window.createTerminal({
		name: `${session.provider === "codex" ? "Codex" : "Claude"} — ${session.projectName || "session"}`,
		cwd: projectExists ? session.projectPath : undefined,
	});

	const command = template
		.replace(/\{sessionId\}/g, session.nativeId || session.id)
		.replace(/\{projectPath\}/g, session.projectPath);

	terminal.show();
	terminal.sendText(command);

	if (!projectExists) {
		void vscode.window.showWarningMessage(
			`${session.projectPath} no longer exists, so the terminal opened in the default directory. The agent may not find this session from there.`,
		);
	}
}

export async function exportSession(store: SessionStore, session: SessionMeta): Promise<void> {
	const configuration = vscode.workspace.getConfiguration("codingAgentSessions");
	const messages = await store.openSession(session.filePath, {
		toolOutputLimit: configuration.get<number>("toolOutputLimit", 4000),
	});

	const target = await vscode.window.showSaveDialog({
		defaultUri: vscode.Uri.file(path.join(defaultExportDirectory(), suggestFileName(session))),
		filters: { Markdown: ["md"] },
		title: "Export session",
	});
	if (!target) {
		return;
	}

	const markdown = sessionToMarkdown(messages, session);
	await vscode.workspace.fs.writeFile(target, Buffer.from(markdown, "utf8"));
	await offerToOpen(target, `Exported ${session.messageCount} messages.`);
}

export async function exportRange(
	store: SessionStore,
	startDate: string,
	endDate: string,
): Promise<void> {
	const sessions = (await store.load()).filter((session) => {
		const day = session.timestamp.slice(0, 10);
		return day >= startDate && day <= endDate;
	});

	if (sessions.length === 0) {
		void vscode.window.showWarningMessage(
			`No sessions between ${startDate} and ${endDate}. Pick a wider range.`,
		);
		return;
	}

	const target = await vscode.window.showSaveDialog({
		defaultUri: vscode.Uri.file(
			path.join(
				defaultExportDirectory(),
				`coding-agent-sessions-${startDate}-to-${endDate}.md`,
			),
		),
		filters: { Markdown: ["md"] },
		title: "Export sessions",
	});
	if (!target) {
		return;
	}

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: "Exporting sessions",
			cancellable: true,
		},
		async (progress, token) => {
			const configuration = vscode.workspace.getConfiguration("codingAgentSessions");
			const limit = configuration.get<number>("toolOutputLimit", 4000);
			const entries: {
				meta: SessionMeta;
				messages: Awaited<ReturnType<SessionStore["openSession"]>>;
			}[] = [];

			for (let index = 0; index < sessions.length; index++) {
				if (token.isCancellationRequested) {
					return;
				}
				const session = sessions[index];
				progress.report({
					message: `${index + 1} of ${sessions.length}`,
					increment: 100 / sessions.length,
				});
				entries.push({
					meta: session,
					messages: await store.openSession(session.filePath, { toolOutputLimit: limit }),
				});
			}

			const markdown = sessionsToMarkdown(
				entries,
				`Coding Agent sessions, ${startDate} to ${endDate}`,
			);
			await vscode.workspace.fs.writeFile(target, Buffer.from(markdown, "utf8"));
			await offerToOpen(target, `Exported ${entries.length} sessions.`);
		},
	);
}

/** Ask for a date range, defaulting to the last 30 days. */
export async function promptForRange(): Promise<{ start: string; end: string } | undefined> {
	const today = new Date().toISOString().slice(0, 10);
	const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);

	const start = await vscode.window.showInputBox({
		title: "Export sessions — start date",
		value: thirtyDaysAgo,
		prompt: "Earliest day to include, as YYYY-MM-DD",
		validateInput: validateDate,
	});
	if (!start) {
		return undefined;
	}

	const end = await vscode.window.showInputBox({
		title: "Export sessions — end date",
		value: today,
		prompt: "Latest day to include, as YYYY-MM-DD",
		validateInput: validateDate,
	});
	if (!end) {
		return undefined;
	}

	return start <= end ? { start, end } : { start: end, end: start };
}

function validateDate(value: string): string | undefined {
	return /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? undefined : "Use the format YYYY-MM-DD";
}

async function offerToOpen(target: vscode.Uri, message: string): Promise<void> {
	const open = "Open";
	const choice = await vscode.window.showInformationMessage(
		`${message} ${path.basename(target.fsPath)}`,
		open,
	);
	if (choice === open) {
		await vscode.commands.executeCommand("vscode.open", target);
	}
}

function defaultExportDirectory(): string {
	const workspace = vscode.workspace.workspaceFolders?.[0];
	return workspace ? workspace.uri.fsPath : os.homedir();
}

function suggestFileName(session: SessionMeta): string {
	const base = (session.title || session.preview || session.id)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
	const day = session.timestamp.slice(0, 10);
	return `${day}-${base || session.id}.md`;
}
