#!/usr/bin/env node
// Tests the Zotero-independent core (similarity, layout, OpenAlex parsing).
//   npm test            offline tests
//   npm run test:live   also builds a real graph from OpenAlex (~10 requests)
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ctx = vm.createContext({ console, URL, Math, Promise, Map, Set });
for (const f of ["themes.js", "core.js"]) {
	vm.runInContext(readFileSync(join(root, "addon/content/lib", f), "utf8"), ctx, { filename: f });
}
const { CPCore, CPThemes } = vm.runInContext("({ CPCore, CPThemes })", ctx);

let failed = 0;
function test(name, fn) {
	return Promise.resolve().then(fn).then(
		() => console.log(`✓ ${name}`),
		(e) => {
			failed++;
			console.log(`✗ ${name}\n  ${e.stack || e}`);
		});
}
const assert = (c, m) => {
	if (!c) throw new Error("assert: " + m);
};

await test("themes: ramp endpoints and all themes complete", () => {
	for (const t of CPThemes.list) {
		for (const k of ["bg", "canvas", "panel", "text", "muted", "accent", "edge", "edgeHi", "origin", "library", "relation", "ramp"]) {
			assert(t[k], `${t.id}.${k}`);
		}
		assert(CPThemes.rampColor(t.ramp, 0) && CPThemes.rampColor(t.ramp, 1), t.id);
	}
	assert(CPThemes.rampColor(["#000000", "#ffffff"], 0.5) === "rgb(128, 128, 128)", "midpoint");
});

await test("parseWork + helpers", () => {
	const p = CPCore.parseWork({
		id: "https://openalex.org/W1", doi: "https://doi.org/10.1234/ABC", display_name: "A <i>b</i>",
		publication_year: 2020, cited_by_count: 5, referenced_works: ["https://openalex.org/W2"],
		authorships: [{ author: { display_name: "X Y" } }], primary_location: { source: { display_name: "J" } },
	});
	assert(p.id === "W1" && p.doi === "10.1234/abc" && p.title === "A b" && p.refs[0] === "W2", JSON.stringify(p));
	assert(CPCore.cleanDOI("doi: 10.1000/xyz.") === "10.1000/xyz", "cleanDOI");
	assert(CPCore.abstractFromIndex({ hello: [0], world: [1] }) === "hello world", "abstract");
	assert(CPCore.titleSimilarity("Deep Residual Learning", "deep residual learning!") === 1, "title sim");
});

// Synthetic library: two topic clusters that share no references.
function fakeWorld() {
	const works = {};
	const add = (id, refs, cites = 10, year = 2015) => {
		works[id] = { id, display_name: "Paper " + id, publication_year: year, cited_by_count: cites, referenced_works: refs };
	};
	const A = ["a1", "a2", "a3", "a4", "a5", "a6"];
	const B = ["b1", "b2", "b3", "b4", "b5", "b6"];
	A.forEach((id, i) => add(id, [], 100 + i));
	B.forEach((id, i) => add(id, [], 100 + i));
	add("O", ["a1", "a2", "a3", "a4", "b1"], 500, 2018);
	for (let i = 0; i < 8; i++) add("ca" + i, ["O", ...A.slice(0, 4 + (i % 3))], 20 + i, 2019 + (i % 4));
	for (let i = 0; i < 4; i++) add("cb" + i, ["O", ...B.slice(0, 4)], 5 + i, 2020);
	return works;
}

function fakeRequest(works) {
	return async (url) => {
		const u = new URL(url);
		const path = u.pathname;
		const filter = u.searchParams.get("filter") || "";
		const all = Object.values(works);
		if (path.startsWith("/works/")) {
			const id = path.slice(7);
			if (!works[id]) throw Object.assign(new Error("404"), { status: 404 });
			return { ...works[id], related_works: [] };
		}
		if (filter.startsWith("openalex_id:")) {
			const ids = filter.slice(12).split("|");
			return { results: all.filter(w => ids.includes(w.id)) };
		}
		if (filter.startsWith("cites:")) {
			const ids = filter.slice(6).split("|");
			const res = all.filter(w => w.referenced_works.some(r => ids.includes(r)));
			res.sort((a, b) => b.cited_by_count - a.cited_by_count);
			return { meta: { count: res.length }, results: res };
		}
		return { results: [] };
	};
}

