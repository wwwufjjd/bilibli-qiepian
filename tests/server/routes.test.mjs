import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import express from "express";
import { WebSocketServer } from "ws";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "bilive-workbench-"));
process.chdir(tempRoot);

const routesModule = await import(pathToFileURL(path.join(repoRoot, "server/routes.mjs")).href);
const { createApiRouter, evaluateUploadPolicy, normalizeAsrCuesForTimeline, startRecordingAutoMonitor, stopRecordingAutoMonitor, __testing } = routesModule;

function closeTestServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  });
}

function createDanmakuPacket(operation, payload) {
  const body = Buffer.from(payload || "", "utf8");
  const packet = Buffer.alloc(16 + body.length);
  packet.writeUInt32BE(packet.length, 0);
  packet.writeUInt16BE(16, 4);
  packet.writeUInt16BE(1, 6);
  packet.writeUInt32BE(operation, 8);
  packet.writeUInt32BE(1, 12);
  body.copy(packet, 16);
  return packet;
}

test("recording config exposes internal recorder as the primary recording capability", async (t) => {
  const recordingsRoot = path.join(tempRoot, "primary-recorder-config");
  await mkdir(path.join(tempRoot, ".workbench"), { recursive: true });
  await writeFile(
    path.join(tempRoot, ".workbench", "service-settings.json"),
    JSON.stringify({ recordingsRoot, recording: { backend: "internal", outputDir: recordingsRoot } }),
    "utf8"
  );

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createApiRouter());
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(server));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const settings = await fetch(`${baseUrl}/api/settings`).then((response) => response.json());
  assert.equal(settings.recording.recorder.backend, "internal");
  assert.equal(settings.recording.recorder.available, true);
  assert.equal(settings.recording.internal.backend, "internal");

  const config = await fetch(`${baseUrl}/api/recording/config`).then((response) => response.json());
  assert.equal(config.recorder.backend, "internal");
  assert.equal(config.recorder.available, true);
  assert.equal(config.internal.backend, "internal");
});

test("internal recorder paths keep one room folder when the live title changes", async () => {
  const recordingsRoot = path.join(tempRoot, "stable-room-folder-output");
  const recorder = {
    roomId: "309997",
    realRoomId: "1309997",
    roomName: "Fallback Room",
    recordingSettings: {
      outputDir: recordingsRoot,
      streamFormat: "flv",
      streamCodec: "avc",
      roomFolderTemplate: "{anchorName}_{roomId}",
      filenameTemplate: "{start}_{title}_{roomId}_{backend}"
    }
  };

  const first = await __testing.createInternalRecordingPaths(recorder, {
    title: "First Live Title",
    anchorName: "Stable Anchor",
    anchorUid: "42"
  });
  const second = await __testing.createInternalRecordingPaths(recorder, {
    title: "Second Live Title",
    anchorName: "Stable Anchor",
    anchorUid: "42"
  });

  assert.equal(first.roomDir, second.roomDir);
  assert.equal(path.basename(first.roomDir), "Stable Anchor_309997");
  assert.match(path.basename(first.videoPath), /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_First Live Title_309997_internal\.flv$/);
  assert.match(path.basename(second.videoPath), /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_Second Live Title_309997_internal\.flv$/);

  const metadata = JSON.parse(await readFile(path.join(first.roomDir, ".room.json"), "utf8"));
  assert.equal(metadata.roomId, "309997");
  assert.equal(metadata.anchorName, "Stable Anchor");
  assert.equal(metadata.title, "Second Live Title");
});

test("recording rooms accept full Bilibili live URLs", async (t) => {
  const previousBase = process.env.BILI_LIVE_API_BASE;
  const fakeBili = express();
  fakeBili.get("/room/v1/Room/room_init", (req, res) => {
    assert.equal(req.query.id, "1918794441");
    res.json({ code: 0, data: { room_id: 1918794441, short_id: 22889, uid: 42, live_status: 1 } });
  });
  fakeBili.get("/room/v1/Room/get_info", (req, res) => {
    assert.equal(req.query.room_id, "1918794441");
    res.json({
      code: 0,
      data: {
        title: "瀵煎叆鏍囬娴嬭瘯鎴块棿",
        user_cover: "https://example.test/cover.jpg",
        keyframe: "https://example.test/keyframe.jpg",
        parent_area_name: "缃戞父",
        area_name: "鑻遍泟鑱旂洘",
        live_status: 1,
        live_time: "2026-06-14 20:00:00"
      }
    });
  });
  fakeBili.get("/live_user/v1/UserInfo/get_anchor_in_room", (req, res) => {
    assert.equal(req.query.roomid, "1918794441");
    res.json({ code: 0, data: { info: { uid: 42, uname: "瀵煎叆涓绘挱", face: "https://example.test/face.jpg" } } });
  });
  const fakeServer = await new Promise((resolve) => {
    const instance = fakeBili.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(fakeServer));
  process.env.BILI_LIVE_API_BASE = `http://127.0.0.1:${fakeServer.address().port}`;
  t.after(() => {
    if (previousBase === undefined) {
      delete process.env.BILI_LIVE_API_BASE;
    } else {
      process.env.BILI_LIVE_API_BASE = previousBase;
    }
  });

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createApiRouter());
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(server));

  const liveUrl = "https://live.bilibili.com/1918794441?spm_id_from=333.337.search-card.all.click";
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/recording/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomId: liveUrl })
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.room.roomId, "1918794441");
  assert.equal(body.room.inputRoomId, liveUrl);
  assert.equal(body.room.name, "瀵煎叆鏍囬娴嬭瘯鎴块棿");
  assert.equal(body.room.title, "瀵煎叆鏍囬娴嬭瘯鎴块棿");
  assert.equal(body.room.shortId, "22889");
  assert.equal(body.room.anchorName, "瀵煎叆涓绘挱");
  assert.equal(body.room.anchorUid, "42");
  assert.equal(body.room.coverUrl, "https://example.test/cover.jpg");
  assert.equal(body.room.keyframeUrl, "https://example.test/keyframe.jpg");
  assert.equal(body.room.avatarUrl, "https://example.test/face.jpg");
  assert.equal(body.room.parentAreaName, "缃戞父");
  assert.equal(body.room.areaName, "鑻遍泟鑱旂洘");
  assert.equal(body.room.biliLiveStatus, "live");
  assert.equal(body.rooms.some((room) => room.roomId === "1918794441"), true);
});

test("disabled recording rooms can still be started manually", async (t) => {
  const previousBase = process.env.BILI_LIVE_API_BASE;
  const roomId = "779900";
  const fakeBili = express();
  fakeBili.get("/room/v1/Room/room_init", (req, res) => {
    assert.equal(req.query.id, roomId);
    res.json({ code: 0, data: { room_id: Number(roomId), live_status: 0, uid: 42 } });
  });
  fakeBili.get("/room/v1/Room/get_info", (_req, res) => {
    res.json({ code: 0, data: { title: "Disabled Room", live_status: 0 } });
  });
  fakeBili.get("/live_user/v1/UserInfo/get_anchor_in_room", (_req, res) => {
    res.json({ code: 0, data: { info: { uname: "Disabled Anchor", uid: 42 } } });
  });
  const fakeServer = await new Promise((resolve) => {
    const instance = fakeBili.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(fakeServer));
  process.env.BILI_LIVE_API_BASE = `http://127.0.0.1:${fakeServer.address().port}`;
  t.after(() => {
    if (previousBase === undefined) {
      delete process.env.BILI_LIVE_API_BASE;
    } else {
      process.env.BILI_LIVE_API_BASE = previousBase;
    }
  });

  const recordingsRoot = path.join(tempRoot, `manual-disabled-${Date.now()}`);
  await mkdir(path.join(tempRoot, ".workbench"), { recursive: true });
  await writeFile(
    path.join(tempRoot, ".workbench", "service-settings.json"),
    JSON.stringify({
      recordingsRoot,
      recording: {
        backend: "internal",
        outputDir: recordingsRoot,
        pollIntervalSeconds: 600,
        reconnectSeconds: 1
      },
      automation: { enabled: false }
    }),
    "utf8"
  );

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createApiRouter());
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(server));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const add = await fetch(`${baseUrl}/api/recording/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomId, name: "Disabled Room", enabled: false })
  });
  assert.equal(add.status, 200);
  const added = await add.json();
  assert.equal(added.room.enabled, false);

  const start = await fetch(`${baseUrl}/api/recording/rooms/${roomId}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({})
  });
  const body = await start.json();
  assert.equal(start.status, 200, JSON.stringify(body));
  assert.equal(body.taskStatus, "waiting");
  assert.equal(body.liveStatus, "offline");
  assert.ok(!String(body.error || "").includes("自动录制已关闭"));

  const stop = await fetch(`${baseUrl}/api/recording/rooms/${roomId}/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({})
  });
  assert.equal(stop.status, 200, await stop.text());
});

test("recording room delete removes config but refuses active rooms", async (t) => {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createApiRouter());
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(server));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const roomId = "779901";
  const add = await fetch(`${baseUrl}/api/recording/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomId, name: "Delete Room" })
  });
  assert.equal(add.status, 200);

  const deleteIdle = await fetch(`${baseUrl}/api/recording/rooms/${roomId}`, { method: "DELETE" });
  const deleteIdleBody = await deleteIdle.json();
  assert.equal(deleteIdle.status, 200);
  assert.equal(deleteIdleBody.rooms.some((room) => room.roomId === roomId), false);

  await fetch(`${baseUrl}/api/recording/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomId, name: "Delete Room" })
  });
  const recordingPath = path.join(tempRoot, `delete-active-${Date.now()}.flv`);
  await writeFile(recordingPath, "active recording", "utf8");
  const recordingEvent = await fetch(`${baseUrl}/api/recording/events/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "delete-recording-room",
      type: "RecordingStartedEvent",
      date: "2026-06-14T12:00:00+08:00",
      data: { room_id: roomId, path: recordingPath }
    })
  });
  assert.equal(recordingEvent.status, 200);

  const deleteActive = await fetch(`${baseUrl}/api/recording/rooms/${roomId}`, { method: "DELETE" });
  const deleteActiveBody = await deleteActive.json();
  assert.equal(deleteActive.status, 409);
  assert.ok(String(deleteActiveBody.error || "").includes("不能移除"));
});

test("material room delete hides scanned room without removing files", async (t) => {
  const recordingsRoot = path.join(tempRoot, `material-hide-${Date.now()}`);
  const roomDir = path.join(recordingsRoot, "667788 - Local Room");
  const videoPath = path.join(roomDir, "clip.flv");
  const danmakuPath = path.join(roomDir, "clip.xml");
  await mkdir(path.join(tempRoot, ".workbench"), { recursive: true });
  await mkdir(roomDir, { recursive: true });
  await writeFile(videoPath, "fake-video", "utf8");
  await writeFile(danmakuPath, "<i></i>", "utf8");
  await writeFile(
    path.join(tempRoot, ".workbench", "service-settings.json"),
    JSON.stringify({
      recordingsRoot,
      recording: { backend: "internal", outputDir: recordingsRoot },
      automation: { enabled: false }
    }),
    "utf8"
  );

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createApiRouter());
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(server));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const before = await fetch(`${baseUrl}/api/rooms`);
  const beforeBody = await before.json();
  const room = beforeBody.rooms.find((item) => item.roomId === "667788");
  assert.ok(room, "fixture room should be visible before hiding");

  const deleted = await fetch(`${baseUrl}/api/rooms/${encodeURIComponent(room.key)}`, { method: "DELETE" });
  const deletedBody = await deleted.json();
  assert.equal(deleted.status, 200, JSON.stringify(deletedBody));
  assert.equal(deletedBody.rooms.some((item) => item.roomId === "667788"), false);

  const after = await fetch(`${baseUrl}/api/rooms`);
  const afterBody = await after.json();
  assert.equal(afterBody.rooms.some((item) => item.roomId === "667788"), false);
  assert.equal(await readFile(videoPath, "utf8"), "fake-video");
  assert.equal(await readFile(danmakuPath, "utf8"), "<i></i>");
});

test("preview status rejects incomplete mp4 cache files", async (t) => {
  const recordingsRoot = path.join(tempRoot, `preview-cache-${Date.now()}`);
  const roomDir = path.join(recordingsRoot, "991122 - Preview Room");
  const videoPath = path.join(roomDir, "clip.flv");
  await mkdir(path.join(tempRoot, ".workbench"), { recursive: true });
  await mkdir(roomDir, { recursive: true });
  await writeFile(videoPath, "fake-video", "utf8");
  await writeFile(
    path.join(tempRoot, ".workbench", "service-settings.json"),
    JSON.stringify({
      recordingsRoot,
      recording: { backend: "internal", outputDir: recordingsRoot },
      automation: { enabled: false }
    }),
    "utf8"
  );

  const videoStat = await stat(videoPath);
  const previewId = createHash("sha1")
    .update(`${path.resolve(videoPath)}:${videoStat.mtimeMs}:${videoStat.size}:preview-v1`)
    .digest("hex");
  const previewDir = path.join(tempRoot, ".workbench", "previews", previewId);
  const previewPath = path.join(previewDir, "clip_preview.mp4");
  await mkdir(previewDir, { recursive: true });
  await writeFile(previewPath, "not a complete mp4", "utf8");

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createApiRouter());
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(server));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const rooms = await fetch(`${baseUrl}/api/rooms`).then((response) => response.json());
  const room = rooms.rooms.find((item) => item.roomId === "991122");
  assert.ok(room?.latestVideo?.key, "fixture video should be discoverable");

  const response = await fetch(`${baseUrl}/api/preview/status?key=${encodeURIComponent(room.latestVideo.key)}`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.status, "error");
  assert.ok(String(body.message || "").length > 0);
  assert.equal(body.mediaUrl, null);
});

