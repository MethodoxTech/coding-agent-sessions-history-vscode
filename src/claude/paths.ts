/**
 * Locating Claude Code's data on disk, and turning its encoded folder names
 * back into real paths.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Resolve the Claude Code home directory (the one containing `projects/`).
 *
 * Precedence: an explicit setting, then `$CLAUDE_CONFIG_DIR` which the CLI
 * itself honours, then the `~/.claude` default.
 */
export function resolveClaudeHome(configured?: string): string {
	const explicit = (configured || "").trim();
	if (explicit) {
		return expandHome(explicit);
	}
	const fromEnv = (process.env.CLAUDE_CONFIG_DIR || "").trim();
	if (fromEnv) {
		return expandHome(fromEnv);
	}
	return path.join(os.homedir(), ".claude");
}

export function projectsRoot(claudeHome: string): string {
	return path.join(claudeHome, "projects");
}

function expandHome(p: string): string {
	if (p === "~") {
		return os.homedir();
	}
	if (p.startsWith("~/") || p.startsWith("~\\")) {
		return path.join(os.homedir(), p.slice(2));
	}
	return p;
}

/**
 * Best-effort reconstruction of a project path from its encoded folder name.
 *
 * Claude Code builds the folder name by replacing every path separator with
 * "-", but it replaces other characters the same way, so `_` and `.` in a real
 * directory name are indistinguishable from separators once encoded:
 *
 *   C:\Projects\App_2025   ->   C--Projects-App-2025
 *
 * That makes decoding inherently lossy, which is why {@link SessionMeta}'s
 * `projectPath` is taken from the `cwd` field recorded inside the transcript
 * whenever one is present. This function is only the fallback for transcripts
 * that carry no `cwd` at all, and its result is verified against the filesystem
 * where possible.
 */
export function decodeProjectDir(projectDir: string): string {
	const windows = projectDir.match(/^([A-Za-z])--(.*)$/);
	if (windows) {
		const drive = windows[1].toUpperCase();
		const rest = windows[2].replace(/-/g, "\\");
		return recoverExisting(`${drive}:\\${rest}`, "\\") ?? `${drive}:\\${rest}`;
	}
	const posix = "/" + projectDir.replace(/^-+/, "").replace(/-/g, "/");
	return recoverExisting(posix, "/") ?? posix;
}

/**
 * Walk a lossily decoded path segment by segment, and wherever the segment does
 * not exist, try re-joining it with the following segments using "_", "-" or
 * "." until a directory that does exist is found. This repairs the common case
 * (`App_2025` decoded as `App/2025`) without guessing when the folder is gone.
 */
function recoverExisting(candidate: string, sep: string): string | undefined {
	try {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	} catch {
		return undefined;
	}

	const parts = candidate.split(sep);
	if (parts.length < 2) {
		return undefined;
	}

	// The root is whatever comes before the first separator (a drive on
	// Windows, an empty string on POSIX); it is never a guessable segment.
	let resolved = parts[0];
	let index = 1;

	while (index < parts.length) {
		let matched = false;
		// Prefer the longest join, so `A_B_C` is recovered before `A_B`.
		for (let end = parts.length; end > index; end--) {
			const joiners = end === index + 1 ? [""] : ["_", "-", "."];
			for (const joiner of joiners) {
				const segment = parts.slice(index, end).join(joiner);
				const next = resolved === "" ? sep + segment : resolved + sep + segment;
				try {
					if (fs.existsSync(next)) {
						resolved = next;
						index = end;
						matched = true;
						break;
					}
				} catch {
					// Unreadable path — treat as a miss and keep looking.
				}
			}
			if (matched) {
				break;
			}
		}
		if (!matched) {
			return undefined;
		}
	}

	return resolved;
}

/**
 * Basename of a path that may use either separator.
 *
 * Transcripts record paths in the syntax of the machine that produced them, so
 * a transcript written on Windows can be read on Linux and vice versa;
 * `path.basename` only understands the host's separator.
 */
export function anyBasename(filePath: string): string {
	if (!filePath) {
		return "";
	}
	const parts = filePath.split(/[\\/]/).filter(Boolean);
	return parts.length > 0 ? parts[parts.length - 1] : filePath;
}

/** Parent directory of a path that may use either separator. */
export function anyDirname(filePath: string): string {
	if (!filePath) {
		return "";
	}
	const match = filePath.match(/^(.*)[\\/][^\\/]+$/);
	return match ? match[1] : "";
}

/** Last meaningful segment of a project path, for compact display. */
export function projectDisplayName(projectPath: string): string {
	const base = anyBasename(projectPath.replace(/[\\/]+$/, ""));
	return base || projectPath;
}

/** The session id is the transcript filename, on every platform. */
export function sessionIdFromPath(filePath: string): string {
	return anyBasename(filePath).replace(/\.jsonl$/i, "");
}

export function fileExists(filePath: string): boolean {
	if (!filePath) {
		return false;
	}
	try {
		return fs.existsSync(filePath);
	} catch {
		return false;
	}
}

export function resolveCodexHome(configured?: string): string {
	return expandHome(
		(configured || "").trim() ||
			(process.env.CODEX_HOME || "").trim() ||
			path.join(os.homedir(), ".codex"),
	);
}
