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
import * as readline from "readline";
import { TranscriptRecord } from "./types";

/** Signals that iteration should stop; the reader closes the stream. */
export const STOP = Symbol("stop");

export type LineVisitor = (record: TranscriptRecord, lineNumber: number) => void | typeof STOP;

export interface ReadOptions {
	/** Aborts the read as soon as the signal fires. */
	signal?: AbortSignal;
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

	const stream = fs.createReadStream(filePath, { encoding: "utf8" });
	const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

	try {
		for await (const line of lines) {
			lineNumber++;
			if (signal?.aborted) {
				break;
			}
			if (!line) {
				continue;
			}
			let record: TranscriptRecord;
			try {
				record = JSON.parse(line) as TranscriptRecord;
			} catch {
				// A truncated final line, or a line from a newer format we
				// cannot read. Neither is worth failing the whole transcript.
				continue;
			}
			if (record === null || typeof record !== "object") {
				continue;
			}
			if (visit(record, lineNumber) === STOP) {
				break;
			}
		}
	} finally {
		lines.close();
		stream.destroy();
	}

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
