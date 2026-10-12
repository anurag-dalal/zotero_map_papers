/* global ChromeUtils */
"use strict";

var { Zotero } = ChromeUtils.importESModule("chrome://zotero/content/zotero.mjs");

const CP = Zotero.MapPapers;
const { core, themes } = CP;

const $ = id => document.getElementById(id);

function h(tag, props = {}, ...children) {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (v === undefined || v === null || v === false) continue;
		if (k === "class") el.className = v;
		else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
		else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
		else if (k in el && k !== "list") el[k] = v;
		else el.setAttribute(k, v);
	}
	for (const c of children.flat()) {
		if (c === null || c === undefined || c === false) continue;
		el.append(c instanceof Node ? c : document.createTextNode(String(c)));
	}
	return el;
}

const fmt = n => (n || 0).toLocaleString();
const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

function authorShort(p, max = 3) {
	const a = p.authors || [];
	if (!a.length) return "Unknown authors";
	return a.length > max ? `${a.slice(0, max).join(", ")} et al.` : a.join(", ");
}

function nodeLabel(p) {
	const first = (p.authors && p.authors[0]) || "";
	const last = first.trim().split(/\s+/).pop() || "?";
	return `${last}${p.year ? ", " + p.year : ""}`;
}

const RELATION_TEXT = {
	origin: "Origin paper",
	ref: "Referenced by origin",
	cite: "Cites origin",
	other: "Related",
};

// ---- state --------------------------------------------------------------

const state = {
	tab: "graph",
	theme: themes.get(CP.getPref("theme")),
	colorBy: CP.getPref("colorBy"),
	size: Number(CP.getPref("graphSize")) || 40,
	graph: null,
	history: [],
	hIndex: -1,
	lastRequest: null,
	selected: null,
	hover: null,
	view: { k: 1, tx: 0, ty: 0 },
	lib: null,
	listSort: "similarity",
	listFilter: "",
	prior: { scope: "graph", sort: "graphCount", items: null, loading: false, error: null, key: null, token: 0 },
	deriv: { scope: "graph", sort: CP.getPref("derivativeSort") || "citations", items: [], page: 0, total: 0, scanned: 0, hasMore: false, loading: false, error: null, key: null, token: 0 },
	cache: new Map(),
	abstracts: new Map(),
	loadToken: 0,
	busy: new Set(),
};

// ---- theme ----------------------------------------------------------------

function applyTheme() {
	const t = state.theme;
	const root = document.documentElement.style;
	const vars = {
		bg: t.bg, canvas: t.canvas, panel: t.panel, panel2: t.panel2, border: t.border, text: t.text,
		muted: t.muted, accent: t.accent, "accent-text": t.accentText, library: t.library, origin: t.origin,
	};
	for (const [k, v] of Object.entries(vars)) root.setProperty("--" + k, v);
	root.colorScheme = t.dark ? "dark" : "light";
	$("theme").value = t.id;
	$("color-by").value = state.colorBy;
	renderLegend();
	renderList();
	draw();
}

function yearRange() {
	const years = (state.graph?.nodes || []).map(n => n.year).filter(Boolean);
	return years.length ? [Math.min(...years), Math.max(...years)] : [2000, 2020];
}

function nodeColor(n) {
	const t = state.theme;
	if (state.colorBy === "relation") return t.relation[n.relation] || t.relation.other;
	if (!n.year) return t.relation.other;
	const [min, max] = yearRange();
	return themes.rampColor(t.ramp, max > min ? (n.year - min) / (max - min) : 1);
}

function renderLegend() {
	const t = state.theme;
	const el = $("legend");
	el.replaceChildren();
	if (!state.graph) {
		el.hidden = true;
		return;
	}
	el.hidden = false;
	if (state.colorBy === "relation") {
		el.append(h("div", {}, ...["origin", "ref", "cite", "other"].map(r =>
			h("span", { class: "sw" }, h("i", { style: { background: t.relation[r] } }), RELATION_TEXT[r]))));
	}
	else {
		const [min, max] = yearRange();
		el.append(
			h("div", {}, "Publication year"),
			h("div", { class: "ramp", style: { background: `linear-gradient(to right, ${t.ramp.join(", ")})` } }),
			h("div", { class: "ends" }, h("span", {}, min), h("span", {}, max)));
	}
	el.append(h("div", { class: "hint" }, "Size = citations · Lines = similarity"),
		h("div", { class: "hint" },
			h("span", { class: "sw" }, h("i", { style: { border: `2px solid ${t.library}`, background: "transparent" } }), "In your library"),
			h("span", { class: "sw" }, h("i", { style: { border: `2px solid ${t.origin}`, background: "transparent" } }), "Origin")));
}

// ---- library ---------------------------------------------------------------

function libraryItemID(p) {
	if (!state.lib || !p) return null;
	return (p.doi && state.lib.dois.get(p.doi)) || state.lib.titles.get(core.normTitle(p.title)) || null;
}

async function refreshLibrary() {
	state.lib = await CP.libraryIndex();
}

// ---- loading ---------------------------------------------------------------

function showOverlay(msg, { error = false, idle = false, actions = [] } = {}) {
	const ov = $("overlay");
	ov.hidden = false;
	ov.classList.toggle("error", error);
	ov.classList.toggle("idle", idle);
	$("overlay-msg").textContent = msg;
	$("overlay-actions").replaceChildren(...actions);
}

