/*
 * A small Markdown renderer for assistant and user messages.
 *
 * Deliberately not a full CommonMark implementation — messages use a narrow
 * slice of Markdown, and a dependency-free renderer keeps the webview's content
 * security policy simple. What it does handle it handles correctly:
 *
 *  - fenced and inline code, lifted out before anything else runs, so nothing
 *    inside them is ever reinterpreted;
 *  - headings, horizontal rules, blockquotes, tables, and nested lists;
 *  - bold, italic, strikethrough, Markdown links and bare URLs.
 *
 * Every placeholder uses NUL, which cannot occur in the escaped text, so a
 * stretch of ordinary prose can never be mistaken for one. (Substituting on a
 * pattern that prose can contain — a bare number between spaces, say — is a
 * classic way to turn "ran 3 tests" into "ran undefined tests".)
 *
 * Loaded as a plain script in the webview, and requirable from Node for tests.
 */

(function (root) {
	"use strict";

	const PLACEHOLDER = "\u0000";

	function escapeHtml(text) {
		return String(text === null || text === undefined ? "" : text)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;");
	}

	function render(source) {
		if (!source) {
			return "";
		}

		const fences = [];
		const text = String(source).replace(
			/```([^\n`]*)\n?([\s\S]*?)```/g,
			function (_match, language, code) {
				fences.push({ language: String(language || "").trim(), code: code });
				return "\n" + PLACEHOLDER + "F" + (fences.length - 1) + PLACEHOLDER + "\n";
			}
		);

		return renderBlocks(text.split(/\r?\n/), fences);
	}

	function renderBlocks(lines, fences) {
		const html = [];
		let paragraph = [];

		function flush() {
			if (paragraph.length > 0) {
				html.push("<p>" + renderInline(paragraph.join("\n")) + "</p>");
				paragraph = [];
			}
		}

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];

			const fence = line.match(new RegExp("^" + PLACEHOLDER + "F(\\d+)" + PLACEHOLDER + "$"));
			if (fence) {
				flush();
				const block = fences[Number(fence[1])];
				html.push(
					'<pre><code class="language-' +
						escapeHtml(block.language) +
						'">' +
						escapeHtml(block.code.replace(/\n$/, "")) +
						"</code></pre>"
				);
				continue;
			}

			if (!line.trim()) {
				flush();
				continue;
			}

			const heading = line.match(/^(#{1,6})\s+(.*)$/);
			if (heading) {
				flush();
				// Message headings sit inside the page, so they start one level
				// down from where the author wrote them.
				const level = Math.min(heading[1].length + 1, 6);
				html.push("<h" + level + ">" + renderInline(heading[2]) + "</h" + level + ">");
				continue;
			}

			if (/^\s*(-\s*-\s*-|\*\s*\*\s*\*|_\s*_\s*_)[-*_\s]*$/.test(line)) {
				flush();
				html.push("<hr>");
				continue;
			}

			if (/^\s*>/.test(line)) {
				flush();
				const quoted = [];
				while (i < lines.length && /^\s*>/.test(lines[i])) {
					quoted.push(lines[i].replace(/^\s*>\s?/, ""));
					i++;
				}
				i--;
				html.push("<blockquote>" + renderBlocks(quoted, fences) + "</blockquote>");
				continue;
			}

			if (isTableRow(line) && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
				flush();
				const rows = [];
				while (i < lines.length && isTableRow(lines[i])) {
					rows.push(lines[i]);
					i++;
				}
				i--;
				html.push(renderTable(rows));
				continue;
			}

			if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
				flush();
				const items = [];
				while (
					i < lines.length &&
					(/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) || /^\s{2,}\S/.test(lines[i]))
				) {
					items.push(lines[i]);
					i++;
				}
				i--;
				html.push(renderList(items, fences));
				continue;
			}

			paragraph.push(line);
		}

		flush();
		return html.join("");
	}

	function isTableRow(line) {
		return /^\s*\|.*\|\s*$/.test(line);
	}

	function isTableDivider(line) {
		return /^\s*\|[\s:|-]*-[\s:|-]*\|\s*$/.test(line);
	}

	function splitRow(line) {
		return line
			.trim()
			.replace(/^\||\|$/g, "")
			.split("|")
			.map(function (cell) {
				return cell.trim();
			});
	}

	function renderTable(rows) {
		const header = splitRow(rows[0]);
		// Wrapped so a table wider than the column scrolls on its own rather
		// than forcing the whole conversation sideways.
		let html = '<div class="table-wrap"><table><thead><tr>';
		for (let i = 0; i < header.length; i++) {
			html += "<th>" + renderInline(header[i]) + "</th>";
		}
		html += "</tr></thead><tbody>";

		for (let r = 2; r < rows.length; r++) {
			const cells = splitRow(rows[r]);
			html += "<tr>";
			for (let c = 0; c < header.length; c++) {
				html += "<td>" + renderInline(cells[c] || "") + "</td>";
			}
			html += "</tr>";
		}
		return html + "</tbody></table></div>";
	}

	function renderList(lines, fences) {
		const items = [];
		let current = null;
		let baseIndent = null;

		for (let i = 0; i < lines.length; i++) {
			const match = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
			if (match) {
				const indent = match[1].length;
				if (baseIndent === null) {
					baseIndent = indent;
				}
				// A deeper marker belongs to the item above, as a nested list.
				if (indent > baseIndent && current) {
					current.children.push(lines[i].slice(Math.min(indent, baseIndent + 2)));
					continue;
				}
				current = { ordered: /\d/.test(match[2]), text: match[3], children: [] };
				items.push(current);
			} else if (current) {
				current.children.push(lines[i].replace(/^\s{0,2}/, ""));
			}
		}

		if (items.length === 0) {
			return "";
		}

		const tag = items[0].ordered ? "ol" : "ul";
		let html = "<" + tag + ">";
		for (let i = 0; i < items.length; i++) {
			html += "<li>" + renderInline(items[i].text);
			if (items[i].children.length > 0) {
				html += renderBlocks(items[i].children, fences);
			}
			html += "</li>";
		}
		return html + "</" + tag + ">";
	}

	function renderInline(source) {
		const spans = [];
		let text = String(source).replace(/`([^`]+)`/g, function (_match, code) {
			spans.push(code);
			return PLACEHOLDER + "C" + (spans.length - 1) + PLACEHOLDER;
		});

		text = escapeHtml(text);

		const anchors = [];
		function stash(html) {
			anchors.push(html);
			return PLACEHOLDER + "A" + (anchors.length - 1) + PLACEHOLDER;
		}

		text = text.replace(/\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)/g, function (_m, label, url) {
			return stash('<a href="' + url + '" title="' + url + '">' + label + "</a>");
		});

		// Bare URLs, with trailing sentence punctuation left outside the link.
		text = text.replace(/https?:\/\/[^\s<>"'`]+/g, function (url) {
			const trailing = (url.match(/[.,;:!?)\]]+$/) || [""])[0];
			const clean = trailing ? url.slice(0, url.length - trailing.length) : url;
			return stash('<a href="' + clean + '">' + clean + "</a>") + trailing;
		});

		text = text
			.replace(/\*\*\*([^*\n]+)\*\*\*/g, "<strong><em>$1</em></strong>")
			.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
			.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>")
			.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");

		text = text.replace(new RegExp(PLACEHOLDER + "A(\\d+)" + PLACEHOLDER, "g"), function (_m, i) {
			return anchors[Number(i)];
		});

		text = text.replace(new RegExp(PLACEHOLDER + "C(\\d+)" + PLACEHOLDER, "g"), function (_m, i) {
			return "<code>" + escapeHtml(spans[Number(i)]) + "</code>";
		});

		return text.replace(/\n/g, "<br>");
	}

	const api = { render: render, escapeHtml: escapeHtml };

	if (typeof module === "object" && module.exports) {
		module.exports = api;
	} else {
		root.ClaudeMarkdown = api;
	}
})(typeof globalThis !== "undefined" ? globalThis : this);
