/* global Zotero, Services, CPCore, CPThemes */
/* exported MapPapers */
"use strict";

const GRAPH_URL = "chrome://mappapers/content/graph/graph.html";
const GRAPH_WINDOWTYPE = "mappapers:graph";
const PREF = "mappapers.";
const DEFAULTS = {
	theme: "meadow",
	colorBy: "year",
	graphSize: 40,
	derivativeSort: "citations",
	apiKey: "",
	mailto: "",
};
const ELEMENT_IDS = ["cp-item-menu", "cp-item-menu-sep", "cp-tools-menuitem"];

var MapPapers = {
	core: CPCore,
	themes: CPThemes,
	pluginID: null,
	version: null,
	rootURI: null,
	initialized: false,
	_paneID: null,
	_notifierID: null,
	_prefObservers: [],
	_source: null,
	_libraryIndex: null,
	_pending: null,

	async init({ id, version, rootURI }) {
		this.pluginID = id;
		this.version = version;
		this.rootURI = rootURI;
		await Zotero.initializationPromise;

		this._registerItemPane();
		await Zotero.PreferencePanes.register({
			pluginID: id,
			src: rootURI + "content/preferences.xhtml",
			label: "Map Papers",
			image: rootURI + "content/icons/icon.svg",
		});
		this._notifierID = Zotero.Notifier.registerObserver(
			{ notify: () => (this._libraryIndex = null) },
			["item"],
			"mapPapers"
		);
		// A new key or email needs a fresh source (requests are cached per source).
		for (const name of ["apiKey", "mailto"]) {
			this._prefObservers.push(Zotero.Prefs.registerObserver(PREF + name, () => (this._source = null)));
		}

		this.initialized = true;
		for (const win of Zotero.getMainWindows()) {
			if (win.ZoteroPane) this.addToWindow(win);
		}
		this.log(`started ${version}`);
	},

	async shutdown() {
		const steps = [
			() => {
				for (const w of Services.wm.getEnumerator(GRAPH_WINDOWTYPE)) w.close();
			},
			() => Zotero.getMainWindows().forEach(win => this.removeFromWindow(win)),
			() => this._paneID && Zotero.ItemPaneManager.unregisterSection(this._paneID),
			() => this._notifierID && Zotero.Notifier.unregisterObserver(this._notifierID),
			() => this._prefObservers.forEach(id => Zotero.Prefs.unregisterObserver(id)),
		];
		for (const step of steps) {
			try {
				await step();
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
		this.initialized = false;
	},

	log(msg) {
		Zotero.debug(`[CP] ${msg}`);
	},

	// ---- prefs --------------------------------------------------------------

	getPref(name) {
		const v = Zotero.Prefs.get(PREF + name);
		return v === undefined ? DEFAULTS[name] : v;
	},

	setPref(name, value) {
		Zotero.Prefs.set(PREF + name, value);
	},

	// ---- data -----------------------------------------------------------------

	get source() {
		if (!this._source) {
			this._source = CPCore.createSource({
				request: url => this._request(url),
				apiKey: this.getPref("apiKey").trim(),
				mailto: this.getPref("mailto").trim(),
			});
		}
		return this._source;
	},

	/** GET JSON, retrying rate limits and server errors with backoff. */
	async _request(url) {
		for (let attempt = 0; ; attempt++) {
			try {
				const xhr = await Zotero.HTTP.request("GET", url, {
					responseType: "json",
					headers: { Accept: "application/json" },
					timeout: 30000,
					successCodes: [200],
					errorDelayMax: 0,
				});
				return xhr.response;
			}
			catch (e) {
				const status = e.status ?? e.xmlhttp?.status ?? 0;
				const retryable = status === 429 || status >= 500 || status === 0;
				if (retryable && attempt < 3) {
					await Zotero.Promise.delay(1200 * 2 ** attempt);
					continue;
				}
				let message = `OpenAlex request failed (HTTP ${status || "network error"}).`;
				if (status === 429) {
					message = "OpenAlex rate limit reached. Add a free OpenAlex API key in Settings → Map Papers, or try again later.";
				}
				const err = new Error(message);
				err.status = status;
				throw err;
			}
		}
	},

	/** What we know about an item that can identify it in OpenAlex. */
	itemQuery(item) {
		if (!item) return null;
		if (!item.isRegularItem() && item.parentItem) item = item.parentItem;
		if (!item.isRegularItem()) return null;
		const field = (name) => {
			try {
				return item.getField(name) || "";
			}
			catch {
				return "";
			}
		};
		const extra = field("extra");
		const url = field("url");
		const doi = CPCore.cleanDOI(field("DOI")) || CPCore.cleanDOI((extra.match(/^DOI:\s*(.+)$/im) || [])[1]);
		const arxivMatch = (url.match(/arxiv\.org\/(?:abs|pdf)\/([^\s?#]+?)(?:\.pdf)?$/i)
			|| extra.match(/arXiv:\s*([\w./-]+)/i)
			|| field("archiveID").match(/arXiv:\s*([\w./-]+)/i)
			|| []);
		const openalex = (extra.match(/OpenAlex:\s*(W\d+)/i) || [])[1];
		const parsedDate = Zotero.Date.strToDate(field("date"));
		return {
			openalex: openalex || null,
			doi,
			arxiv: arxivMatch[1] || null,
			title: field("title"),
			year: parsedDate.year ? Number(parsedDate.year) : null,
			itemID: item.id,
			label: field("title") || "Untitled",
		};
	},

	/** Map of DOI / normalized title -> itemID, across all libraries. */
	async libraryIndex() {
		if (this._libraryIndex) return this._libraryIndex;
		const doiField = Zotero.ItemFields.getID("DOI");
		const titleField = Zotero.ItemFields.getID("title");
		const rows = await Zotero.DB.queryAsync(
			"SELECT itemID, fieldID, value FROM itemData JOIN itemDataValues USING (valueID) "
			+ "WHERE fieldID IN (?, ?) AND itemID NOT IN (SELECT itemID FROM deletedItems)",
			[doiField, titleField]
		);
		const dois = new Map();
		const titles = new Map();
		for (const row of rows) {
			if (row.fieldID === doiField) {
				const d = CPCore.cleanDOI(row.value);
				if (d) dois.set(d, row.itemID);
			}
			else {
				const t = CPCore.normTitle(row.value);
				if (t.length > 12) titles.set(t, row.itemID);
			}
		}
		this._libraryIndex = { dois, titles };
		return this._libraryIndex;
	},

	async findInLibrary(paper) {
		const { dois, titles } = await this.libraryIndex();
		return (paper.doi && dois.get(paper.doi)) || titles.get(CPCore.normTitle(paper.title)) || null;
	},

	/** Save a paper into the library/collection selected in the main window. */
	async addToLibrary(paper) {
		const pane = Zotero.getActiveZoteroPane();
		let libraryID = pane?.getSelectedLibraryID() ?? Zotero.Libraries.userLibraryID;
		if (!Zotero.Libraries.get(libraryID)?.editable) libraryID = Zotero.Libraries.userLibraryID;
		const collection = pane?.getSelectedCollection();
		const collections = collection && collection.libraryID === libraryID ? [collection.id] : [];

		let item = null;
		if (paper.doi) {
			try {
				const translate = new Zotero.Translate.Search();
				translate.setIdentifier({ DOI: paper.doi });
				const translators = await translate.getTranslators();
				if (translators.length) {
					translate.setTranslator(translators);
					const items = await translate.translate({ libraryID, collections, saveAttachments: false });
					item = items?.[0] || null;
				}
			}
			catch (e) {
				this.log(`DOI lookup failed for ${paper.doi}, saving OpenAlex metadata instead: ${e}`);
			}
		}
		if (!item) {
			const type = { article: "journalArticle", "book-chapter": "bookSection", book: "book", dissertation: "thesis", preprint: "preprint" }[paper.type];
			item = new Zotero.Item(type && Zotero.ItemTypes.getID(type) ? type : "journalArticle");
			item.libraryID = libraryID;
			item.setField("title", paper.title);
			if (paper.year) item.setField("date", String(paper.year));
			const set = (f, v) => v && Zotero.ItemFields.isValidForType(Zotero.ItemFields.getID(f), item.itemTypeID) && item.setField(f, v);
			set("DOI", paper.doi);
			set("publicationTitle", paper.venue);
			set("url", paper.url);
			item.setCreators(paper.authors.slice(0, 50).map((name) => {
				const parts = name.trim().split(/\s+/);
				const lastName = parts.pop();
				return { firstName: parts.join(" "), lastName, creatorType: "author" };
			}));
			item.setField("extra", `OpenAlex: ${paper.id}`);
			if (collections.length) item.setCollections(collections);
			await item.saveTx();
		}
		this._libraryIndex = null;
		return item.id;
	},

	showInLibrary(itemID) {
		const win = Zotero.getMainWindow();
		if (!win) return;
		win.ZoteroPane.selectItem(itemID);
		win.focus();
	},

	// ---- window -----------------------------------------------------------

	/**
	 * Open the graph window for a request:
	 * { query } (from an item), { openalex } (a paper), or {} (search box).
	 * tab: "graph" | "prior" | "derivative"
	 */
	openWindow(request = {}) {
		const existing = Services.wm.getMostRecentWindow(GRAPH_WINDOWTYPE);
		if (existing?.CPApp) {
			existing.focus();
			if (request.query || request.openalex) existing.CPApp.open(request);
			else if (request.tab) existing.CPApp.setTab(request.tab);
			return;
		}
		this._pending = request;
		Zotero.getMainWindow().openDialog(
			GRAPH_URL,
			"",
			"chrome,centerscreen,resizable=yes,dialog=no,width=1440,height=900"
		);
	},

	takePendingRequest() {
		const r = this._pending;
		this._pending = null;
		return r;
	},

	openForItem(item, tab = "graph") {
		const query = this.itemQuery(item);
		if (!query) return;
		this.openWindow({ query, tab });
	},

	// ---- main window UI -----------------------------------------------------

	_registerItemPane() {
		const icon = "chrome://mappapers/content/icons/section.svg";
		this._paneID = Zotero.ItemPaneManager.registerSection({
			paneID: "map-papers",
			pluginID: this.pluginID,
			header: { l10nID: "mappapers-section-header", icon },
			sidenav: { l10nID: "mappapers-section-sidenav", icon },
			sectionButtons: [{
				type: "cp-open",
				icon: "chrome://zotero/skin/16/universal/link.svg",
				l10nID: "mappapers-section-open",
				onClick: ({ item }) => this.openForItem(item),
			}],
			onItemChange: ({ item, setEnabled }) => {
				setEnabled(!!this.itemQuery(item) && !item.isFeedItem);
			},
			onRender: ({ doc, body, item, setSectionSummary }) => {
				this._renderPane(doc, body, item);
				const q = this.itemQuery(item);
				setSectionSummary(q?.doi ? `DOI ${q.doi}` : q?.arxiv ? `arXiv ${q.arxiv}` : "Title lookup");
			},
		});
	},

	_renderPane(doc, body, item) {
		const HTML = "http://www.w3.org/1999/xhtml";
		const el = (tag, props = {}, text) => {
			const e = doc.createElementNS(HTML, tag);
			Object.assign(e, props);
			if (text) e.textContent = text;
			return e;
		};
		body.replaceChildren();
		const q = this.itemQuery(item);
		const wrap = el("div");
		wrap.style.cssText = "display:flex;flex-direction:column;gap:8px;padding:2px 0 4px";

		const row = el("div");
		row.style.cssText = "display:flex;gap:6px;flex-wrap:wrap";
		const button = (label, tab, primary) => {
			const b = el("button", { className: "cp-pane-btn" }, label);
			b.style.cssText = "flex:1 1 auto;min-width:90px;padding:5px 10px;border-radius:5px;cursor:pointer;"
				+ "border:1px solid var(--fill-quinary, #ccc);"
				+ (primary ? "background:var(--accent-blue, #2f7d66);color:#fff;border-color:transparent;font-weight:600;"
					: "background:var(--material-button, transparent);color:inherit;");
			b.addEventListener("click", () => this.openForItem(item, tab));
			return b;
		};
		row.append(button("Graph", "graph", true), button("Prior works", "prior"), button("Derivative works", "derivative"));

		const hint = el("div", {}, q?.doi
			? `Looked up by DOI ${q.doi}`
			: q?.arxiv ? `Looked up by arXiv ID ${q.arxiv}`
				: "No DOI: the paper will be matched by its title.");
		hint.style.cssText = "font-size:0.9em;opacity:0.7";
		wrap.append(row, hint);
		body.append(wrap);
	},

	addToWindow(win) {
		if (!this.initialized) return;
		const doc = win.document;
		this.removeFromWindow(win);
		win.MozXULElement.insertFTLIfNeeded("map-papers.ftl");

		const itemMenu = doc.getElementById("zotero-itemmenu");
		if (itemMenu) {
			const sep = doc.createXULElement("menuseparator");
			sep.id = "cp-item-menu-sep";
			const menu = doc.createXULElement("menu");
			menu.id = "cp-item-menu";
			menu.setAttribute("label", "Map Papers");
			const popup = doc.createXULElement("menupopup");
			for (const [label, tab] of [["Show graph", "graph"], ["Prior works", "prior"], ["Derivative works", "derivative"]]) {
				const mi = doc.createXULElement("menuitem");
				mi.setAttribute("label", label);
				mi.addEventListener("command", () => {
					const item = win.ZoteroPane.getSelectedItems()[0];
					if (item) this.openForItem(item, tab);
				});
				popup.append(mi);
			}
			menu.append(popup);
			itemMenu.append(sep, menu);
			itemMenu._cpOnShowing = (e) => {
				if (e.target !== itemMenu) return;
				const items = win.ZoteroPane.getSelectedItems();
				const show = items.length === 1 && !!this.itemQuery(items[0]);
				menu.hidden = sep.hidden = !show;
			};
			itemMenu.addEventListener("popupshowing", itemMenu._cpOnShowing);
		}

		const tools = doc.getElementById("menu_ToolsPopup");
		if (tools) {
			const mi = doc.createXULElement("menuitem");
			mi.id = "cp-tools-menuitem";
			mi.setAttribute("label", "Map Papers…");
			mi.addEventListener("command", () => this.openWindow({}));
			tools.append(mi);
		}
	},

	removeFromWindow(win) {
		const doc = win.document;
		for (const id of ELEMENT_IDS) doc.getElementById(id)?.remove();
		const itemMenu = doc.getElementById("zotero-itemmenu");
		if (itemMenu?._cpOnShowing) {
			itemMenu.removeEventListener("popupshowing", itemMenu._cpOnShowing);
			delete itemMenu._cpOnShowing;
		}
	},
};