await test("graph: clusters separate, layout finite and deterministic", async () => {
	const world = fakeWorld();
	const build = () => CPCore.buildGraph(CPCore.createSource({ request: fakeRequest(world) }), "O", { size: 30 });
	const g = await build();
	assert(g.origin.id === "O" && g.nodes[0].isOrigin, "origin first");
	assert(g.nodes.length > 10, "nodes " + g.nodes.map(n => n.id).join(","));
	for (const n of g.nodes) assert(Number.isFinite(n.x) && Number.isFinite(n.y) && n.r > 0, "finite " + n.id);
	assert(g.edges.every(e => e.weight > 0 && e.weight <= 1), "edge weights");
	const pos = id => g.nodes.find(n => n.id === id) || assert(false, `${id} missing from ${g.nodes.map(n => n.id)}`);
	const d = (p, q) => Math.hypot(pos(p).x - pos(q).x, pos(p).y - pos(q).y);
	assert(d("ca0", "ca1") < d("ca0", "cb0"), `A-cluster citers closer together (${d("ca0", "ca1").toFixed(0)} vs ${d("ca0", "cb0").toFixed(0)})`);
	const g2 = await build();
	assert(g2.nodes.every((n, i) => n.x === g.nodes[i].x), "deterministic");

	const source = CPCore.createSource({ request: fakeRequest(world) });
	const g3 = await CPCore.buildGraph(source, "O", { size: 30 });
	const prior = await CPCore.priorWorks(source, g3, { scope: "origin" });
	assert(prior.length === 5, "origin refs " + prior.length);
	const deriv = await CPCore.derivativeWorks(source, g3, { scope: "origin" });
	assert(deriv.items.length === 12 && deriv.items.every(p => p.graphCount >= 1) && deriv.items[0].citations >= deriv.items[1].citations, "derivatives sorted");
});

if (process.argv.includes("--live")) {
	const request = async (url) => {
		const res = await fetch(url, { headers: { Accept: "application/json" } });
		if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} for ${url}`), { status: res.status });
		return res.json();
	};
	await test("live: ResNet graph from OpenAlex", async () => {
		const source = CPCore.createSource({ request });
		const origin = await source.resolve({ doi: "10.1109/CVPR.2016.90" });
		const t0 = Date.now();
		const g = await CPCore.buildGraph(source, origin.id, { size: 40, onProgress: m => console.log("   …", m) });
		console.log(`   ${g.nodes.length} nodes, ${g.edges.length} edges, pool ${g.stats.pool}, ${g.stats.requests} requests, ${Date.now() - t0} ms`);
		for (const n of g.nodes.slice(0, 12)) {
			console.log(`   ${n.similarity.toFixed(2)}  ${String(n.year).padEnd(4)}  ${String(n.citations).padStart(7)}  ${n.relation.padEnd(6)} ${n.title.slice(0, 70)}`);
		}
		assert(g.nodes.length >= 30, "enough nodes");
		const prior = await CPCore.priorWorks(source, g);
		console.log(`   prior works: ${prior.length}, top: ${prior.slice(0, 3).map(p => `${p.title.slice(0, 40)} (${p.graphCount})`).join(" | ")}`);
		const deriv = await CPCore.derivativeWorks(source, g, { sort: "citations" });
		console.log(`   derivative works: ${deriv.items.length} kept of ${deriv.scanned} scanned (${deriv.total} total), top: ${deriv.items.slice(0, 3).map(p => `${p.title.slice(0, 40)} (${p.citations})`).join(" | ")}`);
		assert(prior.length > 10 && deriv.items.length > 10, "lists");
		const abs = await source.getAbstract(origin.id);
		console.log(`   abstract: ${(abs || "(none)").slice(0, 80)}…`);
		const byTitle = await source.resolve({ title: "Attention Is All You Need", year: 2017 });
		console.log(`   title lookup: ${byTitle.id} ${byTitle.title} (${byTitle.year})`);
	});
}

if (failed) process.exit(1);