function hideOverlay() {
	$("overlay").hidden = true;
}

function setStatus(text) {
	$("status").textContent = text || "";
}

/**
 * Open a paper. request: { query } (Zotero item fields), { openalex }, plus
 * optional tab. fromHistory: don't push onto the history stack.
 */
async function open(request, { fromHistory = false, force = false } = {}) {
	if (request.tab) setTab(request.tab, { load: false });
	state.lastRequest = request;
	const token = ++state.loadToken;
	const label = request.label || request.query?.label;
	showOverlay(label ? `Looking up “${label}”…` : "Looking up the paper…");
	try {
		let id = request.openalex;
		if (!id) id = (await CP.source.resolve(request.query)).id;
		if (token !== state.loadToken) return;
		if (!fromHistory) {
			state.history = state.history.slice(0, state.hIndex + 1);
			if (state.history[state.hIndex] !== id) state.history.push(id);
			state.hIndex = state.history.length - 1;
		}
		updateNav();

		const key = `${id}:${state.size}`;
		let graph = force ? null : state.cache.get(key);
		if (!graph) {
			graph = await core.buildGraph(CP.source, id, {
				size: state.size,
				onProgress: msg => token === state.loadToken && showOverlay(msg),
			});
			state.cache.set(key, graph);
		}
		await refreshLibrary();
		if (token !== state.loadToken) return;
		setGraph(graph);
	}
	catch (e) {
		if (token !== state.loadToken) return;
		Zotero.logError(e);
		showOverlay(e.message || String(e), {
			error: true,
			actions: [h("button", { class: "btn primary", onclick: () => open(request, { fromHistory: true, force: true }) }, "Try again")],
		});
	}
}

function setGraph(graph) {
	state.graph = graph;
	state.selected = graph.nodes[0];
	state.hover = null;
	state.prior.items = null;
	state.prior.key = null;
	state.deriv.items = [];
	state.deriv.key = null;
	hideOverlay();
	$("origin-bar").hidden = false;
	$("origin-title").textContent = graph.origin.title;
	$("origin-title").title = graph.origin.title;
	document.title = `Map Papers: ${graph.origin.title}`;
	setStatus(`${graph.nodes.length} papers · ${graph.edges.length} links · ${graph.stats.pool} candidates analysed`);
	renderLegend();
	renderList();
	renderDetails();
	fit();
	if (state.tab !== "graph") loadTab();
}

function updateNav() {
	$("back").disabled = state.hIndex <= 0;
	$("forward").disabled = state.hIndex >= state.history.length - 1;
}

function go(delta) {
	const i = state.hIndex + delta;
	if (i < 0 || i >= state.history.length) return;
	state.hIndex = i;
	updateNav();
	open({ openalex: state.history[i] }, { fromHistory: true });
}

function rebuild() {
	if (state.graph) open({ openalex: state.graph.origin.id, label: state.graph.origin.title }, { fromHistory: true });
}

// ---- tabs ------------------------------------------------------------------

function setTab(tab, { load = true } = {}) {
	state.tab = tab;
	$("main").dataset.tab = tab;
	for (const b of document.querySelectorAll(".tab")) {
		b.classList.toggle("active", b.dataset.tab === tab);
		b.setAttribute("aria-selected", b.dataset.tab === tab);
	}
	$("graph-view").hidden = tab !== "graph";
	$("table-view").hidden = tab === "graph";
	if (tab === "graph") requestAnimationFrame(resize);
	if (load) loadTab();
}

function loadTab() {
	if (!state.graph) return;
	if (state.tab === "prior") loadPrior();
	else if (state.tab === "derivative") loadDeriv();
}

async function loadPrior() {
	const p = state.prior;
	const key = `${state.graph.origin.id}:${state.size}:${p.scope}`;
	if (p.key === key && (p.items || p.loading)) return renderTable();
	const token = ++p.token;
	p.key = key;
	p.items = null;
	p.error = null;
	p.loading = true;
	renderTable();
	try {
		const items = await core.priorWorks(CP.source, state.graph, { scope: p.scope });
		if (token !== p.token) return;
		p.items = items;
	}
	catch (e) {
		if (token !== p.token) return;
		p.error = e;
		p.key = null;
	}
	p.loading = false;
	renderTable();
}

const serverSort = sort => (sort === "year" ? "year" : "citations");

async function loadDeriv({ more = false } = {}) {
	const d = state.deriv;
	const key = `${state.graph.origin.id}:${state.size}:${d.scope}:${serverSort(d.sort)}`;
	if (!more && d.key === key) return renderTable();
	const token = ++d.token;
	if (!more) {
		d.key = key;
		d.items = [];
		d.page = 0;
		d.scanned = 0;
		d.total = 0;
		d.hasMore = false;
	}
	d.error = null;
	d.loading = true;
	renderTable();
	try {
		// Keep paging until we have a useful number of rows (graph scope filters).
		let added = 0;
		do {
			const res = await core.derivativeWorks(CP.source, state.graph, { scope: d.scope, sort: serverSort(d.sort), page: d.page + 1 });
			if (token !== d.token) return;
			const seen = new Set(d.items.map(p => p.id));
			const fresh = res.items.filter(p => !seen.has(p.id));
			d.items = d.items.concat(fresh);
			added += fresh.length;
			d.page++;
			d.scanned += res.scanned;
			d.total = res.total;
			d.hasMore = res.hasMore;
		} while (added < 25 && d.hasMore && d.page < 5);
	}
	catch (e) {
		if (token !== d.token) return;
		d.error = e;
		if (!d.items.length) d.key = null;
	}
	d.loading = false;
	renderTable();
}

