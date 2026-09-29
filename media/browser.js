/*
 * Coding Agent Sessions History — session browser front end.
 *
 * The extension host owns the data: it indexes transcripts, parses a session
 * and hands this view one page of messages at a time. This file is only
 * presentation and input.
 */

(function () {
	"use strict";

	const vscode = acquireVsCodeApi();
	const agentFilter = document.getElementById("agent-filter");
	if (agentFilter)
		agentFilter.addEventListener("change", () =>
			vscode.postMessage({ type: "agentFilter", value: agentFilter.value }),
		);

	/** Pull request buttons shown in a session header before collapsing. */
	const PR_LINKS_SHOWN = 4;

	/**
	 * Messages per batch while loading a whole session. Larger batches mean
	 * fewer round trips; smaller ones keep each render short enough that the
	 * view can paint and Stop stays responsive.
	 */
	const LOAD_ALL_BATCH = 250;

	// === Icons ===
	//
	// Lucide geometry (24px grid, 2px stroke, round caps), inlined as CSS masks
	// so every glyph inherits currentColor. The design language rules out emoji
	// and dingbats as icons, so there are no text glyphs used as symbols here.

	const ICON_PATHS = {
		search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
		star: '<path d="M11.5 3.2a.6.6 0 0 1 1 0l2.3 4.6 5.1.7a.6.6 0 0 1 .3 1l-3.7 3.6.9 5a.6.6 0 0 1-.9.7L12 16.4l-4.5 2.4a.6.6 0 0 1-.9-.7l.9-5-3.7-3.6a.6.6 0 0 1 .3-1l5.1-.7z"/>',
		refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v5h-5"/>',
		play: '<path d="M7 4.5v15l12-7.5z"/>',
		download:
			'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
		externalLink:
			'<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6"/>',
		eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
		fileText:
			'<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h5"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
		appWindow:
			'<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 9h20"/><path d="M6 6.5h.01"/><path d="M9 6.5h.01"/>',
		tool: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-8 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-8z"/>',
		thinking:
			'<path d="M15 14c.2-1 .7-1.7 1.5-2.5A5 5 0 0 0 12 3a5 5 0 0 0-4.5 8.5c.8.8 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 21h4"/>',
		open: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
		alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
		branch: '<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
	};

	function iconUrl(name) {
		const body = ICON_PATHS[name];
		if (!body) {
			return "none";
		}
		const svg =
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
			'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
			body +
			"</svg>";
		return 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")';
	}

	function installIcons() {
		const root = document.documentElement.style;
		const map = {
			"--icon-search": "search",
			"--icon-star": "star",
			"--icon-refresh": "refresh",
			"--icon-play": "play",
			"--icon-download": "download",
			"--icon-external": "externalLink",
			"--icon-eye": "eye",
			"--icon-file": "fileText",
			"--icon-artifact": "appWindow",
			"--icon-tool": "tool",
			"--icon-thinking": "thinking",
			"--icon-open": "open",
			"--icon-alert": "alert",
			"--icon-branch": "branch",
		};
		for (const property in map) {
			root.setProperty(property, iconUrl(map[property]));
		}
	}

	// === State ===

	const saved = vscode.getState() || {};
	const state = {
		sessions: [],
		projects: [],
		bookmarks: [],
		matches: [],
		filter: saved.filter || "",
		project: saved.project || "",
		deep: false,
		bookmarksOnly: saved.bookmarksOnly || false,
		tab: saved.tab === "stats" ? "stats" : "sessions",
		selected: saved.selected || null,
		meta: null,
		messages: [],
		total: 0,
		rendered: 0,
		sessionTotal: 0,
		searching: false,
		loadingAll: false,
		filterQuery: "",
		filterScope: "all",
		filterTerms: [],
	};

	function persist() {
		vscode.setState({
			filter: state.filter,
			project: state.project,
			bookmarksOnly: state.bookmarksOnly,
			tab: state.tab,
			selected: state.selected,
		});
	}

	// === Elements ===

	const el = {
		search: document.getElementById("search"),
		deep: document.getElementById("deep"),
		project: document.getElementById("project"),
		bookmarks: document.getElementById("bookmarks"),
		reload: document.getElementById("reload"),
		progress: document.getElementById("progress"),
		progressFill: document.getElementById("progress-fill"),
		sidebar: document.getElementById("sidebar"),
		sidebarStatus: document.getElementById("sidebar-status"),
		list: document.getElementById("list"),
		detail: document.getElementById("detail"),
		welcome: document.getElementById("welcome"),
		conversation: document.getElementById("conversation"),
		stats: document.getElementById("stats"),
		menu: document.getElementById("menu"),
		tabs: Array.prototype.slice.call(document.querySelectorAll(".tab")),
	};

	// === Text helpers ===

	const escapeHtml =
		(globalThis.ClaudeMarkdown || {}).escapeHtml ||
		function (text) {
			return String(text === null || text === undefined ? "" : text)
				.replace(/&/g, "&amp;")
				.replace(/</g, "&lt;")
				.replace(/>/g, "&gt;")
				.replace(/"/g, "&quot;")
				.replace(/'/g, "&#39;");
		};

	function truncate(text, limit) {
		const flat = String(text || "")
			.replace(/\s+/g, " ")
			.trim();
		return flat.length > limit ? flat.slice(0, limit - 1) + "…" : flat;
	}

	function formatNumber(value) {
		if (value >= 1e6) {
			return (value / 1e6).toFixed(1) + "M";
		}
		if (value >= 1e4) {
			return (value / 1e3).toFixed(1) + "K";
		}
		return String(value);
	}

	function formatSize(bytes) {
		if (!bytes) {
			return "0 B";
		}
		if (bytes < 1024) {
			return bytes + " B";
		}
		if (bytes < 1024 * 1024) {
			return Math.round(bytes / 1024) + " KB";
		}
		return (bytes / (1024 * 1024)).toFixed(1) + " MB";
	}

	function formatClock(timestamp) {
		const date = new Date(timestamp);
		return isNaN(date.getTime())
			? ""
			: date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	}

	function formatDateTime(timestamp) {
		const date = new Date(timestamp);
		return isNaN(date.getTime())
			? ""
			: date.toLocaleString(undefined, {
					year: "numeric",
					month: "short",
					day: "numeric",
					hour: "2-digit",
					minute: "2-digit",
				});
	}

	function formatDateHeading(key) {
		const today = new Date().toISOString().slice(0, 10);
		if (key === today) {
			return "Today";
		}
		const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
		if (key === yesterday) {
			return "Yesterday";
		}
		const date = new Date(key + "T00:00:00");
		if (isNaN(date.getTime())) {
			return key;
		}
		const sameYear = date.getFullYear() === new Date().getFullYear();
		return date.toLocaleDateString(undefined, {
			weekday: "short",
			month: "short",
			day: "numeric",
			year: sameYear ? undefined : "numeric",
		});
	}

	// === Markdown ===
	//
	// The renderer lives in markdown.js so it can be unit-tested under Node.

	const renderMarkdown =
		(globalThis.ClaudeMarkdown || {}).render ||
		function (text) {
			return "<p>" + escapeHtml(text) + "</p>";
		};

	// === Session list ===

	function visibleSessions() {
		let sessions = state.sessions;
		if (state.project) {
			sessions = sessions.filter(function (session) {
				return session.projectPath === state.project;
			});
		}
		if (state.bookmarksOnly) {
			sessions = sessions.filter(function (session) {
				return state.bookmarks.indexOf(session.id) !== -1;
			});
		}
		if (state.filter && !state.deep) {
			const needle = state.filter.toLowerCase();
			sessions = sessions.filter(function (session) {
				return (
					(session.title || "").toLowerCase().indexOf(needle) !== -1 ||
					(session.preview || "").toLowerCase().indexOf(needle) !== -1 ||
					(session.projectPath || "").toLowerCase().indexOf(needle) !== -1 ||
					(session.gitBranch || "").toLowerCase().indexOf(needle) !== -1 ||
					session.id.toLowerCase().indexOf(needle) !== -1
				);
			});
		}
		return sessions;
	}

	function renderList() {
		if (state.deep && state.filter) {
			renderMatches();
			return;
		}

		const sessions = visibleSessions();
		if (sessions.length === 0) {
			el.list.innerHTML =
				'<p class="list-empty">' +
				(state.sessions.length === 0
					? "No sessions indexed yet. Run Claude Code or Codex once, then rescan."
					: "Nothing matches that filter. Clear it to see every session.") +
				"</p>";
			setStatus("");
			return;
		}

		const groups = [];
		const index = {};
		for (let i = 0; i < sessions.length; i++) {
			const key = sessions[i].lastTimestamp.slice(0, 10);
			if (!index[key]) {
				index[key] = [];
				groups.push(key);
			}
			index[key].push(sessions[i]);
		}

		let html = "";
		for (let g = 0; g < groups.length; g++) {
			html +=
				'<div class="group-heading">' + escapeHtml(formatDateHeading(groups[g])) + "</div>";
			const group = index[groups[g]];
			for (let i = 0; i < group.length; i++) {
				html += sessionRow(group[i]);
			}
		}

		el.list.innerHTML = html;
		setStatus(sessions.length + (sessions.length === 1 ? " session" : " sessions"));
	}

	function sessionRow(session) {
		const bookmarked = state.bookmarks.indexOf(session.id) !== -1;
		const active = state.selected === session.filePath;
		const title = session.title || truncate(session.preview, 70) || session.id;
		const showPreview = session.preview && session.preview !== session.title;

		let meta =
			'<span class="num">' + escapeHtml(formatClock(session.lastTimestamp)) + "</span>";
		if (session.model) {
			meta += '<span class="badge">' + escapeHtml(session.model) + "</span>";
		}
		meta += '<span class="num">' + session.messageCount + " msgs</span>";
		meta +=
			'<span class="chip">' + (session.provider === "codex" ? "Codex" : "Claude") + "</span>";
		meta += '<span class="chip">' + escapeHtml(session.projectName) + "</span>";
		if (session.hasErrors) {
			meta += '<span class="chip">errors</span>';
		}

		return (
			'<div class="row' +
			(active ? " is-active" : "") +
			'" role="listitem" tabindex="0" data-path="' +
			escapeHtml(session.filePath) +
			'">' +
			'<button class="star' +
			(bookmarked ? " is-on" : "") +
			'" type="button" title="' +
			(bookmarked ? "Remove bookmark" : "Bookmark this session") +
			'" data-bookmark="' +
			escapeHtml(session.id) +
			'"></button>' +
			'<span class="row-title">' +
			escapeHtml(title) +
			"</span>" +
			(showPreview
				? '<span class="row-preview">' +
					escapeHtml(truncate(session.preview, 110)) +
					"</span>"
				: "") +
			'<span class="row-meta">' +
			meta +
			"</span>" +
			"</div>"
		);
	}

	function renderMatches() {
		const seen = {};
		const grouped = [];
		for (let i = 0; i < state.matches.length; i++) {
			const match = state.matches[i];
			if (state.project && match.meta.projectPath !== state.project) {
				continue;
			}
			if (!seen[match.meta.filePath]) {
				seen[match.meta.filePath] = { meta: match.meta, hits: [] };
				grouped.push(seen[match.meta.filePath]);
			}
			seen[match.meta.filePath].hits.push(match);
		}

		if (grouped.length === 0) {
			el.list.innerHTML = state.searching
				? '<p class="list-empty">Searching…</p>'
				: '<p class="list-empty">No message contains that text. Try a shorter phrase.</p>';
			return;
		}

		let html = "";
		for (let g = 0; g < grouped.length; g++) {
			const entry = grouped[g];
			const session = entry.meta;
			html +=
				'<div class="row' +
				(state.selected === session.filePath ? " is-active" : "") +
				'" role="listitem" tabindex="0" data-path="' +
				escapeHtml(session.filePath) +
				'" data-index="' +
				entry.hits[0].messageIndex +
				'">' +
				'<span class="row-title">' +
				escapeHtml(session.title || truncate(session.preview, 70)) +
				"</span>" +
				'<span class="row-meta"><span class="num">' +
				escapeHtml(formatClock(session.lastTimestamp)) +
				'</span><span class="chip">' +
				escapeHtml(session.projectName) +
				'</span><span class="num">' +
				entry.hits.length +
				(entry.hits.length === 1 ? " hit" : " hits") +
				"</span></span>";

			for (let h = 0; h < Math.min(entry.hits.length, 3); h++) {
				const hit = entry.hits[h];
				html +=
					'<div class="row-match" data-jump="' +
					hit.messageIndex +
					'"><strong>' +
					escapeHtml(hit.role) +
					"</strong> " +
					highlight(hit.matchText, state.filter) +
					"</div>";
			}
			html += "</div>";
		}

		el.list.innerHTML = html;
		setStatus(
			state.matches.length +
				(state.matches.length === 1 ? " match in " : " matches in ") +
				grouped.length +
				(grouped.length === 1 ? " session" : " sessions"),
		);
	}

	function highlight(text, query) {
		const escaped = escapeHtml(text);
		if (!query) {
			return escaped;
		}
		const pattern = escapeHtml(query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return escaped.replace(new RegExp("(" + pattern + ")", "gi"), "<mark>$1</mark>");
	}

	function setStatus(text) {
		if (text) {
			el.sidebarStatus.textContent = text;
			el.sidebarStatus.hidden = false;
		} else {
			el.sidebarStatus.hidden = true;
		}
	}

	// === Conversation ===

	function renderConversation() {
		const meta = state.meta;
		if (!meta) {
			return;
		}

		const bookmarked = state.bookmarks.indexOf(meta.id) !== -1;
		const facts = [];
		facts.push('<span class="num">' + escapeHtml(formatDateTime(meta.timestamp)) + "</span>");
		if (meta.models && meta.models.length > 0) {
			facts.push('<span class="badge">' + escapeHtml(meta.models.join(", ")) + "</span>");
		}
		// The parsed total, not the indexed estimate, so the number agrees with
		// what you can actually scroll through.
		facts.push('<span class="num">' + state.total + " messages</span>");
		facts.push('<span class="num">' + meta.toolCallCount + " tool calls</span>");
		facts.push('<span class="num">' + escapeHtml(formatSize(meta.fileSize)) + "</span>");
		facts.push('<span class="chip">' + escapeHtml(meta.projectPath) + "</span>");
		if (meta.gitBranch) {
			facts.push('<span class="chip">' + escapeHtml(meta.gitBranch) + "</span>");
		}
		if (meta.cliVersion) {
			facts.push(
				'<span class="chip">' +
					(meta.provider === "codex" ? "Codex " : "Claude Code ") +
					escapeHtml(meta.cliVersion) +
					"</span>",
			);
		}

		let header =
			'<header class="conv-header"><div class="conv-header-text"><h2>' +
			escapeHtml(meta.title || truncate(meta.preview, 90) || "Session") +
			'</h2><div class="conv-facts">' +
			facts.join("") +
			"</div>";

		if (meta.prLinks && meta.prLinks.length > 0) {
			header += '<div class="conv-facts" id="pr-links" style="margin-top:8px">';
			for (let i = 0; i < meta.prLinks.length; i++) {
				const pr = meta.prLinks[i];
				// A long session can touch a dozen pull requests; show the first
				// few and keep the rest one click away rather than filling the
				// header with a wall of buttons.
				const extra =
					i >= PR_LINKS_SHOWN ? ' class="button pr-extra" hidden' : ' class="button"';
				header +=
					"<button" +
					extra +
					' data-icon data-external="' +
					escapeHtml(pr.url) +
					'" style="--icon:var(--icon-external)">' +
					escapeHtml(
						pr.repository
							? pr.repository + "#" + pr.number
							: pr.number
								? "Pull request #" + pr.number
								: "Pull request",
					) +
					"</button>";
			}
			if (meta.prLinks.length > PR_LINKS_SHOWN) {
				header +=
					'<button class="button" data-action="more-prs">Show ' +
					(meta.prLinks.length - PR_LINKS_SHOWN) +
					" more</button>";
			}
			header += "</div>";
		}

		header +=
			'</div><div class="conv-actions">' +
			'<button class="button is-primary" data-icon data-action="resume" style="--icon:var(--icon-play)">Resume</button>' +
			'<button class="button" data-icon data-action="export" style="--icon:var(--icon-download)">Export…</button>' +
			'<button class="button" data-icon data-action="bookmark" style="--icon:var(--icon-star)">' +
			(bookmarked ? "Bookmarked" : "Bookmark") +
			"</button>" +
			'<button class="button" data-icon data-action="transcript" style="--icon:var(--icon-file)">Transcript</button>' +
			"</div></header>";

		el.conversation.innerHTML = header + filterRowHtml() + '<div id="messages"></div>';
		appendMessages(state.messages, true);
		updateFilterStatus();
	}

	function filterRowHtml() {
		const scopes = [
			["all", "All messages"],
			["user", "From you"],
			["assistant", "From assistant"],
			["tools", "Tool calls"],
			["changes", "File changes"],
		];
		let options = "";
		for (let i = 0; i < scopes.length; i++) {
			options +=
				'<option value="' +
				scopes[i][0] +
				'"' +
				(scopes[i][0] === state.filterScope ? " selected" : "") +
				">" +
				escapeHtml(scopes[i][1]) +
				"</option>";
		}

		return (
			'<div class="filter-row">' +
			'<label class="search filter-search" for="msg-filter">' +
			'<span class="search-icon" aria-hidden="true"></span>' +
			'<input id="msg-filter" type="search" spellcheck="false" autocomplete="off" ' +
			'placeholder="Filter this session" value="' +
			escapeHtml(state.filterQuery) +
			'"></label>' +
			'<select id="msg-scope" aria-label="Limit the filter to">' +
			options +
			"</select>" +
			'<span class="filter-count" id="filter-count"></span>' +
			'<button class="button" type="button" data-action="clear-filter" hidden>Clear</button>' +
			"</div>"
		);
	}

	function filterIsActive() {
		return state.filterQuery.trim().length > 0 || state.filterScope !== "all";
	}

	function updateFilterStatus() {
		const count = document.getElementById("filter-count");
		const clear = el.conversation.querySelector('[data-action="clear-filter"]');
		if (!count || !clear) {
			return;
		}
		if (filterIsActive()) {
			count.innerHTML =
				'<span class="num">' +
				state.total +
				'</span> of <span class="num">' +
				state.sessionTotal +
				"</span> messages";
			clear.hidden = false;
		} else {
			count.textContent = "";
			clear.hidden = true;
		}
	}

	let messageFilterTimer = null;

	function scheduleFilter() {
		clearTimeout(messageFilterTimer);
		messageFilterTimer = setTimeout(applyFilter, 200);
	}

	function applyFilter() {
		clearTimeout(messageFilterTimer);
		state.loadingAll = false;
		vscode.postMessage({
			type: "filterSession",
			query: state.filterQuery,
			scope: state.filterScope,
		});
	}

	function resetFilterState() {
		state.filterQuery = "";
		state.filterScope = "all";
		state.filterTerms = [];
	}

	/**
	 * Wrap each matched term in the rendered messages.
	 *
	 * Walks text nodes rather than rewriting the HTML, so a term that happens to
	 * appear inside a tag name, an attribute or a URL cannot corrupt the markup.
	 */
	function highlightMatches(root, terms) {
		if (!terms || terms.length === 0) {
			return;
		}

		const pattern = new RegExp(
			"(" +
				terms
					.map(function (term) {
						// Terms are literal text, so every regex metacharacter
						// in them has to be escaped before they are joined.
						return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
					})
					.join("|") +
				")",
			"gi",
		);

		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
			acceptNode: function (node) {
				if (!node.nodeValue || !node.nodeValue.trim()) {
					return NodeFilter.FILTER_REJECT;
				}
				const parent = node.parentElement;
				if (!parent || parent.closest("mark, .copy")) {
					return NodeFilter.FILTER_REJECT;
				}
				return NodeFilter.FILTER_ACCEPT;
			},
		});

		const targets = [];
		let node = walker.nextNode();
		while (node) {
			targets.push(node);
			node = walker.nextNode();
		}

		for (let i = 0; i < targets.length; i++) {
			const text = targets[i];
			const value = text.nodeValue;
			pattern.lastIndex = 0;
			if (!pattern.test(value)) {
				continue;
			}

			pattern.lastIndex = 0;
			const fragment = document.createDocumentFragment();
			let last = 0;
			let match = pattern.exec(value);
			while (match) {
				if (match.index > last) {
					fragment.appendChild(document.createTextNode(value.slice(last, match.index)));
				}
				const mark = document.createElement("mark");
				mark.textContent = match[0];
				fragment.appendChild(mark);
				last = match.index + match[0].length;
				if (match[0].length === 0) {
					pattern.lastIndex++;
				}
				match = pattern.exec(value);
			}
			if (last < value.length) {
				fragment.appendChild(document.createTextNode(value.slice(last)));
			}
			text.parentNode.replaceChild(fragment, text);
		}
	}

	function appendMessages(messages, replace) {
		const host = document.getElementById("messages");
		if (!host) {
			return;
		}

		if (replace && messages.length === 0) {
			host.innerHTML =
				'<p class="list-empty">No message in this session matches. Use fewer words, or widen the scope.</p>';
			state.rendered = 0;
			renderConversationFooter();
			return;
		}

		let html = "";
		for (let i = 0; i < messages.length; i++) {
			html += renderMessage(messages[i]);
		}

		if (replace) {
			host.innerHTML = html;
			state.rendered = messages.length;
			// Highlight before the copy buttons exist, so their own label can
			// never be marked up as a match.
			highlightMatches(host, state.filterTerms);
			addCopyButtons(host);
		} else {
			// Build the batch off-document so its copy buttons are attached
			// without rescanning what is already on screen; doing that on every
			// page makes each one cost more than the last.
			const batch = document.createElement("div");
			batch.innerHTML = html;
			highlightMatches(batch, state.filterTerms);
			addCopyButtons(batch);

			const fragment = document.createDocumentFragment();
			while (batch.firstChild) {
				fragment.appendChild(batch.firstChild);
			}
			host.appendChild(fragment);
			state.rendered += messages.length;
		}

		renderConversationFooter();
	}

	/** The paging controls under the conversation, or nothing once it is whole. */
	function renderConversationFooter() {
		const existing = el.conversation.querySelector(".load-more-row");
		if (existing) {
			existing.remove();
		}
		if (state.rendered >= state.total) {
			return;
		}

		let html = '<div class="load-more-row">';
		if (state.loadingAll) {
			html +=
				'<span class="load-more-status">Loading <span class="num">' +
				state.rendered +
				'</span> of <span class="num">' +
				state.total +
				"</span> messages</span>" +
				'<button class="button" type="button" data-action="stop-loading">Stop</button>';
		} else {
			const remaining = state.total - state.rendered;
			html +=
				'<button class="load-more" type="button" data-action="load-more">Show more — ' +
				remaining +
				(remaining === 1 ? " message left" : " messages left") +
				"</button>" +
				'<button class="button" type="button" data-action="load-all" ' +
				'title="Render the rest of this session in one go">Load everything</button>';
		}
		el.conversation.insertAdjacentHTML("beforeend", html + "</div>");
	}

	function requestNextBatch() {
		vscode.postMessage({ type: "loadMore", offset: state.rendered, chunk: LOAD_ALL_BATCH });
	}

	function renderMessage(message) {
		if (message.role === "system") {
			const isError = message.level === "error";
			return (
				'<div class="message system' +
				(isError ? " is-error" : "") +
				'">' +
				escapeHtml(message.text) +
				(message.timestamp
					? ' <span class="num">' + escapeHtml(formatClock(message.timestamp)) + "</span>"
					: "") +
				"</div>"
			);
		}

		let html =
			'<div class="message ' +
			message.role +
			(message.sidechain ? " is-sidechain" : "") +
			'" data-index="' +
			message.index +
			'">';

		html += '<div class="message-role">';
		html +=
			message.role === "user" ? "You" : state.meta?.provider === "codex" ? "Codex" : "Claude";
		if (message.model) {
			html += '<span class="badge">' + escapeHtml(message.model) + "</span>";
		}
		if (message.subtype === "queued") {
			html += '<span class="chip">queued</span>';
		}
		if (message.sidechain) {
			html += '<span class="chip">subagent</span>';
		}
		if (message.timestamp) {
			html +=
				'<span class="num" style="margin-left:auto;font-weight:400">' +
				escapeHtml(formatClock(message.timestamp)) +
				"</span>";
		}
		html += "</div>";

		if (message.thinking) {
			html +=
				'<details class="block thinking"><summary><span class="summary-name">Thinking</span>' +
				'<span class="summary-detail">' +
				message.thinking.length +
				" characters</span></summary>" +
				'<div class="block-body">' +
				escapeHtml(message.thinking) +
				"</div></details>";
		}

		if (message.text) {
			html += '<div class="message-body">' + renderMarkdown(message.text) + "</div>";
		}

		if (message.toolCalls) {
			for (let i = 0; i < message.toolCalls.length; i++) {
				html += renderToolCall(message.toolCalls[i]);
			}
		}

		return html + "</div>";
	}

	function renderToolCall(call) {
		if (call.artifact) {
			return renderFileCard(call.artifact);
		}

		let html =
			'<details class="block"><summary><span class="summary-name">' +
			escapeHtml(call.name) +
			"</span>";
		if (call.summary) {
			html +=
				'<span class="summary-detail">' +
				escapeHtml(truncate(call.summary, 120)) +
				"</span>";
		}
		if (call.isError) {
			html += '<span class="summary-flag">error</span>';
		}
		html += '</summary><div class="block-body">';

		html +=
			'<div class="block-label">Input</div><pre><code>' +
			escapeHtml(call.input) +
			"</code></pre>";

		if (call.patch && call.patch.length > 0) {
			html +=
				'<div class="block-label">Changes' +
				(call.patchFile ? " to " + escapeHtml(basename(call.patchFile)) : "") +
				"</div>" +
				renderPatch(call.patch);
		}

		if (call.output) {
			html +=
				'<div class="block-label">Output</div><pre><code>' +
				escapeHtml(call.output) +
				(call.outputTruncated ? "\n… truncated" : "") +
				"</code></pre>";
		}

		if (call.stderr) {
			html +=
				'<div class="block-label">Stderr</div><pre><code>' +
				escapeHtml(call.stderr) +
				"</code></pre>";
		}

		return html + "</div></details>";
	}

	function renderPatch(hunks) {
		let html = '<div class="diff">';
		for (let h = 0; h < hunks.length; h++) {
			const hunk = hunks[h];
			html +=
				'<span class="diff-line is-hunk">@@ -' +
				hunk.oldStart +
				"," +
				hunk.oldLines +
				" +" +
				hunk.newStart +
				"," +
				hunk.newLines +
				" @@</span>";
			for (let l = 0; l < hunk.lines.length; l++) {
				const line = hunk.lines[l];
				const kind =
					line.charAt(0) === "+" ? " is-add" : line.charAt(0) === "-" ? " is-del" : "";
				html += '<span class="diff-line' + kind + '">' + escapeHtml(line) + "</span>";
			}
		}
		return html + "</div>";
	}

	function renderFileCard(artifact) {
		const isArtifact = artifact.kind === "artifact";
		const icon = isArtifact ? "var(--icon-artifact)" : "var(--icon-file)";
		const detail = artifact.description || dirname(artifact.filePath);

		let actions = "";
		if (artifact.url) {
			actions +=
				'<button class="button" data-icon data-external="' +
				escapeHtml(artifact.url) +
				'" style="--icon:var(--icon-external)" title="Open the published artifact on claude.ai">Open in browser</button>';
		}
		if (artifact.exists) {
			actions +=
				'<button class="button" data-icon data-preview="' +
				escapeHtml(artifact.filePath) +
				'" data-title="' +
				escapeHtml(artifact.description || artifact.fileName) +
				'" style="--icon:var(--icon-eye)">Preview</button>';
			actions +=
				'<button class="button" data-icon data-open="' +
				escapeHtml(artifact.filePath) +
				'" style="--icon:var(--icon-open)">Open</button>';
		} else {
			actions +=
				'<button class="button" disabled title="' +
				(isArtifact
					? "The source file is gone. Artifacts are written to a temporary folder that is cleared when the machine restarts."
					: "This file has been moved or deleted since the session ran.") +
				'">Preview</button>';
		}

		return (
			'<div class="file-card">' +
			'<span class="file-card-icon" style="--icon:' +
			icon +
			'"></span>' +
			'<div class="file-card-info">' +
			'<div class="file-card-name">' +
			escapeHtml(artifact.fileName) +
			"</div>" +
			(detail ? '<div class="file-card-detail">' + escapeHtml(detail) + "</div>" : "") +
			"</div>" +
			'<div class="file-card-actions">' +
			actions +
			"</div></div>"
		);
	}

	function basename(filePath) {
		const parts = String(filePath || "").split(/[\\/]/);
		return parts[parts.length - 1] || filePath;
	}

	function dirname(filePath) {
		const match = String(filePath || "").match(/^(.*)[\\/][^\\/]+$/);
		return match ? match[1] : "";
	}

	function addCopyButtons(host) {
		const blocks = host.querySelectorAll("pre");
		for (let i = 0; i < blocks.length; i++) {
			const pre = blocks[i];
			if (pre.querySelector(".copy")) {
				continue;
			}
			const button = document.createElement("button");
			button.className = "copy";
			button.type = "button";
			button.textContent = "Copy";
			button.addEventListener("click", function (event) {
				event.stopPropagation();
				const code = pre.querySelector("code");
				vscode.postMessage({
					type: "copy",
					text: code ? code.textContent : pre.textContent,
				});
				button.textContent = "Copied";
				setTimeout(function () {
					button.textContent = "Copy";
				}, 1200);
			});
			pre.appendChild(button);
		}
	}

	// === Statistics ===

	function renderStats(stats) {
		const cards = [
			["Sessions", formatNumber(stats.totalSessions)],
			["Messages", formatNumber(stats.totalMessages)],
			["Tool calls", formatNumber(stats.totalToolCalls)],
			["Average length", stats.averageMessageCount + " msgs"],
			["On disk", formatSize(stats.totalSizeBytes)],
		];
		if (stats.totalTokens > 0) {
			cards.push(["Tokens", formatNumber(stats.totalTokens)]);
		}

		let html = '<h2>Statistics</h2><div class="stat-grid">';
		for (let i = 0; i < cards.length; i++) {
			html +=
				'<div class="stat-card"><div class="stat-value">' +
				escapeHtml(cards[i][1]) +
				'</div><div class="stat-label">' +
				escapeHtml(cards[i][0]) +
				"</div></div>";
		}
		html += "</div>";

		let peak = 1;
		for (let i = 0; i < stats.dailyFrequency.length; i++) {
			peak = Math.max(peak, stats.dailyFrequency[i].count);
		}
		html +=
			'<section class="stats-section"><h3>Sessions per day, last 30 days</h3><div class="bars">';
		for (let i = 0; i < stats.dailyFrequency.length; i++) {
			const day = stats.dailyFrequency[i];
			html +=
				'<div class="bar-col" title="' +
				escapeHtml(
					day.date + ": " + day.count + " sessions, " + day.messages + " messages",
				) +
				'"><div class="bar' +
				(day.count > 0 ? " has-value" : "") +
				'" style="height:' +
				Math.round((day.count / peak) * 100) +
				'%"></div></div>';
		}
		html += "</div></section>";

		html += barSection("Models", stats.modelDistribution, function (entry) {
			return { label: entry.model, value: entry.count, note: entry.percentage + "%" };
		});

		html += barSection("Busiest projects", stats.projectActivity, function (entry) {
			return {
				label: entry.name,
				value: entry.count,
				note: entry.count + " · " + entry.messages + " msgs",
				title: entry.project,
			};
		});

		if (stats.branchActivity.length > 0) {
			html += barSection("Branches", stats.branchActivity, function (entry) {
				return { label: entry.branch, value: entry.count, note: String(entry.count) };
			});
		}

		const notes = [];
		if (stats.longestSession) {
			notes.push(
				"Longest session: " +
					escapeHtml(truncate(stats.longestSession.title, 80)) +
					" (" +
					stats.longestSession.messageCount +
					" messages)",
			);
		}
		if (stats.busiestDay) {
			notes.push(
				"Busiest day: " +
					escapeHtml(stats.busiestDay.date) +
					" with " +
					stats.busiestDay.count +
					" sessions",
			);
		}
		if (stats.firstSession) {
			notes.push("First session: " + escapeHtml(formatDateTime(stats.firstSession)));
		}
		if (notes.length > 0) {
			html +=
				'<section class="stats-section"><h3>Highlights</h3><ul>' +
				notes
					.map(function (note) {
						return "<li>" + note + "</li>";
					})
					.join("") +
				"</ul></section>";
		}

		const today = new Date().toISOString().slice(0, 10);
		const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
		html +=
			'<section class="stats-section"><h3>Export a date range</h3><div class="range-export">' +
			'<label for="range-start">From</label><input type="date" id="range-start" value="' +
			monthAgo +
			'">' +
			'<label for="range-end">To</label><input type="date" id="range-end" value="' +
			today +
			'">' +
			'<button class="button is-primary" data-icon data-action="export-range" style="--icon:var(--icon-download)">Export…</button>' +
			"</div></section>";

		el.stats.innerHTML = html;
	}

	function barSection(title, entries, map) {
		if (!entries || entries.length === 0) {
			return "";
		}
		let peak = 1;
		for (let i = 0; i < entries.length; i++) {
			peak = Math.max(peak, map(entries[i]).value);
		}
		let html = '<section class="stats-section"><h3>' + escapeHtml(title) + "</h3>";
		for (let i = 0; i < entries.length; i++) {
			const row = map(entries[i]);
			html +=
				'<div class="hbar-row"><div class="hbar-label" title="' +
				escapeHtml(row.title || row.label) +
				'">' +
				escapeHtml(row.label) +
				'</div><div class="hbar-track"><div class="hbar-fill" style="width:' +
				Math.round((row.value / peak) * 100) +
				'%"></div></div><div class="hbar-value">' +
				escapeHtml(row.note) +
				"</div></div>";
		}
		return html + "</section>";
	}

	// === View switching ===

	function showTab(tab) {
		state.tab = tab;
		persist();
		for (let i = 0; i < el.tabs.length; i++) {
			el.tabs[i].classList.toggle("is-active", el.tabs[i].dataset.tab === tab);
		}

		const isStats = tab === "stats";
		el.sidebar.hidden = isStats;
		el.stats.hidden = !isStats;
		el.conversation.hidden = isStats || !state.meta;
		el.welcome.hidden = isStats || !!state.meta;

		if (isStats) {
			vscode.postMessage({ type: "stats" });
		}
	}

	function setBusy(busy, label) {
		el.progress.hidden = !busy;
		if (busy) {
			el.progressFill.style.width = "15%";
			setStatus(label || "Working…");
		}
	}

	// === Events ===

	let filterTimer = null;

	el.search.addEventListener("input", function () {
		state.filter = el.search.value;
		persist();
		clearTimeout(filterTimer);
		filterTimer = setTimeout(function () {
			if (state.deep && state.filter.trim()) {
				vscode.postMessage({ type: "deepSearch", query: state.filter });
			} else {
				vscode.postMessage({ type: "cancelSearch" });
				state.matches = [];
				renderList();
			}
		}, 250);
	});

	el.deep.addEventListener("change", function () {
		state.deep = el.deep.checked;
		state.matches = [];
		if (state.deep && state.filter.trim()) {
			vscode.postMessage({ type: "deepSearch", query: state.filter });
		} else {
			vscode.postMessage({ type: "cancelSearch" });
			renderList();
		}
	});

	el.project.addEventListener("change", function () {
		state.project = el.project.value;
		persist();
		renderList();
	});

	el.bookmarks.addEventListener("click", function () {
		state.bookmarksOnly = !state.bookmarksOnly;
		el.bookmarks.setAttribute("aria-pressed", String(state.bookmarksOnly));
		persist();
		renderList();
	});

	el.reload.addEventListener("click", function () {
		vscode.postMessage({ type: "reload" });
	});

	for (let i = 0; i < el.tabs.length; i++) {
		el.tabs[i].addEventListener("click", function () {
			showTab(this.dataset.tab);
		});
	}

	el.list.addEventListener("click", function (event) {
		const star = event.target.closest("[data-bookmark]");
		if (star) {
			event.stopPropagation();
			vscode.postMessage({ type: "toggleBookmark", id: star.dataset.bookmark });
			return;
		}

		const row = event.target.closest(".row");
		if (!row) {
			return;
		}

		const jump = event.target.closest("[data-jump]");
		openSession(row.dataset.path, jump ? Number(jump.dataset.jump) : undefined);
	});

	el.list.addEventListener("keydown", function (event) {
		if (event.key !== "Enter" && event.key !== " ") {
			return;
		}
		const row = event.target.closest(".row");
		if (row) {
			event.preventDefault();
			openSession(row.dataset.path);
		}
	});

	// === Context menu ===

	/**
	 * The session behind a list row. Deep-search results are not in
	 * state.sessions until the next index, so the matches are checked too.
	 */
	function sessionByPath(filePath) {
		for (let i = 0; i < state.sessions.length; i++) {
			if (state.sessions[i].filePath === filePath) {
				return state.sessions[i];
			}
		}
		for (let i = 0; i < state.matches.length; i++) {
			if (state.matches[i].meta.filePath === filePath) {
				return state.matches[i].meta;
			}
		}
		return null;
	}

	function closeMenu() {
		el.menu.hidden = true;
		el.menu.innerHTML = "";
	}

	function openMenu(x, y, items) {
		let html = "";
		for (let i = 0; i < items.length; i++) {
			html += items[i].separator
				? '<div class="menu-separator"></div>'
				: '<button class="menu-item" type="button" role="menuitem" data-item="' +
					i +
					'">' +
					escapeHtml(items[i].label) +
					"</button>";
		}
		el.menu.innerHTML = html;
		el.menu.hidden = false;

		// Measure once visible, then keep the menu inside the viewport.
		const size = el.menu.getBoundingClientRect();
		const left = Math.max(4, Math.min(x, window.innerWidth - size.width - 4));
		const top = Math.max(4, Math.min(y, window.innerHeight - size.height - 4));
		el.menu.style.left = left + "px";
		el.menu.style.top = top + "px";

		el.menu.onclick = function (event) {
			const button = event.target.closest("[data-item]");
			if (!button) {
				return;
			}
			const item = items[Number(button.dataset.item)];
			closeMenu();
			if (item && item.run) {
				item.run();
			}
		};

		const first = el.menu.querySelector(".menu-item");
		if (first) {
			first.focus();
		}
	}

	function copy(text) {
		vscode.postMessage({ type: "copy", text: text });
	}

	el.list.addEventListener("contextmenu", function (event) {
		const row = event.target.closest(".row");
		if (!row) {
			return;
		}
		const session = sessionByPath(row.dataset.path);
		if (!session) {
			return;
		}
		event.preventDefault();

		const title = session.title || session.preview || session.id;
		const bookmarked = state.bookmarks.indexOf(session.id) !== -1;

		openMenu(event.clientX, event.clientY, [
			{
				label: "Copy title",
				run: function () {
					copy(title);
				},
			},
			{
				label: "Copy session ID",
				run: function () {
					copy(session.nativeId || session.id);
				},
			},
			{
				label: "Copy project path",
				run: function () {
					copy(session.projectPath);
				},
			},
			{ separator: true },
			{
				label: bookmarked ? "Remove bookmark" : "Bookmark session",
				run: function () {
					vscode.postMessage({ type: "toggleBookmark", id: session.id });
				},
			},
			{ separator: true },
			{
				label: "Open transcript",
				run: function () {
					vscode.postMessage({ type: "openFile", filePath: session.filePath });
				},
			},
			{
				label: "Reveal transcript",
				run: function () {
					vscode.postMessage({ type: "revealFile", filePath: session.filePath });
				},
			},
		]);
	});

	document.addEventListener("mousedown", function (event) {
		if (!el.menu.hidden && !event.target.closest("#menu")) {
			closeMenu();
		}
	});

	document.addEventListener("keydown", function (event) {
		if (event.key === "Escape" && !el.menu.hidden) {
			closeMenu();
		}
	});

	// A menu pinned to viewport coordinates would drift away from its row.
	el.list.addEventListener("scroll", closeMenu);
	window.addEventListener("blur", closeMenu);

	function openSession(filePath, jumpIndex) {
		state.selected = filePath;
		state.pendingJump = typeof jumpIndex === "number" ? jumpIndex : null;
		persist();

		const rows = el.list.querySelectorAll(".row");
		for (let i = 0; i < rows.length; i++) {
			rows[i].classList.toggle("is-active", rows[i].dataset.path === filePath);
		}

		vscode.postMessage({ type: "openSession", filePath: filePath });
	}

	// The filter row is rebuilt with each conversation, so its events are
	// delegated rather than rebound.
	el.conversation.addEventListener("input", function (event) {
		if (event.target.id !== "msg-filter") {
			return;
		}
		state.filterQuery = event.target.value;
		scheduleFilter();
	});

	el.conversation.addEventListener("change", function (event) {
		if (event.target.id !== "msg-scope") {
			return;
		}
		state.filterScope = event.target.value;
		applyFilter();
	});

	el.conversation.addEventListener("keydown", function (event) {
		if (event.target.id === "msg-filter" && event.key === "Escape" && state.filterQuery) {
			event.target.value = "";
			state.filterQuery = "";
			applyFilter();
		}
	});

	el.detail.addEventListener("click", function (event) {
		const target = event.target.closest("button");
		if (!target) {
			return;
		}

		if (target.dataset.external) {
			vscode.postMessage({ type: "openExternal", url: target.dataset.external });
			return;
		}
		if (target.dataset.preview) {
			vscode.postMessage({
				type: "previewFile",
				filePath: target.dataset.preview,
				title: target.dataset.title,
			});
			return;
		}
		if (target.dataset.open) {
			vscode.postMessage({ type: "openFile", filePath: target.dataset.open });
			return;
		}

		switch (target.dataset.action) {
			case "resume":
				vscode.postMessage({ type: "resume", filePath: state.selected });
				break;
			case "export":
				vscode.postMessage({ type: "export", filePath: state.selected });
				break;
			case "transcript":
				vscode.postMessage({ type: "openFile", filePath: state.selected });
				break;
			case "bookmark":
				if (state.meta) {
					vscode.postMessage({ type: "toggleBookmark", id: state.meta.id });
				}
				break;
			case "clear-filter": {
				resetFilterState();
				const input = document.getElementById("msg-filter");
				const scope = document.getElementById("msg-scope");
				if (input) {
					input.value = "";
				}
				if (scope) {
					scope.value = "all";
				}
				applyFilter();
				break;
			}
			case "load-more":
				vscode.postMessage({ type: "loadMore", offset: state.rendered });
				break;
			case "load-all":
				state.loadingAll = true;
				renderConversationFooter();
				requestNextBatch();
				break;
			case "stop-loading":
				state.loadingAll = false;
				renderConversationFooter();
				break;
			case "more-prs": {
				const hidden = el.conversation.querySelectorAll(".pr-extra");
				for (let i = 0; i < hidden.length; i++) {
					hidden[i].hidden = false;
				}
				target.remove();
				break;
			}
			case "export-range": {
				const start = document.getElementById("range-start");
				const end = document.getElementById("range-end");
				vscode.postMessage({
					type: "exportRange",
					start: start ? start.value : "",
					end: end ? end.value : "",
				});
				break;
			}
			default:
				break;
		}
	});

	// === Host messages ===

	window.addEventListener("message", function (event) {
		const message = event.data;

		switch (message.type) {
			case "sessions": {
				if (agentFilter) agentFilter.value = message.agentFilter || "both";
				state.sessions = message.sessions || [];
				state.projects = message.projects || [];
				state.bookmarks = message.bookmarks || [];
				if (state.project && !state.projects.some((p) => p.path === state.project))
					state.project = "";
				if (state.meta && !state.sessions.some((s) => s.filePath === state.meta.filePath)) {
					state.meta = null;
					state.selected = null;
					state.messages = [];
					state.loadingAll = false;
					el.conversation.hidden = true;
					el.welcome.hidden = state.tab === "stats";
				}
				state.matches = [];
				if (state.deep && state.filter.trim())
					vscode.postMessage({ type: "deepSearch", query: state.filter });
				if (state.tab === "stats") vscode.postMessage({ type: "stats" });
				renderProjects();
				renderList();
				break;
			}

			case "bookmarks": {
				state.bookmarks = message.bookmarks || [];
				renderList();
				if (state.meta) {
					const button = el.conversation.querySelector('[data-action="bookmark"]');
					if (button) {
						button.textContent =
							state.bookmarks.indexOf(state.meta.id) !== -1
								? "Bookmarked"
								: "Bookmark";
					}
				}
				break;
			}

			case "scanProgress": {
				if (message.total > 0) {
					el.progress.hidden = false;
					el.progressFill.style.width =
						Math.round((message.scanned / message.total) * 100) + "%";
					setStatus("Indexing " + message.scanned + " of " + message.total);
				}
				break;
			}

			case "busy": {
				setBusy(message.value, message.label);
				break;
			}

			case "sessionFiltered": {
				state.loadingAll = false;
				state.filterQuery = message.query || "";
				state.filterScope = message.scope || "all";
				state.filterTerms = message.terms || [];
				state.total = message.total || 0;
				state.sessionTotal = message.sessionTotal || state.sessionTotal;
				state.messages = message.messages || [];
				appendMessages(state.messages, true);
				updateFilterStatus();
				el.detail.scrollTop = 0;
				break;
			}

			case "sessionOpened": {
				state.loadingAll = false;
				resetFilterState();
				state.meta = message.meta;
				state.messages = message.messages || [];
				state.total = message.total || 0;
				state.sessionTotal = message.total || 0;
				state.selected = message.meta.filePath;
				el.welcome.hidden = true;
				el.stats.hidden = true;
				el.conversation.hidden = false;
				renderConversation();

				if (state.pendingJump !== null && state.pendingJump !== undefined) {
					vscode.postMessage({ type: "jumpTo", index: state.pendingJump });
				} else {
					el.detail.scrollTop = 0;
				}
				break;
			}

			case "sessionPage": {
				if (message.replace) {
					// Jumping to a search result drops any filter, so the row
					// and its highlighting are reset to match.
					if (typeof message.query === "string") {
						resetFilterState();
						const input = document.getElementById("msg-filter");
						const scope = document.getElementById("msg-scope");
						if (input) {
							input.value = "";
						}
						if (scope) {
							scope.value = "all";
						}
					}
					if (typeof message.total === "number") {
						state.total = message.total;
					}
					state.messages = message.messages || [];
					appendMessages(state.messages, true);
					updateFilterStatus();
				} else {
					appendMessages(message.messages || [], false);
				}

				if (typeof message.scrollTo === "number") {
					const target = el.conversation.querySelector(
						'[data-index="' + message.scrollTo + '"]',
					);
					if (target) {
						target.scrollIntoView({ block: "center" });
					}
					state.pendingJump = null;
				}

				if (state.loadingAll) {
					if (state.rendered < state.total) {
						// Ask for the next batch from a fresh task, so the view
						// paints between batches and Stop stays clickable.
						setTimeout(requestNextBatch, 0);
					} else {
						state.loadingAll = false;
						renderConversationFooter();
					}
				}
				break;
			}

			case "searchStart": {
				state.matches = [];
				state.searching = true;
				el.progress.hidden = false;
				renderMatches();
				break;
			}

			case "searchProgress": {
				el.progressFill.style.width =
					Math.round((message.current / message.total) * 100) + "%";
				setStatus("Searching " + message.current + " of " + message.total + " transcripts");
				break;
			}

			case "searchMatch": {
				state.matches.push(message.match);
				scheduleMatchRender();
				break;
			}

			case "searchDone": {
				state.searching = false;
				el.progress.hidden = true;
				renderMatches();
				break;
			}

			case "stats": {
				renderStats(message.stats);
				break;
			}

			default:
				break;
		}
	});

	let matchRenderTimer = null;

	function scheduleMatchRender() {
		if (matchRenderTimer) {
			return;
		}
		// Matches stream in one at a time; batching keeps a broad search from
		// re-rendering the list hundreds of times a second.
		matchRenderTimer = setTimeout(function () {
			matchRenderTimer = null;
			renderMatches();
		}, 120);
	}

	function renderProjects() {
		let html = '<option value="">All projects</option>';
		for (let i = 0; i < state.projects.length; i++) {
			const project = state.projects[i];
			html +=
				'<option value="' +
				escapeHtml(project.path) +
				'"' +
				(project.path === state.project ? " selected" : "") +
				">" +
				escapeHtml(project.name) +
				" (" +
				project.count +
				")</option>";
		}
		el.project.innerHTML = html;
	}

	// === Start ===

	installIcons();
	el.search.value = state.filter;
	el.bookmarks.setAttribute("aria-pressed", String(state.bookmarksOnly));
	showTab(state.tab);
	vscode.postMessage({ type: "ready" });
})();
