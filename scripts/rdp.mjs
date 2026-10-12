#!/usr/bin/env node
// Minimal Firefox DevTools (RDP) client for driving a dev Zotero started with
// `npm run dev -- --debug-server`. Runs JS in Zotero's chrome (parent process).
//
// CLI:
//   node scripts/rdp.mjs eval "return Zotero.version"
//   node scripts/rdp.mjs screenshot out.png        # main window
//   node scripts/rdp.mjs screenshot out.png settings # window whose URL contains "settings"
import net from "node:net";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export class RDP {
	constructor(port = Number(process.env.RDP_PORT) || 6100, host = "127.0.0.1") {
		this.port = port;
		this.host = host;
		this.buf = Buffer.alloc(0);
		this.waiters = [];
		this.events = [];
	}

	async connect(timeoutMs = 90000) {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			try {
				await this._open();
				break;
			}
			catch (e) {
				if (Date.now() > deadline) throw new Error(`DevTools server not reachable on ${this.port}: ${e.message}`);
				await new Promise(r => setTimeout(r, 500));
			}
		}
		const { processDescriptor } = await this.request({ to: "root", type: "getProcess", id: 0 });
		const target = await this.request({ to: processDescriptor.actor, type: "getTarget" });
		this.console = (target.process || target.frame || target).consoleActor;
		if (!this.console) throw new Error("No console actor: " + JSON.stringify(target));
		return this;
	}

	_open() {
		return new Promise((resolve, reject) => {
			const sock = net.connect(this.port, this.host);
			let greeted = false;
			sock.on("error", reject);
			sock.on("data", (chunk) => {
				this.buf = Buffer.concat([this.buf, chunk]);
				for (;;) {
					const colon = this.buf.indexOf(":");
					if (colon < 0) return;
					const len = parseInt(this.buf.subarray(0, colon).toString(), 10);
					if (this.buf.length < colon + 1 + len) return;
					const packet = JSON.parse(this.buf.subarray(colon + 1, colon + 1 + len).toString());
					this.buf = this.buf.subarray(colon + 1 + len);
					if (!greeted) {
						greeted = true;
						this.sock = sock;
						resolve();
						continue;
					}
					this._dispatch(packet);
				}
			});
		});
	}

	_dispatch(packet) {
		const i = this.waiters.findIndex(w => w.match(packet));
		if (i >= 0) {
			const [w] = this.waiters.splice(i, 1);
			if (packet.error) w.reject(new Error(`${packet.error}: ${packet.message}`));
			else w.resolve(packet);
		}
		else {
			this.events.push(packet);
		}
	}

	_wait(match) {
		const idx = this.events.findIndex(match);
		if (idx >= 0) return Promise.resolve(this.events.splice(idx, 1)[0]);
		return new Promise((resolve, reject) => this.waiters.push({ match, resolve, reject }));
	}

	request(packet) {
		const data = JSON.stringify(packet);
		// Replies come back in order per actor, without a "type".
		const p = this._wait(r => r.from === packet.to && !r.type);
		this.sock.write(`${Buffer.byteLength(data)}:${data}`);
		return p;
	}

	async _evaluate(text) {
		const { resultID } = await this.request({ to: this.console, type: "evaluateJSAsync", text });
		const res = await this._wait(r => r.type === "evaluationResult" && r.resultID === resultID);
		if (res.exception) {
			throw new Error(res.exceptionMessage || JSON.stringify(res.exception));
		}
		let value = res.result;
		if (value && typeof value === "object" && value.type === "longString") {
			const { substring } = await this.request({ to: value.actor, type: "substring", start: 0, end: value.length });
			value = substring;
		}
		return value;
	}

	/**
	 * Run an async function body in the main Zotero window; `return` a
	 * JSON-serializable result.
	 */
	async run(body, timeoutMs = 60000) {
		const slot = "__rdp_" + Math.random().toString(36).slice(2);
		await this._evaluate(`(() => {
			const w = Services.wm.getMostRecentWindow("navigator:browser") || window;
			w.${slot} = { done: false };
			const fn = new w.Function("return (async () => {" + ${JSON.stringify(body)} + "})()");
			fn().then(
				v => (w.${slot} = { done: true, ok: true, v: JSON.stringify(v === undefined ? null : v) }),
				e => (w.${slot} = { done: true, ok: false, e: String(e) + "\\n" + (e && e.stack || "") }));
			return "started";
		})()`);
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const raw = await this._evaluate(`(() => {
				const w = Services.wm.getMostRecentWindow("navigator:browser") || window;
				const r = w.${slot};
				if (r && r.done) delete w.${slot};
				return JSON.stringify(r || null);
			})()`);
			const r = JSON.parse(raw);
			if (r?.done) {
				if (!r.ok) throw new Error(r.e);
				return JSON.parse(r.v);
			}
			if (Date.now() > deadline) throw new Error("Timed out waiting for script");
			await new Promise(res => setTimeout(res, 150));
		}
	}

	/** PNG of a chrome window (main window, or first whose URL contains `match`). */
	async screenshot(path, match) {
		const b64 = await this.run(`
			const m = ${JSON.stringify(match || "")};
			let win = null;
			for (const w of Services.wm.getEnumerator(null)) {
				if (m ? w.location.href.includes(m) : w.location.href.includes("zoteroPane.xhtml")) win = w;
			}
			if (!win) throw new Error("window not found: " + m);
			const rect = new win.DOMRect(0, 0, win.innerWidth, win.innerHeight);
			const bmp = await win.browsingContext.currentWindowGlobal.drawSnapshot(rect, 1, "white");
			const c = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
			c.width = bmp.width; c.height = bmp.height;
			c.getContext("2d").drawImage(bmp, 0, 0);
			return c.toDataURL("image/png").split(",")[1];
		`);
		writeFileSync(path, Buffer.from(b64, "base64"));
		return path;
	}

	close() {
		this.sock?.end();
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [cmd, arg, extra] = process.argv.slice(2);
	const rdp = await new RDP().connect();
	try {
		if (cmd === "eval") console.log(JSON.stringify(await rdp.run(arg), null, 2));
		else if (cmd === "screenshot") console.log(await rdp.screenshot(arg || "screenshot.png", extra));
		else console.error("usage: rdp.mjs eval <js> | screenshot <file.png> [urlSubstring]");
	}
	finally {
		rdp.close();
	}
}