test("preview generation starts with fast stream-copy remux", async (t) => {
  const { logPath } = await withFakeFfmpeg(t);
  const recordingsRoot = path.join(tempRoot, `preview-fast-remux-${Date.now()}`);
  const roomDir = path.join(recordingsRoot, "991123 - Fast Preview Room");
  const videoPath = path.join(roomDir, "clip.flv");
  await mkdir(roomDir, { recursive: true });
  await writeFile(videoPath, "fake flv", "utf8");
  await mkdir(path.join(tempRoot, ".workbench"), { recursive: true });
  await writeFile(
    path.join(tempRoot, ".workbench", "service-settings.json"),
    JSON.stringify({
      recordingsRoot,
      recording: { backend: "internal", outputDir: recordingsRoot }
    }),
    "utf8"
  );

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createApiRouter());
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(server));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const rooms = await fetch(`${baseUrl}/api/rooms`).then((response) => response.json());
  const room = rooms.rooms.find((item) => item.roomId === "991123");
  assert.ok(room?.latestVideo?.key, "fixture FLV should be discoverable");

  const start = await fetch(`${baseUrl}/api/preview/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoKey: room.latestVideo.key })
  });
  assert.equal(start.status, 200);

  await new Promise((resolve) => setTimeout(resolve, 300));
  const ffmpegCalls = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(ffmpegCalls.some((args) => args.includes("-c") && args[args.indexOf("-c") + 1] === "copy"), "preview should first try stream-copy remux");
});

test("waiting recording rooms remain running in task center", async (t) => {
  await mkdir(path.join(tempRoot, ".workbench"), { recursive: true });
  await writeFile(
    path.join(tempRoot, ".workbench", "fixed-rooms.json"),
    JSON.stringify({ rooms: [{ roomId: "778899", name: "瀵煎叆鏍囬娴嬭瘯鎴块棿", title: "瀵煎叆鏍囬娴嬭瘯鎴块棿" }] }),
    "utf8"
  );

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createApiRouter());
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(server));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const post = await fetch(`${baseUrl}/api/recording/events/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "waiting-room-event",
      type: "LiveBeganEvent",
      date: "2026-06-14T12:00:00+08:00",
      data: { room_id: 778899 }
    })
  });
  assert.equal(post.status, 200);

  const response = await fetch(`${baseUrl}/api/tasks`);
  const body = await response.json();
  const task = body.tasks.find((item) => item.id === "recording-room-778899");
  assert.equal(task?.status, "running");
  assert.equal(task?.progress, 3);
  assert.match(task?.label || "", /778899/);
});

test("recording monitor sweep starts live rooms and keeps offline rooms waiting", async (t) => {
  const liveRoomId = "556601";
  const offlineRoomId = "556602";
  const previousBase = process.env.BILI_LIVE_API_BASE;
  const fakeBili = express();
  let fakeBaseUrl = "";
  fakeBili.get("/room/v1/Room/room_init", (req, res) => {
    const id = String(req.query.id || "");
    res.json({ code: 0, data: { room_id: Number(id), live_status: id === liveRoomId ? 1 : 0 } });
  });
  fakeBili.get("/room/v1/Room/get_info", (req, res) => {
    const id = String(req.query.room_id || "");
    res.json({ code: 0, data: { title: id === liveRoomId ? "Auto Live Room" : "Auto Offline Room", live_status: id === liveRoomId ? 1 : 0 } });
  });
  fakeBili.get("/live_user/v1/UserInfo/get_anchor_in_room", (_req, res) => {
    res.json({ code: 0, data: { info: { uid: 1, uname: "Auto Anchor" } } });
  });
  fakeBili.get("/xlive/web-room/v2/index/getRoomPlayInfo", (_req, res) => {
    res.json({
      code: 0,
      data: {
        playurl_info: {
          playurl: {
            stream: [
              {
                format: [
                  {
                    format_name: "flv",
                    codec: [
                      {
                        codec_name: "avc",
                        current_qn: 10000,
                        base_url: "/auto-live.flv",
                        url_info: [{ host: fakeBaseUrl, extra: "" }]
                      }
                    ]
                  }
                ]
              }
            ]
          }
        }
      }
    });
  });
  fakeBili.get("/auto-live.flv", (_req, res) => {
    res.type("application/octet-stream");
    res.write(Buffer.from("FLV"));
    setTimeout(() => res.end(Buffer.from("auto-monitor-stream")), 30);
  });
  const fakeServer = await new Promise((resolve) => {
    const instance = fakeBili.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(fakeServer));
  fakeBaseUrl = `http://127.0.0.1:${fakeServer.address().port}`;
  process.env.BILI_LIVE_API_BASE = fakeBaseUrl;
  t.after(() => {
    if (previousBase === undefined) {
      delete process.env.BILI_LIVE_API_BASE;
    } else {
      process.env.BILI_LIVE_API_BASE = previousBase;
    }
  });

  const recordingsRoot = path.join(tempRoot, `monitor-sweep-${Date.now()}`);
  await mkdir(path.join(tempRoot, ".workbench"), { recursive: true });
  await writeFile(
    path.join(tempRoot, ".workbench", "service-settings.json"),
    JSON.stringify({
      recordingsRoot,
      recording: {
        backend: "internal",
        outputDir: recordingsRoot,
        autoMonitorEnabled: true,
        enableDanmaku: false,
        pollIntervalSeconds: 1,
        reconnectSeconds: 1,
        maxConcurrentRecordings: 1
      },
      automation: { enabled: false }
    }),
    "utf8"
  );
  await writeFile(
    path.join(tempRoot, ".workbench", "fixed-rooms.json"),
    JSON.stringify({
      rooms: [
        { roomId: liveRoomId, name: "Auto Live Room", enabled: true },
        {
          roomId: offlineRoomId,
          name: "Auto Offline Room",
          enabled: true,
          biliLiveStatus: "live",
          metadataUpdatedAt: new Date().toISOString()
        }
      ]
    }),
    "utf8"
  );

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createApiRouter());
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(server));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const sweep = await fetch(`${baseUrl}/api/recording/monitor/sweep`, { method: "POST" });
  const sweepBody = await sweep.json();
  assert.equal(sweep.status, 200, JSON.stringify(sweepBody));
  assert.equal(sweepBody.checked, 2);
  assert.equal(sweepBody.started, 1);
  assert.equal(sweepBody.waiting, 1);

  const liveStatus = await fetch(`${baseUrl}/api/recording/rooms/${liveRoomId}`).then((response) => response.json());
  assert.ok(["starting", "recording", "waiting"].includes(liveStatus.taskStatus), JSON.stringify(liveStatus));
  const offlineStatus = await fetch(`${baseUrl}/api/recording/rooms/${offlineRoomId}`).then((response) => response.json());
  assert.equal(offlineStatus.biliLiveStatus, "offline");
  assert.equal(offlineStatus.taskStatus, "waiting");
  assert.equal(offlineStatus.liveStatus, "offline");
  assert.ok(String(offlineStatus.message || "").length > 0);
  assert.ok(offlineStatus.monitorCheckedAt);
  assert.ok(offlineStatus.nextMonitorAt);

  const monitorStatus = await fetch(`${baseUrl}/api/recording/monitor/status`).then((response) => response.json());
  assert.equal(monitorStatus.enabled, true);
  assert.equal(monitorStatus.running, false);
  assert.equal(monitorStatus.lastResult.checked, 2);
  assert.equal(monitorStatus.lastResult.started, 1);
  assert.equal(monitorStatus.lastResult.waiting, 1);

  await fetch(`${baseUrl}/api/recording/rooms/${liveRoomId}/stop`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
});

test("auto monitor starts recording from danmaku LIVE event without manual sweep", async (t) => {
  const previousBase = process.env.BILI_LIVE_API_BASE;
  const roomId = "700001";
  let fakeBaseUrl = "";
  let live = false;
  let streamHits = 0;
  const fakeBili = express();
  fakeBili.get("/room/v1/Room/room_init", (req, res) => {
    assert.equal(req.query.id, roomId);
    res.json({ code: 0, data: { room_id: Number(roomId), live_status: live ? 1 : 0 } });
  });
  fakeBili.get("/room/v1/Room/get_info", (_req, res) => {
    res.json({ code: 0, data: { title: "Event Monitor Room", live_status: live ? 1 : 0 } });
  });
  fakeBili.get("/live_user/v1/UserInfo/get_anchor_in_room", (_req, res) => {
    res.json({ code: 0, data: { info: { uid: 700001, uname: "Event Anchor" } } });
  });
  fakeBili.get("/xlive/web-room/v2/index/getRoomPlayInfo", (_req, res) => {
    assert.equal(live, true);
    res.json({
      code: 0,
      data: {
        playurl_info: {
          playurl: {
            stream: [
              {
                format: [
                  {
                    format_name: "flv",
                    codec: [
                      {
                        codec_name: "avc",
                        current_qn: 10000,
                        base_url: "/event-live.flv",
                        url_info: [{ host: fakeBaseUrl, extra: "" }]
                      }
                    ]
                  }
                ]
              }
            ]
          }
        }
      }
    });
  });
  fakeBili.get("/event-live.flv", (_req, res) => {
    streamHits += 1;
    res.type("application/octet-stream");
    res.write(Buffer.from("FLV"));
    setTimeout(() => res.end(Buffer.from("event-monitor-stream")), 20);
  });
  const fakeServer = await new Promise((resolve) => {
    const instance = fakeBili.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(fakeServer));
  fakeBaseUrl = `http://127.0.0.1:${fakeServer.address().port}`;
  process.env.BILI_LIVE_API_BASE = fakeBaseUrl;
  t.after(() => {
    if (previousBase === undefined) {
      delete process.env.BILI_LIVE_API_BASE;
    } else {
      process.env.BILI_LIVE_API_BASE = previousBase;
    }
  });

  const danmakuServer = await new Promise((resolve) => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/sub" }, () => resolve(server));
  });
  t.after(() => new Promise((resolve) => danmakuServer.close(() => resolve())));
  danmakuServer.on("connection", (socket) => {
    socket.once("message", () => {
      live = true;
      setTimeout(() => socket.send(createDanmakuPacket(5, JSON.stringify({ cmd: "LIVE" }))), 20);
    });
  });
  const danmakuPort = danmakuServer.address().port;
  fakeBili.get("/xlive/web-room/v1/index/getDanmuInfo", (_req, res) => {
    res.json({
      code: 0,
      data: {
        token: "",
        host_list: [{ scheme: "ws", host: "127.0.0.1", ws_port: danmakuPort, port: danmakuPort }]
      }
    });
  });

  const recordingsRoot = path.join(tempRoot, "event-monitor-output");
  await mkdir(path.join(tempRoot, ".workbench"), { recursive: true });
  await writeFile(
    path.join(tempRoot, ".workbench", "service-settings.json"),
    JSON.stringify({
      recordingsRoot,
      recording: {
        backend: "internal",
        outputDir: recordingsRoot,
        enableDanmaku: false,
        autoMonitorEnabled: true,
        pollIntervalSeconds: 300,
        reconnectSeconds: 1
      },
      automation: { enabled: false }
    }),
    "utf8"
  );
  await writeFile(
    path.join(tempRoot, ".workbench", "fixed-rooms.json"),
    JSON.stringify({ rooms: [{ roomId, name: "Event Monitor Room", enabled: true, biliLiveStatus: "offline" }] }),
    "utf8"
  );

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createApiRouter());
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(server));
  t.after(() => stopRecordingAutoMonitor());

  startRecordingAutoMonitor({ initialDelayMs: 120000 });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let completed = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const eventsResponse = await fetch(`${baseUrl}/api/recording/events?roomId=${roomId}`);
    const eventsBody = await eventsResponse.json();
    completed = eventsBody.events.find((event) => event.type === "VideoFileCompletedEvent");
    if (completed) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(completed, "danmaku LIVE event should start recording without a manual sweep");
  assert.equal(streamHits >= 1, true);
  const video = await readFile(completed.path);
  assert.ok(video.includes(Buffer.from("event-monitor-stream")));

  await fetch(`${baseUrl}/api/recording/rooms/${roomId}/stop`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
});

test("live metadata overrides stale stream errors and auto monitor restarts recording", async (t) => {
  const roomId = "556606";
  const previousBase = process.env.BILI_LIVE_API_BASE;
  const fakeBili = express();
  let fakeBaseUrl = "";
  fakeBili.get("/room/v1/Room/room_init", (req, res) => {
    assert.equal(String(req.query.id || ""), roomId);
    res.json({ code: 0, data: { room_id: Number(roomId), live_status: 1 } });
  });
  fakeBili.get("/room/v1/Room/get_info", (_req, res) => {
    res.json({ code: 0, data: { title: "Stale Error Live Room", live_status: 1 } });
  });
  fakeBili.get("/live_user/v1/UserInfo/get_anchor_in_room", (_req, res) => {
    res.json({ code: 0, data: { info: { uid: 1, uname: "Stale Anchor" } } });
  });
  fakeBili.get("/xlive/web-room/v2/index/getRoomPlayInfo", (_req, res) => {
    res.json({
      code: 0,
      data: {
        playurl_info: {
          playurl: {
            stream: [
              {
                format: [
                  {
                    format_name: "flv",
                    codec: [
                      {
                        codec_name: "avc",
                        current_qn: 10000,
                        base_url: "/stale-recovered.flv",
                        url_info: [{ host: fakeBaseUrl, extra: "" }]
                      }
                    ]
                  }
                ]
              }
            ]
          }
        }
      }
    });
  });
  fakeBili.get("/stale-recovered.flv", (_req, res) => {
    res.type("application/octet-stream");
    res.write(Buffer.from("FLV"));
    setTimeout(() => res.end(Buffer.from("recovered-stream")), 30);
  });
  const fakeServer = await new Promise((resolve) => {
    const instance = fakeBili.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(fakeServer));
  fakeBaseUrl = `http://127.0.0.1:${fakeServer.address().port}`;
  process.env.BILI_LIVE_API_BASE = fakeBaseUrl;
  t.after(() => {
    if (previousBase === undefined) {
      delete process.env.BILI_LIVE_API_BASE;
    } else {
      process.env.BILI_LIVE_API_BASE = previousBase;
    }
    __testing.clearRoomRuntimeStatus(roomId);
  });

  const recordingsRoot = path.join(tempRoot, `monitor-stale-error-${Date.now()}`);
  await mkdir(path.join(tempRoot, ".workbench"), { recursive: true });
  await writeFile(
    path.join(tempRoot, ".workbench", "service-settings.json"),
    JSON.stringify({
      recordingsRoot,
      recording: {
        backend: "internal",
        outputDir: recordingsRoot,
        autoMonitorEnabled: true,
        enableDanmaku: false,
        pollIntervalSeconds: 1,
        reconnectSeconds: 1,
        maxConcurrentRecordings: 3
      },
      automation: { enabled: false }
    }),
    "utf8"
  );
  await writeFile(
    path.join(tempRoot, ".workbench", "fixed-rooms.json"),
    JSON.stringify({
      rooms: [
        {
          roomId,
          name: "Stale Error Live Room",
          enabled: true,
          biliLiveStatus: "live",
          metadataUpdatedAt: new Date().toISOString()
        }
      ]
    }),
    "utf8"
  );
  __testing.setRoomRuntimeStatus(roomId, {
    taskStatus: "error",
    liveStatus: "unknown",
    message: "Bili stream request failed: 404 Not Found",
    nextAction: "retry",
    log: "recording interrupted: Bili stream request failed: 404 Not Found\n"
  });

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createApiRouter());
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(server));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const beforeSweep = await fetch(`${baseUrl}/api/recording/rooms/${roomId}`).then((response) => response.json());
  assert.equal(beforeSweep.biliLiveStatus, "live");
  assert.equal(beforeSweep.taskStatus, "waiting");
  assert.equal(beforeSweep.liveStatus, "live");
  assert.ok(String(beforeSweep.message || "").length > 0);

  const sweep = await fetch(`${baseUrl}/api/recording/monitor/sweep`, { method: "POST" });
  const sweepBody = await sweep.json();
  assert.equal(sweep.status, 200, JSON.stringify(sweepBody));
  assert.equal(sweepBody.checked, 1);
  assert.equal(sweepBody.started, 1);

  const afterSweep = await fetch(`${baseUrl}/api/recording/rooms/${roomId}`).then((response) => response.json());
  assert.equal(afterSweep.biliLiveStatus, "live");
  assert.equal(afterSweep.liveStatus, "live");
  assert.notEqual(afterSweep.taskStatus, "error");

  await fetch(`${baseUrl}/api/recording/rooms/${roomId}/stop`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
});