// ---- table (prior / derivative) -------------------------------------------

const SORTS = {
	prior: [
		["graphCount", "Relevance (cited by graph papers)"],
		["citations", "Citations"],
		["year", "Newest"],
		["yearAsc", "Oldest"],
		["title", "Title"],
	],
	derivative: [
		["citations", "Citations"],
		["year", "Newest"],
		["graphCount", "Relevance (cites graph papers)"],
		["title", "Title"],
	],
};

function sortPapers(items, sort) {
	const by = {
		citations: (a, b) => b.citations - a.citations,
		year: (a, b) => (b.year || 0) - (a.year || 0) || b.citations - a.citations,
		yearAsc: (a, b) => (a.year || 9999) - (b.year || 9999) || b.citations - a.citations,
		graphCount: (a, b) => b.graphCount - a.graphCount || b.citations - a.citations,
		similarity: (a, b) => b.similarity - a.similarity,
		title: (a, b) => a.title.localeCompare(b.title),
	}[sort] || (() => 0);
	return items.slice().sort(by);
}

function setTableSort(sort) {
	if (state.tab === "prior") {
		state.prior.sort = sort;
		renderTable();
	}
	else {
		state.deriv.sort = sort;
		CP.setPref("derivativeSort", sort);
		// Citation and year order come from the server so the true top works show up.
		if (state.graph) loadDeriv();
	}
}

function renderTable() {
	if (state.tab === "graph") return;
	const isPrior = state.tab === "prior";
	const s = isPrior ? state.prior : state.deriv;

	$("table-title").textContent = isPrior ? "Prior works" : "Derivative works";
	const scopes = isPrior
		? [["graph", "Common to the graph"], ["origin", "This paper’s references"]]
		: [["graph", "Citing the graph"], ["origin", "Citing this paper"]];
	$("scope").replaceChildren(...scopes.map(([v, label]) => h("button", {
		class: s.scope === v ? "active" : "",
		onclick: () => {
			s.scope = v;
			loadTab();
		},
	}, label)));

	const sel = $("table-sort");
	sel.replaceChildren(...SORTS[state.tab].map(([v, label]) => h("option", { value: v }, label)));
	sel.value = s.sort;

	const linkHead = isPrior ? "Cited by graph" : "Cites graph";
	if (isPrior) {
		$("table-note").textContent = s.scope === "graph"
			? "Earlier works that many papers in the graph cite. Often the foundational papers of the field."
			: "Every work the origin paper cites.";
	}
	else {
		$("table-note").textContent = s.scope === "graph"
			? "Newer works (from the origin’s year on) that cite at least two papers in the graph: recent work in the field."
			: "Works that cite the origin paper.";
	}

	const cols = [
		["title", "Title", ""],
		["year", "Year", "num"],
		["citations", "Citations", "num"],
		["graphCount", linkHead, "num"],
		[null, "Library", ""],
	];
	const sortKey = s.sort === "yearAsc" ? "year" : s.sort;
	$("table").tHead.rows[0].replaceChildren(...cols.map(([key, label, cls]) => h("th", {
		class: [cls, key && key === sortKey ? "sorted" : ""].join(" "),
		title: key ? "Sort by " + label.toLowerCase() : "",
		onclick: () => key && setTableSort(key === "year" && s.sort === "year" && isPrior ? "yearAsc" : key),
	}, label, key && key === sortKey ? (s.sort === "title" || s.sort === "yearAsc" ? " ↑" : " ↓") : "")));

	const tbody = $("table").tBodies[0];
	const more = $("table-more");
	const items = s.items;
	if (s.error && !(items && items.length)) {
		tbody.replaceChildren();
		more.replaceChildren(h("div", {}, s.error.message || String(s.error)), h("p"),
			h("button", { class: "btn", onclick: () => loadTab() }, "Try again"));
		return;
	}
	if (!items || (!items.length && s.loading)) {
		tbody.replaceChildren();
		more.replaceChildren(h("div", { class: "spinner", style: { margin: "20px auto" } }), "Loading…");
		return;
	}

	const sorted = sortPapers(items, s.sort);
	const maxLinks = Math.max(1, ...sorted.map(p => p.graphCount || 0));
	tbody.replaceChildren(...sorted.map((p) => {
		const libID = libraryItemID(p);
		const tr = h("tr", {
			class: state.selected && state.selected.id === p.id ? "selected" : "",
			onclick: () => select(p),
			ondblclick: () => open({ openalex: p.id, label: p.title }),
		},
		h("td", {},
			h("div", { class: "t" }, p.title),
			h("div", { class: "meta" }, authorShort(p), p.venue ? ` · ${clip(p.venue, 80)}` : "",
				p.inGraph ? " " : "", p.inGraph ? h("span", { class: "badge muted" }, "IN GRAPH") : "")),
		h("td", { class: "num" }, p.year || "—"),
		h("td", { class: "num" }, fmt(p.citations)),
		h("td", { class: "num" },
			h("span", { class: "bar", style: { width: `${Math.round(40 * (p.graphCount || 0) / maxLinks)}px` } }),
			p.graphCount || 0),
		h("td", {}, libID ? h("span", { class: "badge lib" }, "IN LIBRARY") : ""));
		tr.dataset.id = p.id;
		return tr;
	}));

	more.replaceChildren();
	if (!sorted.length && !s.loading) {
		more.append(isPrior ? "No prior works found." : "No derivative works found yet.");
	}
	if (isPrior) {
		if (sorted.length) more.append(`${sorted.length} works`);
	}
	else {
		more.append(`${sorted.length} shown · ${fmt(s.scanned)} of ${fmt(s.total)} citing works scanned `);
		if (s.loading) more.append(h("div", { class: "spinner", style: { margin: "10px auto" } }));
		else if (s.hasMore) more.append(h("button", { class: "btn", onclick: () => loadDeriv({ more: true }) }, "Load more"));
		if (s.error) more.append(h("div", {}, s.error.message));
	}
}

