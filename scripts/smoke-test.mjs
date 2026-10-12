#!/usr/bin/env node
// End-to-end smoke test against a running dev Zotero:
//   npm run dev -- --debug-server     (in one terminal)
//   npm run smoke                     (in another)
//
// Adds a sample item to the dev library, opens the graph window from it,
// exercises themes, tabs and sorting, and saves screenshots to
// build/screenshots/. Uses ~15 OpenAlex requests.
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RDP } from "./rdp.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shots = join(root, "build", "screenshots");
mkdirSync(shots, { recursive: true });

const rdp = await new RDP().connect();
let failures = 0;

async function step(name, body, timeout = 90000) {
	try {
		const out = await rdp.run(body, timeout);
		console.log(`✓ ${name}${out !== null && out !== undefined ? "  " + JSON.stringify(out) : ""}`);
		return out;
	}
	catch (e) {
		failures++;
		console.log(`✗ ${name}\n  ${String(e.message).split("\n").slice(0, 6).join("\n  ")}`);
		return null;
	}
}

async function shot(name, match) {
	try {
		await rdp.screenshot(join(shots, name), match);
		console.log(`  📷 build/screenshots/${name}`);
	}
	catch (e) {
		console.log(`  (screenshot ${name} failed: ${e.message})`);
	}
}

const H = `
	const CP = Zotero.MapPapers;
	const win = Zotero.getMainWindow();
	const delay = ms => Zotero.Promise.delay(ms);
	const assert = (cond, msg) => { if (!cond) throw new Error("assert: " + msg); };
	const graphWin = () => Services.wm.getMostRecentWindow("mappapers:graph");
	const app = () => graphWin()?.CPApp;
	const waitFor = async (fn, what, ms = 60000) => {
		const end = Date.now() + ms;
		for (;;) {
			const v = await fn();
			if (v) return v;
			if (Date.now() > end) throw new Error("timed out waiting for " + what);
			await delay(200);
		}
	};
`;

await step("plugin initialized", `${H}
	await waitFor(() => CP?.initialized, "plugin init", 30000);
	return { zotero: Zotero.version, plugin: CP.version };
`);

await step("menus and item pane section registered", `${H}
	const doc = win.document;
	assert(doc.getElementById("cp-item-menu"), "item context menu");
	assert(doc.getElementById("cp-tools-menuitem"), "tools menu");
	assert(CP._paneID, "item pane section");
	return CP._paneID;
`);

await step("create and select sample item", `${H}
	const lib = Zotero.Libraries.userLibraryID;
	let item = (await Zotero.Items.getAll(lib)).find(i => i.isRegularItem() && i.getField("extra").includes("cp-smoke"));
	if (!item) {
		item = new Zotero.Item("conferencePaper");
		item.libraryID = lib;
		item.setField("title", "Deep Residual Learning for Image Recognition");
		item.setField("DOI", "10.1109/CVPR.2016.90");
		item.setField("date", "2016");
		item.setField("extra", "cp-smoke");
		await item.saveTx();
	}
	await win.ZoteroPane.collectionsView.selectLibrary(lib);
	await win.ZoteroPane.itemsView.waitForLoad();
	await win.ZoteroPane.selectItem(item.id);
	await delay(800);
	const q = CP.itemQuery(item);
	assert(q.doi === "10.1109/cvpr.2016.90", "doi " + q.doi);
	const section = win.document.querySelector('[data-pane$="map-papers"]');
	return { query: q.doi, sectionRendered: !!section, buttons: section ? section.querySelectorAll(".cp-pane-btn").length : 0 };
`);
await step("scroll item pane to the section", `${H}
	const details = win.ZoteroPane.itemPane._itemDetails;
	details.scrollToPane(CP._paneID);
	await delay(600);
`);
await shot("main-window.png");

