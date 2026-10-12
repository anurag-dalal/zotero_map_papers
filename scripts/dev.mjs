#!/usr/bin/env node
// Runs Zotero against a separate dev profile + data directory with the plugin
// loaded straight from addon/ (no rebuild needed; restart Zotero to reload).
//
// Your real profile and library are untouched. Override with env vars:
//   ZOTERO_BIN       path to the zotero binary   (default: auto-detect)
//   ZOTERO_DEV_DIR   where the dev profile lives (default: ./.dev)
//   ZOTERO_DATA_DIR  use this data directory instead of an empty one,
//                    e.g. a COPY of ~/Zotero to test with real items
// Flags: --devtools (open the browser toolbox), --debug-server (listen for
// the DevTools protocol on RDP_PORT, default 6100, used by scripts/rdp.mjs and
// scripts/smoke-test.mjs), --all-logs (unfiltered output)
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const addonDir = join(root, "addon");
const manifest = JSON.parse(readFileSync(join(addonDir, "manifest.json"), "utf8"));
const addonID = manifest.applications.zotero.id;

function findZotero() {
	if (process.env.ZOTERO_BIN) return process.env.ZOTERO_BIN;
	const candidates = [
		"/opt/zotero/zotero",
		"/usr/lib/zotero/zotero",
		"/usr/bin/zotero",
		join(process.env.HOME || "", "Zotero_linux-x86_64/zotero"),
		"/Applications/Zotero.app/Contents/MacOS/zotero",
		"C:\\Program Files\\Zotero\\zotero.exe",
	];
	for (const c of candidates) if (existsSync(c)) return c;
	try {
		return execSync("command -v zotero", { encoding: "utf8" }).trim();
	}
	catch {
		return null;
	}
}

const zotero = findZotero();
if (!zotero) {
	console.error("Could not find Zotero. Set ZOTERO_BIN=/path/to/zotero");
	process.exit(1);
}

const devDir = resolve(process.env.ZOTERO_DEV_DIR || join(root, ".dev"));
const profileDir = join(devDir, "profile");
const dataDir = resolve(process.env.ZOTERO_DATA_DIR || join(devDir, "data"));
mkdirSync(join(profileDir, "extensions"), { recursive: true });
mkdirSync(dataDir, { recursive: true });

// Proxy file: tells Zotero to load the extension from the source folder.
writeFileSync(join(profileDir, "extensions", addonID), addonDir + "\n");

// Make Zotero rescan extensions on every start so the proxy file is picked up.
const prefsJs = join(profileDir, "prefs.js");
if (existsSync(prefsJs)) {
	const kept = readFileSync(prefsJs, "utf8")
		.split("\n")
		.filter(l => !/extensions\.lastAppBuildId|extensions\.lastAppVersion/.test(l))
		.join("\n");
	writeFileSync(prefsJs, kept);
}
rmSync(join(profileDir, "extensions.json"), { force: true });
rmSync(join(profileDir, "startupCache"), { recursive: true, force: true });

writeFileSync(join(profileDir, "user.js"), [
	`user_pref("extensions.zotero.dataDir", ${JSON.stringify(dataDir)});`,
	`user_pref("extensions.zotero.useDataDir", true);`,
	`user_pref("extensions.zotero.firstRun2", false);`,
	`user_pref("extensions.zotero.debug.log", true);`,
	`user_pref("extensions.zotero.debug.time", true);`,
	`user_pref("extensions.autoDisableScopes", 0);`,
	`user_pref("extensions.enabledScopes", 15);`,
	`user_pref("xpinstall.signatures.required", false);`,
	`user_pref("devtools.chrome.enabled", true);`,
	`user_pref("devtools.debugger.remote-enabled", true);`,
	`user_pref("devtools.debugger.prompt-connection", false);`,
	`user_pref("browser.dom.window.dump.enabled", true);`,
	"",
].join("\n"));

console.log(`Zotero:   ${zotero}`);
console.log(`Profile:  ${profileDir}`);
console.log(`Data dir: ${dataDir}`);
console.log(`Plugin:   ${addonDir}`);
console.log("Tip: Tools → Developer → Run JavaScript / Error Console for debugging.\n");

const args = ["-profile", profileDir, "-purgecaches", "-no-remote", "-ZoteroDebugText", "-jsconsole"];
if (process.argv.includes("--devtools")) args.push("-jsdebugger");
// Remote control for scripts/rdp.mjs and scripts/smoke-test.mjs
if (process.argv.includes("--debug-server")) args.push("-start-debugger-server", String(Number(process.env.RDP_PORT) || 6100));

const child = spawn(zotero, args, { stdio: ["ignore", "pipe", "pipe"] });
const filter = process.argv.includes("--all-logs") ? null : /map-?papers|MapPapers|\[CP\]|JavaScript error|Error:/i;
const pipe = stream => stream.on("data", (buf) => {
	for (const line of buf.toString().split("\n")) {
		if (line && (!filter || filter.test(line))) console.log(line);
	}
});
pipe(child.stdout);
pipe(child.stderr);
child.on("exit", code => process.exit(code ?? 0));
