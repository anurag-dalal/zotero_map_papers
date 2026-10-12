/* exported CPThemes */
"use strict";

/**
 * Color themes for the graph window. `ramp` runs from the oldest to the newest
 * paper when nodes are colored by year; `relation` colors nodes by how they
 * relate to the origin paper.
 */
var CPThemes = (() => {
	const themes = [
		{
			id: "meadow", name: "Meadow (classic)", dark: false,
			bg: "#f7f8f6", canvas: "#ffffff", panel: "#ffffff", panel2: "#f1f4f2", border: "#dde3df",
			text: "#1d2a26", muted: "#6b7b75", accent: "#2f7d66", accentText: "#ffffff",
			edge: "rgba(60, 90, 80, 0.16)", edgeHi: "rgba(47, 125, 102, 0.75)", label: "#33433e",
			ramp: ["#e3f2ec", "#a8d8c4", "#5fb092", "#2f7d66", "#164c3e"],
			origin: "#c2410c", selected: "#111827", library: "#2563eb",
			relation: { origin: "#c2410c", ref: "#5fb092", cite: "#3b82f6", other: "#cbd5d1" },
		},
		{
			id: "midnight", name: "Midnight", dark: true,
			bg: "#0d1117", canvas: "#0f141b", panel: "#151b23", panel2: "#1b232d", border: "#2a3441",
			text: "#e6edf3", muted: "#8b98a7", accent: "#7c9cff", accentText: "#0d1117",
			edge: "rgba(140, 160, 200, 0.14)", edgeHi: "rgba(124, 156, 255, 0.8)", label: "#c3cdd8",
			ramp: ["#2b2f6b", "#4b3f9e", "#6f5fd6", "#4fa3e0", "#5ff0e0"],
			origin: "#ffb84d", selected: "#ffffff", library: "#5ff07a",
			relation: { origin: "#ffb84d", ref: "#6f5fd6", cite: "#5ff0e0", other: "#3a4556" },
		},
		{
			id: "dracula", name: "Dracula", dark: true,
			bg: "#21222c", canvas: "#282a36", panel: "#2d2f3d", panel2: "#343746", border: "#44475a",
			text: "#f8f8f2", muted: "#a4a8c4", accent: "#bd93f9", accentText: "#21222c",
			edge: "rgba(189, 147, 249, 0.14)", edgeHi: "rgba(255, 121, 198, 0.85)", label: "#e2e2dc",
			ramp: ["#44475a", "#6272a4", "#bd93f9", "#ff79c6", "#ffb86c"],
			origin: "#50fa7b", selected: "#f1fa8c", library: "#8be9fd",
			relation: { origin: "#50fa7b", ref: "#bd93f9", cite: "#ff79c6", other: "#4b4f66" },
		},
		{
			id: "viridis", name: "Viridis", dark: false,
			bg: "#f6f6f4", canvas: "#ffffff", panel: "#ffffff", panel2: "#f0f0ee", border: "#dedfdc",
			text: "#1f1f24", muted: "#6c6d75", accent: "#31688e", accentText: "#ffffff",
			edge: "rgba(49, 104, 142, 0.15)", edgeHi: "rgba(49, 104, 142, 0.8)", label: "#2f3036",
			ramp: ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"],
			origin: "#e4572e", selected: "#111111", library: "#e4572e",
			relation: { origin: "#e4572e", ref: "#3b528b", cite: "#5ec962", other: "#cfd1d6" },
		},
		{
			id: "sunset", name: "Sunset", dark: false,
			bg: "#fbf7f4", canvas: "#fffdfb", panel: "#ffffff", panel2: "#f7efe9", border: "#eadcd1",
			text: "#2d1d17", muted: "#86695c", accent: "#d9480f", accentText: "#ffffff",
			edge: "rgba(160, 90, 60, 0.15)", edgeHi: "rgba(217, 72, 15, 0.75)", label: "#4a3128",
			ramp: ["#fde2c8", "#fbb17a", "#f2733c", "#c93a3a", "#6d1a4a"],
			origin: "#1d4ed8", selected: "#1a1a1a", library: "#0f766e",
			relation: { origin: "#1d4ed8", ref: "#f2733c", cite: "#c93a3a", other: "#e6d6cb" },
		},
		{
			id: "ocean", name: "Ocean", dark: false,
			bg: "#f3f7fa", canvas: "#ffffff", panel: "#ffffff", panel2: "#eaf1f6", border: "#d4e0e9",
			text: "#14232f", muted: "#5d7385", accent: "#1c6ea4", accentText: "#ffffff",
			edge: "rgba(28, 110, 164, 0.14)", edgeHi: "rgba(28, 110, 164, 0.8)", label: "#203646",
			ramp: ["#dbeef8", "#9fd0ea", "#4ea3d1", "#1c6ea4", "#0b3a5e"],
			origin: "#e8590c", selected: "#0b1620", library: "#2b8a3e",
			relation: { origin: "#e8590c", ref: "#4ea3d1", cite: "#0b3a5e", other: "#c9d7e2" },
		},
		{
			id: "mono", name: "Monochrome", dark: false,
			bg: "#f5f5f5", canvas: "#ffffff", panel: "#ffffff", panel2: "#efefef", border: "#dcdcdc",
			text: "#161616", muted: "#6f6f6f", accent: "#262626", accentText: "#ffffff",
			edge: "rgba(0, 0, 0, 0.12)", edgeHi: "rgba(0, 0, 0, 0.7)", label: "#262626",
			ramp: ["#ececec", "#bdbdbd", "#8a8a8a", "#525252", "#1f1f1f"],
			origin: "#d00000", selected: "#000000", library: "#d00000",
			relation: { origin: "#d00000", ref: "#8a8a8a", cite: "#363636", other: "#dedede" },
		},
		{
			id: "solarized", name: "Solarized dark", dark: true,
			bg: "#002b36", canvas: "#002b36", panel: "#073642", panel2: "#0a404d", border: "#18505e",
			text: "#eee8d5", muted: "#93a1a1", accent: "#2aa198", accentText: "#002b36",
			edge: "rgba(147, 161, 161, 0.15)", edgeHi: "rgba(42, 161, 152, 0.85)", label: "#d5d0bd",
			ramp: ["#26525e", "#268bd2", "#2aa198", "#859900", "#b58900"],
			origin: "#dc322f", selected: "#fdf6e3", library: "#d33682",
			relation: { origin: "#dc322f", ref: "#268bd2", cite: "#859900", other: "#2f5763" },
		},
	];

	const byId = new Map(themes.map(t => [t.id, t]));

	function get(id) {
		return byId.get(id) || themes[0];
	}

	function hexToRgb(hex) {
		const h = hex.replace("#", "");
		const n = parseInt(h.length === 3 ? h.replace(/./g, c => c + c) : h, 16);
		return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
	}

	/** Color at position t (0..1) along a multi-stop ramp. */
	function rampColor(ramp, t) {
		if (!(t >= 0)) t = 0;
		if (t > 1) t = 1;
		const pos = t * (ramp.length - 1);
		const i = Math.min(ramp.length - 2, Math.floor(pos));
		const f = pos - i;
		const a = hexToRgb(ramp[i]);
		const b = hexToRgb(ramp[i + 1]);
		const c = a.map((v, k) => Math.round(v + (b[k] - v) * f));
		return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
	}

	/** Perceived luminance (0..1), used to pick a readable stroke. */
	function luminance(color) {
		const m = color.match(/\d+/g);
		const [r, g, b] = color.startsWith("#") ? hexToRgb(color) : m.map(Number);
		return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
	}

	return { list: themes, get, rampColor, luminance };
})();

if (typeof module !== "undefined") module.exports = CPThemes;