// ---- list (graph papers) -----------------------------------------------------

function renderList() {
	const list = $("list");
	if (!state.graph) {
		list.replaceChildren(h("div", { class: "empty" }, "Graph papers will appear here."));
		return;
	}
	const q = state.listFilter.trim().toLowerCase();
	const nodes = sortPapers(state.graph.nodes, state.listSort === "year" ? "year" : state.listSort)
		.filter(n => !q || n.title.toLowerCase().includes(q) || (n.authors || []).some(a => a.toLowerCase().includes(q)));
	list.replaceChildren(...nodes.map((n) => {
		const row = h("div", {
			class: "row" + (state.selected && state.selected.id === n.id ? " selected" : ""),
			role: "option",
			onclick: () => select(n, { center: true }),
			onmouseenter: () => {
				state.hover = n.index;
				draw();
			},
			onmouseleave: () => {
				state.hover = null;
				draw();
			},
		},
		h("span", { class: "dot", style: { background: nodeColor(n) } }),
		h("div", {},
			h("div", { class: "t" }, n.title),
			h("div", { class: "m" },
				`${nodeLabel(n)} · ${fmt(n.citations)} cites`,
				n.isOrigin ? " " : "", n.isOrigin ? h("span", { class: "badge origin" }, "ORIGIN") : "",
				libraryItemID(n) ? " " : "", libraryItemID(n) ? h("span", { class: "badge lib" }, "IN LIBRARY") : "")));
		row.dataset.id = n.id;
		return row;
	}));
	if (!nodes.length) list.append(h("div", { class: "empty" }, "No papers match the filter."));
}

// ---- details -----------------------------------------------------------------

function graphNode(p) {
	return p && state.graph ? state.graph.nodes.find(n => n.id === p.id) || null : null;
}

function select(paper, { center = false } = {}) {
	state.selected = graphNode(paper) || paper;
	renderDetails();
	for (const el of document.querySelectorAll("#list .row, #table tbody tr")) {
		el.classList.toggle("selected", el.dataset.id === paper.id);
	}
	const node = graphNode(paper);
	if (center && node) centerOn(node);
	draw();
}

async function withBusy(key, button, label, fn) {
	if (state.busy.has(key)) return;
	state.busy.add(key);
	const prev = button.textContent;
	button.disabled = true;
	button.textContent = label;
	try {
		await fn();
	}
	catch (e) {
		Zotero.logError(e);
		button.textContent = "Failed: " + (e.message || e);
		await Zotero.Promise.delay(2500);
		button.textContent = prev;
	}
	finally {
		state.busy.delete(key);
		button.disabled = false;
	}
}