test("enabled rooms expose monitoring wait state before first sweep", async (t) => {
  const roomId = "556603";
  const recordingsRoot = path.join(tempRoot, `monitor-public-${Date.now()}`);
  await mkdir(path.join(tempRoot, ".workbench"), { recursive: true });
  await writeFile(
    path.join(tempRoot, ".workbench", "service-settings.json"),
    JSON.stringify({
      recordingsRoot,
      recording: {
        backend: "internal",
        outputDir: recordingsRoot,
        autoMonitorEnabled: true,
        pollIntervalSeconds: 30
      },
      automation: { enabled: false }
    }),
    "utf8"
  );
  await writeFile(
    path.join(tempRoot, ".workbench", "fixed-rooms.json"),
    JSON.stringify({
      rooms: [
        {
          roomId,
          name: "Offline Monitor Room",
          title: "Offline Monitor Room",
          enabled: true,
          biliLiveStatus: "offline",
          metadataUpdatedAt: new Date().toISOString()
        }
      ]
    }),
    "utf8"
  );

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createApiRouter());
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(server));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const body = await fetch(`${baseUrl}/api/recording/rooms`).then((response) => response.json());
  const room = body.rooms.find((item) => item.roomId === roomId);
  assert.equal(room.taskStatus, "waiting");
  assert.equal(room.liveStatus, "offline");
  assert.ok(String(room.message || "").length > 0);
  assert.equal(room.nextAction, "stop");

  const monitorStatus = await fetch(`${baseUrl}/api/recording/monitor/status`).then((response) => response.json());
  assert.equal(monitorStatus.waitingRooms, 1);
});

test("stream 404 after a live ends returns to monitoring wait instead of error", async (t) => {
  const roomId = "556604";
  const previousBase = process.env.BILI_LIVE_API_BASE;
  let liveStatus = 1;
  let fakeBaseUrl = "";
  const fakeBili = express();
  fakeBili.get("/room/v1/Room/room_init", (req, res) => {
    assert.equal(String(req.query.id || ""), roomId);
    res.json({ code: 0, data: { room_id: Number(roomId), live_status: liveStatus } });
  });
  fakeBili.get("/room/v1/Room/get_info", (_req, res) => {
    res.json({ code: 0, data: { title: "Ends During Stream Room", live_status: liveStatus } });
  });
  fakeBili.get("/live_user/v1/UserInfo/get_anchor_in_room", (_req, res) => {
    res.json({ code: 0, data: { info: { uid: 1, uname: "Ending Anchor" } } });
  });
  fakeBili.get("/xlive/web-room/v2/index/getRoomPlayInfo", (_req, res) => {
    res.json({
      code: 0,
      data: {
        playurl_info: {
          playurl: {
            stream: [
              {
                format: [
                  {
                    format_name: "flv",
                    codec: [
                      {
                        codec_name: "avc",
                        current_qn: 10000,
                        base_url: "/ended.flv",
                        url_info: [{ host: fakeBaseUrl, extra: "" }]
                      }
                    ]
                  }
                ]
              }
            ]
          }
        }
      }
    });
  });
  fakeBili.get("/ended.flv", (_req, res) => {
    liveStatus = 0;
    res.status(404).send("ended");
  });
  const fakeServer = await new Promise((resolve) => {
    const instance = fakeBili.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(fakeServer));
  fakeBaseUrl = `http://127.0.0.1:${fakeServer.address().port}`;
  process.env.BILI_LIVE_API_BASE = fakeBaseUrl;
  t.after(() => {
    if (previousBase === undefined) {
      delete process.env.BILI_LIVE_API_BASE;
    } else {
      process.env.BILI_LIVE_API_BASE = previousBase;
    }
  });

  const recordingsRoot = path.join(tempRoot, `stream-ended-${Date.now()}`);
  await mkdir(path.join(tempRoot, ".workbench"), { recursive: true });
  await writeFile(
    path.join(tempRoot, ".workbench", "service-settings.json"),
    JSON.stringify({
      recordingsRoot,
      recording: {
        backend: "internal",
        outputDir: recordingsRoot,
        autoMonitorEnabled: true,
        enableDanmaku: false,
        pollIntervalSeconds: 1,
        reconnectSeconds: 1,
        remuxToMp4: false
      },
      automation: { enabled: false }
    }),
    "utf8"
  );
  await writeFile(
    path.join(tempRoot, ".workbench", "fixed-rooms.json"),
    JSON.stringify({ rooms: [{ roomId, name: "Ends During Stream Room", enabled: true }] }),
    "utf8"
  );

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createApiRouter());
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(server));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const start = await fetch(`${baseUrl}/api/recording/rooms/${roomId}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  assert.equal(start.status, 200, JSON.stringify(await start.json()));

  let room = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    room = await fetch(`${baseUrl}/api/recording/rooms/${roomId}`).then((response) => response.json());
    if (room.taskStatus === "waiting" && room.liveStatus === "offline") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(room.taskStatus, "waiting");
  assert.equal(room.liveStatus, "offline");
  assert.ok(String(room.message || "").length > 0);
  assert.notEqual(room.taskStatus, "error");

  await fetch(`${baseUrl}/api/recording/rooms/${roomId}/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
});

test("stream fetch failure after a live ends returns to monitoring wait instead of network error", async (t) => {
  const roomId = "556605";
  const previousBase = process.env.BILI_LIVE_API_BASE;
  let liveStatus = 1;
  let fakeBaseUrl = "";
  const fakeBili = express();
  fakeBili.get("/room/v1/Room/room_init", (req, res) => {
    assert.equal(String(req.query.id || ""), roomId);
    res.json({ code: 0, data: { room_id: Number(roomId), live_status: liveStatus } });
  });
  fakeBili.get("/room/v1/Room/get_info", (_req, res) => {
    res.json({ code: 0, data: { title: "Fetch Failed Ended Room", live_status: liveStatus } });
  });
  fakeBili.get("/live_user/v1/UserInfo/get_anchor_in_room", (_req, res) => {
    res.json({ code: 0, data: { info: { uid: 1, uname: "Fetch Failed Anchor" } } });
  });
  fakeBili.get("/xlive/web-room/v2/index/getRoomPlayInfo", (_req, res) => {
    res.json({
      code: 0,
      data: {
        playurl_info: {
          playurl: {
            stream: [
              {
                format: [
                  {
                    format_name: "flv",
                    codec: [
                      {
                        codec_name: "avc",
                        current_qn: 10000,
                        base_url: "/ended-fetch.flv",
                        url_info: [{ host: fakeBaseUrl, extra: "" }]
                      }
                    ]
                  }
                ]
              }
            ]
          }
        }
      }
    });
  });
  fakeBili.get("/ended-fetch.flv", (_req, res) => {
    liveStatus = 0;
    res.socket?.destroy();
  });
  const fakeServer = await new Promise((resolve) => {
    const instance = fakeBili.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(fakeServer));
  fakeBaseUrl = `http://127.0.0.1:${fakeServer.address().port}`;
  process.env.BILI_LIVE_API_BASE = fakeBaseUrl;
  t.after(() => {
    if (previousBase === undefined) {
      delete process.env.BILI_LIVE_API_BASE;
    } else {
      process.env.BILI_LIVE_API_BASE = previousBase;
    }
  });

  const recordingsRoot = path.join(tempRoot, `stream-fetch-ended-${Date.now()}`);
  await mkdir(path.join(tempRoot, ".workbench"), { recursive: true });
  await writeFile(
    path.join(tempRoot, ".workbench", "service-settings.json"),
    JSON.stringify({
      recordingsRoot,
      recording: {
        backend: "internal",
        outputDir: recordingsRoot,
        autoMonitorEnabled: true,
        enableDanmaku: false,
        pollIntervalSeconds: 1,
        reconnectSeconds: 1,
        remuxToMp4: false
      },
      automation: { enabled: false }
    }),
    "utf8"
  );
  await writeFile(
    path.join(tempRoot, ".workbench", "fixed-rooms.json"),
    JSON.stringify({ rooms: [{ roomId, name: "Fetch Failed Ended Room", enabled: true }] }),
    "utf8"
  );

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createApiRouter());
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(server));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const start = await fetch(`${baseUrl}/api/recording/rooms/${roomId}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  const startBody = await start.json();
  assert.equal(start.status, 200, JSON.stringify(startBody));

  let room = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    room = await fetch(`${baseUrl}/api/recording/rooms/${roomId}`).then((response) => response.json());
    if (room.taskStatus === "waiting" && room.liveStatus === "offline") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(room.taskStatus, "waiting");
  assert.equal(room.liveStatus, "offline");
  assert.ok(String(room.message || "").length > 0);
  assert.doesNotMatch(room.message, /fetch failed|缃戠粶鍙栨祦澶辫触/i);

  await fetch(`${baseUrl}/api/recording/rooms/${roomId}/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
});

