/**
 * Tests for the webview's Markdown renderer.
 *
 * The renderer ships as a plain browser script, so it is loaded here the same
 * way Node would load any CommonJS module. Message text is arbitrary — it
 * contains code, shell output, paths and prose — so the cases below are mostly
 * about what the renderer must leave alone.
 */

import * as assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const markdown = require(
	path.join(__dirname, "..", "..", "media", "markdown.js")
) as { render(source: string): string; escapeHtml(text: string): string };

const render = (source: string): string => markdown.render(source);

describe("markdown escaping", () => {
	it("escapes HTML in prose", () => {
		assert.equal(render("<script>alert(1)</script>"), "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
	});

	it("escapes HTML inside code", () => {
		assert.ok(render("`<b>`").includes("<code>&lt;b&gt;</code>"));
		assert.ok(render("```\n<b>\n```").includes("&lt;b&gt;"));
	});
});

describe("markdown placeholders", () => {
	it("leaves bare numbers in prose alone", () => {
		// A renderer that stashes links as " <n> " and restores them by
		// matching / (\d+) / will replace an ordinary number with a lookup
		// miss, turning this sentence into "ran undefined tests".
		assert.equal(render("I ran 3 tests and 42 passed"), "<p>I ran 3 tests and 42 passed</p>");
	});

	it("leaves numbers alone in a paragraph that also has a link", () => {
		const html = render("See https://example.com for 7 more notes on 12 files");
		assert.ok(html.includes("for 7 more notes on 12 files</p>"), html);
		assert.ok(html.includes('<a href="https://example.com">https://example.com</a>'));
	});

	it("does not reinterpret Markdown inside code spans", () => {
		const html = render("Use `**not bold**` here");
		assert.ok(html.includes("<code>**not bold**</code>"));
		assert.ok(!html.includes("<strong>"));
	});
});

describe("markdown blocks", () => {
	it("renders a fenced block with its language", () => {
		const html = render("```ts\nconst x = 1;\n```");
		assert.ok(html.includes('<pre><code class="language-ts">const x = 1;</code></pre>'), html);
	});

	it("renders headings one level down", () => {
		assert.equal(render("# Title"), "<h2>Title</h2>");
		assert.equal(render("### Deep"), "<h4>Deep</h4>");
	});

	it("renders unordered and ordered lists", () => {
		assert.equal(render("- one\n- two"), "<ul><li>one</li><li>two</li></ul>");
		assert.equal(render("1. one\n2. two"), "<ol><li>one</li><li>two</li></ol>");
	});

	it("nests a list inside its parent item", () => {
		const html = render("- outer\n  - inner");
		assert.ok(html.includes("<li>outer<ul><li>inner</li></ul></li>"), html);
	});

	it("renders a table inside its own scroll container", () => {
		const html = render("| a | b |\n|---|---|\n| 1 | 2 |");
		assert.ok(html.includes("<th>a</th><th>b</th>"), html);
		assert.ok(html.includes("<td>1</td><td>2</td>"), html);
		// A wide table has to scroll on its own; otherwise it widens the whole
		// conversation and the panel scrolls sideways.
		assert.ok(html.startsWith('<div class="table-wrap"><table>'), html);
		assert.ok(html.endsWith("</table></div>"), html);
	});

	it("renders blockquotes and rules", () => {
		assert.equal(render("> quoted"), "<blockquote><p>quoted</p></blockquote>");
		assert.equal(render("---"), "<hr>");
	});

	it("keeps paragraphs separate", () => {
		assert.equal(render("one\n\ntwo"), "<p>one</p><p>two</p>");
	});
});

describe("markdown inline", () => {
	it("renders emphasis", () => {
		assert.equal(render("**bold**"), "<p><strong>bold</strong></p>");
		assert.equal(render("an *italic* word"), "<p>an <em>italic</em> word</p>");
		assert.equal(render("~~gone~~"), "<p><del>gone</del></p>");
	});

	it("does not italicise a Windows path or a glob", () => {
		assert.equal(render("C:\\a*b\\c"), "<p>C:\\a*b\\c</p>");
		assert.equal(render("run **/*.ts now"), "<p>run **/*.ts now</p>");
	});

	it("links Markdown links and bare URLs", () => {
		assert.ok(
			render("[docs](https://example.com/a)").includes(
				'<a href="https://example.com/a" title="https://example.com/a">docs</a>'
			)
		);
		const bare = render("see https://example.com/a.");
		// The full stop ends the sentence; it is not part of the address.
		assert.ok(bare.includes('<a href="https://example.com/a">https://example.com/a</a>.'), bare);
	});

	it("does not linkify inside a code span", () => {
		const html = render("`https://example.com`");
		assert.ok(html.includes("<code>https://example.com</code>"));
		assert.ok(!html.includes("<a href"));
	});
});