function renderDetails() {
	const panel = $("details");
	const p = state.selected;
	if (!p) {
		panel.replaceChildren(h("div", { class: "empty" },
			"Select a paper in the graph or a list to see its details."));
		return;
	}
	const node = graphNode(p);
	const libID = libraryItemID(p);
	const badges = [];
	if (node) badges.push(h("span", { class: "badge " + (node.isOrigin ? "origin" : "muted") }, RELATION_TEXT[node.relation].toUpperCase()));
	if (libID) badges.push(h("span", { class: "badge lib" }, "IN LIBRARY"));

	const metrics = [
		[fmt(p.citations), "Citations"],
		[fmt((p.refs || []).length), "References"],
		node && !node.isOrigin
			? [`${Math.round(node.similarity * 100)}%`, "Similarity"]
			: p.graphCount !== undefined ? [p.graphCount, state.tab === "prior" ? "Cited by graph" : "Cites graph"]
				: [p.year || "—", "Year"],
	];

	const libButton = libID
		? h("button", { class: "btn", onclick: () => CP.showInLibrary(libID) }, "Show in Zotero")
		: h("button", {
			class: "btn primary",
			onclick: e => withBusy("add:" + p.id, e.currentTarget, "Adding…", async () => {
				await CP.addToLibrary(p);
				await refreshLibrary();
				renderDetails();
				renderList();
				renderTable();
				draw();
			}),
		}, "＋ Add to Zotero");

	const actions = [
		libButton,
		h("button", { class: "btn", onclick: () => Zotero.launchURL(p.url) }, "Open ↗"),
		!(node && node.isOrigin) && h("button", {
			class: "btn",
			title: "Build a new graph around this paper",
			onclick: () => open({ openalex: p.id, label: p.title }),
		}, "Build graph"),
		p.doi && h("button", {
			class: "btn",
			onclick: (e) => {
				Zotero.Utilities.Internal.copyTextToClipboard(p.doi);
				e.currentTarget.textContent = "Copied";
			},
		}, "Copy DOI"),
	];

	const abstract = h("div", { class: "abstract muted" }, "Loading abstract…");
	panel.replaceChildren(h("div", { class: "details-inner" },
		badges.length ? h("div", { style: { display: "flex", gap: "6px", flexWrap: "wrap" } }, badges) : null,
		h("h2", {}, p.title),
		h("div", { class: "authors" }, authorShort(p, 8)),
		h("div", { class: "meta", title: p.venue || "" }, [clip(p.venue, 140), p.year, p.type].filter(Boolean).join(" · ")),
		h("div", { class: "metrics" }, metrics.map(([v, l]) => h("div", { class: "metric" }, h("b", {}, v), h("span", {}, l)))),
		h("div", { class: "actions" }, actions),
		h("div", { class: "section-label" }, "Abstract"),
		abstract));

	const showAbstract = (text) => {
		abstract.textContent = text || "No abstract available.";
		abstract.classList.toggle("muted", !text);
	};
	if (state.abstracts.has(p.id)) {
		showAbstract(state.abstracts.get(p.id));
	}
	else {
		CP.source.getAbstract(p.id).then((text) => {
			state.abstracts.set(p.id, text);
			if (state.selected && state.selected.id === p.id) showAbstract(text);
		}, () => showAbstract(null));
	}
}

// ---- canvas ------------------------------------------------------------------

const canvas = $("canvas");
const ctx = canvas.getContext("2d");
let W = 0;
let H = 0;
let drawQueued = false;

function resize() {
	const rect = canvas.getBoundingClientRect();
	if (!rect.width || !rect.height) return;
	const dpr = window.devicePixelRatio || 1;
	const first = !W;
	W = rect.width;
	H = rect.height;
	canvas.width = Math.round(W * dpr);
	canvas.height = Math.round(H * dpr);
	if (first && state.graph) fit();
	else drawNow();
}

function draw() {
	if (drawQueued) return;
	drawQueued = true;
	requestAnimationFrame(() => {
		drawQueued = false;
		drawNow();
	});
}

const toScreen = (x, y) => [x * state.view.k + state.view.tx, y * state.view.k + state.view.ty];
const toWorld = (sx, sy) => [(sx - state.view.tx) / state.view.k, (sy - state.view.ty) / state.view.k];

function focusIndex() {
	if (state.hover !== null) return state.hover;
	const n = graphNode(state.selected);
	return n && !n.isOrigin ? n.index : null;
}

