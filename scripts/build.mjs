#!/usr/bin/env node
// Packages addon/ into build/custom-columns-<version>.xpi (a plain zip).
// No dependencies: uses node's zlib for deflate + crc32.
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join, relative, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, crc32 } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const addonDir = join(root, "addon");
const outDir = join(root, "build");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifestPath = join(addonDir, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

// Keep manifest version in sync with package.json.
if (manifest.version !== pkg.version) {
	manifest.version = pkg.version;
	writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
	console.log(`manifest.json version -> ${pkg.version}`);
}

function walk(dir) {
	const out = [];
	for (const name of readdirSync(dir).sort()) {
		if (name.startsWith(".") || name.endsWith("~")) continue;
		const full = join(dir, name);
		if (statSync(full).isDirectory()) out.push(...walk(full));
		else out.push(full);
	}
	return out;
}

function dosDateTime(d) {
	const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
	const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
	return { time, date };
}

const files = walk(addonDir);
const locals = [];
const centrals = [];
let offset = 0;
const { time, date } = dosDateTime(new Date());

for (const file of files) {
	const name = Buffer.from(relative(addonDir, file).split(sep).join("/"));
	const data = readFileSync(file);
	const crc = crc32(data);
	const deflated = deflateRawSync(data, { level: 9 });
	const useDeflate = deflated.length < data.length;
	const body = useDeflate ? deflated : data;
	const method = useDeflate ? 8 : 0;

	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(20, 4);
	local.writeUInt16LE(0x0800, 6); // UTF-8 names
	local.writeUInt16LE(method, 8);
	local.writeUInt16LE(time, 10);
	local.writeUInt16LE(date, 12);
	local.writeUInt32LE(crc, 14);
	local.writeUInt32LE(body.length, 18);
	local.writeUInt32LE(data.length, 22);
	local.writeUInt16LE(name.length, 26);
	local.writeUInt16LE(0, 28);
	locals.push(local, name, body);

	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt16LE(20, 4);
	central.writeUInt16LE(20, 6);
	central.writeUInt16LE(0x0800, 8);
	central.writeUInt16LE(method, 10);
	central.writeUInt16LE(time, 12);
	central.writeUInt16LE(date, 14);
	central.writeUInt32LE(crc, 16);
	central.writeUInt32LE(body.length, 20);
	central.writeUInt32LE(data.length, 24);
	central.writeUInt16LE(name.length, 28);
	central.writeUInt32LE(offset, 42);
	centrals.push(central, name);

	offset += local.length + name.length + body.length;
}

const centralSize = centrals.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);

mkdirSync(outDir, { recursive: true });
const xpi = join(outDir, `map-papers-${pkg.version}.xpi`);
writeFileSync(xpi, Buffer.concat([...locals, ...centrals, end]));
writeFileSync(join(outDir, "map-papers.xpi"), readFileSync(xpi));

// update.json for the manifest's update_url, if you host releases.
const update = {
	addons: {
		[manifest.applications.zotero.id]: {
			updates: [{
				version: pkg.version,
				update_link: `${pkg.homepage || "https://example.com"}/releases/download/v${pkg.version}/map-papers-${pkg.version}.xpi`,
				applications: { zotero: { strict_min_version: manifest.applications.zotero.strict_min_version } },
			}],
		},
	},
};
writeFileSync(join(outDir, "update.json"), JSON.stringify(update, null, 2) + "\n");

console.log(`Built ${relative(root, xpi)} (${files.length} files, ${(statSync(xpi).size / 1024).toFixed(1)} KB)`);