async function withFakeFfmpeg(t, options = {}) {
  const ffprobeSucceeds = options.ffprobeSucceeds !== false;
  const fakeDir = path.join(tempRoot, `fake-ffmpeg-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(fakeDir, { recursive: true });
  const runner = path.join(fakeDir, "fake-ffmpeg.cjs");
  const probeRunner = path.join(fakeDir, "fake-ffprobe.cjs");
  const logPath = path.join(fakeDir, "ffmpeg.jsonl");
  await writeFile(
    runner,
    [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const args = process.argv.slice(2);",
      "const out = args[args.length - 1];",
      "fs.mkdirSync(path.dirname(out), { recursive: true });",
      "const input = args.includes('-i') ? args[args.indexOf('-i') + 1] : null;",
      "const source = input && fs.existsSync(input) ? fs.readFileSync(input) : Buffer.from('fake-source');",
      "const payload = args.includes('-frames:v') ? Buffer.from('fake-cover') : Buffer.concat([Buffer.from('fake-remux\\n'), source]);",
      "fs.writeFileSync(out, payload);",
      "if (process.env.FAKE_FFMPEG_LOG) fs.appendFileSync(process.env.FAKE_FFMPEG_LOG, JSON.stringify(args) + '\\n');"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    probeRunner,
    [
      "if (process.env.FAKE_FFPROBE_FAIL === '1') process.exit(1);",
      "process.stdout.write(JSON.stringify({ format: { duration: '12.34', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' } }));"
    ].join("\n"),
    "utf8"
  );
  const unixShim = path.join(fakeDir, "ffmpeg");
  await writeFile(unixShim, `#!/bin/sh\nexec "${process.execPath}" "${runner}" "$@"\n`, "utf8");
  await chmod(unixShim, 0o755);
  await writeFile(path.join(fakeDir, "ffmpeg.cmd"), `@"${process.execPath}" "${runner}" %*\r\n`, "utf8");
  const previousPath = process.env.PATH || "";
  const previousLog = process.env.FAKE_FFMPEG_LOG;
  const previousProbeFail = process.env.FAKE_FFPROBE_FAIL;
  const previousCommand = process.env.BILIVE_FFMPEG_COMMAND;
  const previousPrefix = process.env.BILIVE_FFMPEG_ARGS_PREFIX;
  const previousProbeCommand = process.env.BILIVE_FFPROBE_COMMAND;
  const previousProbePrefix = process.env.BILIVE_FFPROBE_ARGS_PREFIX;
  process.env.PATH = `${fakeDir}${path.delimiter}${previousPath}`;
  process.env.FAKE_FFMPEG_LOG = logPath;
  process.env.FAKE_FFPROBE_FAIL = ffprobeSucceeds ? "0" : "1";
  process.env.BILIVE_FFMPEG_COMMAND = process.execPath;
  process.env.BILIVE_FFMPEG_ARGS_PREFIX = JSON.stringify([runner]);
  process.env.BILIVE_FFPROBE_COMMAND = process.execPath;
  process.env.BILIVE_FFPROBE_ARGS_PREFIX = JSON.stringify([probeRunner]);
  t.after(() => {
    process.env.PATH = previousPath;
    if (previousLog === undefined) {
      delete process.env.FAKE_FFMPEG_LOG;
    } else {
      process.env.FAKE_FFMPEG_LOG = previousLog;
    }
    if (previousProbeFail === undefined) {
      delete process.env.FAKE_FFPROBE_FAIL;
    } else {
      process.env.FAKE_FFPROBE_FAIL = previousProbeFail;
    }
    if (previousCommand === undefined) {
      delete process.env.BILIVE_FFMPEG_COMMAND;
    } else {
      process.env.BILIVE_FFMPEG_COMMAND = previousCommand;
    }
    if (previousPrefix === undefined) {
      delete process.env.BILIVE_FFMPEG_ARGS_PREFIX;
    } else {
      process.env.BILIVE_FFMPEG_ARGS_PREFIX = previousPrefix;
    }
    if (previousProbeCommand === undefined) {
      delete process.env.BILIVE_FFPROBE_COMMAND;
    } else {
      process.env.BILIVE_FFPROBE_COMMAND = previousProbeCommand;
    }
    if (previousProbePrefix === undefined) {
      delete process.env.BILIVE_FFPROBE_ARGS_PREFIX;
    } else {
      process.env.BILIVE_FFPROBE_ARGS_PREFIX = previousProbePrefix;
    }
  });
  return { logPath };
}

async function withFakeBiliup(t) {
  const fakeDir = path.join(tempRoot, `fake-biliup-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(fakeDir, { recursive: true });
  const runner = path.join(fakeDir, "fake-biliup.cjs");
  const logPath = path.join(fakeDir, "biliup.jsonl");
  await writeFile(
    runner,
    [
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      "if (args.includes('--version')) { console.log('biliup-cli 1.1.29'); process.exit(0); }",
      "fs.appendFileSync(process.env.FAKE_BILIUP_LOG, JSON.stringify(args) + '\\n');",
      "console.log('fake biliup upload ok');"
    ].join("\n"),
    "utf8"
  );
  await writeFile(path.join(fakeDir, "biliup.cmd"), `@"${process.execPath}" "${runner}" %*\r\n`, "utf8");
  const previousPath = process.env.PATH || "";
  const previousLog = process.env.FAKE_BILIUP_LOG;
  process.env.PATH = `${fakeDir}${path.delimiter}${previousPath}`;
  process.env.FAKE_BILIUP_LOG = logPath;
  t.after(() => {
    process.env.PATH = previousPath;
    if (previousLog === undefined) {
      delete process.env.FAKE_BILIUP_LOG;
    } else {
      process.env.FAKE_BILIUP_LOG = previousLog;
    }
  });
  return { logPath };
}

test("normalizes segment-local ASR cues to the global video timeline", () => {
  const cues = normalizeAsrCuesForTimeline(
    [{ id: "cue-1", start: 1.2, end: 4.8, text: "high energy moment" }],
    600,
    690,
    "test-asr"
  );

  assert.equal(cues[0].start, 601.2);
  assert.equal(cues[0].end, 604.8);
  assert.equal(cues[0].timebase, "global");
  assert.equal(cues[0].originalTimebase, "segment");
});

test("does not offset ASR cues that are already global", () => {
  const cues = normalizeAsrCuesForTimeline(
    [{ id: "cue-1", start: 602, end: 606, text: "already global" }],
    600,
    690,
    "test-asr"
  );

  assert.equal(cues[0].start, 602);
  assert.equal(cues[0].end, 606);
  assert.equal(cues[0].originalTimebase, "global");
});

test("ASR jobs expose completed status and rewrite subtitle files to the global timeline", async (t) => {
  await withFakeFfmpeg(t);
  const recordingsRoot = path.join(tempRoot, `asr-global-file-${Date.now()}`);
  const roomDir = path.join(recordingsRoot, "22889 - ASR Room");
  const videoPath = path.join(roomDir, "sample.mp4");
  const fakeAsrScript = path.join(tempRoot, `fake-asr-${Date.now()}.cjs`);
  await mkdir(roomDir, { recursive: true });
  await mkdir(path.join(tempRoot, ".workbench"), { recursive: true });
  await writeFile(videoPath, "fake video", "utf8");
  await writeFile(
    fakeAsrScript,
    [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const outDir = process.argv[2];",
      "fs.mkdirSync(outDir, { recursive: true });",
      "fs.writeFileSync(path.join(outDir, 'local.srt'), '1\\n00:00:01,000 --> 00:00:03,000\\nlocal cue\\n\\n', 'utf8');"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(tempRoot, ".workbench", "service-settings.json"),
    JSON.stringify({
      recordingsRoot,
      recording: { backend: "internal", outputDir: recordingsRoot },
      asr: {
        mode: "local-command",
        provider: "local-command",
        outputFormat: "srt",
        localCommand: `& "${process.execPath}" "${fakeAsrScript}" "{outDir}"`
      },
      automation: { enabled: false }
    }),
    "utf8"
  );

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createApiRouter());
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(server));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const start = await fetch(`${baseUrl}/api/asr/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoKey: Buffer.from(videoPath).toString("base64url"), start: 100, end: 110 })
  });
  const created = await start.json();
  assert.equal(start.status, 200, JSON.stringify(created));

  let job = created;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/asr/status/${created.id}`);
    job = await response.json();
    if (job.status !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.equal(job.status, "completed", JSON.stringify(job));
  assert.equal(job.subtitles.length, 1);
  assert.equal(job.subtitles[0].start, 101);
  assert.equal(job.subtitles[0].end, 103);
  assert.match(path.basename(job.subtitlePath), /^result\.srt$/);
  const rewritten = await readFile(job.subtitlePath, "utf8");
  assert.match(rewritten, /00:01:41,000 --> 00:01:43,000/);
});

test("blocks auto-public uploads without high-confidence clip evidence", () => {
  const policy = evaluateUploadPolicy(
    {
      uploadPolicy: "auto-public",
      autoSubmit: true,
      title: "Candidate",
      tag: "live,clip",
      automation: { eligibleForAutoUpload: true, score: 60, evidenceCount: 1 }
    },
    { confirmed: true }
  );

  assert.equal(policy.canRun, false);
  assert.match(policy.issues.join("\n"), /auto-public requires/);
});

test("accepts high-confidence auto-public upload policy", () => {
  const policy = evaluateUploadPolicy(
    {
      uploadPolicy: "auto-public",
      autoSubmit: true,
      title: "Candidate",
      tag: "live,clip",
      automation: { eligibleForAutoUpload: true, score: 88, evidenceCount: 3 }
    },
    { confirmed: true }
  );

  assert.equal(policy.canRun, true);
  assert.equal(policy.effectiveDraft.visibility, "public");
  assert.equal(policy.effectiveDraft.isOnlySelf, 0);
});

test("upload policy can simulate final execution during preflight", () => {
  const policy = evaluateUploadPolicy(
    {
      uploadPolicy: "auto-only-self"
    },
    { confirmed: true, assumeAutoSubmit: true }
  );

  assert.equal(policy.canRun, true);
  assert.equal(policy.effectiveDraft.autoSubmit, true);
  assert.equal(policy.effectiveDraft.visibility, "onlySelf");
});

test("confirmed upload run executes a local biliup command without bypassing the gate", async (t) => {
  const { logPath } = await withFakeBiliup(t);
  const uploadRoot = path.join(tempRoot, `upload-run-${Date.now()}`);
  const videoPath = path.join(uploadRoot, "clip.mp4");
  const cookiePath = path.join(uploadRoot, "cookies.json");
  await mkdir(uploadRoot, { recursive: true });
  await writeFile(videoPath, "fake mp4 payload", "utf8");
  await writeFile(cookiePath, JSON.stringify({ SESSDATA: "fake-cookie" }), "utf8");

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createApiRouter());
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(server));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const draft = {
    uploadPolicy: "auto-only-self",
    autoSubmit: true,
    title: "Safe upload dry run",
    desc: "Exercises command construction without contacting Bilibili.",
    tag: "live,clip",
    source: "https://live.bilibili.com/22889",
    tid: 171,
    copyright: 2,
    noReprint: 1,
    visibility: "onlySelf",
    isOnlySelf: 1,
    cookiePath,
    parts: [{ path: videoPath, title: "P1" }],
    automation: { eligibleForAutoUpload: true, score: 95, evidenceCount: 3, signalFamilies: ["danmaku-burst"] }
  };

  const blocked = await fetch(`${baseUrl}/api/upload/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ draft, confirm: false })
  });
  assert.equal(blocked.status, 400);
  const blockedBody = await blocked.json();
  assert.match(blockedBody.error, /confirm=true/);

  const response = await fetch(`${baseUrl}/api/upload/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ draft, confirm: true })
  });
  const created = await response.json();
  assert.equal(response.status, 200, JSON.stringify(created));
  assert.equal(created.type, "biliup-run");
  assert.equal(created.policy.canRun, true);

  let job = created;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const poll = await fetch(`${baseUrl}/api/upload/jobs/${created.id}`);
    job = await poll.json();
    if (job.status !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.equal(job.status, "ready", JSON.stringify(job));
  assert.equal(job.exitCode, 0);
  assert.match(job.command, /upload/);
  assert.match(job.command, /--is-only-self/);
  const calls = (await readFile(logPath, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes("upload"));
  assert.ok(calls[0].includes("--is-only-self"));
  assert.ok(calls[0].includes(videoPath));
});

test("ingests recording webhook events and exposes recent room events", async (t) => {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createApiRouter());

  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(server));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const eventPayload = {
    id: "event-1",
    type: "VideoFileCreatedEvent",
    date: "2026-06-13T00:00:00+08:00",
    data: {
      room_id: 22889,
      path: path.join(tempRoot, "recordings", "22889", "clip.flv")
    }
  };

  const post = await fetch(`${baseUrl}/api/recording/events/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(eventPayload)
  });
  assert.equal(post.status, 200);
  const posted = await post.json();
  assert.equal(posted.event.roomId, "22889");
  assert.equal(posted.event.type, "VideoFileCreatedEvent");

  const get = await fetch(`${baseUrl}/api/recording/rooms/22889/events`);
  assert.equal(get.status, 200);
  const body = await get.json();
  assert.equal(body.events.length, 1);
  assert.equal(body.events[0].id, "event-1");
});


test("queues and runs high-confidence automation from completed recording events", async (t) => {
  let upstreamCalls = 0;
  const upstreamApp = express();
  upstreamApp.use(express.json({ limit: "1mb" }));
  upstreamApp.post("/v1/chat/completions", (_req, res) => {
    upstreamCalls += 1;
    res.json({
      id: "chat-auto-event-test",
      object: "chat.completion",
      choices: [
        {
          message: {
            content: JSON.stringify({
              candidates: [
                {
                  id: "model-event-60-120",
                  title: "Model picked event clip",
                  start: 60,
                  end: 120,
                  score: 94,
                  reason: "模型认为这一段弹幕集中，适合切片。",
                  evidence: ["弹幕 1:00：hhh 233 ?", "弹幕 1:01：hhh 233 ?"]
                }
              ]
            })
          }
        }
      ]
    });
  });
  const upstream = await new Promise((resolve) => {
    const instance = upstreamApp.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(upstream));

  const recordingsRoot = path.join(tempRoot, "recordings");
  const roomDir = path.join(recordingsRoot, "22889 - Test Room");
  const videoPath = path.join(roomDir, "clip.flv");
  const xmlPath = path.join(roomDir, "clip.xml");
  await mkdir(roomDir, { recursive: true });
  await mkdir(path.join(tempRoot, ".workbench"), { recursive: true });
  await writeFile(videoPath, "not a real video; ffprobe failure is tolerated", "utf8");
  const comments = Array.from({ length: 36 }, (_, index) => {
    const time = (60 + index * 0.2).toFixed(1);
    return `<d p="${time},1,25,16777215,0,0,0,${index}">hhh 233 ?</d>`;
  }).join("");
  await writeFile(xmlPath, `<i>${comments}</i>`, "utf8");
  await writeFile(
    path.join(tempRoot, ".workbench", "service-settings.json"),
    JSON.stringify({
      recordingsRoot,
      vision: {
        provider: "openai-compatible",
        wireApi: "chat-completions",
        endpoint: `http://127.0.0.1:${upstream.address().port}/v1`,
        apiKey: "test-key",
        model: "gpt-5.5",
        sendFrames: true,
        audioSpectrum: true,
        frameSampleCount: 2
      },
      automation: {
        enabled: true,
        autoAnalyze: true,
        uploadPolicy: "review",
        clipDuration: 90,
        clipCount: 2,
        sources: ["danmaku"],
        minScore: 72
      }
    }),
    "utf8"
  );

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createApiRouter());

  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(server));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const post = await fetch(`${baseUrl}/api/recording/events/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "event-automation-1",
      type: "VideoFileCompletedEvent",
      date: "2026-06-13T00:10:00+08:00",
      data: { room_id: 22889, path: videoPath }
    })
  });
  assert.equal(post.status, 200);

  let job = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/automation/jobs`);
    const body = await response.json();
    job = body.jobs.find((item) => item.triggerEventId === "event-automation-1");
    if (job && job.status !== "running" && job.status !== "queued") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.ok(job, "automation job should be created");
  assert.equal(job.status, "ready");
  assert.equal(job.stage, "clips-ready");
  assert.ok(job.acceptedClips.length >= 1);
  assert.equal(job.acceptedClips[0].automation.eligibleForAutoUpload, true);
  assert.ok(upstreamCalls > 0);

  const project = JSON.parse(await readFile(job.projectPath, "utf8"));
  assert.ok(project.automation.acceptedClipIds.includes(job.acceptedClips[0].id));
});

test("automation can keep recording-complete events from auto-queueing clips", async (t) => {
  const recordingsRoot = path.join(tempRoot, "recordings-no-auto-queue");
  const roomDir = path.join(recordingsRoot, "338899 - Quiet Room");
  const videoPath = path.join(roomDir, "quiet.flv");
  await mkdir(roomDir, { recursive: true });
  await mkdir(path.join(tempRoot, ".workbench"), { recursive: true });
  await writeFile(videoPath, "quiet video", "utf8");
  await writeFile(
    path.join(tempRoot, ".workbench", "service-settings.json"),
    JSON.stringify({
      recordingsRoot,
      automation: {
        enabled: true,
        triggerOnRecordingComplete: false,
        autoAnalyze: true,
        uploadPolicy: "review"
      }
    }),
    "utf8"
  );

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createApiRouter());
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(server));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const post = await fetch(`${baseUrl}/api/recording/events/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "event-no-auto-queue-1",
      type: "VideoFileCompletedEvent",
      date: "2026-06-13T00:12:00+08:00",
      data: { room_id: 338899, path: videoPath }
    })
  });
  assert.equal(post.status, 200);

  const response = await fetch(`${baseUrl}/api/automation/jobs`);
  const body = await response.json();
  assert.equal(body.jobs.some((item) => item.triggerEventId === "event-no-auto-queue-1"), false);
});

test("automation reconciles stable recording files that missed completion events", async (t) => {
  const recordingsRoot = path.join(tempRoot, "recordings-reconcile");
  const roomDir = path.join(recordingsRoot, "22891 - Reconcile Room");
  const videoPath = path.join(roomDir, "missed-complete.flv");
  const xmlPath = path.join(roomDir, "missed-complete.xml");
  await mkdir(roomDir, { recursive: true });
  await mkdir(path.join(tempRoot, ".workbench"), { recursive: true });
  await writeFile(videoPath, "not a real video but stable on disk", "utf8");
  await writeFile(xmlPath, "<i><d p=\"2,1,25,16777215,0,0,0,1\">hhh 233</d></i>", "utf8");
  const old = new Date(Date.now() - 2 * 60 * 1000);
  await utimes(videoPath, old, old);
  await utimes(xmlPath, old, old);
  await writeFile(
    path.join(tempRoot, ".workbench", "service-settings.json"),
    JSON.stringify({
      recordingsRoot,
      automation: {
        enabled: true,
        triggerOnRecordingComplete: true,
        autoAnalyze: false,
        autoExport: false,
        autoUpload: false,
        uploadPolicy: "auto-only-self",
        clipDuration: 30,
        clipCount: 1,
        sources: ["danmaku"],
        minScore: 72
      }
    }),
    "utf8"
  );
  __testing.resetAutomationReconcileClock();

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createApiRouter());

  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(server));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${baseUrl}/api/automation/jobs`);
  assert.equal(response.status, 200);
  const body = await response.json();
  const job = body.jobs.find((item) => item.videoPath === videoPath);
  assert.ok(job, "stable recording file should be queued for automation");
  assert.equal(job.trigger, "recording-file-reconcile");
  assert.equal(job.uploadPolicy, "auto-only-self");
  assert.equal(job.status, "queued");
});

