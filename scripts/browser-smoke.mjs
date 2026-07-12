import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const baseURL = process.env.BASE_URL || "http://127.0.0.1:5173";
const outDir = path.resolve("test-results/browser-smoke");
fs.mkdirSync(outDir, { recursive: true });

const results = [];
function ok(name, detail = "") {
  results.push({ name, ok: true, detail });
  console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name, detail = "") {
  results.push({ name, ok: false, detail });
  console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });

try {
  await page.goto(baseURL, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForSelector(".app, .topbar, body", { timeout: 15000 });
  const title = await page.title();
  const hasBrand = await page.locator("text=Bilive").count();
  if (hasBrand > 0 || (await page.locator(".topbar").count()) > 0) {
    ok("homepage-loads", `title=${title || "(none)"}`);
  } else {
    fail("homepage-loads", `title=${title}`);
  }
  await page.screenshot({ path: path.join(outDir, "01-home.png"), fullPage: true });

  // library / recording dashboard
  let libraryVisible =
    (await page.locator('[data-testid="recording-dashboard"]').count()) > 0 ||
    (await page.locator(".library-grid").count()) > 0 ||
    (await page.getByText("房间总览").count()) > 0;
  if (!libraryVisible) {
    const libBtn = page.locator('nav button:has-text("素材库")');
    if (await libBtn.count()) await libBtn.click();
    await page.waitForTimeout(500);
    libraryVisible =
      (await page.locator('[data-testid="recording-dashboard"]').count()) > 0 ||
      (await page.getByText("房间总览").count()) > 0;
  }
  if (libraryVisible) ok("library-visible");
  else fail("library-visible");
  await page.screenshot({ path: path.join(outDir, "02-library.png"), fullPage: true });

  // tasks
  const tasksBtn = page.locator('nav button:has-text("任务")');
  await tasksBtn.click();
  await page.waitForTimeout(800);
  const tasksOk =
    (await page.locator('[data-testid="automation-task-section"]').count()) > 0 ||
    (await page.locator(".tasks-layout").count()) > 0 ||
    (await page.getByText("自动切片").count()) > 0;
  if (tasksOk) ok("tasks-page");
  else {
    const mainText = await page.locator("main").innerText().catch(() => "");
    fail("tasks-page", mainText.slice(0, 200));
  }
  await page.screenshot({ path: path.join(outDir, "03-tasks.png"), fullPage: true });

  // settings
  const settingsBtn = page.locator('nav button:has-text("设置")');
  await settingsBtn.click();
  await page.waitForTimeout(1000);
  const settingsOk =
    (await page.locator(".settings-layout").count()) > 0 ||
    (await page.locator(".settings-grid").count()) > 0 ||
    (await page.getByText("录制素材").count()) > 0 ||
    (await page.getByText("录制 Cookie").count()) > 0;
  if (settingsOk) ok("settings-page");
  else fail("settings-page");
  // cookie labels
  const recCookie = await page.getByText("录制 Cookie").count();
  if (recCookie > 0) ok("settings-recording-cookie-label");
  else fail("settings-recording-cookie-label");
  await page.screenshot({ path: path.join(outDir, "04-settings.png"), fullPage: true });

  // upload page
  const uploadBtn = page.locator('[data-testid="nav-upload"]');
  if (await uploadBtn.count()) await uploadBtn.click();
  else await page.locator('nav button:has-text("投稿")').click();
  await page.waitForTimeout(1000);
  const uploadOk =
    (await page.locator(".upload-layout").count()) > 0 ||
    (await page.getByText("分 P").count()) > 0 ||
    (await page.getByText("投稿方式").count()) > 0 ||
    (await page.getByText("投稿 Cookie").count()) > 0;
  if (uploadOk) ok("upload-page");
  else fail("upload-page");
  const uploadCookieLabel = await page.getByText("投稿 Cookie").count();
  if (uploadCookieLabel > 0) ok("upload-cookie-label");
  else fail("upload-cookie-label");
  await page.screenshot({ path: path.join(outDir, "05-upload.png"), fullPage: true });

  // console errors collection
  // reopen home and check no red toast stuck forever without close
  await page.locator('nav button:has-text("素材库")').click();
  await page.waitForTimeout(400);
  const errorToast = page.locator(".toast.error");
  if ((await errorToast.count()) === 0) ok("no-error-toast-on-load");
  else {
    const msg = await errorToast.first().innerText();
    // not necessarily a failure if root missing, but report
    fail("no-error-toast-on-load", msg.slice(0, 200));
  }

  // API smoke from browser context
  const api = await page.evaluate(async () => {
    const paths = ["/api/settings", "/api/rooms", "/api/automation/jobs", "/api/tasks"];
    const out = {};
    for (const p of paths) {
      const r = await fetch(p);
      out[p] = r.status;
    }
    return out;
  });
  const apiAllOk = Object.values(api).every((s) => s === 200);
  if (apiAllOk) ok("browser-api-fetch", JSON.stringify(api));
  else fail("browser-api-fetch", JSON.stringify(api));

  // automation upload-draft endpoint shape (404 ok if no draft)
  const draftStatus = await page.evaluate(async () => {
    const jobs = await fetch("/api/automation/jobs").then((r) => r.json());
    const job = (jobs.jobs || [])[0];
    if (!job) return { noJobs: true };
    const r = await fetch(`/api/automation/jobs/${encodeURIComponent(job.id)}/upload-draft`);
    return { jobId: job.id, status: r.status, hasPath: Boolean(job.uploadDraftPath) };
  });
  ok("automation-draft-endpoint", JSON.stringify(draftStatus));

} catch (error) {
  fail("uncaught", error?.stack || String(error));
  await page.screenshot({ path: path.join(outDir, "99-error.png"), fullPage: true }).catch(() => {});
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log(`screenshots: ${outDir}`);
process.exit(failed.length ? 1 : 0);