await step("open graph from the item", `${H}
	graphWin()?.close();
	await delay(300);
	CP.setPref("theme", "meadow");
	CP.setPref("colorBy", "year");
	CP.openForItem(win.ZoteroPane.getSelectedItems()[0], "graph");
	await waitFor(() => app()?.state.graph, "graph", 90000);
	const s = app().state;
	assert(s.graph.nodes.length >= 20, "nodes " + s.graph.nodes.length);
	assert(s.graph.origin.title.includes("Residual"), s.graph.origin.title);
	graphWin().resizeTo(1440, 900);
	await delay(800);
	return { nodes: s.graph.nodes.length, edges: s.graph.edges.length, requests: CP.source.stats.requests };
`, 120000);
await shot("graph-meadow.png", "graph.html");

await step("select a node shows details", `${H}
	const s = app().state;
	const n = s.graph.nodes.slice(1).sort((a, b) => b.similarity - a.similarity)[0];
	app().select(n);
	await delay(1500);
	const d = graphWin().document.getElementById("details").textContent;
	assert(d.includes(n.title.slice(0, 20)), "details");
	return n.title;
`);
await shot("graph-selected.png", "graph.html");

for (const theme of ["dracula", "midnight", "sunset"]) {
	await step(`theme ${theme}`, `${H}
		CP.setPref("theme", "${theme}");
		await delay(500);
		const bg = graphWin().getComputedStyle(graphWin().document.body).backgroundColor;
		assert(app().state.theme.id === "${theme}", "theme");
		return bg;
	`);
	await shot(`graph-${theme}.png`, "graph.html");
}

await step("dropdowns respond to real mouse clicks", `${H}
	const gw = graphWin();
	const doc = gw.document;
	gw.focus();
	await delay(300);
	// Real input events through the widget layer, like a user's mouse.
	const clickAt = async (el) => {
		el.scrollIntoView({ block: "nearest" });
		const r = el.getBoundingClientRect();
		const x = r.left + r.width / 2;
		const y = r.top + r.height / 2;
		gw.windowUtils.sendMouseEvent("mousedown", x, y, 0, 1, 0);
		gw.windowUtils.sendMouseEvent("mouseup", x, y, 0, 1, 0);
		await delay(250);
	};
	const pick = async (selectId, label) => {
		await clickAt(doc.getElementById(selectId).nextElementSibling);
		const opt = [...doc.querySelectorAll(".dd-menu .dd-opt")].find(o => o.textContent === label);
		assert(opt, "option " + label + " shown for " + selectId);
		await clickAt(opt);
		assert(!doc.querySelector(".dd-menu"), "menu closed");
	};
	await pick("theme", "Ocean");
	assert(CP.getPref("theme") === "ocean" && app().state.theme.id === "ocean", "theme via click");
	assert(doc.getElementById("theme").nextElementSibling.textContent === "Ocean", "button label");
	await pick("color-by", "by relation");
	assert(CP.getPref("colorBy") === "relation", "color via click");
	await pick("color-by", "by year");
	await pick("list-sort", "Citations");
	assert(app().state.listSort === "citations", "list sort via click");
	await pick("theme", "Meadow (classic)");
	await pick("graph-size", "30");
	await waitFor(() => app().state.graph && app().state.graph.nodes.length === 31, "30-paper graph", 90000);
	await pick("graph-size", "40");
	await waitFor(() => app().state.graph && app().state.graph.nodes.length === 41, "40-paper graph", 90000);
	await clickAt(doc.getElementById("theme").nextElementSibling);
	return { theme: CP.getPref("theme"), size: CP.getPref("graphSize") };
`, 200000);
await shot("dropdown-open.png", "graph.html");
await step("close dropdown", `${H}
	graphWin().document.body.dispatchEvent(new (graphWin().MouseEvent)("mousedown", { bubbles: true }));
	await delay(200);
	assert(!graphWin().document.querySelector(".dd-menu"), "closed");
`);

await step("color by relation", `${H}
	CP.setPref("colorBy", "relation");
	await delay(400);
	return app().state.colorBy;
`);
await shot("graph-relation.png", "graph.html");
await step("restore defaults", `${H}
	CP.setPref("colorBy", "year");
	CP.setPref("theme", "meadow");
	await delay(300);
`);