test("selected FLV conversion only queues checked videos and exposes danmaku metadata", async (t) => {
  const recordingsRoot = path.join(tempRoot, "recordings-selected-flv");
  const roomDir = path.join(recordingsRoot, "22892 - Convert Room");
  const selectedFlv = path.join(roomDir, "selected.flv");
  const selectedMp4 = path.join(roomDir, "_compressed", "selected.mp4");
  const unselectedFlv = path.join(roomDir, "unselected.flv");
  const xmlPath = path.join(roomDir, "selected.xml");
  await mkdir(roomDir, { recursive: true });
  await mkdir(path.join(tempRoot, ".workbench"), { recursive: true });
  await writeFile(selectedFlv, "fake selected flv", "utf8");
  await mkdir(path.dirname(selectedMp4), { recursive: true });
  await writeFile(selectedMp4, "already converted", "utf8");
  await writeFile(unselectedFlv, "fake unselected flv", "utf8");
  await writeFile(xmlPath, "<i><d p=\"2,1,25,16777215,0,0,0,1\">hello</d><d p=\"3,1,25,16777215,0,0,0,2\">world</d></i>", "utf8");
  await writeFile(
    path.join(tempRoot, ".workbench", "service-settings.json"),
    JSON.stringify({
      recordingsRoot,
      media: {
        flvOutputMode: "compressed-dir",
        deleteSourceAfterConvert: false,
        skipIfMp4Exists: true
      }
    }),
    "utf8"
  );

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createApiRouter());
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(server));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const roomKey = Buffer.from(roomDir).toString("base64url");
  const detailResponse = await fetch(`${baseUrl}/api/rooms/${encodeURIComponent(roomKey)}`);
  const detail = await detailResponse.json();
  assert.equal(detailResponse.status, 200, JSON.stringify(detail));
  const selected = detail.videos.find((video) => video.name === "selected.flv");
  assert.equal(selected.danmakuCount, 2);
  assert.equal(selected.remuxTarget.exists, true);

  const convert = await fetch(`${baseUrl}/api/media/convert-flv`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomKey: "room:22892", videoKeys: [Buffer.from(selectedFlv).toString("base64url")] })
  });
  const convertBody = await convert.json();
  assert.equal(convert.status, 200, JSON.stringify(convertBody));

  let task = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const tasks = await fetch(`${baseUrl}/api/tasks`).then((response) => response.json());
    task = tasks.tasks.find((item) => item.id === convertBody.job.id);
    if (task?.status === "ready") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(task.status, "ready", JSON.stringify(task));
  assert.match(task.message, /1 个文件/);
  assert.ok(await readFile(unselectedFlv, "utf8"));
});

test("FLV conversion honors compression and lossless audio settings", async (t) => {
  const { logPath } = await withFakeFfmpeg(t);
  const recordingsRoot = path.join(tempRoot, `recordings-flv-settings-${Date.now()}`);
  const roomDir = path.join(recordingsRoot, "22893 - Convert Settings Room");
  const selectedFlv = path.join(roomDir, "selected.flv");
  await mkdir(roomDir, { recursive: true });
  await mkdir(path.join(tempRoot, ".workbench"), { recursive: true });
  await writeFile(selectedFlv, "fake selected flv", "utf8");
  await writeFile(
    path.join(tempRoot, ".workbench", "service-settings.json"),
    JSON.stringify({
      recordingsRoot,
      media: {
        flvOutputMode: "same-dir",
        deleteSourceAfterConvert: false,
        skipIfMp4Exists: false,
        videoTranscodeMode: "compress",
        videoCrf: 19,
        videoPreset: "slow",
        audioTranscodeMode: "lossless"
      }
    }),
    "utf8"
  );

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createApiRouter());
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(server));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const convert = await fetch(`${baseUrl}/api/media/convert-flv`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoKeys: [Buffer.from(selectedFlv).toString("base64url")] })
  });
  const convertBody = await convert.json();
  assert.equal(convert.status, 200, JSON.stringify(convertBody));

  let task = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const tasks = await fetch(`${baseUrl}/api/tasks`).then((response) => response.json());
    task = tasks.tasks.find((item) => item.id === convertBody.job.id);
    if (task?.status === "ready") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(task.status, "ready", JSON.stringify(task));
  const ffmpegCalls = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const args = ffmpegCalls.find((call) => call.includes(selectedFlv));
  assert.ok(args, "conversion should invoke ffmpeg for selected FLV");
  assert.equal(args[args.indexOf("-c:v") + 1], "libx264");
  assert.equal(args[args.indexOf("-crf") + 1], "19");
  assert.equal(args[args.indexOf("-preset") + 1], "slow");
  assert.equal(args[args.indexOf("-c:a") + 1], "alac");
});

test("AI clipping workflow validates candidates export draft preflight and upload gate", async (t) => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore", timeout: 10000 });
  } catch {
    t.skip("ffmpeg is not available in this environment");
    return;
  }

  let upstreamCalls = 0;
  const upstreamApp = express();
  upstreamApp.use(express.json({ limit: "1mb" }));
  let sliceRequestBody = null;
  upstreamApp.post("/v1/chat/completions", (req, res) => {
    upstreamCalls += 1;
    if (!sliceRequestBody && req.body?.messages?.some((message) => JSON.stringify(message).includes("bilibili_ai_slice_candidates"))) {
      sliceRequestBody = req.body;
    }
    res.json({
      id: "chat-ai-workflow-test",
      object: "chat.completion",
      choices: [
        {
          message: {
            content: JSON.stringify({
              candidates: [
                {
                  id: "model-workflow-60-120",
                  title: "Model workflow clip",
                  start: 50,
                  end: 115,
                  score: 95,
                  reason: "模型直接从弹幕摘要中挑出高能片段。",
                  evidence: ["弹幕 1:20：hhh 233 ?", "弹幕 1:21：hhh 233 ?"]
                }
              ]
            })
          }
        }
      ]
    });
  });
  const upstream = await new Promise((resolve) => {
    const instance = upstreamApp.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(upstream));

  const recordingsRoot = path.join(tempRoot, "recordings-auto-export");
  const roomDir = path.join(recordingsRoot, "22890 - Export Room");
  const videoPath = path.join(roomDir, "clip.mp4");
  const xmlPath = path.join(roomDir, "clip.xml");
  await mkdir(roomDir, { recursive: true });
  await mkdir(path.join(tempRoot, ".workbench"), { recursive: true });
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=160x90:r=1:d=120",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-shortest",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-c:a",
      "aac",
      videoPath
    ],
    { stdio: "ignore", timeout: 60000 }
  );
  const comments = Array.from({ length: 42 }, (_, index) => {
    const time = (80 + index * 0.2).toFixed(1);
    return `<d p="${time},1,25,16777215,0,0,0,${index}">hhh 233 ?</d>`;
  }).join("");
  await writeFile(xmlPath, `<i>${comments}</i>`, "utf8");
  await writeFile(
    path.join(tempRoot, ".workbench", "service-settings.json"),
    JSON.stringify({
      recordingsRoot,
      vision: {
        provider: "openai-compatible",
        wireApi: "chat-completions",
        endpoint: `http://127.0.0.1:${upstream.address().port}/v1`,
        apiKey: "test-key",
        model: "gpt-5.5"
      },
      automation: {
        enabled: true,
        autoAnalyze: false,
        autoExport: true,
        autoUpload: false,
        uploadPolicy: "auto-only-self",
        clipDuration: 90,
        clipCount: 1,
        sources: ["danmaku"],
        minScore: 72
      }
    }),
    "utf8"
  );

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createApiRouter());

  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(server));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const slices = await fetch(`${baseUrl}/api/ai/slices`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      videoKey: Buffer.from(videoPath).toString("base64url"),
      sources: ["danmaku", "visual", "audio"],
      clipCount: 1,
      precisionMode: "high"
    })
  });
  const slicesBody = await slices.json();
  assert.equal(slices.status, 200, JSON.stringify(slicesBody));
  assert.equal(slicesBody.candidates.length, 1);
  assert.equal(slicesBody.candidates[0].automation.eligibleForAutoUpload, true);
  assert.equal(slicesBody.diagnostics.modelUsed, true);
  assert.equal(slicesBody.diagnostics.engine, "model-only");
  assert.ok(upstreamCalls > 0);
  assert.ok(sliceRequestBody, "slice request should reach upstream");
  const userContent = sliceRequestBody.messages.find((message) => message.role === "user")?.content;
  assert.ok(Array.isArray(userContent), "multimodal slice request should use array content");
  assert.ok(userContent.some((part) => part.type === "image_url"), "slice request should include frame or spectrum images");
  const userText = userContent.find((part) => part.type === "text")?.text || "";
  assert.match(userText, /mediaSamples/);
  assert.match(userText, /"durationPolicy"/);
  assert.match(userText, /"mode": "model-decides"/);
  assert.doesNotMatch(userText, /clipDuration/);

  const analyze = await fetch(`${baseUrl}/api/automation/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoKey: Buffer.from(videoPath).toString("base64url"), uploadPolicy: "auto-only-self" })
  });
  assert.equal(analyze.status, 200);
  const created = await analyze.json();
  const run = await fetch(`${baseUrl}/api/automation/jobs/${created.job.id}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({})
  });
  const body = await run.json();
  assert.equal(run.status, 200, JSON.stringify(body));
  const job = body.job;

  assert.equal(job.stage, "upload-draft-ready");
  assert.ok(job.acceptedClips[0].exportPath);
  assert.equal(job.exportedClips.length, job.acceptedClips.filter((clip) => clip.exportPath).length);
  assert.ok(job.exportedClips[0].exportPath);
  assert.ok(job.uploadDraftPath);
  const draft = JSON.parse(await readFile(job.uploadDraftPath, "utf8"));
  assert.equal(draft.uploadPolicy, "auto-only-self");
  assert.equal(draft.visibility, "onlySelf");
  assert.equal(draft.isOnlySelf, 1);
  assert.equal(draft.parts.length, 1);

  const fakeBiliupDir = path.join(tempRoot, ".workbench", "tools", "biliup-venv", "Scripts");
  await mkdir(fakeBiliupDir, { recursive: true });
  await writeFile(path.join(fakeBiliupDir, "biliup.exe"), "", "utf8");
  await writeFile(draft.cookiePath, "{}", "utf8");
  const preflight = await fetch(`${baseUrl}/api/upload/preflight`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ draft })
  });
  const preflightBody = await preflight.json();
  assert.equal(preflight.status, 200);
  assert.equal(preflightBody.ok, true, JSON.stringify(preflightBody));
  assert.match(preflightBody.command, /--is-only-self 1/);

  const blockedRun = await fetch(`${baseUrl}/api/upload/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ draft: { ...draft, autoSubmit: true }, confirm: false })
  });
  const blockedBody = await blockedRun.json();
  assert.equal(blockedRun.status, 400);
  assert.match(blockedBody.policy.issues.join("\n"), /explicit confirm=true/);
});

test("AI clipping retries text-only model request when image inputs are rejected", async (t) => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore", timeout: 10000 });
  } catch {
    t.skip("ffmpeg is not available in this environment");
    return;
  }

  const calls = [];
  const upstreamApp = express();
  upstreamApp.use(express.json({ limit: "10mb" }));
  upstreamApp.post("/v1/chat/completions", (req, res) => {
    const serialized = JSON.stringify(req.body);
    const hasImage = serialized.includes("\"image_url\"");
    calls.push({ hasImage, serialized });
    if (hasImage) {
      res.status(400).json({
        error: {
          code: "upstream_error",
          message: JSON.stringify({
            error: {
              message: "bad response status code 400",
              type: "invalid_request_error",
              param: "input",
              code: "invalid_value"
            }
          }),
          type: "invalid_request_error"
        }
      });
      return;
    }
    res.json({
      id: "chat-ai-text-retry-test",
      object: "chat.completion",
      choices: [
        {
          message: {
            content: JSON.stringify({
              candidates: [
                {
                  id: "model-text-retry-35-75",
                  title: "弹幕突然开始接梗",
                  start: 35,
                  end: 75,
                  score: 91,
                  reason: "这段弹幕连续接梗，节奏突然热起来，适合剪成一个短包袱。",
                  evidence: ["弹幕 0:45：哈哈哈这句太损了", "弹幕 0:46：主播接住了"]
                }
              ]
            })
          }
        }
      ]
    });
  });
  const upstream = await new Promise((resolve) => {
    const instance = upstreamApp.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(upstream));

  const recordingsRoot = path.join(tempRoot, "recordings-ai-text-retry");
  const roomDir = path.join(recordingsRoot, "22893 - Text Retry Room");
  const videoPath = path.join(roomDir, "clip.mp4");
  const xmlPath = path.join(roomDir, "clip.xml");
  await mkdir(roomDir, { recursive: true });
  await mkdir(path.join(tempRoot, ".workbench"), { recursive: true });
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=160x90:r=1:d=80",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-shortest",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-c:a",
      "aac",
      videoPath
    ],
    { stdio: "ignore", timeout: 60000 }
  );
  const comments = Array.from({ length: 30 }, (_, index) => {
    const time = (45 + index * 0.2).toFixed(1);
    return `<d p="${time},1,25,16777215,0,0,0,${index}">哈哈哈这句太损了</d>`;
  }).join("");
  await writeFile(xmlPath, `<i>${comments}</i>`, "utf8");
  await writeFile(
    path.join(tempRoot, ".workbench", "service-settings.json"),
    JSON.stringify({
      recordingsRoot,
      vision: {
        provider: "openai-compatible",
        wireApi: "chat-completions",
        endpoint: `http://127.0.0.1:${upstream.address().port}/v1`,
        apiKey: "test-key",
        model: "gpt-5.5",
        frameSampleCount: 2,
        audioSpectrum: true
      }
    }),
    "utf8"
  );

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createApiRouter());
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(server));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${baseUrl}/api/ai/slices`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      videoKey: Buffer.from(videoPath).toString("base64url"),
      sources: ["danmaku", "visual", "audio"],
      clipDuration: 45,
      clipCount: 1,
      precisionMode: "high"
    })
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.candidates.length, 1);
  assert.equal(body.candidates[0].title, "弹幕突然开始接梗");
  assert.equal(body.diagnostics.modelStatus, "ok");
  assert.equal(body.diagnostics.modelUsed, true);
  assert.equal(body.diagnostics.mediaImagesUsed, 0);
  assert.ok(body.diagnostics.mediaImagesRequested > 0);
  assert.match(body.diagnostics.message, /文本信号重试/);
  assert.ok(body.diagnostics.warnings?.some((warning) => warning.includes("图片输入")));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].hasImage, true);
  assert.equal(calls[1].hasImage, false);
  assert.match(calls[1].serialized, /mediaImagesSkipped/);
});

test("automation jobs use model-enhanced slice titles and reasons", async (t) => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore", timeout: 10000 });
  } catch {
    t.skip("ffmpeg is not available in this environment");
    return;
  }

  let upstreamCalls = 0;
  const upstreamApp = express();
  upstreamApp.use(express.json({ limit: "1mb" }));
  upstreamApp.post("/v1/chat/completions", (req, res) => {
    upstreamCalls += 1;
    const prompt = req.body.messages?.map((message) => message.content).join("\n") || "";
    const id = /"id":\s*"([^"]+)"/.exec(prompt)?.[1] || "clip-0-30";
    res.json({
      id: "chat-auto-slice-test",
      object: "chat.completion",
      choices: [
        {
          message: {
            content: JSON.stringify({
              candidates: [
                {
                  id,
                  title: "AI auto slice title",
                  score: 99,
                  reason: "AI reason: danmaku and subtitle signals are strong enough for a high-confidence clip.",
                  evidence: ["AI evidence: both danmaku and subtitle signals hit the same moment."]
                }
              ]
            })
          }
        }
      ]
    });
  });
  const upstream = await new Promise((resolve) => {
    const instance = upstreamApp.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(upstream));

  const recordingsRoot = path.join(tempRoot, "recordings-auto-ai");
  const roomDir = path.join(recordingsRoot, "22891 - AI Room");
  const videoPath = path.join(roomDir, "clip.mp4");
  const xmlPath = path.join(roomDir, "clip.xml");
  await mkdir(roomDir, { recursive: true });
  await mkdir(path.join(tempRoot, ".workbench"), { recursive: true });
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=160x90:r=1:d=120",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-shortest",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-c:a",
      "aac",
      videoPath
    ],
    { stdio: "ignore", timeout: 60000 }
  );
  const comments = Array.from({ length: 36 }, (_, index) => {
    const time = (70 + index * 0.25).toFixed(2);
    return `<d p="${time},1,25,16777215,0,0,0,${index}">hhh 233 famous moment</d>`;
  }).join("");
  await writeFile(xmlPath, `<i>${comments}</i>`, "utf8");
  await writeFile(
    path.join(tempRoot, ".workbench", "service-settings.json"),
    JSON.stringify({
      recordingsRoot,
      vision: {
        provider: "openai-compatible",
        wireApi: "chat-completions",
        endpoint: `http://127.0.0.1:${upstream.address().port}/v1`,
        apiKey: "test-key",
        model: "gpt-5.5"
      },
      automation: {
        enabled: true,
        autoAnalyze: false,
        autoExport: false,
        autoUpload: false,
        uploadPolicy: "review",
        clipDuration: 60,
        clipCount: 1,
        sources: ["danmaku"],
        minScore: 72,
        minEvidenceCount: 1
      }
    }),
    "utf8"
  );

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createApiRouter());

  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(server));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const analyze = await fetch(`${baseUrl}/api/automation/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoKey: Buffer.from(videoPath).toString("base64url"), uploadPolicy: "review" })
  });
  assert.equal(analyze.status, 200);
  const created = await analyze.json();
  const run = await fetch(`${baseUrl}/api/automation/jobs/${created.job.id}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({})
  });
  const body = await run.json();
  assert.equal(run.status, 200, JSON.stringify(body));
  assert.ok(upstreamCalls > 0);
  assert.equal(body.job.candidates[0].title, "AI auto slice title");
  assert.match(body.job.acceptedClips[0].reason, /AI reason/);
});

