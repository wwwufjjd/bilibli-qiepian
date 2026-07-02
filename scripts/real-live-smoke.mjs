import express from "express";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const roomId = String(process.env.REAL_BILI_ROOM_ID || "").trim();
if (!roomId) {
  console.error("Set REAL_BILI_ROOM_ID to run the real live recording smoke test.");
  process.exit(2);
}

const roomInput = String(process.env.REAL_BILI_ROOM_INPUT || `https://live.bilibili.com/${roomId}`).trim();
const sampleSeconds = Math.max(15, Math.min(180, Number(process.env.REAL_BILI_SAMPLE_SECONDS || 30)));
const requireDanmaku = ["1", "true", "yes"].includes(String(process.env.REAL_BILI_REQUIRE_DANMAKU || "").toLowerCase());
const workbenchRoot = path.resolve(process.env.BILIVE_WORKBENCH_ROOT || path.join(process.cwd(), ".workbench", "real-live-smoke"));
const recordingsRoot = path.resolve(process.env.REAL_BILI_RECORDINGS_ROOT || path.join(workbenchRoot, "recordings"));

process.env.BILIVE_WORKBENCH_ROOT = workbenchRoot;
await fsp.mkdir(workbenchRoot, { recursive: true });
await fsp.mkdir(recordingsRoot, { recursive: true });
await fsp.writeFile(
  path.join(workbenchRoot, "service-settings.json"),
  JSON.stringify(
    {
      recordingsRoot,
      recording: {
        backend: "internal",
        outputDir: recordingsRoot,
        autoMonitorEnabled: false,
        enableDanmaku: true,
        saveRawDanmaku: true,
        streamFormat: "flv",
        streamCodec: "avc",
        qualityNumber: 10000,
        maxConcurrentRecordings: 1,
        pollIntervalSeconds: 5,
        reconnectSeconds: 2,
        remuxToMp4: false,
        segmentSeconds: 0,
        requestTimeoutSeconds: 20
      },
      automation: { enabled: false },
      asr: { mode: "extract-audio" }
    },
    null,
    2
  ),
  "utf8"
);

const { createApiRouter } = await import("../server/routes.mjs");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use("/api", createApiRouter());

const server = await new Promise((resolve) => {
  const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
});

const baseUrl = `http://127.0.0.1:${server.address().port}`;
let started = false;

async function requestJson(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (!response.ok) {
    throw new Error(typeof payload === "string" ? payload : payload?.message || payload?.error || response.statusText);
  }
  return payload;
}

async function pollRoom(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await requestJson(`/api/recording/rooms/${encodeURIComponent(roomId)}`);
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${label} timed out. Latest status: ${JSON.stringify(latest)}`);
}

async function countLines(file) {
  try {
    const text = await fsp.readFile(file, "utf8");
    return text.split(/\r?\n/).filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function findRawDanmakuPath(recordingPath) {
  const parsed = path.parse(recordingPath);
  const candidates = [
    path.join(parsed.dir, `${parsed.name}.raw.jsonl`),
    path.join(parsed.dir, `${parsed.name}.raw-danmaku.jsonl`)
  ];
  for (const candidate of candidates) {
    try {
      await fsp.access(candidate, fs.constants.R_OK);
      return candidate;
    } catch {
      // try the next historical filename
    }
  }
  return null;
}

try {
  await requestJson(`/api/recording/rooms/${encodeURIComponent(roomId)}`, { method: "DELETE" }).catch(() => null);
  await requestJson("/api/recording/rooms", {
    method: "POST",
    body: JSON.stringify({ roomId: roomInput })
  });

  const startStatus = await requestJson(`/api/recording/rooms/${encodeURIComponent(roomId)}/start`, {
    method: "POST",
    body: "{}"
  });
  if (startStatus.taskStatus === "error") throw new Error(startStatus.message || "recording start failed");
  started = true;

  const running = await pollRoom(
    (status) => Number(status.bytesWritten || status.videoSize || 0) > 128 * 1024
      && Number(status.speedBytesPerSecond || status.averageSpeedBytesPerSecond || 0) > 0,
    75_000,
    "recording metrics"
  );

  await new Promise((resolve) => setTimeout(resolve, sampleSeconds * 1000));

  const stopStatus = await requestJson(`/api/recording/rooms/${encodeURIComponent(roomId)}/stop`, {
    method: "POST",
    body: "{}"
  });
  const completed = stopStatus.recordingPath
    ? stopStatus
    : await pollRoom((status) => status.recordingPath && status.danmakuPath, 45_000, "recording completion");

  const videoStat = await fsp.stat(completed.recordingPath);
  const xmlStat = await fsp.stat(completed.danmakuPath);
  const xml = await fsp.readFile(completed.danmakuPath, "utf8");
  const danmakuCount = (xml.match(/<d\s/g) || []).length;
  const rawDanmakuPath = await findRawDanmakuPath(completed.recordingPath);
  const rawDanmakuStat = rawDanmakuPath ? await fsp.stat(rawDanmakuPath).catch(() => null) : null;
  const rawDanmakuLines = rawDanmakuPath ? await countLines(rawDanmakuPath) : 0;
  if (videoStat.size <= 128 * 1024) throw new Error(`recorded video is too small: ${videoStat.size}`);
  if (!xml.includes("<i>") || !xml.includes("</i>")) throw new Error("danmaku XML is incomplete");
  if (requireDanmaku && danmakuCount <= 0) throw new Error("no real danmaku <d> entries were captured during the sample");

  const eventPayload = await requestJson("/api/recording/events?limit=12").catch(() => ({ events: [] }));
  console.log(JSON.stringify({
    ok: true,
    roomId,
    workbenchRoot,
    recordingsRoot,
    sampleSeconds,
    runningBytes: Number(running.bytesWritten || running.videoSize || 0),
    runningSpeed: Number(running.speedBytesPerSecond || running.averageSpeedBytesPerSecond || 0),
    recordingPath: completed.recordingPath,
    danmakuPath: completed.danmakuPath,
    rawDanmakuPath,
    videoBytes: videoStat.size,
    danmakuBytes: xmlStat.size,
    danmakuCount,
    rawDanmakuBytes: rawDanmakuStat?.size || 0,
    rawDanmakuLines,
    events: (eventPayload.events || []).map((event) => event.type)
  }, null, 2));
} finally {
  if (started) {
    await requestJson(`/api/recording/rooms/${encodeURIComponent(roomId)}/stop`, { method: "POST", body: "{}" }).catch(() => null);
  }
  await new Promise((resolve) => server.close(resolve));
}