function drawNow() {
	const t = state.theme;
	const dpr = window.devicePixelRatio || 1;
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.fillStyle = t.canvas;
	ctx.fillRect(0, 0, W, H);
	const g = state.graph;
	if (!g || !W) return;

	const { k } = state.view;
	const focus = focusIndex();
	const neighbors = new Set();
	if (focus !== null) {
		neighbors.add(focus);
		for (const e of g.edges) {
			if (e.source === focus) neighbors.add(e.target);
			if (e.target === focus) neighbors.add(e.source);
		}
	}
	const widthScale = Math.max(0.5, Math.min(1.6, k));

	// Edges: dim first, highlighted on top.
	ctx.lineCap = "round";
	for (const pass of [0, 1]) {
		for (const e of g.edges) {
			const hi = focus !== null && (e.source === focus || e.target === focus);
			if ((pass === 1) !== hi) continue;
			const a = g.nodes[e.source];
			const b = g.nodes[e.target];
			const [x1, y1] = toScreen(a.x, a.y);
			const [x2, y2] = toScreen(b.x, b.y);
			ctx.globalAlpha = focus !== null && !hi ? 0.35 : 1;
			ctx.strokeStyle = hi ? t.edgeHi : t.edge;
			ctx.lineWidth = (0.6 + 2.8 * e.weight) * widthScale * (hi ? 1.25 : 1);
			ctx.beginPath();
			ctx.moveTo(x1, y1);
			ctx.lineTo(x2, y2);
			ctx.stroke();
		}
	}
	ctx.globalAlpha = 1;

	const selectedId = state.selected && state.selected.id;
	const order = g.nodes.slice().sort((a, b) => (neighbors.has(a.index) ? 1 : 0) - (neighbors.has(b.index) ? 1 : 0));
	const labels = [];
	const baseStroke = t.dark ? "rgba(255,255,255,0.28)" : "rgba(0,0,0,0.18)";
	for (const n of order) {
		const [x, y] = toScreen(n.x, n.y);
		const r = Math.max(2.5, n.r * k);
		if (x + r < -40 || x - r > W + 40 || y + r < -40 || y - r > H + 40) continue;
		const dim = focus !== null && !neighbors.has(n.index);
		ctx.globalAlpha = dim ? 0.25 : 1;

		ctx.beginPath();
		ctx.arc(x, y, r, 0, Math.PI * 2);
		ctx.fillStyle = nodeColor(n);
		ctx.fill();
		ctx.lineWidth = 1;
		ctx.strokeStyle = baseStroke;
		ctx.stroke();

		let ring = r;
		if (n.isOrigin) {
			ring += 2.5;
			ctx.beginPath();
			ctx.arc(x, y, ring, 0, Math.PI * 2);
			ctx.lineWidth = 3;
			ctx.strokeStyle = t.origin;
			ctx.stroke();
			ring += 1.5;
		}
		if (libraryItemID(n)) {
			ring += 3;
			ctx.beginPath();
			ctx.arc(x, y, ring, 0, Math.PI * 2);
			ctx.lineWidth = 2;
			ctx.strokeStyle = t.library;
			ctx.stroke();
		}
		if (n.id === selectedId) {
			ring += 4;
			ctx.beginPath();
			ctx.arc(x, y, ring, 0, Math.PI * 2);
			ctx.lineWidth = 2;
			ctx.setLineDash([4, 3]);
			ctx.strokeStyle = t.selected;
			ctx.stroke();
			ctx.setLineDash([]);
		}

		const emphasized = n.isOrigin || n.index === focus || n.id === selectedId;
		if (k >= 0.45 || emphasized || (focus !== null && neighbors.has(n.index))) {
			labels.push({ x, y: y + ring + 12, text: nodeLabel(n), dim, emphasized });
		}
	}

	// Labels last so they sit above every node.
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.lineJoin = "round";
	for (const l of labels) {
		ctx.globalAlpha = l.dim ? 0.3 : 1;
		ctx.font = `${l.emphasized ? "700 12px" : "500 11px"} system-ui, sans-serif`;
		ctx.lineWidth = 3.5;
		ctx.strokeStyle = t.canvas;
		ctx.strokeText(l.text, l.x, l.y);
		ctx.fillStyle = l.emphasized ? t.text : t.label;
		ctx.fillText(l.text, l.x, l.y);
	}
	ctx.globalAlpha = 1;
}

function fit() {
	const g = state.graph;
	if (!g || !W) return;
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (const n of g.nodes) {
		x0 = Math.min(x0, n.x - n.r - 30);
		x1 = Math.max(x1, n.x + n.r + 30);
		y0 = Math.min(y0, n.y - n.r - 8);
		y1 = Math.max(y1, n.y + n.r + 24);
	}
	const k = Math.max(0.15, Math.min(2.2, Math.min((W - 60) / (x1 - x0), (H - 60) / (y1 - y0))));
	state.view = { k, tx: W / 2 - ((x0 + x1) / 2) * k, ty: H / 2 - ((y0 + y1) / 2) * k };
	draw();
}

function zoomAt(factor, sx = W / 2, sy = H / 2) {
	const v = state.view;
	const k = Math.max(0.1, Math.min(6, v.k * factor));
	const [wx, wy] = toWorld(sx, sy);
	state.view = { k, tx: sx - wx * k, ty: sy - wy * k };
	draw();
}

function centerOn(n) {
	const from = { ...state.view };
	const to = { k: from.k, tx: W / 2 - n.x * from.k, ty: H / 2 - n.y * from.k };
	const start = performance.now();
	const step = (now) => {
		const t = Math.min(1, (now - start) / 280);
		const e = 1 - (1 - t) ** 3;
		state.view = { k: from.k, tx: from.tx + (to.tx - from.tx) * e, ty: from.ty + (to.ty - from.ty) * e };
		drawNow();
		if (t < 1) requestAnimationFrame(step);
	};
	requestAnimationFrame(step);
}

function hitTest(sx, sy) {
	const g = state.graph;
	if (!g) return null;
	let best = null;
	for (const n of g.nodes) {
		const [x, y] = toScreen(n.x, n.y);
		const r = Math.max(6, n.r * state.view.k) + 2;
		const d = Math.hypot(sx - x, sy - y);
		if (d <= r && (!best || d < best.d)) best = { n, d };
	}
	return best && best.n;
}

function showTooltip(n, sx, sy) {
	const tip = $("tooltip");
	if (!n) {
		tip.hidden = true;
		return;
	}
	tip.replaceChildren(
		h("div", { class: "t" }, n.title),
		h("div", { class: "meta" }, `${authorShort(n, 2)} · ${n.year || "n.d."} · ${fmt(n.citations)} citations`),
		h("div", { class: "meta" }, RELATION_TEXT[n.relation] + (n.isOrigin ? "" : ` · ${Math.round(n.similarity * 100)}% similar`)));
	tip.hidden = false;
	const box = $("graph-view").getBoundingClientRect();
	const tw = tip.offsetWidth;
	const th = tip.offsetHeight;
	tip.style.left = `${Math.min(box.width - tw - 8, sx + 14)}px`;
	tip.style.top = `${sy + th + 20 > box.height ? sy - th - 10 : sy + 16}px`;
}

let drag = null;

