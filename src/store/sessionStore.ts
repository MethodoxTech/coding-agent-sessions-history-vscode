/**
 * The index of every Claude Code session on this machine.
 *
 * Scanning every transcript is expensive — a single long session can be tens of
 * megabytes — so results are cached on disk and keyed on the transcript's size
 * and modification time. A transcript that has not changed is never re-read.
 */

import * as fs from "fs";
import * as path from "path";
import { CodexScanResume, parseCodexSession, scanCodexRollout } from "../codex/parser";

import { extractMatchContext, scanSessionMeta } from "../claude/parser";
import { parseSession } from "../claude/parser";
import { projectsRoot } from "../claude/paths";
import { ConversationMessage, SearchMatch, SessionMeta, SessionStats } from "../claude/types";

/**
 * Bumped whenever the cached shape or content of SessionMeta changes, so an
 * existing cache is discarded rather than serving stale results forever — a
 * transcript that has not changed is otherwise never re-read.
 */
const CACHE_VERSION = 5;

interface CacheEntry {
	mtimeMs: number;
	size: number;
	/** null records a transcript that holds no messages, so it is not rescanned. */
	meta: SessionMeta | null;
	/** Where to continue a Codex rollout's scan once it has grown. */
	resume?: CodexScanResume;
}

interface PersistedCache {
	version: number;
	entries: [string, CacheEntry][];
}

interface TranscriptFile {
	provider: "claude" | "codex";
	filePath: string;
	projectDir: string;
	mtimeMs: number;
	size: number;
}

export interface ScanProgress {
	scanned: number;
	total: number;
	/** Transcripts actually re-read this pass, as opposed to served from cache. */
	parsed: number;
}

/** How often a long scan publishes what it has so far, and saves the cache. */
const PARTIAL_INTERVAL_MS = 500;
const SAVE_INTERVAL_MS = 5000;

export type StoreEvent =
	| { type: "progress"; progress: ScanProgress }
	/** `final` is false while a scan is still running. */
	| { type: "sessions"; sessions: SessionMeta[]; final: boolean };

export interface DeepSearchOptions {
	includeToolCalls?: boolean;
	signal?: AbortSignal;
	onProgress?: (current: number, total: number) => void;
	onMatch?: (match: SearchMatch) => void;
}

export class SessionStore {
	private cache = new Map<string, CacheEntry>();
	private loaded: SessionMeta[] = [];
	private loading?: Promise<SessionMeta[]>;
	/** A load was asked for while one was running; run another pass after it. */
	private reloadRequested = false;
	private revision = 0;
	private readonly listeners = new Set<(event: StoreEvent) => void>();

	constructor(
		private readonly cachePath: string,
		private claudeHome: string,
		private codexHome = "",
		private agentFilter: "both" | "claude" | "codex" = "both",
	) {
		this.loadCacheFromDisk();
		// Show what the last session indexed straight away; the first scan
		// then only corrects what changed since.
		this.loaded = this.cachedSessions();
	}

	/** Partial and final scan results, and scan progress, as they happen. */
	subscribe(listener: (event: StoreEvent) => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	get isLoading(): boolean {
		return !!this.loading;
	}

	/** Resolves when the running scan next publishes sessions, or at once if none is running. */
	nextUpdate(): Promise<void> {
		const loading = this.loading;
		if (!loading) {
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			const subscription = this.subscribe((event) => {
				if (event.type === "sessions") {
					subscription.dispose();
					resolve();
				}
			});
			void loading.finally(() => {
				subscription.dispose();
				resolve();
			});
		});
	}

