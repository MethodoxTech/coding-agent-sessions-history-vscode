/*
 * Generates media/icon.png — the marketplace tile.
 *
 * The Methodox design language puts the brand gradient on full-bleed
 * backgrounds and the marks, and draws glyphs as monochrome line icons on a
 * 24px grid with a 2px stroke and round caps. This script renders exactly that:
 * the Methodox gradient (#0A2BEE → #57A3E6 at 38°) behind a white "history"
 * glyph, rasterised from signed distance fields so the strokes stay clean at
 * every size.
 *
 * Kept in the repository, rather than committing a binary nobody can regenerate,
 * so the icon can be re-rendered whenever the brand values change.
 *
 *   node scripts/generate-icon.js
 */

"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SIZE = 256;
const SAMPLES = 4; // Supersampling factor per axis.

// Brand gradient, measured off the real Methodox mark.
const GRADIENT_FROM = [0x0a, 0x2b, 0xee];
const GRADIENT_TO = [0x57, 0xa3, 0xe6];
const GRADIENT_ANGLE_DEG = 38;

// Lucide "history" on its native 24px grid.
const GRID = 24;
const GLYPH_BOX = SIZE * 0.6;
const GLYPH_OFFSET = (SIZE - GLYPH_BOX) / 2;
const STROKE = (2 / GRID) * GLYPH_BOX; // The 2px Lucide stroke, scaled.

function toCanvas(x, y) {
	return [GLYPH_OFFSET + (x / GRID) * GLYPH_BOX, GLYPH_OFFSET + (y / GRID) * GLYPH_BOX];
}

/** Distance from p to the capsule between a and b. */
function distanceToSegment(px, py, ax, ay, bx, by) {
	const abx = bx - ax;
	const aby = by - ay;
	const apx = px - ax;
	const apy = py - ay;
	const lengthSquared = abx * abx + aby * aby;
	const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, (apx * abx + apy * aby) / lengthSquared));
	const dx = px - (ax + abx * t);
	const dy = py - (ay + aby * t);
	return Math.hypot(dx, dy);
}

/** Distance to an arc of `radius` around `cx,cy`, between two angles. */
function distanceToArc(px, py, cx, cy, radius, startDeg, endDeg) {
	const dx = px - cx;
	const dy = py - cy;
	let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
	if (angle < 0) {
		angle += 360;
	}

	const inSweep =
		startDeg <= endDeg
			? angle >= startDeg && angle <= endDeg
			: angle >= startDeg || angle <= endDeg;

	if (inSweep) {
		return Math.abs(Math.hypot(dx, dy) - radius);
	}

	// Outside the sweep, the nearest point is whichever endpoint is closer,
	// which is what gives the arc its round caps.
	const start = [
		cx + radius * Math.cos((startDeg * Math.PI) / 180),
		cy + radius * Math.sin((startDeg * Math.PI) / 180),
	];
	const end = [
		cx + radius * Math.cos((endDeg * Math.PI) / 180),
		cy + radius * Math.sin((endDeg * Math.PI) / 180),
	];
	return Math.min(Math.hypot(px - start[0], py - start[1]), Math.hypot(px - end[0], py - end[1]));
}

const center = toCanvas(12, 12);
const radius = (9 / GRID) * GLYPH_BOX;

// Clock hands: 12 o'clock to the centre, then out to roughly 4 o'clock.
const handTop = toCanvas(12, 7);
const handPivot = toCanvas(12, 12);
const handEnd = toCanvas(15.5, 13.8);

// The arrow corner that makes the circular arrow read as "history".
const arrowTop = toCanvas(3.6, 3.4);
const arrowCorner = toCanvas(3.6, 8.4);
const arrowRight = toCanvas(8.6, 8.4);