test("vision test uses responses wire API and parses responses output text", async (t) => {
  let upstreamRequest = null;
  const upstreamApp = express();
  upstreamApp.use(express.json({ limit: "1mb" }));
  upstreamApp.post("/v1/responses", (req, res) => {
    upstreamRequest = { body: req.body, authorization: req.headers.authorization };
    res.json({
      id: "resp-test",
      output: [
        {
          type: "message",
          content: [
            { type: "output_text", text: "{\"ok\":true,\"message\":\"pong\"}" }
          ]
        }
      ]
    });
  });
  upstreamApp.post("/v1/chat/completions", (_req, res) => {
    res.status(418).json({ error: "wrong endpoint" });
  });
  const upstream = await new Promise((resolve) => {
    const instance = upstreamApp.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(upstream));

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createApiRouter());
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(server));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/vision/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "openai-compatible",
      wireApi: "responses",
      endpoint: `http://127.0.0.1:${upstream.address().port}/v1`,
      apiKey: "test-key",
      model: "gpt-5.5"
    })
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.wireApi, "responses");
  assert.equal(body.response.ok, true);
  assert.equal(body.response.message, "pong");
  assert.equal(upstreamRequest.authorization, "Bearer test-key");
  assert.ok(Array.isArray(upstreamRequest.body.input));
  assert.equal(upstreamRequest.body.input[0].type, "message");
  assert.deepEqual(upstreamRequest.body.include, ["reasoning.encrypted_content"]);
  assert.equal(upstreamRequest.body.store, false);
  assert.equal(upstreamRequest.body.model, "gpt-5.5");
});

test("vision test retries localhost OpenAI-compatible endpoint on IPv4 loopback", async (t) => {
  let upstreamRequest = null;
  const upstreamApp = express();
  upstreamApp.use(express.json({ limit: "1mb" }));
  upstreamApp.post("/v1/chat/completions", (req, res) => {
    upstreamRequest = { body: req.body, authorization: req.headers.authorization };
    res.json({
      id: "chat-test",
      object: "chat.completion",
      choices: [
        { message: { content: "{\"ok\":true,\"message\":\"pong\"}" } }
      ]
    });
  });
  const upstream = await new Promise((resolve) => {
    const instance = upstreamApp.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(upstream));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const rawUrl = typeof input === "string" || input instanceof URL ? String(input) : input?.url;
    if (rawUrl) {
      const url = new URL(rawUrl);
      if (url.hostname === "localhost") {
        throw new TypeError("fetch failed");
      }
    }
    return originalFetch(input, init);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createApiRouter());
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(server));

  const response = await originalFetch(`http://127.0.0.1:${server.address().port}/api/vision/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "openai-compatible",
      wireApi: "chat-completions",
      endpoint: `http://localhost:${upstream.address().port}/v1`,
      apiKey: "test-key",
      model: "gpt-5.5"
    })
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.wireApi, "chat-completions");
  assert.equal(body.response.ok, true);
  assert.equal(body.response.message, "pong");
  assert.equal(upstreamRequest.authorization, "Bearer test-key");
  assert.equal(upstreamRequest.body.model, "gpt-5.5");
});

test("vision test explains overloaded provider channel without local-rule fallback", async (t) => {
  const upstreamApp = express();
  upstreamApp.use(express.json({ limit: "1mb" }));
  upstreamApp.post("/v1/responses", (_req, res) => {
    res.status(503).json({
      error: {
        code: "get_channel_failed",
        message: "褰撳墠妯″瀷 gpt-5.5 璐熻浇宸茬粡杈惧埌涓婇檺锛岃绋嶅悗閲嶈瘯"
      }
    });
  });
  const upstream = await new Promise((resolve) => {
    const instance = upstreamApp.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(upstream));

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createApiRouter());
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(server));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/vision/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "openai-compatible",
      wireApi: "responses",
      endpoint: `http://127.0.0.1:${upstream.address().port}/v1`,
      apiKey: "test-key",
      model: "gpt-5.5"
    })
  });
  const body = await response.json();
  assert.equal(response.status, 500, JSON.stringify(body));
  assert.ok(body.diagnostic, JSON.stringify(body));
  assert.equal(body.diagnostic.kind, "provider-overloaded");
  assert.ok(String(body.error || "").includes("模型通道"));
  assert.ok(!String(body.error || "").includes("继续使用本地"));
  assert.ok(String(body.error || "").length > 0);
  assert.equal(body.diagnostic.providerCode, "get_channel_failed");
});

test("internal Bilibili recorder writes FLV/XML and emits recording completion events", async (t) => {
  const previousBase = process.env.BILI_LIVE_API_BASE;
  const roomId = "309999";
  let fakeBaseUrl = "";
  const fakeBili = express();
  fakeBili.get("/room/v1/Room/room_init", (req, res) => {
    assert.equal(req.query.id, roomId);
    res.json({ code: 0, data: { room_id: Number(roomId), live_status: 1 } });
  });
  fakeBili.get("/room/v1/Room/get_info", (_req, res) => {
    res.json({ code: 0, data: { title: "Internal Test Room" } });
  });
  fakeBili.get("/xlive/web-room/v2/index/getRoomPlayInfo", (_req, res) => {
    res.json({
      code: 0,
      data: {
        playurl_info: {
          playurl: {
            stream: [
              {
                format: [
                  {
                    format_name: "flv",
                    codec: [
                      {
                        codec_name: "avc",
                        current_qn: 10000,
                        base_url: "/fake-live.flv",
                        url_info: [{ host: fakeBaseUrl, extra: "" }]
                      }
                    ]
                  }
                ]
              }
            ]
          }
        }
      }
    });
  });
  fakeBili.get("/fake-live.flv", (_req, res) => {
    res.type("application/octet-stream");
    res.write(Buffer.from("FLV"));
    setTimeout(() => res.end(Buffer.from("mock-stream")), 20);
  });
  const fakeServer = await new Promise((resolve) => {
    const instance = fakeBili.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(fakeServer));
  fakeBaseUrl = `http://127.0.0.1:${fakeServer.address().port}`;
  process.env.BILI_LIVE_API_BASE = fakeBaseUrl;
  t.after(() => {
    if (previousBase === undefined) {
      delete process.env.BILI_LIVE_API_BASE;
    } else {
      process.env.BILI_LIVE_API_BASE = previousBase;
    }
  });

  const recordingsRoot = path.join(tempRoot, "internal-recorder-output");
  await mkdir(path.join(tempRoot, ".workbench"), { recursive: true });
  await writeFile(
    path.join(tempRoot, ".workbench", "service-settings.json"),
    JSON.stringify({
      recordingsRoot,
      recording: {
        backend: "internal",
        outputDir: recordingsRoot,
        enableDanmaku: false,
        pollIntervalSeconds: 1,
        reconnectSeconds: 1
      },
      automation: { enabled: false }
    }),
    "utf8"
  );

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createApiRouter());
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(server));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const addRoom = await fetch(`${baseUrl}/api/recording/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomId, name: "Internal Test Room" })
  });
  assert.equal(addRoom.status, 200, await addRoom.text());

  const start = await fetch(`${baseUrl}/api/recording/rooms/${roomId}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  const startBody = await start.json();
  assert.equal(start.status, 200, JSON.stringify(startBody));
  assert.ok(String(startBody.message || "").length > 0);

  let completed = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/recording/events?roomId=${roomId}`);
    const body = await response.json();
    completed = body.events.find((event) => event.type === "VideoFileCompletedEvent");
    if (completed) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(completed, "internal recorder should emit VideoFileCompletedEvent");
  assert.match(completed.path, /\.flv$/);
  const video = await readFile(completed.path);
  assert.ok(video.includes(Buffer.from("mock-stream")));

  const stop = await fetch(`${baseUrl}/api/recording/rooms/${roomId}/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  const stopBody = await stop.json();
  assert.equal(stop.status, 200, JSON.stringify(stopBody));
  assert.equal(stopBody.taskStatus, "completed");
  assert.match(stopBody.danmakuPath, /\.xml$/);
  const xml = await readFile(stopBody.danmakuPath, "utf8");
  assert.match(xml, /<i>/);
  assert.match(xml, /<\/i>/);
});

