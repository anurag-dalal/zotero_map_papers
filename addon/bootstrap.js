/* global Zotero, Services, Components */
"use strict";

var chromeHandle;

function install() {}

async function startup({ id, version, rootURI }) {
	const aomStartup = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
		.getService(Components.interfaces.amIAddonManagerStartup);
	const manifestURI = Services.io.newURI(rootURI + "manifest.json");
	chromeHandle = aomStartup.registerChrome(manifestURI, [
		["content", "mappapers", rootURI + "content/"],
	]);

	const ctx = { Zotero, Services, rootURI };
	Services.scriptloader.loadSubScript(`${rootURI}content/lib/themes.js`, ctx);
	Services.scriptloader.loadSubScript(`${rootURI}content/lib/core.js`, ctx);
	Services.scriptloader.loadSubScript(`${rootURI}content/scripts/main.js`, ctx);
	Zotero.MapPapers = ctx.MapPapers;

	// Do not await: plugins start while Zotero is still initializing.
	Zotero.MapPapers.init({ id, version, rootURI }).catch(e => Zotero.logError(e));
}

function onMainWindowLoad({ window }) {
	Zotero.MapPapers?.addToWindow(window);
}

function onMainWindowUnload({ window }) {
	Zotero.MapPapers?.removeFromWindow(window);
}

async function shutdown() {
	if (Zotero.MapPapers) {
		await Zotero.MapPapers.shutdown();
		delete Zotero.MapPapers;
	}
	chromeHandle?.destruct();
	chromeHandle = null;
}

function uninstall() {}