canvas.addEventListener("mousedown", (e) => {
	if (e.button !== 0) return;
	const n = hitTest(e.offsetX, e.offsetY);
	drag = { n, x: e.offsetX, y: e.offsetY, moved: false };
	canvas.classList.add("dragging");
});

window.addEventListener("mousemove", (e) => {
	const rect = canvas.getBoundingClientRect();
	const sx = e.clientX - rect.left;
	const sy = e.clientY - rect.top;
	if (drag) {
		const dx = sx - drag.x;
		const dy = sy - drag.y;
		if (!drag.moved && Math.hypot(dx, dy) < 3) return;
		drag.moved = true;
		if (drag.n) {
			drag.n.x += dx / state.view.k;
			drag.n.y += dy / state.view.k;
		}
		else {
			state.view.tx += dx;
			state.view.ty += dy;
		}
		drag.x = sx;
		drag.y = sy;
		showTooltip(null);
		draw();
		return;
	}
	if (e.target !== canvas) return;
	const n = hitTest(sx, sy);
	const idx = n ? n.index : null;
	canvas.classList.toggle("over-node", !!n);
	showTooltip(n, sx, sy);
	if (idx !== state.hover) {
		state.hover = idx;
		draw();
	}
});

window.addEventListener("mouseup", () => {
	if (!drag) return;
	const d = drag;
	drag = null;
	canvas.classList.remove("dragging");
	if (!d.moved) {
		if (d.n) select(d.n);
		else if (state.graph) select(state.graph.nodes[0]);
	}
});

canvas.addEventListener("mouseleave", () => {
	showTooltip(null);
	if (state.hover !== null && !drag) {
		state.hover = null;
		draw();
	}
});

canvas.addEventListener("dblclick", (e) => {
	const n = hitTest(e.offsetX, e.offsetY);
	if (!n) fit();
});

canvas.addEventListener("wheel", (e) => {
	e.preventDefault();
	zoomAt(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018)), e.offsetX, e.offsetY);
}, { passive: false });

// ---- search ------------------------------------------------------------------

let searchHits = [];

function closeSearch() {
	$("search-results").hidden = true;
}

async function runSearch() {
	const text = $("search").value.trim();
	if (!text) return;
	const box = $("search-results");
	const oa = text.match(/(?:openalex\.org\/)?(W\d{4,})/i);
	const doi = core.cleanDOI(text);
	if (oa && !/\s/.test(text)) {
		closeSearch();
		return open({ openalex: oa[1].toUpperCase() });
	}
	if (doi) {
		closeSearch();
		return open({ query: { doi, label: doi } });
	}
	box.hidden = false;
	box.replaceChildren(h("div", { class: "search-hit" }, h("div", { class: "m" }, "Searching OpenAlex…")));
	try {
		searchHits = await CP.source.search(text);
		box.replaceChildren(...(searchHits.length ? searchHits.map(p => h("div", {
			class: "search-hit",
			onclick: () => {
				closeSearch();
				open({ openalex: p.id, label: p.title });
			},
		}, h("div", { class: "t" }, p.title), h("div", { class: "m" }, `${authorShort(p, 2)} · ${p.year || "n.d."} · ${fmt(p.citations)} citations`)))
			: [h("div", { class: "search-hit" }, h("div", { class: "m" }, "No results."))]));
	}
	catch (e) {
		box.replaceChildren(h("div", { class: "search-hit" }, h("div", { class: "m" }, e.message)));
	}
}

// ---- wiring --------------------------------------------------------------------

function initControls() {
	const themeSel = $("theme");
	themeSel.replaceChildren(...themes.list.map(t => h("option", { value: t.id }, t.name)));
	themeSel.addEventListener("change", () => CP.setPref("theme", themeSel.value));
	$("color-by").addEventListener("change", e => CP.setPref("colorBy", e.target.value));
	const sizeSel = $("graph-size");
	sizeSel.value = String(state.size);
	sizeSel.addEventListener("change", () => CP.setPref("graphSize", Number(sizeSel.value)));

	for (const b of document.querySelectorAll(".tab")) b.addEventListener("click", () => setTab(b.dataset.tab));
	$("back").addEventListener("click", () => go(-1));
	$("forward").addEventListener("click", () => go(1));
	$("zoom-in").addEventListener("click", () => zoomAt(1.25));
	$("zoom-out").addEventListener("click", () => zoomAt(0.8));
	$("zoom-fit").addEventListener("click", fit);
	$("list-sort").addEventListener("change", (e) => {
		state.listSort = e.target.value;
		renderList();
	});
	$("list-filter").addEventListener("input", (e) => {
		state.listFilter = e.target.value;
		renderList();
	});
	$("table-sort").addEventListener("change", e => setTableSort(e.target.value));
	$("search").addEventListener("keydown", (e) => {
		if (e.key === "Enter") runSearch();
		if (e.key === "Escape") closeSearch();
	});
	document.addEventListener("mousedown", (e) => {
		if (!e.target.closest(".search-wrap")) closeSearch();
	});
	window.addEventListener("keydown", (e) => {
		const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) || !!openDropdown;
		if (e.altKey && e.key === "ArrowLeft") go(-1);
		else if (e.altKey && e.key === "ArrowRight") go(1);
		else if (!typing && state.tab === "graph" && (e.key === "f" || e.key === "F")) fit();
		else if (!typing && e.key === "Escape" && state.graph) select(state.graph.nodes[0]);
	});

	// Prefs can change here or in Zotero's settings; both land in these observers.
	const observers = [
		Zotero.Prefs.registerObserver("mappapers.theme", (v) => {
			state.theme = themes.get(v);
			applyTheme();
		}),
		Zotero.Prefs.registerObserver("mappapers.colorBy", (v) => {
			state.colorBy = v;
			applyTheme();
		}),
		Zotero.Prefs.registerObserver("mappapers.graphSize", (v) => {
			state.size = Number(v) || 40;
			$("graph-size").value = String(state.size);
			rebuild();
		}),
	];
	window.addEventListener("unload", () => observers.forEach(id => Zotero.Prefs.unregisterObserver(id)));
	new ResizeObserver(resize).observe($("graph-view"));
}