/** Signed distance to the whole glyph, negative inside the stroke. */
function glyphDistance(px, py) {
	const half = STROKE / 2;
	let distance = distanceToArc(px, py, center[0], center[1], radius, 200, 140) - half;
	distance = Math.min(
		distance,
		distanceToSegment(px, py, handTop[0], handTop[1], handPivot[0], handPivot[1]) - half
	);
	distance = Math.min(
		distance,
		distanceToSegment(px, py, handPivot[0], handPivot[1], handEnd[0], handEnd[1]) - half
	);
	distance = Math.min(
		distance,
		distanceToSegment(px, py, arrowTop[0], arrowTop[1], arrowCorner[0], arrowCorner[1]) - half
	);
	distance = Math.min(
		distance,
		distanceToSegment(px, py, arrowCorner[0], arrowCorner[1], arrowRight[0], arrowRight[1]) - half
	);
	return distance;
}

function gradientColorAt(x, y) {
	const radians = (GRADIENT_ANGLE_DEG * Math.PI) / 180;
	const dx = Math.cos(radians);
	const dy = Math.sin(radians);
	// Project onto the gradient axis and normalise to 0..1 across the square.
	const projected = (x * dx + y * dy) / (SIZE * (Math.abs(dx) + Math.abs(dy)));
	const t = Math.max(0, Math.min(1, projected));
	return [
		GRADIENT_FROM[0] + (GRADIENT_TO[0] - GRADIENT_FROM[0]) * t,
		GRADIENT_FROM[1] + (GRADIENT_TO[1] - GRADIENT_FROM[1]) * t,
		GRADIENT_FROM[2] + (GRADIENT_TO[2] - GRADIENT_FROM[2]) * t,
	];
}

function render() {
	const pixels = Buffer.alloc(SIZE * SIZE * 4);

	for (let y = 0; y < SIZE; y++) {
		for (let x = 0; x < SIZE; x++) {
			let coverage = 0;
			for (let sy = 0; sy < SAMPLES; sy++) {
				for (let sx = 0; sx < SAMPLES; sx++) {
					const px = x + (sx + 0.5) / SAMPLES;
					const py = y + (sy + 0.5) / SAMPLES;
					if (glyphDistance(px, py) <= 0) {
						coverage++;
					}
				}
			}
			coverage /= SAMPLES * SAMPLES;

			const background = gradientColorAt(x, y);
			const offset = (y * SIZE + x) * 4;
			pixels[offset] = Math.round(background[0] * (1 - coverage) + 255 * coverage);
			pixels[offset + 1] = Math.round(background[1] * (1 - coverage) + 255 * coverage);
			pixels[offset + 2] = Math.round(background[2] * (1 - coverage) + 255 * coverage);
			pixels[offset + 3] = 255;
		}
	}

	return pixels;
}

// === Minimal PNG encoder ===

function chunk(type, data) {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length, 0);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body) >>> 0, 0);
	return Buffer.concat([length, body, crc]);
}

let crcTable = null;

function crc32(buffer) {
	if (!crcTable) {
		crcTable = [];
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) {
				c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			}
			crcTable[n] = c >>> 0;
		}
	}
	let crc = 0xffffffff;
	for (let i = 0; i < buffer.length; i++) {
		crc = crcTable[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
	}
	return crc ^ 0xffffffff;
}

function encodePng(pixels) {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(SIZE, 0);
	header.writeUInt32BE(SIZE, 4);
	header[8] = 8; // bit depth
	header[9] = 6; // RGBA
	header[10] = 0; // deflate
	header[11] = 0; // no filter beyond per-scanline
	header[12] = 0; // no interlace

	// Each scanline is prefixed with filter type 0 (none).
	const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
	for (let y = 0; y < SIZE; y++) {
		raw[y * (SIZE * 4 + 1)] = 0;
		pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
	}

	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

const target = path.join(__dirname, "..", "media", "icon.png");
fs.writeFileSync(target, encodePng(render()));
process.stdout.write(`Wrote ${target} (${SIZE}x${SIZE})\n`);