	private emit(event: StoreEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// One broken view should not stop the others updating.
			}
		}
	}

	/** Point the store at a different Claude Code home and drop stale results. */
	setClaudeHome(claudeHome: string): void {
		if (this.claudeHome === claudeHome) {
			return;
		}
		this.revision++;
		this.claudeHome = claudeHome;
		this.loaded = this.cachedSessions();
	}

	configure(
		claudeHome: string,
		codexHome: string,
		agentFilter: "both" | "claude" | "codex",
	): void {
		this.revision++;
		this.claudeHome = claudeHome;
		this.codexHome = codexHome;
		this.agentFilter = agentFilter;
		this.loaded = this.cachedSessions();
	}

	get sourceFilter(): string {
		return this.agentFilter;
	}
	get transcriptDirectories(): string[] {
		return [
			...(this.agentFilter !== "codex" ? [projectsRoot(this.claudeHome)] : []),
			...(this.agentFilter !== "claude" && this.codexHome
				? [
						path.join(this.codexHome, "sessions"),
						path.join(this.codexHome, "archived_sessions"),
					]
				: []),
		];
	}

	get projectsDirectory(): string {
		return this.transcriptDirectories.join("; ");
	}

	/**
	 * The current session list, without triggering a scan: cached results at
	 * first, then partial results while a scan runs, then the scan's result.
	 */
	get sessions(): SessionMeta[] {
		return this.loaded;
	}

	/**
	 * Index every transcript, re-reading only the ones that changed.
	 *
	 * Concurrent callers share one scan; the tree view and the browser panel
	 * both refresh on startup and would otherwise duplicate the work. A load
	 * asked for mid-scan runs one more (mostly cached) pass afterwards, so a
	 * change that landed after the first pass listed the files is not missed.
	 *
	 * Partial results and progress also go to `subscribe` listeners.
	 */
	async load(onProgress?: (progress: ScanProgress) => void): Promise<SessionMeta[]> {
		if (this.loading) {
			this.reloadRequested = true;
			return this.loading;
		}
		this.loading = (async () => {
			let revision: number;
			let sessions: SessionMeta[];
			do {
				revision = this.revision;
				this.reloadRequested = false;
				sessions = await this.scan(onProgress);
			} while (revision !== this.revision || this.reloadRequested);
			this.emit({ type: "sessions", sessions, final: true });
			return sessions;
		})().finally(() => {
			this.loading = undefined;
		});
		return this.loading;
	}

	private async scan(onProgress?: (progress: ScanProgress) => void): Promise<SessionMeta[]> {
		const revision = this.revision;
		// Newest first, so a cold index fills in from the top of the list.
		const files = this.listTranscripts().sort((a, b) => b.mtimeMs - a.mtimeMs);
		const sessions: SessionMeta[] = [];
		const seen = new Set<string>();
		let dirty = false;
		let parsed = 0;
		let lastPartial = Date.now();
		let lastSave = Date.now();

		const progress = (scanned: number): void => {
			const event = { scanned, total: files.length, parsed };
			onProgress?.(event);
			this.emit({ type: "progress", progress: event });
		};

		for (let index = 0; index < files.length; index++) {
			if (revision !== this.revision) return [];
			const file = files[index];
			seen.add(file.filePath);

			const cached = this.cache.get(file.filePath);
			if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size) {
				if (cached.meta) {
					sessions.push(cached.meta);
				}
				continue;
			}

			try {
				const { meta, resume } = await this.scanMeta(file, cached);
				this.cache.set(file.filePath, {
					mtimeMs: file.mtimeMs,
					size: file.size,
					meta: meta ?? null,
					resume,
				});
				dirty = true;
				parsed++;
				if (meta) {
					sessions.push(meta);
				}
			} catch {
				// An unreadable transcript should not take down the whole scan.
			}

			progress(index + 1);
			const now = Date.now();
			if (now - lastPartial >= PARTIAL_INTERVAL_MS && revision === this.revision) {
				lastPartial = now;
				// What is scanned so far, plus the previous results for the rest.
				const rest = files
					.slice(index + 1)
					.map((pending) => this.cache.get(pending.filePath)?.meta)
					.filter((meta): meta is SessionMeta => !!meta);
				this.loaded = sortByRecent([...sessions, ...rest]);
				this.emit({ type: "sessions", sessions: this.loaded, final: false });
			}
			if (dirty && now - lastSave >= SAVE_INTERVAL_MS) {
				// A long cold scan should not be lost if the window closes.
				lastSave = now;
				dirty = false;
				this.saveCacheToDisk();
			}
		}
		progress(files.length);

		if (revision !== this.revision) return [];

		// Drop cache entries for transcripts that no longer exist.
		for (const key of Array.from(this.cache.keys())) {
			if (!seen.has(key) && !fs.existsSync(key)) {
				this.cache.delete(key);
				dirty = true;
			}
		}

		if (dirty) {
			this.saveCacheToDisk();
		}

		this.loaded = sortByRecent(sessions);
		return this.loaded;
	}

	/** Cached entries that belong to the current homes and agent filter. */
	private cachedSessions(): SessionMeta[] {
		const directories = this.transcriptDirectories;
		const sessions: SessionMeta[] = [];
		for (const [filePath, entry] of this.cache) {
			if (entry.meta && directories.some((directory) => isInside(directory, filePath))) {
				sessions.push(entry.meta);
			}
		}
		return sortByRecent(sessions);
	}

	/**
	 * Index entry for one transcript, without waiting for a full scan. Used
	 * to open a session the list has not caught up with yet.
	 */
	async metaFor(filePath: string): Promise<SessionMeta | undefined> {
		const known = this.loaded.find((session) => session.filePath === filePath);
		if (known) {
			return known;
		}
		let stat: fs.Stats;
		try {
			stat = fs.statSync(filePath);
		} catch {
			return undefined;
		}
		const cached = this.cache.get(filePath);
		if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
			return cached.meta ?? undefined;
		}
		const file: TranscriptFile = {
			provider: this.isCodex(filePath) ? "codex" : "claude",
			filePath,
			projectDir: path.basename(path.dirname(filePath)),
			mtimeMs: stat.mtimeMs,
			size: stat.size,
		};
		const { meta, resume } = await this.scanMeta(file, cached);
		this.cache.set(filePath, {
			mtimeMs: stat.mtimeMs,
			size: stat.size,
			meta: meta ?? null,
			resume,
		});
		return meta;
	}

	/** Every `.jsonl` under `projects/`, with the stat data the cache keys on. */
	private listClaudeTranscripts(): TranscriptFile[] {
		const root = projectsRoot(this.claudeHome);
		const files: TranscriptFile[] = [];

		let projectDirs: string[];
		try {
			projectDirs = fs.readdirSync(root);
		} catch {
			return files;
		}

		for (const projectDir of projectDirs) {
			const projectPath = path.join(root, projectDir);
			let entries: fs.Dirent[];
			try {
				if (!fs.statSync(projectPath).isDirectory()) {
					continue;
				}
				entries = fs.readdirSync(projectPath, { withFileTypes: true });
			} catch {
				continue;
			}

			for (const entry of entries) {
				if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".jsonl")) {
					continue;
				}
				const filePath = path.join(projectPath, entry.name);
				try {
					const stat = fs.statSync(filePath);
					files.push({
						provider: "claude",
						filePath,
						projectDir,
						mtimeMs: stat.mtimeMs,
						size: stat.size,
					});
				} catch {
					// Vanished between readdir and stat.
				}
			}
		}

		return files;
	}

	private async scanMeta(
		file: TranscriptFile,
		cached?: CacheEntry,
	): Promise<{ meta: SessionMeta | undefined; resume?: CodexScanResume }> {
		if (file.provider === "codex") {
			// A growing rollout is read on from where the last scan stopped.
			return scanCodexRollout(file.filePath, file.size, cached?.resume);
		}
		const meta = await scanSessionMeta(file.filePath, file.projectDir, file.size);
		return {
			meta: meta
				? { ...meta, provider: "claude", nativeId: meta.id, id: "claude:" + meta.id }
				: undefined,
		};
	}
	private listTranscripts(): TranscriptFile[] {
		const files = this.agentFilter !== "codex" ? this.listClaudeTranscripts() : [];
		const walk = (dir: string): void => {
			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				const filePath = path.join(dir, entry.name);
				if (entry.isDirectory()) walk(filePath);
				else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
					try {
						const stat = fs.statSync(filePath);
						files.push({
							provider: "codex",
							filePath,
							projectDir: "",
							size: stat.size,
							mtimeMs: stat.mtimeMs,
						});
					} catch {
						/* File disappeared. */
					}
				}
			}
		};
		if (this.agentFilter !== "claude" && this.codexHome) {
			walk(path.join(this.codexHome, "sessions"));
			walk(path.join(this.codexHome, "archived_sessions"));
		}
		return files;
	}
	private isCodex(filePath: string): boolean {
		if (this.loaded.some((s) => s.filePath === filePath && s.provider === "codex")) return true;
		if (!this.codexHome) return false;
		return ["sessions", "archived_sessions"].some((dir) =>
			isInside(path.join(this.codexHome, dir), filePath),
		);
	}
	/** Full message list for one session. */
	async openSession(
		filePath: string,
		options: { toolOutputLimit?: number; includeSidechains?: boolean } = {},
	): Promise<ConversationMessage[]> {
		return this.isCodex(filePath)
			? parseCodexSession(filePath, options)
			: parseSession(filePath, options);
	}

	/** Fast filter over indexed metadata only. */
	filter(sessions: SessionMeta[], query: string): SessionMeta[] {
		const needle = query.trim().toLowerCase();
		if (!needle) {
			return sessions;
		}
		return sessions.filter((session) => {
			return (
				session.title?.toLowerCase().includes(needle) ||
				session.preview.toLowerCase().includes(needle) ||
				session.projectPath.toLowerCase().includes(needle) ||
				session.projectName.toLowerCase().includes(needle) ||
				session.gitBranch?.toLowerCase().includes(needle) ||
				session.id.toLowerCase().includes(needle)
			);
		});
	}

	/**
	 * Search the body of every message in every session.
	 *
	 * Results are reported through `onMatch` as they are found rather than
	 * collected, so the UI can fill in while a long search is still running.
	 */
	async deepSearch(query: string, options: DeepSearchOptions = {}): Promise<SearchMatch[]> {
		const { includeToolCalls = false, signal, onProgress, onMatch } = options;
		const needle = query.trim().toLowerCase();
		const matches: SearchMatch[] = [];
		if (!needle) {
			return matches;
		}

		const revision = this.revision;
		const files = this.listTranscripts();
		const metaByPath = new Map(this.loaded.map((session) => [session.filePath, session]));

		for (let index = 0; index < files.length; index++) {
			if (signal?.aborted || revision !== this.revision) {
				return matches;
			}
			const file = files[index];
			onProgress?.(index + 1, files.length);

			let meta = metaByPath.get(file.filePath);
			if (!meta) {
				const cached = this.cache.get(file.filePath);
				meta = cached?.meta ?? undefined;
			}
			if (!meta) {
				// A session indexed since the last scan; index it now so the
				// result row has a title and a project to show.
				try {
					meta = (await this.scanMeta(file)).meta;
				} catch {
					continue;
				}
				if (!meta) {
					continue;
				}
			}

			try {
				const messages =
					file.provider === "codex"
						? await parseCodexSession(file.filePath, {
								signal,
								toolOutputLimit: 100000,
							})
						: await parseSession(file.filePath, { signal, toolOutputLimit: 100000 });
				for (const message of messages) {
					if (signal?.aborted || revision !== this.revision) return matches;
					const candidates = [
						{ text: message.text, role: message.role as SearchMatch["role"] },
					];
					if (includeToolCalls)
						for (const call of message.toolCalls || [])
							candidates.push({
								text: call.name + " " + call.input + " " + (call.output || ""),
								role: "tool",
							});
					for (const candidate of candidates)
						if (candidate.text.toLowerCase().includes(needle)) {
							const match: SearchMatch = {
								meta,
								messageIndex: message.index,
								role: candidate.role,
								matchText: extractMatchContext(candidate.text, query),
								timestamp: message.timestamp,
							};
							matches.push(match);
							onMatch?.(match);
						}
				}
			} catch {
				/* Unreadable transcript. */
			}
		}

		return matches;
	}

	/** Distinct project paths across the indexed sessions, sorted by name. */
	projects(
		sessions: SessionMeta[] = this.loaded,
	): { path: string; name: string; count: number }[] {
		const byPath = new Map<string, { path: string; name: string; count: number }>();
		for (const session of sessions) {
			const existing = byPath.get(session.projectPath);
			if (existing) {
				existing.count++;
			} else {
				byPath.set(session.projectPath, {
					path: session.projectPath,
					name: session.projectName,
					count: 1,
				});
			}
		}
		return Array.from(byPath.values()).sort((a, b) => a.name.localeCompare(b.name));
	}

	computeStats(sessions: SessionMeta[] = this.loaded): SessionStats {
		let totalMessages = 0;
		let totalToolCalls = 0;
		let totalSizeBytes = 0;
		let totalTokens = 0;

		const daily = new Map<string, { count: number; messages: number }>();
		const byModel = new Map<string, number>();
		const byProject = new Map<string, { name: string; count: number; messages: number }>();
		const byBranch = new Map<string, number>();
		let longest: SessionMeta | undefined;

		for (const session of sessions) {
			totalMessages += session.messageCount;
			totalToolCalls += session.toolCallCount;
			totalSizeBytes += session.fileSize;
			totalTokens += session.totalTokens || 0;

			const date = session.timestamp.slice(0, 10);
			const day = daily.get(date) || { count: 0, messages: 0 };
			day.count++;
			day.messages += session.messageCount;
			daily.set(date, day);

			for (const model of session.models.length > 0 ? session.models : ["Unknown"]) {
				byModel.set(model, (byModel.get(model) || 0) + 1);
			}

			const project = byProject.get(session.projectPath) || {
				name: session.projectName,
				count: 0,
				messages: 0,
			};
			project.count++;
			project.messages += session.messageCount;
			byProject.set(session.projectPath, project);

			if (session.gitBranch) {
				byBranch.set(session.gitBranch, (byBranch.get(session.gitBranch) || 0) + 1);
			}

			if (!longest || session.messageCount > longest.messageCount) {
				longest = session;
			}
		}

		const dailyFrequency: SessionStats["dailyFrequency"] = [];
		const today = new Date();
		for (let daysAgo = 29; daysAgo >= 0; daysAgo--) {
			const date = new Date(today.getTime() - daysAgo * 86_400_000)
				.toISOString()
				.slice(0, 10);
			const day = daily.get(date);
			dailyFrequency.push({ date, count: day?.count || 0, messages: day?.messages || 0 });
		}

		let busiestDay: SessionStats["busiestDay"] = null;
		for (const [date, day] of daily) {
			if (!busiestDay || day.count > busiestDay.count) {
				busiestDay = { date, count: day.count };
			}
		}

		const totalSessions = sessions.length;
		const modelDistribution = Array.from(byModel.entries())
			.map(([model, count]) => ({
				model,
				count,
				percentage: totalSessions > 0 ? Math.round((count / totalSessions) * 100) : 0,
			}))
			.sort((a, b) => b.count - a.count);

		const projectActivity = Array.from(byProject.entries())
			.map(([projectPath, data]) => ({
				project: projectPath,
				name: data.name,
				count: data.count,
				messages: data.messages,
			}))
			.sort((a, b) => b.count - a.count)
			.slice(0, 12);

		const branchActivity = Array.from(byBranch.entries())
			.map(([branch, count]) => ({ branch, count }))
			.sort((a, b) => b.count - a.count)
			.slice(0, 10);

		const timestamps = sessions.map((session) => session.timestamp).sort();

		return {
			totalSessions,
			totalMessages,
			totalToolCalls,
			totalSizeBytes,
			totalTokens,
			averageMessageCount: totalSessions > 0 ? Math.round(totalMessages / totalSessions) : 0,
			dailyFrequency,
			modelDistribution,
			projectActivity,
			branchActivity,
			busiestDay,
			longestSession: longest
				? {
						id: longest.id,
						filePath: longest.filePath,
						title: longest.title || longest.preview.slice(0, 80),
						messageCount: longest.messageCount,
					}
				: null,
			firstSession: timestamps[0],
			lastSession: timestamps[timestamps.length - 1],
		};
	}

	/** Forget every cached result, so the next load re-reads all transcripts. */
	clearCache(): void {
		this.revision++;
		this.cache.clear();
		this.loaded = [];
		try {
			fs.unlinkSync(this.cachePath);
		} catch {
			// Already absent.
		}
	}

	private loadCacheFromDisk(): void {
		try {
			const raw = fs.readFileSync(this.cachePath, "utf8");
			const parsed = JSON.parse(raw) as PersistedCache;
			if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.entries)) {
				return;
			}
			for (const [filePath, entry] of parsed.entries) {
				if (entry && typeof entry.mtimeMs === "number") {
					this.cache.set(filePath, entry);
				}
			}
		} catch {
			// No cache yet, or it is unreadable — start cold.
		}
	}

	private saveCacheToDisk(): void {
		const payload: PersistedCache = {
			version: CACHE_VERSION,
			entries: Array.from(this.cache.entries()),
		};
		try {
			fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
			// Write through a temporary file so a crash mid-write cannot leave
			// a truncated cache that fails to parse on the next start.
			const temporary = this.cachePath + ".tmp";
			fs.writeFileSync(temporary, JSON.stringify(payload), "utf8");
			fs.renameSync(temporary, this.cachePath);
		} catch {
			// Losing the cache costs a rescan, nothing more.
		}
	}
}

function sortByRecent(sessions: SessionMeta[]): SessionMeta[] {
	return sessions.sort((a, b) => Date.parse(b.lastTimestamp) - Date.parse(a.lastTimestamp));
}

function isInside(directory: string, filePath: string): boolean {
	const relative = path.relative(directory, filePath);
	return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}
