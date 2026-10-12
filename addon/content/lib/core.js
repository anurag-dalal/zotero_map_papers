/* exported CPCore */
"use strict";

/**
 * Data + graph logic, independent of Zotero so it can be tested with node.
 *
 * Data comes from OpenAlex (free, no key needed). The graph follows the
 * Map Papers idea: papers are placed by *similarity*, not by direct
 * citation. Similarity combines bibliographic coupling (two papers cite the
 * same works) and co-citation (two papers are cited by the same works),
 * computed over a candidate pool of the origin's references, the papers that
 * cite it, OpenAlex's related works, and works its neighbourhood cites often.
 */
var CPCore = (() => {
	const API = "https://api.openalex.org";
	const SELECT = "id,doi,display_name,publication_year,cited_by_count,referenced_works,authorships,primary_location,type";
	// OpenAlex accepts up to 100 OR'ed values in one filter.
	const MAX_OR = 100;
	const BATCH = 50;

	const shortId = s => (s ? String(s).replace(/^https?:\/\/openalex\.org\//i, "") : null);

	function normTitle(t) {
		return String(t || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
			.replace(/<[^>]+>/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
	}

	function cleanDOI(doi) {
		if (!doi) return null;
		const m = String(doi).match(/10\.\d{4,9}\/[^\s"<>]+/i);
		return m ? m[0].replace(/[.,;]+$/, "").toLowerCase() : null;
	}

	function titleSimilarity(a, b) {
		const ta = new Set(normTitle(a).split(" ").filter(Boolean));
		const tb = new Set(normTitle(b).split(" ").filter(Boolean));
		if (!ta.size || !tb.size) return 0;
		let shared = 0;
		for (const t of ta) if (tb.has(t)) shared++;
		return shared / (ta.size + tb.size - shared);
	}

	function parseWork(w) {
		const id = shortId(w.id);
		const doi = cleanDOI(w.doi);
		const loc = w.primary_location || {};
		return {
			id,
			title: (w.display_name || w.title || "(untitled)").replace(/<[^>]+>/g, ""),
			year: w.publication_year || null,
			citations: w.cited_by_count || 0,
			refs: (w.referenced_works || []).map(shortId),
			authors: (w.authorships || []).map(a => a.author && a.author.display_name).filter(Boolean),
			venue: (loc.source && loc.source.display_name) || null,
			type: w.type || null,
			doi,
			url: doi ? "https://doi.org/" + doi : (loc.landing_page_url || "https://openalex.org/" + id),
			openalexURL: "https://openalex.org/" + id,
			relatedIds: w.related_works ? w.related_works.map(shortId) : null,
		};
	}

	function abstractFromIndex(index) {
		if (!index) return null;
		const words = [];
		for (const [word, positions] of Object.entries(index)) {
			for (const p of positions) words[p] = word;
		}
		return words.filter(w => w !== undefined).join(" ");
	}

	function chunk(arr, n) {
		const out = [];
		for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
		return out;
	}

	async function mapLimit(items, limit, fn) {
		const out = new Array(items.length);
		let next = 0;
		const worker = async () => {
			while (next < items.length) {
				const i = next++;
				out[i] = await fn(items[i], i);
			}
		};
		await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
		return out;
	}

	/** Small seeded PRNG so the same graph always lays out the same way. */
	function rng(seedStr) {
		let h = 1779033703 ^ seedStr.length;
		for (let i = 0; i < seedStr.length; i++) {
			h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
			h = (h << 13) | (h >>> 19);
		}
		let a = h >>> 0;
		return () => {
			a |= 0;
			a = (a + 0x6d2b79f5) | 0;
			let t = Math.imul(a ^ (a >>> 15), 1 | a);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	// ---- OpenAlex source --------------------------------------------------

	/**
	 * @param {object} opts
	 * @param {(url: string) => Promise<object>} opts.request  GET returning parsed
	 *   JSON; must throw an Error with `.status` on HTTP errors.
	 */
	function createSource({ request, apiKey, mailto }) {
		const works = new Map(); // id -> paper
		const pending = new Map(); // url -> promise
		const stats = { requests: 0 };

		function buildURL(path, params = {}) {
			const qs = [];
			for (const [k, v] of Object.entries(params)) {
				if (v !== undefined && v !== null && v !== "") qs.push(`${k}=${encodeURIComponent(v)}`);
			}
			if (apiKey) qs.push(`api_key=${encodeURIComponent(apiKey)}`);
			if (mailto) qs.push(`mailto=${encodeURIComponent(mailto)}`);
			return API + path + (qs.length ? "?" + qs.join("&") : "");
		}

		function get(path, params) {
			const url = buildURL(path, params);
			if (!pending.has(url)) {
				stats.requests++;
				const p = Promise.resolve().then(() => request(url)).catch((e) => {
					pending.delete(url);
					throw e;
				});
				pending.set(url, p);
			}
			return pending.get(url);
		}

		function remember(w) {
			const p = parseWork(w);
			const prev = works.get(p.id);
			// Keep related works from a full fetch if a batch fetch comes later.
			if (prev && prev.relatedIds && !p.relatedIds) p.relatedIds = prev.relatedIds;
			works.set(p.id, p);
			return p;
		}

		const pathId = id => encodeURIComponent(id).replace(/%2F/gi, "/").replace(/%3A/gi, ":");

		async function getWork(id) {
			const sid = shortId(id);
			const cached = works.get(sid);
			if (cached && cached.relatedIds) return cached;
			const json = await get(`/works/${pathId(sid)}`, { select: SELECT + ",related_works" });
			return remember(json);
		}

		async function getMany(ids) {
			const want = [...new Set(ids.map(shortId).filter(Boolean))];
			const missing = want.filter(id => !works.has(id));
			await mapLimit(chunk(missing, BATCH), 3, async (part) => {
				const json = await get("/works", {
					filter: "openalex_id:" + part.join("|"),
					"per-page": BATCH,
					select: SELECT,
				});
				for (const w of json.results || []) remember(w);
			});
			const out = new Map();
			for (const id of want) if (works.has(id)) out.set(id, works.get(id));
			return out;
		}

		/** Works citing any of `ids`. sort: "citations" | "year". */
		async function citing(ids, { sort = "citations", page = 1, perPage = 100, fromYear = null } = {}) {
			let filter = "cites:" + ids.slice(0, MAX_OR).map(shortId).join("|");
			if (fromYear) filter += ",publication_year:>" + (fromYear - 1);
			const json = await get("/works", {
				filter,
				sort: sort === "year" ? "publication_date:desc" : "cited_by_count:desc",
				"per-page": perPage,
				page,
				select: SELECT,
			});
			return {
				count: (json.meta && json.meta.count) || 0,
				results: (json.results || []).map(remember),
			};
		}

		async function getAbstract(id) {
			const json = await get(`/works/${pathId(shortId(id))}`, { select: "abstract_inverted_index" });
			return abstractFromIndex(json.abstract_inverted_index);
		}

		/** Free-text search, for the search box. */
		async function search(text, perPage = 12) {
			const json = await get("/works", { search: text, "per-page": perPage, select: SELECT });
			return (json.results || []).map(remember);
		}

		async function byTitle(title, year) {
			const clean = normTitle(title);
			if (!clean) return null;
			const json = await get("/works", { filter: "title.search:" + clean, "per-page": 8, select: SELECT });
			let best = null;
			for (const w of json.results || []) {
				const p = parseWork(w);
				let score = titleSimilarity(title, p.title);
				if (year && p.year) score += Math.abs(p.year - year) <= 1 ? 0.1 : -0.1;
				score += Math.min(0.05, Math.log10(1 + p.citations) / 100);
				if (!best || score > best.score) best = { score, w };
			}
			return best && best.score >= 0.7 ? remember(best.w) : null;
		}

		async function tryWork(id) {
			try {
				return await getWork(id);
			}
			catch (e) {
				if (e.status === 404) return null;
				throw e;
			}
		}

		/**
		 * Find the OpenAlex work for an item.
		 * @param {{openalex?, doi?, arxiv?, title?, year?}} q
		 */
		async function resolve(q) {
			let found = null;
			if (q.openalex) found = await tryWork(q.openalex);
			if (!found && q.doi) found = await tryWork("doi:" + cleanDOI(q.doi));
			if (!found && q.arxiv) {
				found = await tryWork("doi:10.48550/arxiv." + String(q.arxiv).replace(/v\d+$/i, "").toLowerCase());
			}
			if (!found && q.title) {
				const hit = await byTitle(q.title, q.year);
				if (hit) found = await getWork(hit.id);
			}
			if (!found) {
				const what = q.doi ? `DOI ${q.doi}` : q.arxiv ? `arXiv ${q.arxiv}` : q.title ? `“${q.title}”` : "this item";
				const err = new Error(`Couldn't find ${what} in OpenAlex.`);
				err.status = 404;
				throw err;
			}
			return found;
		}

		return { getWork, getMany, citing, getAbstract, search, resolve, stats, works };
	}

	// ---- similarity -------------------------------------------------------

	/**
	 * Pairwise similarity over `papers` (origin first). Returns a function
	 * sim(i, j) and per-paper link info.
	 */
	function similarity(papers) {
		const n = papers.length;
		const index = new Map(papers.map((p, i) => [p.id, i]));
		const couple = new Float32Array(n * n);
		const cocite = new Float32Array(n * n);
		const direct = new Uint8Array(n * n);
		const citedBy = new Uint16Array(n); // citers inside the pool

		// Bibliographic coupling: refId -> pool papers that cite it.
		const citersOfRef = new Map();
		papers.forEach((p, i) => {
			for (const r of new Set(p.refs)) {
				let list = citersOfRef.get(r);
				if (!list) citersOfRef.set(r, list = []);
				list.push(i);
			}
		});
		for (const list of citersOfRef.values()) {
			for (let a = 0; a < list.length; a++) {
				for (let b = a + 1; b < list.length; b++) {
					couple[list[a] * n + list[b]]++;
					couple[list[b] * n + list[a]]++;
				}
			}
		}

		// Co-citation: for each paper, the pool papers it cites.
		papers.forEach((p, k) => {
			const inPool = [];
			for (const r of new Set(p.refs)) {
				const j = index.get(r);
				if (j !== undefined && j !== k) {
					inPool.push(j);
					citedBy[j]++;
					direct[k * n + j] = direct[j * n + k] = 1;
				}
			}
			for (let a = 0; a < inPool.length; a++) {
				for (let b = a + 1; b < inPool.length; b++) {
					cocite[inPool[a] * n + inPool[b]]++;
					cocite[inPool[b] * n + inPool[a]]++;
				}
			}
		});

		const refCount = papers.map(p => new Set(p.refs).size);
		// Smoothing keeps papers with one or two shared links from scoring 1.0.
		const K_COUPLE = 3;
		const K_COCITE = 1.5;
		const S = new Float32Array(n * n);
		for (let i = 0; i < n; i++) {
			for (let j = i + 1; j < n; j++) {
				const c = couple[i * n + j];
				const cc = cocite[i * n + j];
				const s = (c ? c / (Math.sqrt(refCount[i] * refCount[j]) + K_COUPLE) : 0)
					+ (cc ? cc / (Math.sqrt(citedBy[i] * citedBy[j]) + K_COCITE) : 0)
					+ (direct[i * n + j] ? 0.08 : 0);
				S[i * n + j] = S[j * n + i] = s;
			}
		}
		return { sim: (i, j) => S[i * n + j], index, n };
	}

	// ---- layout -----------------------------------------------------------

	/** Radius from citations, scaled across the graph's own min..max (log). */
	function nodeRadius(citations, minCitations, maxCitations) {
		const lo = Math.log1p(minCitations);
		const hi = Math.log1p(maxCitations);
		const t = hi > lo ? (Math.log1p(citations) - lo) / (hi - lo) : 0.5;
		return 5 + 17 * Math.max(0, Math.min(1, t));
	}

	/**
	 * Stress-majorization layout (SGD, Zheng et al. 2018): similar papers are
	 * placed close, dissimilar ones far apart. Mutates nodes' x/y.
	 */
	function layout(nodes, simFn, { iterations = 320 } = {}) {
		const n = nodes.length;
		if (!n) return;
		const rand = rng(nodes.map(nd => nd.id).join(","));
		const x = new Float64Array(n);
		const y = new Float64Array(n);
		for (let i = 0; i < n; i++) {
			x[i] = (rand() - 0.5) * 600;
			y[i] = (rand() - 0.5) * 600;
		}
		let max = 0;
		for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) max = Math.max(max, simFn(i, j));
		const NEAR = 70;
		const FAR = 430;
		const pairs = [];
		for (let i = 0; i < n; i++) {
			for (let j = i + 1; j < n; j++) {
				const s = max ? simFn(i, j) / max : 0;
				const d = s > 0 ? NEAR + (FAR - NEAR) * (1 - Math.sqrt(s)) : FAR + 80;
				const w = (s > 0 ? 1 : 0.2) / (d * d);
				pairs.push([i, j, d, w]);
			}
		}
		if (pairs.length) {
			let wMin = Infinity;
			let wMax = 0;
			for (const p of pairs) {
				wMin = Math.min(wMin, p[3]);
				wMax = Math.max(wMax, p[3]);
			}
			const etaMax = 1 / wMin;
			const etaMin = 0.01 / wMax;
			const lambda = Math.log(etaMax / etaMin) / Math.max(1, iterations - 1);
			for (let t = 0; t < iterations; t++) {
				const eta = etaMax * Math.exp(-lambda * t);
				for (let k = pairs.length - 1; k > 0; k--) {
					const r = Math.floor(rand() * (k + 1));
					[pairs[k], pairs[r]] = [pairs[r], pairs[k]];
				}
				for (const [i, j, d, w] of pairs) {
					const mu = Math.min(1, w * eta);
					const dx = x[i] - x[j];
					const dy = y[i] - y[j];
					const dist = Math.hypot(dx, dy) || 0.01;
					const m = (mu * (dist - d)) / (2 * dist);
					x[i] -= m * dx;
					y[i] -= m * dy;
					x[j] += m * dx;
					y[j] += m * dy;
				}
			}
		}
		// Push overlapping circles apart (room for labels underneath).
		for (let pass = 0; pass < 60; pass++) {
			let moved = false;
			for (let i = 0; i < n; i++) {
				for (let j = i + 1; j < n; j++) {
					const minD = nodes[i].r + nodes[j].r + 10;
					const dx = x[j] - x[i];
					const dy = y[j] - y[i];
					const dist = Math.hypot(dx, dy) || 0.01;
					if (dist < minD) {
						const push = (minD - dist) / 2;
						x[i] -= (dx / dist) * push;
						y[i] -= (dy / dist) * push;
						x[j] += (dx / dist) * push;
						y[j] += (dy / dist) * push;
						moved = true;
					}
				}
			}
			if (!moved) break;
		}
		let cx = 0;
		let cy = 0;
		for (let i = 0; i < n; i++) {
			cx += x[i];
			cy += y[i];
		}
		cx /= n;
		cy /= n;
		nodes.forEach((nd, i) => {
			nd.x = x[i] - cx;
			nd.y = y[i] - cy;
		});
	}

	// ---- graph ------------------------------------------------------------

	/** Drop OpenAlex duplicates (preprint + published version) by title. */
	function dedupe(papers, originTitle) {
		const seen = new Map();
		const originKey = normTitle(originTitle);
		for (const p of papers) {
			const key = normTitle(p.title);
			if (!key || key === originKey) continue;
			const prev = seen.get(key);
			if (!prev || p.citations > prev.citations) seen.set(key, p);
		}
		return [...seen.values()];
	}

	/**
	 * Build the similarity graph around an OpenAlex work.
	 * @returns {Promise<{origin, nodes, edges, refs, stats}>}
	 */
	async function buildGraph(source, originId, { size = 40, onProgress = () => {} } = {}) {
		onProgress("Fetching the paper…");
		const origin = await source.getWork(originId);

		onProgress(`Fetching ${origin.refs.length} references and citing papers…`);
		const [refMap, topCiting, newCiting, related] = await Promise.all([
			source.getMany(origin.refs.slice(0, 300)),
			origin.citations ? source.citing([origin.id], { sort: "citations", perPage: 100 }) : { results: [] },
			origin.citations ? source.citing([origin.id], { sort: "year", perPage: 50 }) : { results: [] },
			source.getMany(origin.relatedIds || []),
		]);

		const pool = new Map();
		const relation = new Map();
		for (const p of refMap.values()) {
			pool.set(p.id, p);
			relation.set(p.id, "ref");
		}
		for (const p of [...topCiting.results, ...newCiting.results]) {
			pool.set(p.id, p);
			relation.set(p.id, "cite");
		}
		for (const p of related.values()) {
			if (!pool.has(p.id)) {
				pool.set(p.id, p);
				relation.set(p.id, "other");
			}
		}

		// Second-order candidates: works the neighbourhood cites a lot.
		const counts = new Map();
		for (const p of [origin, ...pool.values()]) {
			for (const r of new Set(p.refs)) {
				if (r !== origin.id && !pool.has(r)) counts.set(r, (counts.get(r) || 0) + 1);
			}
		}
		const extra = [...counts].filter(([, c]) => c >= 3).sort((a, b) => b[1] - a[1]).slice(0, 50).map(([id]) => id);
		if (extra.length) {
			onProgress("Fetching frequently co-cited works…");
			for (const p of (await source.getMany(extra)).values()) {
				pool.set(p.id, p);
				relation.set(p.id, "other");
			}
		}
		pool.delete(origin.id);

		onProgress("Computing similarity…");
		const candidates = dedupe([...pool.values()], origin.title);
		const papers = [origin, ...candidates];
		const { sim } = similarity(papers);

		// Score = similarity to the origin + similarity to the origin's neighbourhood.
		const n = papers.length;
		let originMass = 0;
		for (let q = 1; q < n; q++) originMass += sim(0, q);
		const scored = [];
		for (let c = 1; c < n; c++) {
			let twoHop = 0;
			if (originMass) {
				for (let q = 1; q < n; q++) if (q !== c) twoHop += sim(c, q) * sim(0, q);
				twoHop /= originMass;
			}
			const score = sim(0, c) + twoHop;
			if (score > 0) scored.push({ c, score });
		}
		scored.sort((a, b) => b.score - a.score);
		const chosen = [0, ...scored.slice(0, size).map(s => s.c)];
		const maxScore = scored.length ? scored[0].score : 1;
		const scoreOf = new Map(scored.map(s => [s.c, s.score]));

		const cites = chosen.map(i => papers[i].citations);
		const minCit = Math.min(...cites);
		const maxCit = Math.max(...cites);
		const nodes = chosen.map((i, k) => {
			const p = papers[i];
			return Object.assign({}, p, {
				index: k,
				isOrigin: i === 0,
				relation: i === 0 ? "origin" : relation.get(p.id) || "other",
				similarity: i === 0 ? 1 : (scoreOf.get(i) || 0) / maxScore,
				r: nodeRadius(p.citations, minCit, maxCit),
				x: 0,
				y: 0,
			});
		});
		const local = (a, b) => sim(chosen[a], chosen[b]);

		onProgress("Laying out the graph…");
		layout(nodes, local);

		// Edges: each node's strongest links plus the strongest overall.
		const m = nodes.length;
		const all = [];
		for (let a = 0; a < m; a++) for (let b = a + 1; b < m; b++) {
			const s = local(a, b);
			if (s > 0) all.push({ source: a, target: b, s });
		}
		all.sort((p, q) => q.s - p.s);
		const keep = new Set(all.slice(0, Math.ceil(all.length * 0.08)).map(e => e.source + ":" + e.target));
		for (let a = 0; a < m; a++) {
			all.filter(e => e.source === a || e.target === a).slice(0, 4)
				.forEach(e => keep.add(e.source + ":" + e.target));
		}
		const maxS = all.length ? all[0].s : 1;
		const edges = all.filter(e => keep.has(e.source + ":" + e.target))
			.map(e => ({ source: e.source, target: e.target, weight: e.s / maxS }));

		return {
			origin: nodes[0],
			nodes,
			edges,
			refs: [...refMap.values()],
			stats: { pool: candidates.length, requests: source.stats.requests },
		};
	}

	/** Works cited by many graph papers (ancestors), or the origin's references. */
	async function priorWorks(source, graph, { scope = "graph", limit = 80 } = {}) {
		const nodeIds = new Set(graph.nodes.map(n => n.id));
		if (scope === "origin") {
			const counts = new Map();
			for (const nd of graph.nodes) for (const r of new Set(nd.refs)) counts.set(r, (counts.get(r) || 0) + 1);
			const map = await source.getMany(graph.origin.refs);
			return [...map.values()].map(p => Object.assign({}, p, {
				graphCount: counts.get(p.id) || 0,
				inGraph: nodeIds.has(p.id),
			}));
		}
		const counts = new Map();
		for (const nd of graph.nodes) {
			for (const r of new Set(nd.refs)) if (!nodeIds.has(r)) counts.set(r, (counts.get(r) || 0) + 1);
		}
		let ranked = [...counts].sort((a, b) => b[1] - a[1]);
		const multi = ranked.filter(([, c]) => c >= 2);
		ranked = (multi.length >= 15 ? multi : ranked).slice(0, limit);
		const map = await source.getMany(ranked.map(([id]) => id));
		return ranked.filter(([id]) => map.has(id))
			.map(([id, c]) => Object.assign({}, map.get(id), { graphCount: c, inGraph: false }));
	}

	/**
	 * Works citing the graph papers (descendants), or citing the origin.
	 * Sorted server-side by citations or year. `graphCount` = how many graph
	 * papers each one cites; in graph scope only works citing at least
	 * `minOverlap` graph papers, published from the origin's year on, are kept
	 * (otherwise famous papers citing one old graph paper swamp the list).
	 */
	async function derivativeWorks(source, graph, { scope = "graph", sort = "citations", page = 1, perPage = 200, minOverlap = 2 } = {}) {
		const nodeIds = new Set(graph.nodes.map(n => n.id));
		const isGraph = scope !== "origin";
		const targets = isGraph
			? graph.nodes.slice().sort((a, b) => b.similarity - a.similarity).slice(0, MAX_OR).map(n => n.id)
			: [graph.origin.id];
		const { count, results } = await source.citing(targets, {
			sort: sort === "year" ? "year" : "citations",
			page,
			perPage,
			fromYear: isGraph ? graph.origin.year : null,
		});
		const items = results.filter(p => p.id !== graph.origin.id).map(p => Object.assign({}, p, {
			graphCount: p.refs.filter(r => nodeIds.has(r)).length,
			inGraph: nodeIds.has(p.id),
		})).filter(p => !isGraph || p.graphCount >= minOverlap);
		return { items, total: count, scanned: results.length, hasMore: page * perPage < Math.min(count, 10000) };
	}

	return {
		createSource, buildGraph, priorWorks, derivativeWorks,
		similarity, layout, nodeRadius, parseWork, normTitle, cleanDOI, titleSimilarity, abstractFromIndex, shortId,
	};
})();

if (typeof module !== "undefined") module.exports = CPCore;