// ---- dropdowns -------------------------------------------------------------------

/**
 * Native <select> popups don't take clicks in a chrome window, so each select
 * is hidden and driven by a page-drawn menu. The <select> stays the source of
 * truth: code reads/writes .value and listens for "change" as usual.
 */
const valueProp = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
let openDropdown = null;

function closeDropdown() {
	if (!openDropdown) return;
	openDropdown.menu.remove();
	openDropdown.button.setAttribute("aria-expanded", "false");
	openDropdown = null;
}

function enhanceSelect(sel) {
	const button = h("button", { class: "dd-btn", type: "button", "aria-haspopup": "listbox", "aria-expanded": "false" });
	if (sel.title) button.title = sel.title;
	sel.hidden = true;
	sel.after(button);

	const refresh = () => {
		const opt = sel.options[sel.selectedIndex];
		button.textContent = opt ? opt.textContent : "";
	};
	Object.defineProperty(sel, "value", {
		configurable: true,
		get: () => valueProp.get.call(sel),
		set: (v) => {
			valueProp.set.call(sel, v);
			refresh();
		},
	});
	new MutationObserver(refresh).observe(sel, { childList: true, subtree: true });

	const choose = (value) => {
		closeDropdown();
		button.focus();
		if (value === sel.value) return;
		sel.value = value;
		sel.dispatchEvent(new Event("change", { bubbles: true }));
	};

	const open = () => {
		closeDropdown();
		const menu = h("div", { class: "dd-menu", role: "listbox" }, [...sel.options].map(o => h("div", {
			class: "dd-opt" + (o.value === sel.value ? " active" : ""),
			role: "option",
			"aria-selected": o.value === sel.value,
			onmousedown: e => e.preventDefault(),
			onclick: () => choose(o.value),
		}, o.textContent)));
		menu.querySelectorAll(".dd-opt").forEach((el, i) => (el.dataset.value = sel.options[i].value));
		document.body.append(menu);
		// Fixed positioning so panels with overflow:hidden can't clip the menu.
		const r = button.getBoundingClientRect();
		menu.style.minWidth = `${r.width}px`;
		const left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 8);
		const below = r.bottom + 4 + menu.offsetHeight <= window.innerHeight;
		menu.style.left = `${Math.max(8, left)}px`;
		menu.style.top = `${below ? r.bottom + 4 : Math.max(8, r.top - 4 - menu.offsetHeight)}px`;
		button.setAttribute("aria-expanded", "true");
		openDropdown = { menu, button, sel };
		menu.querySelector(".active")?.scrollIntoView({ block: "nearest" });
	};

	button.addEventListener("click", () => (openDropdown && openDropdown.sel === sel ? closeDropdown() : open()));
	button.addEventListener("keydown", (e) => {
		const dd = openDropdown && openDropdown.sel === sel ? openDropdown : null;
		if (!dd) {
			if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
				e.preventDefault();
				open();
			}
			return;
		}
		const opts = [...dd.menu.querySelectorAll(".dd-opt")];
		let i = opts.findIndex(o => o.classList.contains("active"));
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			i = Math.max(0, Math.min(opts.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)));
			opts.forEach((o, k) => o.classList.toggle("active", k === i));
			opts[i].scrollIntoView({ block: "nearest" });
		}
		else if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			if (opts[i]) choose(opts[i].dataset.value);
		}
		else if (e.key === "Escape" || e.key === "Tab") {
			e.preventDefault();
			closeDropdown();
		}
	});
	refresh();
}

document.addEventListener("mousedown", (e) => {
	if (openDropdown && !e.target.closest(".dd-menu, .dd-btn")) closeDropdown();
});
window.addEventListener("blur", closeDropdown);
window.addEventListener("resize", closeDropdown);
document.addEventListener("scroll", (e) => {
	if (openDropdown && !openDropdown.menu.contains(e.target)) closeDropdown();
}, true);

window.CPApp = {
	open: req => open(req),
	setTab,
	select,
	state,
};

initControls();
document.querySelectorAll("select").forEach(enhanceSelect);
setTab("graph", { load: false });
applyTheme();
renderDetails();
const initial = CP.takePendingRequest();
if (initial && (initial.query || initial.openalex)) {
	open(initial);
}
else {
	if (initial && initial.tab) setTab(initial.tab, { load: false });
	showOverlay("Search for a paper above, or right-click an item in your library and choose Map Papers.", { idle: true });
	$("search").focus();
}
