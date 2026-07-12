import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const baseURL = process.env.BASE_URL || "http://127.0.0.1:5173";
const outDir = path.resolve("test-results/perf-sample");
fs.mkdirSync(outDir, { recursive: true });

async function timeFetch(url, runs = 5) {
  const samples = [];
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now();
    const res = await fetch(url);
    await res.arrayBuffer();
    samples.push({
      ms: performance.now() - start,
      status: res.status,
      bytes: Number(res.headers.get("content-length") || 0)
    });
  }
  const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
  return {
    url,
    status: samples[0]?.status,
    runs,
    min: Math.round(ms[0]),
    p50: Math.round(ms[Math.floor(ms.length * 0.5)]),
    p95: Math.round(ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))]),
    max: Math.round(ms[ms.length - 1]),
    bytes: samples[0]?.bytes || 0
  };
}

async function waitServer() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(baseURL);
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server not ready: ${baseURL}`);
}

await waitServer();

const apiTargets = [
  "/api/settings",
  "/api/rooms",
  "/api/tasks",
  "/api/automation/jobs",
  "/api/recording/monitor/status",
  "/api/recording/rooms?enrich=0"
];

const apiResults = [];
for (const target of apiTargets) {
  apiResults.push(await timeFetch(`${baseURL}${target}`, 7));
}

// open first room detail if available
const rooms = await fetch(`${baseURL}/api/rooms`).then((r) => r.json());
const firstRoom = (rooms.rooms || [])[0];
let roomDetail = null;
if (firstRoom?.key) {
  roomDetail = await timeFetch(`${baseURL}/api/rooms/${encodeURIComponent(firstRoom.key)}`, 5);
  apiResults.push({ ...roomDetail, note: `room=${firstRoom.name || firstRoom.folderName || firstRoom.key}` });
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const navTimings = [];

async function measureNav(label, action) {
  const start = performance.now();
  await action();
  // wait network mostly idle-ish
  await page.waitForTimeout(600);
  const ms = performance.now() - start;
  const metrics = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    const paints = performance.getEntriesByType("paint");
    return {
      domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
      load: nav ? Math.round(nav.loadEventEnd) : null,
      fcp: Math.round(paints.find((p) => p.name === "first-contentful-paint")?.startTime || 0) || null,
      resources: performance.getEntriesByType("resource").length
    };
  });
  const shot = path.join(outDir, `${String(navTimings.length + 1).padStart(2, "0")}-${label}.png`);
  await page.screenshot({ path: shot, fullPage: true });
  navTimings.push({ label, actionMs: Math.round(ms), ...metrics, shot });
}

try {
  await measureNav("home", async () => {
    await page.goto(baseURL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector(".topbar, .app", { timeout: 15000 });
  });

  await measureNav("tasks", async () => {
    await page.locator('nav button:has-text("任务")').click();
    await page.waitForTimeout(300);
  });

  await measureNav("settings", async () => {
    await page.locator('nav button:has-text("设置")').click();
    await page.waitForTimeout(300);
  });

  await measureNav("upload", async () => {
    const upload = page.locator('[data-testid="nav-upload"]');
    if (await upload.count()) await upload.click();
    else await page.locator('nav button:has-text("投稿")').click();
    await page.waitForTimeout(300);
  });

  await measureNav("library", async () => {
    await page.locator('nav button:has-text("素材库")').click();
    await page.waitForTimeout(300);
  });

  // if room card exists, open workspace
  const roomCard = page.locator('[data-testid^="library-room-card-"]').first();
  if (await roomCard.count()) {
    const openBtn = roomCard.locator('button:has-text("进入房间"), button.primary').first();
    if (await openBtn.count()) {
      await measureNav("open-room", async () => {
        await openBtn.click();
        await page.waitForTimeout(800);
      });
    }
  }
} finally {
  await browser.close();
}

const report = {
  at: new Date().toISOString(),
  baseURL,
  roomCount: (rooms.rooms || []).length,
  api: apiResults,
  pages: navTimings
};
fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));

console.log("=== API latency (ms) ===");
for (const row of apiResults) {
  console.log(
    `${row.url.replace(baseURL, "")}  p50=${row.p50}  p95=${row.p95}  max=${row.max}  status=${row.status}` +
      (row.note ? `  (${row.note})` : "")
  );
}
console.log("\n=== Page actions (ms) ===");
for (const row of navTimings) {
  console.log(`${row.label}  action=${row.actionMs}  dcl=${row.domContentLoaded}  load=${row.load}  fcp=${row.fcp}`);
}
console.log(`\nreport: ${path.join(outDir, "report.json")}`);
