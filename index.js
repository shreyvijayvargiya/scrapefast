/**
 * Minimal Hono API: POST /scrape + POST /screenshot
 * Pattern aligned with ihatereading-api: BrowserPool → puppeteer-core →
 * request interception, stealth-ish evaluateOnNewDocument, JSDOM cleanup, markdown.
 *
 * Env:
 *   BROWSER_POOL_SIZE=2
 *   CHROME_PATH=/path/to/chrome   (optional; on macOS/Windows we auto-detect Chrome if unset)
 */
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";

const POOL_SIZE = Math.max(1, parseInt(process.env.BROWSER_POOL_SIZE || "2", 10) || 2);

const CHROME_ARGS = [
	"--no-sandbox",
	"--disable-setuid-sandbox",
	"--disable-dev-shm-usage",
	"--disable-gpu",
	"--disable-web-security",
	"--no-zygote",
	"--single-process",
];

const MACOS_CHROME_CANDIDATES = [
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
	"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

const LINUX_SYSTEM_CHROME_CANDIDATES = [
	"/usr/bin/google-chrome-stable",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
];

async function pathExecutable(p) {
	if (!p) return false;
	try {
		const mode =
			process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK;
		await fs.access(p, mode);
		return true;
	} catch {
		return false;
	}
}

/**
 * @sparticuz/chromium ships a Linux binary for Lambda; on macOS/Windows that path is not runnable (spawn ENOEXEC).
 * Prefer system Chrome when CHROME_PATH is unset.
 */
async function resolveChromeLaunchConfig() {
	const fromEnv = process.env.CHROME_PATH?.trim();
	if (fromEnv) {
		if (!(await pathExecutable(fromEnv))) {
			throw new Error(`CHROME_PATH is set but not executable: ${fromEnv}`);
		}
		return { executablePath: fromEnv, args: CHROME_ARGS };
	}

	if (process.platform === "darwin") {
		for (const p of MACOS_CHROME_CANDIDATES) {
			if (await pathExecutable(p)) {
				return { executablePath: p, args: CHROME_ARGS };
			}
		}
		throw new Error(
			"Chrome not found. Install Google Chrome or set CHROME_PATH to your Chrome/Chromium binary.",
		);
	}

	if (process.platform === "win32") {
		const candidates = [
			process.env.PROGRAMFILES &&
				`${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
			process.env["PROGRAMFILES(X86)"] &&
				`${process.env["PROGRAMFILES(X86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
			process.env.LOCALAPPDATA &&
				`${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
		].filter(Boolean);
		for (const p of candidates) {
			if (await pathExecutable(p)) {
				return { executablePath: p, args: CHROME_ARGS };
			}
		}
		throw new Error(
			"Chrome not found. Install Google Chrome or set CHROME_PATH to chrome.exe.",
		);
	}

	for (const p of LINUX_SYSTEM_CHROME_CANDIDATES) {
		if (await pathExecutable(p)) {
			return { executablePath: p, args: CHROME_ARGS };
		}
	}

	const chromium = (await import("@sparticuz/chromium")).default;
	return {
		executablePath: await chromium.executablePath(),
		args: [...chromium.args, "--disable-web-security"],
		ignoreDefaultArgs: ["--disable-extensions"],
	};
}

function isValidHttpUrl(s) {
	try {
		const u = new URL(String(s).trim());
		return u.protocol === "http:" || u.protocol === "https:";
	} catch {
		return false;
	}
}

/** In-memory sliding-window rate limit (same idea as index.js). */
const rateLimitMap = new Map();
function rateLimit(ip, limit, windowMs) {
	const now = Date.now();
	const record = rateLimitMap.get(ip);
	if (!record || now > record.resetTime) {
		rateLimitMap.set(ip, { count: 1, resetTime: now + windowMs });
		return { allowed: true, remaining: limit - 1 };
	}
	if (record.count >= limit) {
		return {
			allowed: false,
			retryAfter: Math.ceil((record.resetTime - now) / 1000),
			remaining: 0,
		};
	}
	record.count++;
	return { allowed: true, remaining: limit - record.count };
}

setInterval(() => {
	const now = Date.now();
	for (const [ip, r] of rateLimitMap.entries()) {
		if (now > r.resetTime) rateLimitMap.delete(ip);
	}
}, 5 * 60 * 1000);

class BrowserPool {
	constructor(size) {
		this._size = size;
		this._pool = [];
		this._queue = [];
		this._ready = false;
		this._loading = false;
	}

	async _launch() {
		const puppeteer = (await import("puppeteer-core")).default;
		const cfg = await resolveChromeLaunchConfig();
		const launchOpts = {
			headless: true,
			executablePath: cfg.executablePath,
			args: cfg.args,
		};
		if (cfg.ignoreDefaultArgs) {
			launchOpts.ignoreDefaultArgs = cfg.ignoreDefaultArgs;
		}
		return puppeteer.launch(launchOpts);
	}

	async initialise() {
		if (this._ready || this._loading) return;
		this._loading = true;
		const browsers = await Promise.all(
			Array.from({ length: this._size }, () => this._launch()),
		);
		this._pool = browsers.map((browser, index) => ({
			browser,
			busy: false,
			index,
		}));
		this._ready = true;
		this._loading = false;
	}

	_acquire() {
		const free = this._pool.find((e) => !e.busy);
		if (free) {
			free.busy = true;
			return Promise.resolve(free);
		}
		return new Promise((resolve) => this._queue.push(resolve));
	}

	_release(entry) {
		entry.busy = false;
		const next = this._queue.shift();
		if (next) {
			const f = this._pool.find((e) => !e.busy);
			if (f) {
				f.busy = true;
				next(f);
			} else this._queue.unshift(next);
		}
	}

	async withPage(fn) {
		if (!this._ready) await this.initialise();
		const entry = await this._acquire();
		let page;
		try {
			page = await entry.browser.newPage();
			return await fn(page);
		} finally {
			if (page) {
				try {
					await page.close();
				} catch {}
			}
			this._release(entry);
		}
	}

	get stats() {
		if (!this._pool.length) {
			return { size: 0, busy: 0, free: 0, queued: this._queue.length };
		}
		const busy = this._pool.filter((e) => e.busy).length;
		return {
			size: this._pool.length,
			busy,
			free: this._pool.length - busy,
			queued: this._queue.length,
		};
	}
}

const browserPool = new BrowserPool(POOL_SIZE);

const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
});

const NOISE_SELECTORS = [
	"script",
	"style",
	"noscript",
	"header",
	"footer",
	"nav",
	"aside",
	".ad",
	".ads",
	"[class*='cookie' i]",
	"[id*='cookie' i]",
].join(", ");

function stripDomNoise(document) {
	document.querySelectorAll(NOISE_SELECTORS).forEach((el) => el.remove());
}

async function setupPage(page, { timeout, viewport }) {
	await page.setViewport(viewport);
	await page.setUserAgent(
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
	);
	await page.setExtraHTTPHeaders({
		Accept:
			"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
		"Accept-Language": "en-US,en;q=0.9",
	});

	await page.evaluateOnNewDocument(() => {
		Object.defineProperty(navigator, "webdriver", { get: () => undefined });
		Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
		Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
	});

	await page.setRequestInterception(true);
	page.on("request", (req) => {
		const type = req.resourceType();
		const url = req.url().toLowerCase();
		if (type === "image" || type === "font" || type === "media") {
			req.abort();
			return;
		}
		if (type === "stylesheet") {
			req.respond({ status: 200, contentType: "text/css", body: "" });
			return;
		}
		if (
			url.includes("cloudflare") ||
			url.includes("challenge") ||
			url.includes("bot-detection")
		) {
			req.abort();
			return;
		}
		req.continue();
	});

	page.setDefaultNavigationTimeout(timeout);
	page.setDefaultTimeout(timeout);
}

/**
 * Core scrape — simplified from scrapeSingleUrlWithPuppeteer (no Firestore, proxy, Reddit, G2, AI).
 */
async function scrapeUrl(url, options = {}) {
	const {
		waitForSelector = null,
		timeout = 30_000,
		includeSemanticContent = true,
		includeImages = true,
		includeLinks = true,
		extractMetadata = true,
	} = options;

	const viewport = { width: 1366, height: 768, deviceScaleFactor: 1 };

	return browserPool.withPage(async (page) => {
		await setupPage(page, { timeout, viewport });

		await page.goto(url, { waitUntil: "domcontentloaded", timeout });
		if (waitForSelector) {
			try {
				await page.waitForSelector(waitForSelector, { timeout: 10_000 });
			} catch {}
		}

		const scrapedData = includeSemanticContent
			? await page.evaluate(
					(opts) => {
						const data = {
							url: location.href,
							title: document.title,
							content: {},
							metadata: {},
							links: [],
							images: [],
						};
						["h1", "h2", "h3", "h4", "h5", "h6"].forEach((tag) => {
							data.content[tag] = Array.from(
								document.querySelectorAll(tag),
							).map((h) => h.textContent.trim());
						});
						if (opts.extractMetadata) {
							document.querySelectorAll("meta").forEach((meta) => {
								const name =
									meta.getAttribute("name") || meta.getAttribute("property");
								const content = meta.getAttribute("content");
								if (name && content) data.metadata[name] = content;
							});
						}
						if (opts.includeLinks) {
							const host = location.hostname;
							const seen = new Set();
							data.links = Array.from(document.querySelectorAll("a[href]"))
								.map((a) => ({
									text: a.textContent.trim(),
									href: a.href,
									title: a.getAttribute("title") || "",
								}))
								.filter((l) => {
									try {
										if (new URL(l.href).hostname !== host) return false;
									} catch {
										return false;
									}
									if (!l.text && !l.title) return false;
									const k = `${l.text}|${l.href}`;
									if (seen.has(k)) return false;
									seen.add(k);
									return true;
								});
						}
						if (opts.includeImages) {
							data.images = Array.from(document.querySelectorAll("img[src]"))
								.filter((img) => !img.src.startsWith("data:"))
								.map((img) => ({
									src: img.src,
									alt: img.alt || "",
								}));
						}
						return data;
					},
					{ extractMetadata, includeLinks, includeImages },
				)
			: { url, title: await page.title(), content: {}, metadata: {}, links: [], images: [] };

		const html = await page.content();
		const dom = new JSDOM(html);
		const doc = dom.window.document;
		stripDomNoise(doc);
		const markdown = turndown.turndown(doc.body);

		return {
			success: true,
			data: scrapedData,
			markdown,
		};
	});
}

async function screenshotUrl(url, options = {}) {
	const {
		timeout = 30_000,
		fullPage = true,
		waitForSelector = null,
	} = options;
	const viewport = { width: 1366, height: 768, deviceScaleFactor: 1 };

	return browserPool.withPage(async (page) => {
		await setupPage(page, { timeout, viewport });
		await page.goto(url, { waitUntil: "domcontentloaded", timeout });
		if (waitForSelector) {
			try {
				await page.waitForSelector(waitForSelector, { timeout: 10_000 });
			} catch {}
		}
		const buf = await page.screenshot({
			type: "png",
			fullPage,
			encoding: "binary",
		});
		return Buffer.from(buf).toString("base64");
	});
}

const app = new Hono();

app.get("/", (c) =>
	c.json({
		ok: true,
		hint: "POST /scrape or /screenshot with JSON { url, ... }",
	}),
);

app.post("/scrape", async (c) => {
	const ip =
		c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
		c.req.header("x-real-ip") ||
		"unknown";
	const rl = rateLimit(ip, 30, 10 * 60 * 1000);
	if (!rl.allowed) {
		c.header("Retry-After", String(rl.retryAfter));
		return c.json({ error: "rate_limited", retryAfter: rl.retryAfter }, 429);
	}

	let body = {};
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "invalid_json" }, 400);
	}

	const { url } = body;
	if (!url || !isValidHttpUrl(url)) {
		return c.json({ error: "valid https url required" }, 400);
	}

	try {
		const result = await scrapeUrl(url, {
			waitForSelector: body.waitForSelector ?? null,
			timeout: Number(body.timeout) || 30_000,
			includeSemanticContent: body.includeSemanticContent !== false,
			includeImages: body.includeImages !== false,
			includeLinks: body.includeLinks !== false,
			extractMetadata: body.extractMetadata !== false,
		});
		return c.json({
			...result,
			url,
			timestamp: new Date().toISOString(),
			poolStats: browserPool.stats,
		});
	} catch (e) {
		console.error(e);
		return c.json(
			{ success: false, error: e?.message || "scrape_failed", url },
			500,
		);
	}
});

app.post("/screenshot", async (c) => {
	const ip =
		c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
		c.req.header("x-real-ip") ||
		"unknown";
	const rl = rateLimit(ip, 20, 10 * 60 * 1000);
	if (!rl.allowed) {
		c.header("Retry-After", String(rl.retryAfter));
		return c.json({ error: "rate_limited" }, 429);
	}

	let body = {};
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "invalid_json" }, 400);
	}

	const { url } = body;
	if (!url || !isValidHttpUrl(url)) {
		return c.json({ error: "valid https url required" }, 400);
	}

	try {
		const b64 = await screenshotUrl(url, {
			timeout: Number(body.timeout) || 30_000,
			fullPage: body.fullPage !== false,
			waitForSelector: body.waitForSelector ?? null,
		});
		return c.json({
			success: true,
			url,
			image_base64: b64,
			mime: "image/png",
			timestamp: new Date().toISOString(),
			poolStats: browserPool.stats,
		});
	} catch (e) {
		console.error(e);
		return c.json({ success: false, error: e?.message || "screenshot_failed" }, 500);
	}
});

const port = Number(process.env.PORT) || 3000;
console.log(`Listening on http://localhost:${port}`);
serve({ fetch: app.fetch, port });