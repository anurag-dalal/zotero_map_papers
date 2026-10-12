#!/usr/bin/env node
// Syntax-checks every JS file and validates the JSON files in addon/.
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const walk = dir => readdirSync(dir).flatMap((n) => {
	const p = join(dir, n);
	return statSync(p).isDirectory() ? walk(p) : [p];
});

let failed = 0;
for (const file of walk(join(root, "addon"))) {
	try {
		if (file.endsWith(".js")) execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
		else if (file.endsWith(".json")) JSON.parse(readFileSync(file, "utf8"));
	}
	catch (e) {
		failed++;
		console.error(`✗ ${relative(root, file)}\n${e.stderr?.toString() || e.message}`);
	}
}

const manifest = JSON.parse(readFileSync(join(root, "addon/manifest.json"), "utf8"));
const z = manifest.applications?.zotero;
for (const key of ["id", "update_url", "strict_min_version"]) {
	if (!z?.[key]) {
		failed++;
		console.error(`✗ manifest.json: applications.zotero.${key} is required`);
	}
}

if (failed) process.exit(1);
console.log("✓ check passed");