test("internal recorder automatically reconnects after transient stream failure", async (t) => {
  const previousBase = process.env.BILI_LIVE_API_BASE;
  const roomId = "309998";
  let fakeBaseUrl = "";
  let streamHits = 0;
  const fakeBili = express();
  fakeBili.get("/room/v1/Room/room_init", (req, res) => {
    assert.equal(req.query.id, roomId);
    res.json({ code: 0, data: { room_id: Number(roomId), live_status: 1 } });
  });
  fakeBili.get("/room/v1/Room/get_info", (_req, res) => {
    res.json({ code: 0, data: { title: "Reconnect Test Room" } });
  });
  fakeBili.get("/xlive/web-room/v2/index/getRoomPlayInfo", (_req, res) => {
    res.json({
      code: 0,
      data: {
        playurl_info: {
          playurl: {
            stream: [
              {
                format: [
                  {
                    format_name: "flv",
                    codec: [
                      {
                        codec_name: "avc",
                        current_qn: 10000,
                        base_url: "/recovering-live.flv",
                        url_info: [{ host: fakeBaseUrl, extra: "" }]
                      }
                    ]
                  }
                ]
              }
            ]
          }
        }
      }
    });
  });
  fakeBili.get("/recovering-live.flv", (_req, res) => {
    streamHits += 1;
    if (streamHits === 1) {
      res.status(404).send("expired stream");
      return;
    }
    res.type("application/octet-stream");
    res.write(Buffer.from("FLV"));
    setTimeout(() => res.end(Buffer.from("recovered-stream")), 20);
  });
  const fakeServer = await new Promise((resolve) => {
    const instance = fakeBili.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(fakeServer));
  fakeBaseUrl = `http://127.0.0.1:${fakeServer.address().port}`;
  process.env.BILI_LIVE_API_BASE = fakeBaseUrl;
  t.after(() => {
    if (previousBase === undefined) {
      delete process.env.BILI_LIVE_API_BASE;
    } else {
      process.env.BILI_LIVE_API_BASE = previousBase;
    }
  });

  const recordingsRoot = path.join(tempRoot, "internal-recorder-reconnect-output");
  await mkdir(path.join(tempRoot, ".workbench"), { recursive: true });
  await writeFile(
    path.join(tempRoot, ".workbench", "service-settings.json"),
    JSON.stringify({
      recordingsRoot,
      recording: {
        backend: "internal",
        outputDir: recordingsRoot,
        enableDanmaku: false,
        pollIntervalSeconds: 5,
        reconnectSeconds: 1
      },
      automation: { enabled: false }
    }),
    "utf8"
  );

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createApiRouter());
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(server));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const addRoom = await fetch(`${baseUrl}/api/recording/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomId, name: "Reconnect Test Room" })
  });
  assert.equal(addRoom.status, 200, await addRoom.text());

  const start = await fetch(`${baseUrl}/api/recording/rooms/${roomId}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  const startBody = await start.json();
  assert.equal(start.status, 200, JSON.stringify(startBody));

  let sawAutoReconnect = false;
  let completed = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const statusResponse = await fetch(`${baseUrl}/api/recording/rooms/${roomId}`);
    const status = await statusResponse.json();
    if (status.taskStatus === "waiting" && /重连|reconnect/i.test(status.message || "")) {
      sawAutoReconnect = true;
    }

    const eventsResponse = await fetch(`${baseUrl}/api/recording/events?roomId=${roomId}`);
    const eventsBody = await eventsResponse.json();
    completed = eventsBody.events.find((event) => event.type === "VideoFileCompletedEvent");
    if (completed && sawAutoReconnect) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(sawAutoReconnect, true, "transient stream failure should remain a reconnecting state");
  assert.ok(completed, "internal recorder should recover and emit VideoFileCompletedEvent");
  assert.equal(streamHits >= 2, true);
  const video = await readFile(completed.path);
  assert.ok(video.includes(Buffer.from("recovered-stream")));

  const stop = await fetch(`${baseUrl}/api/recording/rooms/${roomId}/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  const stopBody = await stop.json();
  assert.equal(stop.status, 200, JSON.stringify(stopBody));
  assert.equal(stopBody.taskStatus, "completed");
});

test("internal recorder postprocesses completed segments with cover, remux, and source cleanup", async (t) => {
  const { logPath } = await withFakeFfmpeg(t);
  const previousBase = process.env.BILI_LIVE_API_BASE;
  const roomId = "66889";
  let fakeBaseUrl = "";

  const fakeBili = express();
  fakeBili.get("/room/v1/Room/room_init", (_req, res) => {
    res.json({ code: 0, data: { room_id: Number(roomId), live_status: 1 } });
  });
  fakeBili.get("/room/v1/Room/get_info", (_req, res) => {
    res.json({ code: 0, data: { title: "Postprocess Test Room" } });
  });
  fakeBili.get("/xlive/web-room/v2/index/getRoomPlayInfo", (_req, res) => {
    res.json({
      code: 0,
      data: {
        playurl_info: {
          playurl: {
            stream: [
              {
                format: [
                  {
                    format_name: "flv",
                    codec: [
                      {
                        codec_name: "avc",
                        current_qn: 10000,
                        base_url: "/fake-live-postprocess.flv",
                        url_info: [{ host: fakeBaseUrl, extra: "" }]
                      }
                    ]
                  }
                ]
              }
            ]
          }
        }
      }
    });
  });
  fakeBili.get("/fake-live-postprocess.flv", (_req, res) => {
    res.type("application/octet-stream");
    res.write(Buffer.from("FLV"));
    setTimeout(() => res.end(Buffer.from("postprocess-stream")), 20);
  });
  const fakeServer = await new Promise((resolve) => {
    const instance = fakeBili.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(fakeServer));
  fakeBaseUrl = `http://127.0.0.1:${fakeServer.address().port}`;
  process.env.BILI_LIVE_API_BASE = fakeBaseUrl;
  t.after(() => {
    if (previousBase === undefined) {
      delete process.env.BILI_LIVE_API_BASE;
    } else {
      process.env.BILI_LIVE_API_BASE = previousBase;
    }
  });

  const recordingsRoot = path.join(tempRoot, "internal-recorder-postprocess-output");
  await mkdir(path.join(tempRoot, ".workbench"), { recursive: true });
  await writeFile(
    path.join(tempRoot, ".workbench", "service-settings.json"),
    JSON.stringify({
      recordingsRoot,
      recording: {
        backend: "internal",
        outputDir: recordingsRoot,
        enableDanmaku: false,
        saveCover: true,
        remuxToMp4: true,
        injectExtraMetadata: true,
        deleteSourceAfterRemux: "always",
        spaceThresholdMb: 0,
        pollIntervalSeconds: 1,
        reconnectSeconds: 1
      },
      automation: { enabled: false }
    }),
    "utf8"
  );

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createApiRouter());
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(server));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const addRoom = await fetch(`${baseUrl}/api/recording/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomId, name: "Postprocess Test Room" })
  });
  assert.equal(addRoom.status, 200, await addRoom.text());

  let started = false;
  try {
    const start = await fetch(`${baseUrl}/api/recording/rooms/${roomId}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    const startBody = await start.json();
    assert.equal(start.status, 200, JSON.stringify(startBody));
    started = true;

    let postprocess = null;
    let cover = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await fetch(`${baseUrl}/api/recording/events?roomId=${roomId}`);
      const body = await response.json();
      postprocess = body.events.find((event) => event.type === "VideoPostprocessingCompletedEvent") || postprocess;
      cover = body.events.find((event) => event.type === "CoverImageDownloadedEvent") || cover;
      if (postprocess && cover) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(postprocess, "internal recorder should emit postprocess completion");
    assert.ok(cover, "internal recorder should emit cover completion");
    assert.match(postprocess.path, /\.mp4$/);
    assert.match(cover.path, /\.cover\.jpg$/);
    assert.match(await readFile(postprocess.path, "utf8"), /fake-remux/);
    assert.match(await readFile(cover.path, "utf8"), /fake-cover/);
    await assert.rejects(readFile(postprocess.data.source_path), /ENOENT/);
    const ffmpegLog = await readFile(logPath, "utf8");
    assert.match(ffmpegLog, /"-metadata"/);

    const stop = await fetch(`${baseUrl}/api/recording/rooms/${roomId}/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    started = false;
    const stopBody = await stop.json();
    assert.equal(stop.status, 200, JSON.stringify(stopBody));
    assert.equal(stopBody.taskStatus, "completed");
    assert.match(stopBody.recordingPath, /\.mp4$/);
  } finally {
    if (started) {
      await fetch(`${baseUrl}/api/recording/rooms/${roomId}/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      }).catch(() => null);
    }
  }
});

test("internal recorder keeps FLV when remuxed MP4 fails validation", async (t) => {
  await withFakeFfmpeg(t, { ffprobeSucceeds: false });
  const roomDir = path.join(tempRoot, `invalid-remux-${Date.now()}`);
  await mkdir(roomDir, { recursive: true });
  const videoPath = path.join(roomDir, "source.flv");
  const mp4Path = path.join(roomDir, "source.mp4");
  await writeFile(videoPath, "fake flv source", "utf8");
  const recorder = {
    roomId: "556677",
    realRoomId: "556677",
    roomName: "Invalid Remux Room",
    recordingSettings: {
      saveCover: false,
      remuxToMp4: true,
      injectExtraMetadata: false,
      deleteSourceAfterRemux: "always"
    },
    log: ""
  };

  const result = await __testing.postprocessInternalRecordingSegment(recorder, { videoPath, mp4Path });

  assert.equal(result.videoPath, videoPath);
  assert.equal(result.deletedSource, false);
  assert.equal((await stat(videoPath)).isFile(), true);
  assert.equal((await stat(mp4Path)).isFile(), true);
  assert.match(recorder.log, /验证失败/);
});

test("internal recorder captures websocket danmaku into xml and raw jsonl", async (t) => {
  const previousBase = process.env.BILI_LIVE_API_BASE;
  const roomId = "33889";
  let fakeBaseUrl = "";

  const fakeBili = express();
  fakeBili.get("/room/v1/Room/room_init", (_req, res) => {
    res.json({ code: 0, data: { room_id: Number(roomId), live_status: 1 } });
  });
  fakeBili.get("/room/v1/Room/get_info", (_req, res) => {
    res.json({ code: 0, data: { title: "Danmaku Test Room" } });
  });
  fakeBili.get("/xlive/web-room/v2/index/getRoomPlayInfo", (_req, res) => {
    res.json({
      code: 0,
      data: {
        playurl_info: {
          playurl: {
            stream: [
              {
                format: [
                  {
                    format_name: "flv",
                    codec: [
                      {
                        codec_name: "avc",
                        current_qn: 10000,
                        base_url: "/fake-live-danmaku.flv",
                        url_info: [{ host: fakeBaseUrl, extra: "" }]
                      }
                    ]
                  }
                ]
              }
            ]
          }
        }
      }
    });
  });
  fakeBili.get("/fake-live-danmaku.flv", (_req, res) => {
    res.type("application/octet-stream");
    res.write(Buffer.from("FLV"));
    const timer = setInterval(() => res.write(Buffer.from("mock-stream")), 80);
    setTimeout(() => {
      clearInterval(timer);
      res.end(Buffer.from("done"));
    }, 900);
  });
  const fakeServer = await new Promise((resolve) => {
    const instance = fakeBili.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(fakeServer));
  fakeBaseUrl = `http://127.0.0.1:${fakeServer.address().port}`;
  process.env.BILI_LIVE_API_BASE = fakeBaseUrl;
  t.after(() => {
    if (previousBase === undefined) {
      delete process.env.BILI_LIVE_API_BASE;
    } else {
      process.env.BILI_LIVE_API_BASE = previousBase;
    }
  });

  const danmakuServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => danmakuServer.once("listening", resolve));
  t.after(() => closeTestServer(danmakuServer));
  danmakuServer.on("connection", (socket) => {
    socket.once("message", () => {
      socket.send(createDanmakuPacket(5, JSON.stringify({ cmd: "DANMU_MSG", info: [[], "娴嬭瘯寮瑰箷"] })));
      socket.send(createDanmakuPacket(5, JSON.stringify({ cmd: "SEND_GIFT", data: { uname: "绀肩墿瑙備紬", giftName: "杈ｆ潯", num: 3, price: 1000, coin_type: "gold" } })));
      socket.send(createDanmakuPacket(5, JSON.stringify({ cmd: "SUPER_CHAT_MESSAGE", data: { user_info: { uname: "閱掔洰瑙備紬" }, price: 30, message: "杩欐鑳藉垏" } })));
      socket.send(createDanmakuPacket(5, JSON.stringify({ cmd: "GUARD_BUY", data: { username: "鑸伴暱瑙備紬", guard_level: 3, num: 1 } })));
    });
  });

  const recordingsRoot = path.join(tempRoot, "internal-recorder-danmaku-output");
  await mkdir(path.join(tempRoot, ".workbench"), { recursive: true });
  await writeFile(
    path.join(tempRoot, ".workbench", "service-settings.json"),
    JSON.stringify({
      recordingsRoot,
      recording: {
        backend: "internal",
        outputDir: recordingsRoot,
        enableDanmaku: true,
        saveRawDanmaku: true,
        danmakuServer: `ws://127.0.0.1:${danmakuServer.address().port}`,
        pollIntervalSeconds: 1,
        reconnectSeconds: 1
      },
      automation: { enabled: false }
    }),
    "utf8"
  );

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createApiRouter());
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(server));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const addRoom = await fetch(`${baseUrl}/api/recording/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomId, name: "Danmaku Test Room" })
  });
  assert.equal(addRoom.status, 200, await addRoom.text());

  const start = await fetch(`${baseUrl}/api/recording/rooms/${roomId}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  const startBody = await start.json();
  assert.equal(start.status, 200, JSON.stringify(startBody));

  let danmakuPath = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/recording/events?roomId=${roomId}`);
    const body = await response.json();
    danmakuPath = body.events.find((event) => event.type === "DanmakuFileCreatedEvent")?.path || danmakuPath;
    if (danmakuPath) {
      const xml = await readFile(danmakuPath, "utf8").catch(() => "");
      if (xml.includes("[礼物]") && xml.includes("[醒目留言") && xml.includes("[上舰]")) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const stop = await fetch(`${baseUrl}/api/recording/rooms/${roomId}/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  const stopBody = await stop.json();
  assert.equal(stop.status, 200, JSON.stringify(stopBody));
  assert.equal(stopBody.taskStatus, "completed");
  assert.ok(stopBody.danmakuCount > 0, "danmaku count should be recorded");
  assert.match(stopBody.danmakuPath, /\.xml$/);
  const xml = await readFile(stopBody.danmakuPath, "utf8");
  assert.match(xml, /\[礼物\]/);
  assert.match(xml, /\[醒目留言/);
  assert.match(xml, /\[上舰\]/);
  assert.match(xml, /<\/i>/);
  const rawPath = stopBody.danmakuPath.replace(/\.xml$/, ".raw.jsonl");
  assert.match(await readFile(rawPath, "utf8"), /DANMU_MSG/);
  assert.match(await readFile(rawPath, "utf8"), /SEND_GIFT/);
  assert.match(await readFile(rawPath, "utf8"), /SUPER_CHAT_MESSAGE/);
  assert.match(await readFile(rawPath, "utf8"), /GUARD_BUY/);
});

