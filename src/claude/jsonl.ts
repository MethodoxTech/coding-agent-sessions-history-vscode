/**
 * Streaming reader for JSON Lines transcripts.
 *
 * Transcripts are append-only and can reach tens of megabytes for a long
 * session, so every read is streamed and every consumer is given the chance to
 * stop early. Lines that fail to parse are skipped rather than aborting the
 * read: a transcript for a session that is still running usually ends in a
 * partially written line.
 */

import * as fs from "fs";
import { TranscriptRecord } from "./types";

/** Signals that iteration should stop; the reader closes the stream. */
export const STOP = Symbol("stop");

export type LineVisitor = (record: TranscriptRecord, lineNumber: number) => void | typeof STOP;

export interface ReadOptions {
	/** Aborts the read as soon as the signal fires. */
	signal?: AbortSignal;
}

export interface ReadLinesOptions extends ReadOptions {
	/** Byte offset to start reading from; must be the start of a line. */
	start?: number;
	/** Also visit a final line that has no terminating newline yet. */
	includeTrailing?: boolean;
}

const CHUNK_SIZE = 1 << 20;

/**
 * Visit every line of a file as raw bytes, without decoding or parsing it.
 *
 * Working on bytes lets a caller look at the start of a multi-megabyte line and
 * skip it without paying to decode and parse it. The buffer handed to `visit`
 * is only valid for the duration of the call. `complete` is false only for a
 * final line with no newline yet, visited when `includeTrailing` is set.
 *
 * Returns the offset just past the last complete line visited, which is where a
 * later read can resume once the file has grown.
 */
export async function readLines(
	filePath: string,
	visit: (line: Buffer, complete: boolean) => void | typeof STOP,
	options: ReadLinesOptions = {}
): Promise<number> {
	const { signal, start = 0, includeTrailing = false } = options;
	const handle = await fs.promises.open(filePath, "r");
	const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
	let position = start;
	let consumed = start;
	// Pieces of a line that spans more than one chunk.
	let pending: Buffer[] = [];

	try {
		for (;;) {
			if (signal?.aborted) {
				return consumed;
			}
			const { bytesRead } = await handle.read(buffer, 0, CHUNK_SIZE, position);
			if (bytesRead === 0) {
				break;
			}
			const chunk = buffer.subarray(0, bytesRead);
			const chunkStart = position;
			position += bytesRead;

			let lineStart = 0;
			for (;;) {
				const newline = chunk.indexOf(10, lineStart);
				if (newline === -1) {
					break;
				}
				let line = chunk.subarray(lineStart, newline);
				if (pending.length > 0) {
					pending.push(line);
					line = Buffer.concat(pending);
					pending = [];
				}
				lineStart = newline + 1;
				consumed = chunkStart + lineStart;
				if (visit(line, true) === STOP) {
					return consumed;
				}
			}
			if (lineStart < bytesRead) {
				// The buffer is reused for the next chunk, so keep a copy.
				pending.push(Buffer.from(chunk.subarray(lineStart)));
			}
		}

		if (includeTrailing && pending.length > 0 && !signal?.aborted) {
			visit(Buffer.concat(pending), false);
		}
	} finally {
		await handle.close();
	}

	return consumed;
}

/** Parse one line of a transcript, or undefined if it is not a JSON object. */
export function parseRecord(line: Buffer): TranscriptRecord | undefined {
	if (line.length === 0) {
		return undefined;
	}
	let record: unknown;
	try {
		record = JSON.parse(line.toString("utf8"));
	} catch {
		// A truncated final line, or a line from a newer format we cannot
		// read. Neither is worth failing the whole transcript.
		return undefined;
	}
	return record !== null && typeof record === "object" ? (record as TranscriptRecord) : undefined;
}

/**
 * Read a transcript line by line, handing each parsed record to `visit`.
 *
 * Returns the number of lines read, including ones that failed to parse.
 */
export async function readTranscript(
	filePath: string,
	visit: LineVisitor,
	options: ReadOptions = {}
): Promise<number> {
	const { signal } = options;
	let lineNumber = 0;

	await readLines(
		filePath,
		(line) => {
			lineNumber++;
			if (signal?.aborted) {
				return STOP;
			}
			const record = parseRecord(line);
			return record ? visit(record, lineNumber) : undefined;
		},
		{ signal, includeTrailing: true }
	);

	return lineNumber;
}

/** Read an entire transcript into memory. Only for small files. */
export async function readAllRecords(
	filePath: string,
	options: ReadOptions = {}
): Promise<TranscriptRecord[]> {
	const records: TranscriptRecord[] = [];
	await readTranscript(filePath, (record) => void records.push(record), options);
	return records;
}