await step("prior works", `${H}
	app().setTab("prior");
	await waitFor(() => app().state.prior.items && !app().state.prior.loading, "prior works");
	const items = app().state.prior.items;
	assert(items.length > 5, "count " + items.length);
	const rows = graphWin().document.querySelectorAll("#table tbody tr").length;
	return { items: items.length, rows, top: items[0].title };
`);
await shot("prior-works.png", "graph.html");

await step("derivative works sorted by citations", `${H}
	const doc = graphWin().document;
	app().setTab("derivative");
	const sel = doc.getElementById("table-sort");
	sel.value = "citations";
	sel.dispatchEvent(new (graphWin().Event)("change"));
	await waitFor(() => app().state.deriv.items.length && !app().state.deriv.loading, "derivative works");
	const cites = [...doc.querySelectorAll("#table tbody tr td:nth-child(3)")].map(td => Number(td.textContent.replace(/\\D/g, "")));
	assert(cites.length > 10, "rows " + cites.length);
	for (let i = 1; i < cites.length; i++) assert(cites[i - 1] >= cites[i], "descending at " + i + ": " + cites.slice(0, 10));
	return { rows: cites.length, top: cites.slice(0, 5), total: app().state.deriv.total };
`);
await shot("derivative-citations.png", "graph.html");

await step("derivative works sorted by year (server-side)", `${H}
	const doc = graphWin().document;
	const sel = doc.getElementById("table-sort");
	sel.value = "year";
	sel.dispatchEvent(new (graphWin().Event)("change"));
	await delay(300);
	await waitFor(() => app().state.deriv.items.length && !app().state.deriv.loading, "derivative by year");
	const years = [...doc.querySelectorAll("#table tbody tr td:nth-child(2)")].map(td => Number(td.textContent) || 0);
	for (let i = 1; i < years.length; i++) assert(years[i - 1] >= years[i], "years descending");
	sel.value = "citations";
	sel.dispatchEvent(new (graphWin().Event)("change"));
	await waitFor(() => !app().state.deriv.loading, "back to citations");
	return years.slice(0, 5);
`);

await step("click column header sorts", `${H}
	const doc = graphWin().document;
	const th = [...doc.querySelectorAll("#table th")].find(t => t.textContent.startsWith("Cites graph"));
	th.click();
	await delay(200);
	const vals = [...doc.querySelectorAll("#table tbody tr td:nth-child(4)")].map(td => Number(td.textContent.replace(/\\D/g, "")));
	for (let i = 1; i < vals.length; i++) assert(vals[i - 1] >= vals[i], "graph links descending");
	return vals.slice(0, 5);
`);

await step("add a prior work to Zotero", `${H}
	app().setTab("prior");
	await delay(300);
	const p = app().state.prior.items.find(x => x.doi && !x.inGraph);
	const id = await CP.addToLibrary(p);
	const item = Zotero.Items.get(id);
	assert(item && item.getField("title"), "item saved");
	assert(await CP.findInLibrary(p) === id, "found in library index");
	await item.eraseTx();
	return item.getField("title");
`, 120000);

await step("build graph from another paper + history", `${H}
	const s = app().state;
	app().setTab("graph");
	const n = s.graph.nodes.find(x => !x.isOrigin && x.relation === "cite");
	await app().open({ openalex: n.id, label: n.title });
	await waitFor(() => s.graph.origin.id === n.id, "new graph");
	assert(s.history.length >= 2 && !graphWin().document.getElementById("back").disabled, "history");
	graphWin().document.getElementById("back").click();
	await waitFor(() => s.graph.origin.title.includes("Residual"), "back");
	return { history: s.history.length, requests: CP.source.stats.requests };
`, 120000);

rdp.close();
if (failures) {
	console.log(`\n${failures} step(s) failed`);
	process.exit(1);
}
console.log("\nAll smoke steps passed");