test("internal recorder signs danmaku info and sends cookie uid buvid in websocket auth", async (t) => {
  const previousLiveBase = process.env.BILI_LIVE_API_BASE;
  const previousWebBase = process.env.BILI_WEB_API_BASE;
  const roomId = "33891";
  let fakeBaseUrl = "";
  let danmakuPort = 0;
  let danmuInfoQuery = null;
  let authPayload = null;

  const danmakuServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => danmakuServer.once("listening", resolve));
  t.after(() => closeTestServer(danmakuServer));
  danmakuPort = danmakuServer.address().port;
  danmakuServer.on("connection", (socket) => {
    socket.once("message", (data) => {
      authPayload = JSON.parse(Buffer.from(data).subarray(16).toString("utf8"));
      socket.send(createDanmakuPacket(8, JSON.stringify({ code: 0 })));
      socket.send(createDanmakuPacket(5, JSON.stringify({ cmd: "DANMU_MSG", info: [[], "cookie signed danmaku"] })));
    });
  });

  const fakeBili = express();
  fakeBili.get("/x/web-interface/nav", (_req, res) => {
    res.json({
      code: 0,
      data: {
        wbi_img: {
          img_url: "https://i0.hdslb.com/bfs/wbi/abcdefghijklmnopqrstuvwxyz1234567890abcdefghij.png",
          sub_url: "https://i0.hdslb.com/bfs/wbi/klmnopqrstuvwxyz1234567890abcdefghijklmnopqrst.png"
        }
      }
    });
  });
  fakeBili.get("/room/v1/Room/room_init", (_req, res) => {
    res.json({ code: 0, data: { room_id: Number(roomId), live_status: 1 } });
  });
  fakeBili.get("/room/v1/Room/get_info", (_req, res) => {
    res.json({ code: 0, data: { title: "Signed Danmaku Room" } });
  });
  fakeBili.get("/xlive/web-room/v2/index/getRoomPlayInfo", (req, res) => {
    assert.ok(req.query.w_rid, "stream play info should be WBI signed");
    res.json({
      code: 0,
      data: {
        playurl_info: {
          playurl: {
            stream: [
              {
                format: [
                  {
                    format_name: "flv",
                    codec: [
                      {
                        codec_name: "avc",
                        current_qn: 10000,
                        base_url: "/signed-danmaku.flv",
                        url_info: [{ host: fakeBaseUrl, extra: "" }]
                      }
                    ]
                  }
                ]
              }
            ]
          }
        }
      }
    });
  });
  fakeBili.get("/xlive/web-room/v1/index/getDanmuInfo", (req, res) => {
    danmuInfoQuery = req.query;
    res.json({
      code: 0,
      data: {
        token: "signed-token",
        host_list: [{ scheme: "ws", host: "127.0.0.1", ws_port: danmakuPort, port: danmakuPort }]
      }
    });
  });
  fakeBili.get("/signed-danmaku.flv", (_req, res) => {
    res.type("application/octet-stream");
    res.write(Buffer.from("FLV"));
    setTimeout(() => res.end(Buffer.from("done")), 600);
  });
  const fakeServer = await new Promise((resolve) => {
    const instance = fakeBili.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(fakeServer));
  fakeBaseUrl = `http://127.0.0.1:${fakeServer.address().port}`;
  process.env.BILI_LIVE_API_BASE = fakeBaseUrl;
  process.env.BILI_WEB_API_BASE = fakeBaseUrl;
  t.after(() => {
    if (previousLiveBase === undefined) delete process.env.BILI_LIVE_API_BASE;
    else process.env.BILI_LIVE_API_BASE = previousLiveBase;
    if (previousWebBase === undefined) delete process.env.BILI_WEB_API_BASE;
    else process.env.BILI_WEB_API_BASE = previousWebBase;
  });

  const recordingsRoot = path.join(tempRoot, "internal-recorder-signed-danmaku-output");
  await mkdir(path.join(tempRoot, ".workbench", "drafts"), { recursive: true });
  await writeFile(
    path.join(tempRoot, ".workbench", "drafts", "cookies.json"),
    JSON.stringify([
      { name: "DedeUserID", value: "123456" },
      { name: "buvid3", value: "BUVID3-TEST" },
      { name: "SESSDATA", value: "fake-session" }
    ]),
    "utf8"
  );
  await writeFile(
    path.join(tempRoot, ".workbench", "service-settings.json"),
    JSON.stringify({
      recordingsRoot,
      recording: {
        backend: "internal",
        outputDir: recordingsRoot,
        enableDanmaku: true,
        pollIntervalSeconds: 1,
        reconnectSeconds: 1,
        remuxToMp4: false
      },
      automation: { enabled: false }
    }),
    "utf8"
  );

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createApiRouter());
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(server));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  await fetch(`${baseUrl}/api/recording/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomId, name: "Signed Danmaku Room" })
  });
  const start = await fetch(`${baseUrl}/api/recording/rooms/${roomId}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  assert.equal(start.status, 200, await start.text());

  let danmakuPath = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/recording/events?roomId=${roomId}`);
    const body = await response.json();
    danmakuPath = body.events.find((event) => event.type === "DanmakuFileCreatedEvent")?.path || danmakuPath;
    if (danmakuPath) {
      const xml = await readFile(danmakuPath, "utf8").catch(() => "");
      if (xml.includes("cookie signed danmaku")) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const stop = await fetch(`${baseUrl}/api/recording/rooms/${roomId}/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  assert.equal(stop.status, 200, await stop.text());
  assert.ok(danmuInfoQuery?.w_rid, "danmaku info should include WBI signature");
  assert.ok(danmuInfoQuery?.wts, "danmaku info should include WBI timestamp");
  assert.equal(danmuInfoQuery?.type, "0");
  assert.equal(danmuInfoQuery?.web_location, "444.8");
  assert.equal(authPayload?.uid, 123456);
  assert.equal(authPayload?.buvid, "BUVID3-TEST");
  assert.equal(authPayload?.key, "signed-token");
  assert.match(await readFile(danmakuPath, "utf8"), /cookie signed danmaku/);
});

test("internal recorder keeps one danmaku websocket across short stream reconnects", async (t) => {
  const previousBase = process.env.BILI_LIVE_API_BASE;
  const roomId = "33892";
  let fakeBaseUrl = "";
  let streamRequests = 0;
  let connections = 0;
  let latestSocket = null;

  const danmakuServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => danmakuServer.once("listening", resolve));
  t.after(() => closeTestServer(danmakuServer));
  const interval = setInterval(() => {
    if (latestSocket?.readyState === 1) {
      latestSocket.send(createDanmakuPacket(5, JSON.stringify({ cmd: "DANMU_MSG", info: [[], `same socket ${Date.now()}`] })));
    }
  }, 120);
  t.after(() => clearInterval(interval));
  danmakuServer.on("connection", (socket) => {
    connections += 1;
    latestSocket = socket;
    socket.once("message", () => {
      socket.send(createDanmakuPacket(8, JSON.stringify({ code: 0 })));
    });
  });

  const fakeBili = express();
  fakeBili.get("/room/v1/Room/room_init", (_req, res) => {
    res.json({ code: 0, data: { room_id: Number(roomId), live_status: 1 } });
  });
  fakeBili.get("/room/v1/Room/get_info", (_req, res) => {
    res.json({ code: 0, data: { title: "Short Stream Reconnect Room" } });
  });
  fakeBili.get("/xlive/web-room/v2/index/getRoomPlayInfo", (_req, res) => {
    res.json({
      code: 0,
      data: {
        playurl_info: {
          playurl: {
            stream: [
              {
                format: [
                  {
                    format_name: "flv",
                    codec: [
                      {
                        codec_name: "avc",
                        current_qn: 10000,
                        base_url: "/short-stream.flv",
                        url_info: [{ host: fakeBaseUrl, extra: `?n=${streamRequests}` }]
                      }
                    ]
                  }
                ]
              }
            ]
          }
        }
      }
    });
  });
  fakeBili.get("/short-stream.flv", (_req, res) => {
    streamRequests += 1;
    res.type("application/octet-stream");
    res.write(Buffer.from("FLV"));
    setTimeout(() => res.end(Buffer.from(`done-${streamRequests}`)), 350);
  });
  const fakeServer = await new Promise((resolve) => {
    const instance = fakeBili.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(fakeServer));
  fakeBaseUrl = `http://127.0.0.1:${fakeServer.address().port}`;
  process.env.BILI_LIVE_API_BASE = fakeBaseUrl;
  t.after(() => {
    if (previousBase === undefined) delete process.env.BILI_LIVE_API_BASE;
    else process.env.BILI_LIVE_API_BASE = previousBase;
  });

  const recordingsRoot = path.join(tempRoot, "internal-recorder-long-lived-danmaku-output");
  await mkdir(path.join(tempRoot, ".workbench"), { recursive: true });
  await writeFile(
    path.join(tempRoot, ".workbench", "service-settings.json"),
    JSON.stringify({
      recordingsRoot,
      recording: {
        backend: "internal",
        outputDir: recordingsRoot,
        enableDanmaku: true,
        danmakuServer: `ws://127.0.0.1:${danmakuServer.address().port}`,
        pollIntervalSeconds: 1,
        reconnectSeconds: 1,
        remuxToMp4: false
      },
      automation: { enabled: false }
    }),
    "utf8"
  );

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createApiRouter());
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(server));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  await fetch(`${baseUrl}/api/recording/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomId, name: "Short Stream Reconnect Room" })
  });
  const start = await fetch(`${baseUrl}/api/recording/rooms/${roomId}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  assert.equal(start.status, 200, await start.text());

  let secondDanmakuPath = "";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/recording/events?roomId=${roomId}`);
    const body = await response.json();
    const created = body.events.filter((event) => event.type === "DanmakuFileCreatedEvent").map((event) => event.path);
    if (created.length >= 2) {
      secondDanmakuPath = created[0];
      const xml = await readFile(secondDanmakuPath, "utf8").catch(() => "");
      if (xml.includes("same socket")) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  const stop = await fetch(`${baseUrl}/api/recording/rooms/${roomId}/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  assert.equal(stop.status, 200, await stop.text());
  assert.ok(streamRequests >= 2, "test should exercise at least two short stream requests");
  assert.equal(connections, 1, "danmaku websocket should stay open across stream reconnects");
  assert.match(await readFile(secondDanmakuPath, "utf8"), /same socket/);
});

test("internal recorder reconnects websocket danmaku after close", async (t) => {
  const previousBase = process.env.BILI_LIVE_API_BASE;
  const roomId = "33890";
  let fakeBaseUrl = "";

  const fakeBili = express();
  fakeBili.get("/room/v1/Room/room_init", (_req, res) => {
    res.json({ code: 0, data: { room_id: Number(roomId), live_status: 1 } });
  });
  fakeBili.get("/room/v1/Room/get_info", (_req, res) => {
    res.json({ code: 0, data: { title: "Danmaku Reconnect Room" } });
  });
  fakeBili.get("/xlive/web-room/v2/index/getRoomPlayInfo", (_req, res) => {
    res.json({
      code: 0,
      data: {
        playurl_info: {
          playurl: {
            stream: [
              {
                format: [
                  {
                    format_name: "flv",
                    codec: [
                      {
                        codec_name: "avc",
                        current_qn: 10000,
                        base_url: "/fake-live-danmaku-reconnect.flv",
                        url_info: [{ host: fakeBaseUrl, extra: "" }]
                      }
                    ]
                  }
                ]
              }
            ]
          }
        }
      }
    });
  });
  fakeBili.get("/fake-live-danmaku-reconnect.flv", (_req, res) => {
    res.type("application/octet-stream");
    res.write(Buffer.from("FLV"));
    const timer = setInterval(() => res.write(Buffer.from("mock-stream")), 80);
    setTimeout(() => {
      clearInterval(timer);
      res.end(Buffer.from("done"));
    }, 1300);
  });
  const fakeServer = await new Promise((resolve) => {
    const instance = fakeBili.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(fakeServer));
  fakeBaseUrl = `http://127.0.0.1:${fakeServer.address().port}`;
  process.env.BILI_LIVE_API_BASE = fakeBaseUrl;
  t.after(() => {
    if (previousBase === undefined) {
      delete process.env.BILI_LIVE_API_BASE;
    } else {
      process.env.BILI_LIVE_API_BASE = previousBase;
    }
  });

  const danmakuServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => danmakuServer.once("listening", resolve));
  t.after(() => closeTestServer(danmakuServer));
  let connections = 0;
  danmakuServer.on("connection", (socket) => {
    connections += 1;
    socket.once("message", () => {
      if (connections === 1) {
        socket.send(createDanmakuPacket(5, JSON.stringify({ cmd: "DANMU_MSG", info: [[], "first socket message"] })));
        socket.close(4000, "test reconnect");
        return;
      }
      socket.send(createDanmakuPacket(5, JSON.stringify({ cmd: "DANMU_MSG", info: [[], "reconnected danmaku message"] })));
    });
  });

  const recordingsRoot = path.join(tempRoot, "internal-recorder-danmaku-reconnect-output");
  await mkdir(path.join(tempRoot, ".workbench"), { recursive: true });
  await writeFile(
    path.join(tempRoot, ".workbench", "service-settings.json"),
    JSON.stringify({
      recordingsRoot,
      recording: {
        backend: "internal",
        outputDir: recordingsRoot,
        enableDanmaku: true,
        danmakuServer: `ws://127.0.0.1:${danmakuServer.address().port}`,
        pollIntervalSeconds: 1,
        reconnectSeconds: 0.2,
        danmakuReconnectSeconds: 0.2
      },
      automation: { enabled: false }
    }),
    "utf8"
  );

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createApiRouter());
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => closeTestServer(server));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const addRoom = await fetch(`${baseUrl}/api/recording/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomId, name: "Danmaku Reconnect Room" })
  });
  assert.equal(addRoom.status, 200, await addRoom.text());

  const start = await fetch(`${baseUrl}/api/recording/rooms/${roomId}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  assert.equal(start.status, 200, await start.text());

  let danmakuPath = "";
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/recording/events?roomId=${roomId}`);
    const body = await response.json();
    danmakuPath = body.events.find((event) => event.type === "DanmakuFileCreatedEvent")?.path || danmakuPath;
    if (danmakuPath) {
      const xml = await readFile(danmakuPath, "utf8").catch(() => "");
      if (xml.includes("reconnected danmaku message")) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const stop = await fetch(`${baseUrl}/api/recording/rooms/${roomId}/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  const stopBody = await stop.json();
  assert.equal(stop.status, 200, JSON.stringify(stopBody));
  assert.ok(connections >= 2, "danmaku websocket should reconnect after a close");
  const xml = await readFile(stopBody.danmakuPath, "utf8");
  assert.match(xml, /first socket message/);
  assert.match(xml, /reconnected danmaku message/);
});
