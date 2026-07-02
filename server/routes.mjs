import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile, spawn, spawnSync } from "node:child_process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import zlib from "node:zlib";
import express from "express";
import { XMLParser } from "fast-xml-parser";
import mime from "mime-types";
import WebSocket from "ws";
import {
  buildFlvConvertArgs,
  getFfprobeInvocation,
  getFlvTargetPath,
  getFfmpegInvocation,
  normalizeMediaSettings
} from "./media.mjs";

const execFileAsync = promisify(execFile);

const defaultRecordingsRoot = "";
const workbenchRoot = path.resolve(process.env.BILIVE_WORKBENCH_ROOT || path.join(process.cwd(), ".workbench"));
const thumbsDir = path.join(workbenchRoot, "thumbs");
const projectsDir = path.join(workbenchRoot, "projects");
const exportsDir = path.join(workbenchRoot, "exports");
const draftsDir = path.join(workbenchRoot, "drafts");
const previewsDir = path.join(workbenchRoot, "previews");
const modelAssetsDir = path.join(workbenchRoot, "model-assets");
const coversDir = path.join(workbenchRoot, "covers");
const asrDir = path.join(workbenchRoot, "asr");
const modelsRoot = path.join(workbenchRoot, "models");
const toolsDir = path.join(workbenchRoot, "tools");
const downloadsDir = path.join(workbenchRoot, "downloads");
const timelineDir = path.join(workbenchRoot, "timeline");
const recordingEventsPath = path.join(timelineDir, "recording-events.jsonl");
const automationJobsPath = path.join(timelineDir, "automation-jobs.json");
const fixedRoomsPath = path.join(workbenchRoot, "fixed-rooms.json");
const hiddenMaterialRoomsPath = path.join(workbenchRoot, "hidden-material-rooms.json");
const recordingVerificationPath = path.join(workbenchRoot, "recording-verification.json");
const biliupVenvDir = path.join(toolsDir, "biliup-venv");
const asrVenvDir = path.join(toolsDir, "asr-venv");
const funasrRunnerPath = path.join(process.cwd(), "server", "funasr_runner.py");
const serviceSettingsPath = path.join(workbenchRoot, "service-settings.json");
const qwenReleaseDir = path.join(toolsDir, "qwen3-asr-release");
const qwenReleaseRoot = path.join(qwenReleaseDir, "Qwen3-ASR-Transcribe");
const qwenTranscribeExe = path.join(qwenReleaseRoot, "transcribe.exe");
const qwenModelRoot = path.join(modelsRoot, "qwen3-asr-gguf");
const qwenReleaseZipName = "Qwen3-ASR-Transcribe-20260223.zip";
const qwenReleaseZipUrl = `https://github.com/HaujetZhao/Qwen3-ASR-GGUF/releases/download/v0.1/${qwenReleaseZipName}`;
const defaultSlicePrompt = [
  "你是一个看直播切片的剪辑师，不是质检员。先判断这个点会不会让人想点开、看完、转发。",
  "不要为了凑数量硬选；宁愿少给，也别把普通聊天包装成高能。",
  "标题要像真实 B 站短切片标题：口语、有钩子、能让人知道笑点或反差在哪；少用“高能来袭”“名场面”这类空泛词。",
  "理由写给剪辑的人看，一两句话就够：说清包袱、反差、节奏变化、观众反应或画面/声音为什么成立。",
  "证据要短而具体，优先引用弹幕原话、字幕台词、画面动作、频谱变化；不要写“多信号综合判断”这种废话。"
].join("\n");
const qwenModelAssets = {
  "0.6B": {
    name: "Qwen3-ASR-0.6B-gguf.zip",
    url: "https://github.com/HaujetZhao/Qwen3-ASR-GGUF/releases/download/models/Qwen3-ASR-0.6B-gguf.zip",
    minBytes: 500_000_000
  },
  "1.7B": {
    name: "Qwen3-ASR-1.7B-gguf.zip",
    url: "https://github.com/HaujetZhao/Qwen3-ASR-GGUF/releases/download/models/Qwen3-ASR-1.7B-gguf.zip",
    minBytes: 900_000_000
  }
};
const qwenAlignerAsset = {
  name: "Qwen3-ForceAligner-0.6B-gguf.zip",
  url: "https://github.com/HaujetZhao/Qwen3-ASR-GGUF/releases/download/models/Qwen3-ForceAligner-0.6B-gguf.zip",
  minBytes: 450_000_000
};

const videoExtensions = new Set([".mp4", ".mkv", ".flv", ".mov", ".avi", ".ts"]);
const subtitleExtensions = new Set([".srt", ".vtt", ".ass"]);
const mediaCache = new Map();
const previewJobs = new Map();
const asrJobs = new Map();
const uploadJobs = new Map();
const modelJobs = new Map();
const transcodeJobs = new Map();
const recordingJobs = new Map();
const recordingRoomStatuses = new Map();
const internalRecorders = new Map();
const roomLiveMonitors = new Map();
const fixedRoomMetadataFailureAt = new Map();
const automationJobs = new Map();
let recordingMonitorTimer = null;
let recordingMonitorRunning = false;
let recordingMonitorLastResult = null;
let recordingMonitorNextRunAt = null;
let recordingMonitorActivated = false;
let automationReconcileLastAt = 0;
let automationReconcileRunning = false;
let biliWbiKeyCache = null;

const biliWbiMixinKeyEncTab = [
  46, 47, 18, 2, 53, 8, 23, 32,
  15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19,
  29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63,
  57, 62, 11, 36, 20, 34, 44, 52
];

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  textNodeName: "text",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false
});

export function createApiRouter() {
  ensureWorkspace();

  const router = express.Router();

  router.get("/settings", async (_req, res) => {
    const serviceSettings = await readServiceSettings();
    const recordingsRoot = serviceSettings.recordingsRoot;
    res.json({
      recordingsRoot,
      rootExists: Boolean(recordingsRoot) && fs.existsSync(recordingsRoot),
      recordingRootCandidates: await listRecordingRootCandidates(recordingsRoot),
      ffmpeg: commandExists("ffmpeg"),
      ffprobe: commandExists("ffprobe"),
      uploadTools: getUploadTools(),
      uploadDefaults: getUploadDefaults(),
      serviceSettings,
      asrTools: getLocalAsrStatus(),
      recording: {
        recorder: getInternalRecorderHealth(serviceSettings.recording),
        internal: getInternalRecorderHealth(serviceSettings.recording),
        limits: getRecordingLimits(serviceSettings.recording)
      }
    });
  });

  router.get("/service-settings", async (_req, res) => {
    try {
      res.json(await readServiceSettings());
    } catch (error) {
      res.status(500).json({ error: readableError(error) });
    }
  });

  router.get("/recording-roots", async (_req, res) => {
    try {
      res.json({ candidates: await listRecordingRootCandidates() });
    } catch (error) {
      res.status(500).json({ error: readableError(error) });
    }
  });

  router.get("/tasks", (_req, res) => {
    res.json({ tasks: listWorkbenchTasks() });
  });

  router.get("/automation/jobs", async (_req, res) => {
    try {
      res.json({ jobs: await listAutomationJobs() });
    } catch (error) {
      res.status(500).json({ error: readableError(error) });
    }
  });

  router.post("/automation/analyze", async (req, res) => {
    try {
      const videoPath = decodeAllowedKey(req.body.videoKey);
      const settings = await readServiceSettings();
      const roomPath = findRoomPath(videoPath);
      const roomFiles = collectFiles(roomPath, 2);
      const room = parseRoomName(path.basename(roomPath), roomFiles, roomPath);
      const job = await createAutomationJob({
        roomId: room.roomId,
        videoPath,
        trigger: "manual",
        uploadPolicy: req.body.uploadPolicy || settings.automation.uploadPolicy
      });
      void runAutomationJob(job.id).catch((error) => markAutomationJobError(job.id, error));
      res.json({ ok: true, job });
    } catch (error) {
      res.status(500).json({ error: readableError(error) });
    }
  });

  router.post("/automation/jobs/:jobId/run", async (req, res) => {
    try {
      const job = await runAutomationJob(req.params.jobId, req.body || {});
      res.json({ ok: true, job });
    } catch (error) {
      res.status(500).json({ error: readableError(error) });
    }
  });

  router.get("/recording/config", async (_req, res) => {
    try {
      const settings = await readServiceSettings();
      const rooms = await readFixedRooms({ enrichMetadata: true });
      res.json({
        settings: settings.recording,
        recorder: getInternalRecorderHealth(settings.recording),
        internal: getInternalRecorderHealth(settings.recording),
        limits: getRecordingLimits(settings.recording),
        rooms: rooms.map(publicFixedRoom)
      });
    } catch (error) {
      res.status(500).json({ error: readableError(error) });
    }
  });

  router.get("/recording/monitor/status", async (_req, res) => {
    try {
      res.json(await getRecordingAutoMonitorStatus());
    } catch (error) {
      res.status(500).json({ error: readableError(error) });
    }
  });

  router.get("/image-proxy", async (req, res) => {
    try {
      const url = validateProxyImageUrl(req.query.url);
      const response = await fetch(url, { headers: getBiliHeaders("") });
      if (!response.ok) throw new Error(`图片读取失败：${response.status}`);
      res.setHeader("Content-Type", response.headers.get("content-type") || "image/jpeg");
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.send(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      res.status(400).json({ error: readableError(error) });
    }
  });

  router.post("/recording/config", async (req, res) => {
    try {
      const current = await readServiceSettings();
      const settings = normalizeServiceSettings({
        ...current,
        recording: { ...current.recording, ...(req.body?.recording || req.body || {}) }
      });
      await fsp.writeFile(serviceSettingsPath, JSON.stringify(settings, null, 2), "utf8");
      applyRecordingMonitorSettings(settings.recording);
      res.json({
        ok: true,
        settings: settings.recording,
        recorder: getInternalRecorderHealth(settings.recording),
        internal: getInternalRecorderHealth(settings.recording),
        limits: getRecordingLimits(settings.recording)
      });
    } catch (error) {
      res.status(500).json({ error: readableError(error) });
    }
  });

  router.post("/recording/monitor/sweep", async (_req, res) => {
    try {
      const result = await runRecordingAutoMonitorSweep({ manual: true });
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(500).json({ error: readableError(error) });
    }
  });

  router.post("/recording/events/webhook", async (req, res) => {
    try {
      const event = await ingestRecordingEventWebhook(req.body || {});
      res.json({ ok: true, event });
    } catch (error) {
      res.status(400).json({ error: readableError(error) });
    }
  });


  router.get("/recording/events", async (req, res) => {
    try {
      res.json({
        events: await readRecordingEvents({
          roomId: req.query.roomId,
          limit: req.query.limit
        })
      });
    } catch (error) {
      res.status(500).json({ error: readableError(error) });
    }
  });

  router.get("/recording/rooms/:roomId/events", async (req, res) => {
    try {
      res.json({
        roomId: normalizeRoomId(req.params.roomId),
        events: await readRecordingEvents({ roomId: req.params.roomId, limit: req.query.limit })
      });
    } catch (error) {
      res.status(500).json({ error: readableError(error) });
    }
  });

  router.get("/recording/rooms", async (req, res) => {
    try {
      const enrichMetadata = !["0", "false", "no"].includes(String(req.query.enrich || "1").toLowerCase());
      const rooms = await readFixedRooms({ enrichMetadata });
      res.json({ rooms: rooms.map(publicFixedRoom) });
    } catch (error) {
      res.status(500).json({ error: readableError(error) });
    }
  });

  router.post("/recording/rooms", async (req, res) => {
    try {
      const rooms = await readFixedRooms();
      let room = normalizeFixedRoom(req.body);
      if (!room.roomId) throw new Error("需要填写直播间 ID。");
      if (rooms.some((item) => item.roomId === room.roomId)) {
        throw new Error(`房间 ${room.roomId} 已存在。`);
      }
      const settings = await readServiceSettings();
      room = await enrichFixedRoomMetadata(room, settings.recording);
      rooms.push(room);
      await writeFixedRooms(rooms);
      if (room.enabled !== false && settings.recording.autoMonitorEnabled !== false) {
        setRoomRuntimeStatus(room.roomId, {
          taskStatus: "waiting",
          liveStatus: room.biliLiveStatus || "unknown",
          message: "已加入自动录制，开播后会自动录制",
          nextAction: "stop",
          log: `房间 ${room.roomId} 已加入自动录制\n`
        });
        if (recordingMonitorActivated) {
          startRoomLiveMonitor(room, settings.recording);
          scheduleRecordingAutoMonitor(Math.max(1000, Number(settings.recording.pollIntervalSeconds || 600) * 1000));
        }
      }
      res.json({ ok: true, room: publicFixedRoom(room), rooms: rooms.map(publicFixedRoom) });
    } catch (error) {
      res.status(400).json({ error: readableError(error) });
    }
  });

  router.patch("/recording/rooms/:roomId", async (req, res) => {
    try {
      const rooms = await readFixedRooms();
      const index = rooms.findIndex((room) => room.roomId === req.params.roomId);
      if (index < 0) throw new Error(`房间 ${req.params.roomId} 不存在。`);
      rooms[index] = normalizeFixedRoom({ ...rooms[index], ...(req.body || {}), roomId: rooms[index].roomId });
      await writeFixedRooms(rooms);
      if (rooms[index].enabled === false) {
        stopIdleInternalRoomMonitor(rooms[index].roomId);
        stopRoomLiveMonitor(rooms[index].roomId);
        const assets = await scanRecordingAssetsForRoom(rooms[index].roomId);
        setRoomRuntimeStatus(rooms[index].roomId, {
          ...assets,
          taskStatus: assets.recordingPath ? "completed" : "idle",
          liveStatus: rooms[index].biliLiveStatus || "unknown",
          message: "自动录制已关闭",
          nextAction: "start",
          refreshed: Boolean(assets.recordingPath)
        });
      } else {
        setRoomRuntimeStatus(rooms[index].roomId, {
          taskStatus: "waiting",
          liveStatus: rooms[index].biliLiveStatus || "unknown",
          message: "自动录制已开启，开播后会自动录制",
          nextAction: "stop",
          log: `房间 ${rooms[index].roomId} 自动录制已开启\n`
        });
        if (recordingMonitorActivated) {
          startRoomLiveMonitor(rooms[index], (await readServiceSettings()).recording);
          scheduleRecordingAutoMonitor(1000);
        }
      }
      res.json({ ok: true, room: publicFixedRoom(rooms[index]), rooms: rooms.map(publicFixedRoom) });
    } catch (error) {
      res.status(404).json({ error: readableError(error) });
    }
  });

  router.delete("/recording/rooms/:roomId", async (req, res) => {
    try {
      const roomId = normalizeRoomId(req.params.roomId);
      const status = getRoomRuntimeStatus(roomId);
      if (isActiveRecordingStatus(status)) {
        throw new Error("正在录制的房间不能移除，请先停止录制。");
      }
      stopIdleInternalRoomMonitor(roomId);
      stopRoomLiveMonitor(roomId);
      const rooms = await readFixedRooms();
      const kept = rooms.filter((room) => room.roomId !== roomId);
      if (kept.length === rooms.length) throw new Error(`房间 ${req.params.roomId} 不存在。`);
      await writeFixedRooms(kept);
      recordingRoomStatuses.delete(roomId);
      res.json({ ok: true, rooms: kept.map(publicFixedRoom) });
    } catch (error) {
      const message = readableError(error);
      res.status(message.includes("正在录制") ? 409 : 404).json({ error: message });
    }
  });

  router.get("/recording/rooms/:roomId", async (req, res) => {
    try {
      const room = await findFixedRoom(req.params.roomId);
      if (!room) throw new Error(`房间 ${req.params.roomId} 不存在。`);
      res.json(publicFixedRoom(room));
    } catch (error) {
      res.status(404).json({ error: readableError(error) });
    }
  });

  router.post("/recording/rooms/:roomId/start", async (req, res) => {
    try {
      const status = await startRecordingRoom(req.params.roomId, req.body || {});
      res.json(status);
    } catch (error) {
      const payload = publicRecordingStatus(req.params.roomId, {
        taskStatus: "error",
        message: readableError(error),
        nextAction: "edit",
        log: readableError(error)
      });
      res.status(409).json({ error: readableError(error), ...payload });
    }
  });

  router.post("/recording/rooms/:roomId/stop", async (req, res) => {
    try {
      res.json(await stopRecordingRoom(req.params.roomId, req.body || {}));
    } catch (error) {
      const payload = publicRecordingStatus(req.params.roomId, {
        taskStatus: "error",
        message: readableError(error),
        nextAction: "retry",
        log: readableError(error)
      });
      res.status(500).json({ error: readableError(error), ...payload });
    }
  });

  router.post("/recording/rooms/:roomId/retry", async (req, res) => {
    try {
      res.json(await startRecordingRoom(req.params.roomId, req.body || {}));
    } catch (error) {
      res.status(409).json({ error: readableError(error) });
    }
  });

  router.get("/recording/rooms/:roomId/logs", async (req, res) => {
    const status = getRoomRuntimeStatus(req.params.roomId);
    res.json({ roomId: req.params.roomId, log: redactSecrets(status.log || "") });
  });

  router.post("/recording/verify-real", async (req, res) => {
    try {
      const record = {
        ...req.body,
        updatedAt: new Date().toISOString()
      };
      await fsp.writeFile(recordingVerificationPath, JSON.stringify(record, null, 2), "utf8");
      res.json({ ok: true, record });
    } catch (error) {
      res.status(500).json({ error: readableError(error) });
    }
  });

  router.post("/service-settings", async (req, res) => {
    try {
      const settings = normalizeServiceSettings(req.body);
      await fsp.writeFile(serviceSettingsPath, JSON.stringify(settings, null, 2), "utf8");
      applyRecordingMonitorSettings(settings.recording);
      res.json({ ok: true, settings });
    } catch (error) {
      res.status(500).json({ error: readableError(error) });
    }
  });

  router.post("/vision/test", async (req, res) => {
    try {
      const current = await readServiceSettings();
      const settings = normalizeServiceSettings({ vision: { ...current.vision, ...(req.body || {}) } });
      const startedAt = Date.now();
      const response = await callJsonEndpoint(settings.vision, {
        task: "connection_test",
        model: settings.vision.model,
        instruction: "返回 JSON：{\"ok\":true,\"message\":\"模型服务可用\"}。",
        sample: "ping"
      });
      res.json({
        ok: true,
        elapsedMs: Date.now() - startedAt,
        endpoint: settings.vision.endpoint,
        wireApi: settings.vision.wireApi,
        model: settings.vision.model,
        response
      });
    } catch (error) {
      const diagnostic = readableVisionError(error);
      res.status(500).json({ error: diagnostic.message, diagnostic });
    }
  });

  router.get("/rooms", async (_req, res) => {
    try {
      const rooms = await listRooms();
      res.json({ root: getRecordingsRoot(), rooms });
    } catch (error) {
      res.status(500).json({ error: readableError(error) });
    }
  });

  router.delete("/rooms/:roomKey", async (req, res) => {
    try {
      const roomPath = decodeAllowedKey(req.params.roomKey);
      await hideMaterialRoom(roomPath);
      const rooms = await listRooms();
      res.json({
        ok: true,
        hiddenRoom: {
          key: encodeKey(roomPath),
          path: roomPath,
          folderName: path.basename(roomPath)
        },
        rooms
      });
    } catch (error) {
      res.status(500).json({ error: readableError(error) });
    }
  });

  router.get("/rooms/:roomKey", async (req, res) => {
    try {
      const roomPath = decodeAllowedKey(req.params.roomKey);
      const room = await getRoomDetail(roomPath);
      res.json(room);
    } catch (error) {
      res.status(500).json({ error: readableError(error) });
    }
  });

  router.get("/videos/:videoKey/context", async (req, res) => {
    try {
      const videoPath = decodeAllowedKey(req.params.videoKey);
      const context = await getVideoContext(videoPath);
      res.json(context);
    } catch (error) {
      res.status(500).json({ error: readableError(error) });
    }
  });

  router.get("/preview/status", async (req, res) => {
    try {
      const key = String(req.query.key || "");
      const videoPath = decodeAllowedKey(key);
      res.json(await getPreviewStatus(videoPath));
    } catch (error) {
      res.status(500).json({ error: readableError(error) });
    }
  });

  router.post("/preview/start", async (req, res) => {
    try {
      const videoPath = decodeAllowedKey(req.body.videoKey);
      const status = await startPreviewJob(videoPath);
      res.json(status);
    } catch (error) {
      res.status(500).json({ error: readableError(error) });
    }
  });

  router.get("/media", async (req, res) => {
    try {
      const key = String(req.query.key || "");
      const mediaPath = decodeAllowedKey(key);
      await streamMedia(req, res, mediaPath);
    } catch (error) {
      res.status(404).json({ error: readableError(error) });
    }
  });

  router.get("/thumbnail", async (req, res) => {
    let label = "video";
    try {
      const key = String(req.query.key || "");
      const videoPath = decodeAllowedKey(key);
      label = path.basename(videoPath);
      const thumbPath = await ensureThumbnail(videoPath);
      if (thumbPath) {
        res.type("jpg").send(await fsp.readFile(thumbPath));
        return;
      }
      res.type("svg").send(makeFallbackCover(label));
    } catch {
      res.type("svg").send(makeFallbackCover(label));
    }
  });

  router.post("/ai/slices", async (req, res) => {
    try {
      const videoPath = decodeAllowedKey(req.body.videoKey);
      const context = await getVideoContext(videoPath);
      const settings = await readServiceSettings();
      const localCandidates = buildSliceCandidates(context, req.body);
      const result = await enhanceSliceCandidatesWithModelResult(context, req.body, localCandidates, settings);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: readableError(error) });
    }
  });

  router.post("/ai/title", async (req, res) => {
    try {
      const videoPath = decodeAllowedKey(req.body.videoKey);
      const context = await getVideoContext(videoPath);
      const settings = await readServiceSettings();
      const job = createModelJob("title-generate", "正在生成标题");
      const result = await generateTitleSuggestion(context, req.body, settings, job);
      res.json({ ok: true, ...result, job: publicModelJob(job) });
    } catch (error) {
      res.status(500).json({ error: readableError(error) });
    }
  });

  router.post("/clips/export", async (req, res) => {
    try {
      const videoPath = decodeAllowedKey(req.body.videoKey);
      const result = await exportClip(videoPath, req.body);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: readableError(error) });
    }
  });

  router.post("/model-assets/package", async (req, res) => {
    try {
      const videoPath = decodeAllowedKey(req.body.videoKey);
      const result = await packageModelAssets(videoPath, req.body);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: readableError(error) });
    }
  });

  router.post("/covers/extract", async (req, res) => {
    try {
      const videoPath = decodeAllowedKey(req.body.videoKey);
      const result = await extractCoverFrame(videoPath, req.body);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: readableError(error) });
    }
  });

  router.post("/covers/generate", async (req, res) => {
    try {
      const videoPath = decodeAllowedKey(req.body.videoKey);
      const settings = await readServiceSettings();
      const job = createModelJob("cover-generate", "正在生成封面");
      const result = await generateCoverImage(videoPath, req.body, settings, job);
      res.json({ ok: true, ...result, job: publicModelJob(job) });
    } catch (error) {
      res.status(500).json({ error: readableError(error) });
    }
  });

  router.post("/asr/start", async (req, res) => {
    try {
      const videoPath = decodeAllowedKey(req.body.videoKey);
      const result = await startAsrJob(videoPath, req.body);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: readableError(error) });
    }
  });

  router.post("/asr/prepare", async (req, res) => {
    try {
      const settings = normalizeServiceSettings({ asr: req.body || {} });
      const job = createModelJob("asr-prepare", "正在准备本地 ASR 模型");
      void prepareAsrProvider(job, settings.asr).catch((error) => {
        job.status = "error";
        job.progress = 0;
        job.message = readableError(error);
        job.updatedAt = new Date().toISOString();
      });
      res.json({ ok: true, job: normalizeTask("model", "ASR 模型准备", publicModelJob(job)), asrTools: getLocalAsrStatus() });
    } catch (error) {
      res.status(500).json({ error: readableError(error) });
    }
  });

  router.post("/media/convert-flv", async (req, res) => {
    try {
      const settings = await readServiceSettings();
      const selectedVideoPaths = Array.isArray(req.body?.videoKeys)
        ? req.body.videoKeys.map((key) => decodeAllowedKey(key))
        : [];
      const roomPath = !selectedVideoPaths.length && req.body?.roomKey ? decodeAllowedKey(req.body.roomKey) : null;
      const job = createTranscodeJob(selectedVideoPaths.length
        ? `正在转换 ${selectedVideoPaths.length} 个已选 FLV`
        : roomPath ? `正在转换房间 FLV：${path.basename(roomPath)}` : "正在批量转换全部 FLV");
      void runFlvConvertJob(job, settings, roomPath, selectedVideoPaths).catch((error) => {
        job.status = "error";
        job.progress = 0;
        job.message = readableError(error);
        job.updatedAt = new Date().toISOString();
      });
      res.json({ ok: true, job: normalizeTask("transcode", "FLV 转 MP4", publicTranscodeJob(job)) });
    } catch (error) {
      res.status(500).json({ error: readableError(error) });
    }
  });

  router.get("/asr/status/:jobId", async (req, res) => {
    const job = asrJobs.get(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "ASR job not found." });
      return;
    }
    res.json(publicJob(job));
  });

  router.get("/projects/:videoKey", async (req, res) => {
    try {
      const videoPath = decodeAllowedKey(req.params.videoKey);
      const file = getProjectPath(videoPath);
      if (!fs.existsSync(file)) {
        res.json({ clips: [], danmakuEdits: {}, subtitles: null, updatedAt: null });
        return;
      }
      res.json(JSON.parse(await fsp.readFile(file, "utf8")));
    } catch (error) {
      res.status(500).json({ error: readableError(error) });
    }
  });

  router.post("/projects/:videoKey", async (req, res) => {
    try {
      const videoPath = decodeAllowedKey(req.params.videoKey);
      const file = getProjectPath(videoPath);
      const body = { ...req.body, videoPath, updatedAt: new Date().toISOString() };
      await fsp.writeFile(file, JSON.stringify(body, null, 2), "utf8");
      res.json({ ok: true, path: file, updatedAt: body.updatedAt });
    } catch (error) {
      res.status(500).json({ error: readableError(error) });
    }
  });

  router.get("/upload/tools", (_req, res) => {
    res.json(getUploadTools());
  });

  router.post("/upload/command", async (req, res) => {
    try {
      res.json(buildBiliupCommand(req.body));
    } catch (error) {
      res.status(500).json({ error: readableError(error) });
    }
  });

  router.post("/upload/preflight", async (req, res) => {
    try {
      res.json(preflightUpload(req.body?.draft || req.body || {}));
    } catch (error) {
      res.status(500).json({ error: readableError(error) });
    }
  });

  router.post("/upload/install-biliup", async (_req, res) => {
    try {
      const current = getUploadTools();
      if (current.biliup) {
        res.json({
          ok: true,
          skipped: true,
          message: `已检测到 biliup：${current.biliupPath}`
        });
        return;
      }
      const job = createUploadJob("install-biliup", "正在安装工作区本地 biliup");
      runBiliupInstallJob(job);
      res.json(publicUploadJob(job));
    } catch (error) {
      res.status(500).json({ error: readableError(error) });
    }
  });

  router.get("/upload/jobs/:jobId", (req, res) => {
    const job = uploadJobs.get(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "Upload job not found." });
      return;
    }
    res.json(publicUploadJob(job));
  });

  router.post("/upload/history", async (req, res) => {
    try {
      res.json(await runBiliupReadCommand("list", req.body));
    } catch (error) {
      res.status(500).json({ error: readableError(error) });
    }
  });

  router.post("/upload/show", async (req, res) => {
    try {
      const vid = String(req.body?.vid || "").trim();
      if (!vid) throw new Error("需要 BV 或 av 号。");
      res.json(await runBiliupReadCommand("show", { ...req.body, vid }));
    } catch (error) {
      res.status(500).json({ error: readableError(error) });
    }
  });

  router.post("/upload/login", async (req, res) => {
    try {
      const tools = getUploadTools();
      if (!tools.biliup) {
        res.status(501).json({
          ok: false,
          message: "未检测到 biliup。请先安装本地 biliup，再启动扫码登录。",
          suggestedCommands: ["python -m venv .workbench/tools/biliup-venv", ".workbench/tools/biliup-venv/Scripts/python.exe -m pip install biliup==1.1.29"]
        });
        return;
      }
      const cookiePath = String(req.body?.cookiePath || tools.cookiePath);
      const job = await startBiliupLoginJob(tools, cookiePath, req.body?.launch !== false);
      res.json(publicUploadJob(job));
    } catch (error) {
      res.status(500).json({ error: readableError(error) });
    }
  });

  router.post("/upload/run", async (req, res) => {
    try {
      const draft = req.body?.draft || {};
      const policy = evaluateUploadPolicy(draft, { confirmed: Boolean(req.body?.confirm) });
      if (!policy.canRun) {
        res.status(400).json({ error: policy.issues[0] || "Upload policy blocked this run.", policy });
        return;
      }
      Object.assign(draft, policy.effectiveDraft);
      if (!req.body?.confirm) {
        res.status(400).json({ error: "执行真实投稿需要 confirm=true。" });
        return;
      }
      if (draft.autoSubmit !== true) {
        res.status(400).json({ error: "执行真实投稿需要最终执行确认。" });
        return;
      }
      const preflight = preflightUpload(draft);
      if (!preflight.ok) {
        res.status(400).json(preflight);
        return;
      }
      const payload = buildBiliupCommand({ draft });
      const job = createUploadJob("biliup-run", draft.publishMode === "append" ? "正在追加分 P" : "正在投稿");
      job.policy = policy;
      runProcessJob(job, payload.executablePath, payload.args, { cwd: process.cwd(), timeoutMs: 1000 * 60 * 60 * 6 });
      res.json(publicUploadJob(job));
    } catch (error) {
      res.status(500).json({ error: readableError(error) });
    }
  });

  router.post("/upload/draft", async (req, res) => {
    try {
      const file = path.join(draftsDir, "latest-upload-draft.json");
      await fsp.writeFile(file, JSON.stringify({ ...req.body, updatedAt: new Date().toISOString() }, null, 2), "utf8");
      res.json({ ok: true, path: file });
    } catch (error) {
      res.status(500).json({ error: readableError(error) });
    }
  });

  return router;
}

function ensureWorkspace() {
  for (const dir of [workbenchRoot, thumbsDir, projectsDir, exportsDir, draftsDir, previewsDir, modelAssetsDir, coversDir, asrDir, modelsRoot, toolsDir, downloadsDir, timelineDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function commandExists(command) {
  const result = spawnSync("where.exe", [command], { encoding: "utf8" });
  return result.status === 0;
}

function commandPath(command) {
  const result = spawnSync("where.exe", [command], { encoding: "utf8" });
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] || null;
}

function commandOutput(command, args = []) {
  const result = spawnSync(command, args, { cwd: workbenchRoot, encoding: "utf8", timeout: 10000, env: makeCliEnv() });
  if (result.status !== 0) return null;
  return String(result.stdout || result.stderr || "").trim();
}

function makeCliEnv(extra = {}) {
  return {
    ...process.env,
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    ...extra
  };
}

function getUploadTools() {
  const systemBiliupPath = commandPath("biliup");
  const localBiliupPath = getLocalBiliupPath();
  const biliupPath = systemBiliupPath || localBiliupPath;
  const bilitoolPath = commandPath("bilitool");
  const cookiePath = path.join(draftsDir, "cookies.json");
  return {
    biliup: Boolean(biliupPath),
    bilitool: Boolean(bilitoolPath),
    biliupPath,
    bilitoolPath,
    biliupSource: systemBiliupPath ? "system" : localBiliupPath ? "workspace" : null,
    biliupVersion: biliupPath ? commandOutput(biliupPath, ["--version"]) : null,
    testedBiliupVersion: "1.1.29",
    cookiePath,
    cookieExists: fs.existsSync(cookiePath),
    workspaceInstallPath: biliupVenvDir,
    capabilities: {
      uploadMultiPart: true,
      appendParts: true,
      listArchives: true,
      showArchive: true,
      onlySelfVisible: true,
      commandHelpVerifiedAt: "2026-05-29",
      unsupportedOrUnverified: ["网页内卡片配置", "章节管理", "字幕文件上传", "创作中心水印开关", "商业推广信息"]
    }
  };
}

function getLocalBiliupPath() {
  const exe = path.join(biliupVenvDir, "Scripts", "biliup.exe");
  return fs.existsSync(exe) ? exe : null;
}

function getUploadDefaults() {
  return {
    publishMode: "upload",
    submit: "web",
    line: "auto",
    limit: 3,
    copyright: 1,
    tid: 171,
    tag: "直播切片,虚拟主播,高能片段",
    descFormatId: 0,
    dynamic: "",
    noReprint: 1,
    openElec: 1,
    dolby: 0,
    hires: 0,
    visibility: "public",
    isOnlySelf: 0,
    subtitleOpen: 0,
    subtitleLan: ""
  };
}


function getLocalAsrStatus() {
  const pythonPath = getLocalAsrPython();
  const funAsrInstalled = hasPythonPackage("funasr");
  const torchInstalled = hasPythonPackage("torch");
  const torchRuntime = getTorchRuntimeInfo(pythonPath);
  const torchCuda = torchRuntime.cudaBuild;
  const downloadedModels = listDownloadedAsrModels();
  const qwenStatus = getQwenAsrStatus();
  const qwenModelPresent = qwenStatus.models.some((item) => item.ready);
  const llamaCppFound = Boolean(commandPath("llama-cli") || commandPath("llama-server") || fs.existsSync(qwenTranscribeExe));
  const hasCuda = Boolean(commandPath("nvidia-smi"));
  const notes = [];
  if (!pythonPath) notes.push("未发现 Fun-ASR 的 Python 环境；需要时点下载/检查会自动创建。");
  if (pythonPath && !funAsrInstalled) notes.push("Fun-ASR 虚拟环境存在，但还没装 Fun-ASR。");
  if (funAsrInstalled && !downloadedModels.length) notes.push("ASR 运行库已就绪，但还没下载模型。");
  if (hasCuda && torchInstalled && !torchCuda) notes.push("本机有 NVIDIA GPU，但当前 Fun-ASR 的 Torch 不是 CUDA 版；把设备切到 GPU 后会自动补装。");
  if (!qwenStatus.toolReady) notes.push("Qwen3-ASR 工具未安装；选择 Qwen3 后点下载/检查会安装 release 版 transcribe.exe。");
  if (qwenStatus.toolReady && !qwenModelPresent) notes.push("Qwen3-ASR 工具已安装，但当前规格的模型还没齐。0.6B 更快，1.7B 更准但更慢。");
  return {
    pythonPath,
    runtimeReady: Boolean(pythonPath && funAsrInstalled && torchInstalled),
    funAsrInstalled,
    torchInstalled,
    torchVersion: torchRuntime.version,
    torchBuild: torchRuntime.build,
    cudaAvailable: torchRuntime.cudaAvailable,
    funAsrDownloaded: downloadedModels.some((item) => item.includes("Fun-ASR-Nano")),
    qwenModelPresent,
    llamaCppFound,
    qwen: qwenStatus,
    cacheRoot: modelsRoot,
    downloadedModels,
    notes
  };
}

function getQwenAsrStatus() {
  const toolReady = fs.existsSync(qwenTranscribeExe);
  return {
    toolReady,
    exePath: toolReady ? qwenTranscribeExe : null,
    releaseDir: qwenReleaseRoot,
    modelRoot: qwenModelRoot,
    releaseZipUrl: qwenReleaseZipUrl,
    models: ["0.6B", "1.7B"].map((size) => {
      const modelDir = resolveQwenModelDir({ modelSize: size }, { allowLegacyFlat: size === "0.6B" });
      const missingFiles = getQwenRequiredFiles(modelDir).filter((file) => !fs.existsSync(file)).map((file) => path.basename(file));
      return {
        size,
        ready: missingFiles.length === 0,
        path: modelDir,
        missingFiles
      };
    })
  };
}

function resolveQwenModelDir(asrSettings = {}, options = {}) {
  const size = normalizeQwenModelSize(asrSettings?.modelSize);
  const sizedDir = path.join(qwenModelRoot, size);
  if (isQwenModelDirReady(sizedDir)) return sizedDir;
  if (options.allowLegacyFlat !== false && size === "0.6B" && isQwenModelDirReady(qwenModelRoot)) return qwenModelRoot;
  return sizedDir;
}

function normalizeQwenModelSize(value) {
  return String(value || "0.6B") === "1.7B" ? "1.7B" : "0.6B";
}

function isQwenModelDirReady(modelDir) {
  return getQwenRequiredFiles(modelDir).every((file) => fs.existsSync(file));
}

function getQwenRequiredFiles(modelDir) {
  return [
    "qwen3_asr_llm.q5_k.gguf",
    "qwen3_asr_encoder_frontend.int4.onnx",
    "qwen3_asr_encoder_backend.int4.onnx",
    "qwen3_aligner_llm.q5_k.gguf",
    "qwen3_aligner_encoder_frontend.int4.onnx",
    "qwen3_aligner_encoder_backend.int4.onnx"
  ].map((file) => path.join(modelDir, file));
}

function getLocalAsrPython() {
  const exe = path.join(asrVenvDir, "Scripts", "python.exe");
  return fs.existsSync(exe) ? exe : null;
}

function hasPythonPackage(name) {
  const pythonPath = getLocalAsrPython();
  if (!pythonPath) return false;
  const libDir = path.join(asrVenvDir, "Lib", "site-packages");
  if (!fs.existsSync(libDir)) return false;
  return fs.existsSync(path.join(libDir, name)) || fs.readdirSync(libDir).some((entry) => entry.toLowerCase().startsWith(`${name.toLowerCase()}-`));
}

function listDownloadedAsrModels() {
  if (!fs.existsSync(modelsRoot)) return [];
  const found = new Set();
  const hfHubDir = path.join(modelsRoot, "hf", "hub");
  if (fs.existsSync(hfHubDir)) {
    for (const entry of fs.readdirSync(hfHubDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      found.add(entry.name.replace(/^models--/, "").replace(/--/g, "/"));
    }
  }
  const qwenDir = path.join(modelsRoot, "qwen3-asr-gguf");
  if (fs.existsSync(qwenDir)) {
    found.add("HaujetZhao/Qwen3-ASR-GGUF");
  }
  return [...found].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

function hasDownloadedAsrModel(config) {
  const modelId = String(config?.modelId || "").trim().toLowerCase();
  if (!modelId) return false;
  return listDownloadedAsrModels().some((entry) => entry.trim().toLowerCase() === modelId);
}

function dedupeVideoFiles(videoFiles) {
  const groups = new Map();
  for (const file of videoFiles) {
    const key = normalizeBase(path.join(path.dirname(file), path.basename(file, path.extname(file))).toLowerCase());
    const list = groups.get(key) || [];
    list.push(file);
    groups.set(key, list);
  }
  return [...groups.values()].map((group) => {
    return group
      .slice()
      .sort((a, b) => preferredVideoRank(path.extname(a)) - preferredVideoRank(path.extname(b)))[0];
  });
}

function preferredVideoRank(extension) {
  const ext = String(extension || "").toLowerCase();
  if (ext === ".mp4") return 0;
  if (ext === ".mov") return 1;
  if (ext === ".mkv") return 2;
  if (ext === ".flv") return 3;
  if (ext === ".ts") return 4;
  if (ext === ".avi") return 5;
  return 9;
}

async function readServiceSettings() {
  if (!fs.existsSync(serviceSettingsPath)) {
    return normalizeServiceSettings({});
  }
  try {
    return normalizeServiceSettings(JSON.parse(await fsp.readFile(serviceSettingsPath, "utf8")));
  } catch {
    return normalizeServiceSettings({});
  }
}

function readRawServiceSettingsSync() {
  if (!fs.existsSync(serviceSettingsPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(serviceSettingsPath, "utf8"));
  } catch {
    return {};
  }
}

function resolveRecordingsRoot(value) {
  const raw = String(value || process.env.BLREC_RECORDINGS_DIR || defaultRecordingsRoot).trim();
  return raw ? path.resolve(raw) : "";
}

function getRecordingsRoot() {
  const raw = readRawServiceSettingsSync();
  return resolveRecordingsRoot(raw?.recordingsRoot || raw?.recording?.outputDir);
}

async function listRecordingRootCandidates(currentRoot = getRecordingsRoot()) {
  const candidates = new Map();
  const add = (candidatePath, reason) => {
    const resolved = resolveRecordingsRoot(candidatePath);
    if (!resolved || candidates.has(resolved)) return;
    candidates.set(resolved, { path: resolved, reason });
  };

  add(currentRoot, "当前设置");
  add(process.env.BLREC_RECORDINGS_DIR, "环境变量 BLREC_RECORDINGS_DIR");

  for (const discovered of discoverRecordingRootCandidates()) {
    add(discovered.path, discovered.reason);
  }

  const summarized = await Promise.all([...candidates.values()].map((candidate) => summarizeRecordingRoot(candidate)));
  return summarized
    .filter((candidate) => candidate.exists || candidate.path === resolveRecordingsRoot(currentRoot))
    .sort((a, b) => {
      if (a.path === resolveRecordingsRoot(currentRoot)) return -1;
      if (b.path === resolveRecordingsRoot(currentRoot)) return 1;
      return b.videoCount - a.videoCount || b.roomCount - a.roomCount || a.path.localeCompare(b.path, "zh-Hans-CN");
    })
    .slice(0, 16);
}

function discoverRecordingRootCandidates() {
  const found = [];
  const driveRoots = listDriveRoots();
  for (const driveRoot of driveRoots) {
    let entries = [];
    try {
      entries = fs.readdirSync(driveRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(driveRoot, entry.name);
      const name = entry.name.toLowerCase();
      if (isRecordingRootName(name)) {
        found.push({ path: fullPath, reason: "磁盘根目录发现疑似录制素材目录" });
      }
      for (const childName of ["录制素材", "录播文件", "recordings", "records", "video", "videos"]) {
        const childPath = path.join(fullPath, childName);
        if (fs.existsSync(childPath)) {
          found.push({ path: childPath, reason: `在 ${entry.name} 下发现 ${childName}` });
        }
      }
    }
  }
  return found;
}

function listDriveRoots() {
  if (process.platform !== "win32") {
    return [path.parse(process.cwd()).root].filter(Boolean);
  }
  const roots = [];
  for (let code = 67; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`;
    if (fs.existsSync(root)) roots.push(root);
  }
  return roots;
}

function isRecordingRootName(name) {
  return /录播|record|recording|直播/.test(String(name || "").toLowerCase());
}

async function summarizeRecordingRoot(candidate) {
  const exists = Boolean(candidate.path) && fs.existsSync(candidate.path);
  if (!exists) {
    return {
      path: candidate.path,
      label: path.basename(candidate.path) || candidate.path,
      exists: false,
      roomCount: 0,
      videoCount: 0,
      reason: candidate.reason
    };
  }
  let roomCount = 0;
  let videoCount = 0;
  try {
    const entries = fs.readdirSync(candidate.path, { withFileTypes: true });
    const dirs = entries.filter((entry) => entry.isDirectory()).slice(0, 120);
    roomCount = dirs.length;
    videoCount += entries.filter((entry) => entry.isFile() && videoExtensions.has(path.extname(entry.name).toLowerCase())).length;
    for (const dir of dirs) {
      const files = collectFiles(path.join(candidate.path, dir.name), 2);
      videoCount += dedupeVideoFiles(files.filter((file) => videoExtensions.has(path.extname(file).toLowerCase()))).length;
    }
  } catch {
    roomCount = 0;
    videoCount = 0;
  }
  return {
    path: candidate.path,
    label: path.basename(candidate.path) || candidate.path,
    exists: true,
    roomCount,
    videoCount,
    reason: candidate.reason
  };
}

function normalizeServiceSettings(input) {
  const asr = input?.asr || {};
  const vision = input?.vision || {};
  const cover = input?.cover || {};
  const media = input?.media || {};
  const automation = input?.automation || {};
  const recordingsRoot = resolveRecordingsRoot(input?.recordingsRoot || input?.recording?.outputDir);
  const legacyAsrMode = String(asr.mode || "");
  const legacyAsrProvider = String(asr.provider || "");
  const legacyVisionProvider = String(vision.provider || "");
  const useFunAsrByDefault = !legacyAsrProvider && legacyAsrMode === "local-command" && String(asr.localCommand || "").includes("faster-whisper");
  const normalizedAsrMode = useFunAsrByDefault ? "funasr-local" : String(asr.mode || "funasr-local");
  const normalizedAsrProvider = legacyAsrProvider || (
    normalizedAsrMode === "qwen3-local"
      ? "qwen3-asr-gguf"
      : normalizedAsrMode === "local-command"
        ? "custom-command"
        : normalizedAsrMode === "cloud-endpoint"
          ? "cloud-endpoint"
          : "funasr-nano"
  );
  const normalizedVisionProvider = !legacyVisionProvider || legacyVisionProvider === "manual"
    ? "openai-compatible"
    : legacyVisionProvider;
  const defaultQwenCommand = `"${qwenTranscribeExe}" "{audio}" --model-dir "${qwenModelRoot}" --n-ctx "{nCtx}" --quiet -y`;
  const rawQwenCommand = String(asr.qwenCommand || "");
  const normalizedQwenCommand = !rawQwenCommand || rawQwenCommand.includes("E:\\qwen3-asr\\transcribe.py")
    ? defaultQwenCommand
    : rawQwenCommand;
  return {
    recordingsRoot,
    recording: normalizeRecordingSettings(input?.recording || {}, recordingsRoot),
    asr: {
      mode: normalizedAsrMode,
      provider: normalizedAsrProvider,
      model: String(useFunAsrByDefault ? "" : (asr.model || "")) || (normalizedAsrProvider === "qwen3-asr-gguf" ? "HaujetZhao/Qwen3-ASR-GGUF" : "FunAudioLLM/Fun-ASR-Nano-2512"),
      modelSize: String(asr.modelSize || (normalizedAsrProvider === "qwen3-asr-gguf" ? "0.6B" : "nano-2512")),
      endpoint: String(asr.endpoint || ""),
      apiKey: String(asr.apiKey || ""),
      localCommand: String(
        asr.localCommand
          || 'faster-whisper "{audio}" --model "{model}" --language "{language}" --output_format srt --output_dir "{outDir}"'
      ),
      qwenCommand: normalizedQwenCommand,
      language: String(asr.language || "zh"),
      outputFormat: String(asr.outputFormat || "srt"),
      device: String(asr.device || "auto"),
      autoPrepareModel: asr.autoPrepareModel !== false,
      chunkSeconds: Math.max(15, Math.min(300, Number(asr.chunkSeconds || 60))),
      qwenContextTokens: Math.max(1024, Math.min(8192, Number(asr.qwenContextTokens || 4096))),
      defaultScope: ["selection", "full"].includes(String(asr.defaultScope || "")) ? String(asr.defaultScope) : "selection",
      replaceMode: ["range", "append", "all"].includes(String(asr.replaceMode || "")) ? String(asr.replaceMode) : "range"
    },
    vision: {
      provider: normalizedVisionProvider,
      wireApi: normalizeVisionWireApi(vision.wireApi || vision.wire_api || (String(vision.endpoint || "").includes("anyrouter") ? "responses" : "chat-completions")),
      endpoint: String(vision.endpoint || "http://localhost:8317/v1"),
      apiKey: String(vision.apiKey || "your-api-key-1"),
      model: String(vision.model || "gpt-5.4"),
      sendFrames: vision.sendFrames !== false,
      sendAudio: Boolean(vision.sendAudio),
      sendSubtitles: vision.sendSubtitles !== false,
      sendDanmaku: vision.sendDanmaku !== false,
      frameSampleCount: Math.max(1, Math.min(12, Number(vision.frameSampleCount || 6))),
      audioSpectrum: vision.audioSpectrum !== false,
      sliceTemperature: Math.max(0, Math.min(1.5, Number(vision.sliceTemperature ?? 0.35))),
      slicePrompt: String(vision.slicePrompt || defaultSlicePrompt)
    },
    cover: {
      provider: String(cover.provider || "frame-template"),
      endpoint: String(cover.endpoint || ""),
      apiKey: String(cover.apiKey || ""),
      model: String(cover.model || ""),
      stylePrompt: String(cover.stylePrompt || "清晰、有标题空间、适合 B 站直播切片封面")
    },
    media: normalizeMediaSettings(media),
    automation: normalizeAutomationSettings(automation)
  };
}

function normalizeVisionWireApi(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/_/g, "-");
  if (["responses", "response"].includes(normalized)) return "responses";
  if (["chat-completions", "chat-completion", "chat", "completions"].includes(normalized)) return "chat-completions";
  return "chat-completions";
}

function normalizeAutomationSettings(input = {}) {
  const rawSources = Array.isArray(input.sources) && input.sources.length ? input.sources : ["danmaku", "subtitle"];
  const sources = rawSources.map((item) => String(item)).filter((item) => ["danmaku", "subtitle", "visual", "audio"].includes(item));
  return {
    enabled: Boolean(input.enabled),
    triggerOnRecordingComplete: input.triggerOnRecordingComplete !== false,
    autoAnalyze: input.autoAnalyze !== false,
    autoExport: Boolean(input.autoExport),
    autoUpload: Boolean(input.autoUpload),
    uploadPolicy: normalizeUploadPolicy({ uploadPolicy: input.uploadPolicy || "review" }),
    clipDuration: Math.max(20, Math.min(600, Number(input.clipDuration || 90))),
    clipCount: Math.max(1, Math.min(6, Number(input.clipCount || 3))),
    sources: sources.length ? sources : ["danmaku", "subtitle"],
    minScore: Math.max(1, Math.min(100, Number(input.minScore || 72))),
    minEvidenceCount: Math.max(1, Math.min(10, Number(input.minEvidenceCount || 2))),
    requireHighConfidence: input.requireHighConfidence !== false,
    burnSubtitles: Boolean(input.burnSubtitles)
  };
}

function normalizeRecordingSettings(input = {}, recordingsRoot = getRecordingsRoot()) {
  const port = Number(input.port || 2233);
  const host = String(input.host || "127.0.0.1").trim() || "127.0.0.1";
  const backend = normalizeRecordingBackend(input.backend || input.engine || input.mode);
  const segmentSeconds = Number(input.segmentSeconds ?? input.splitSeconds ?? input.fileDurationSeconds ?? 0);
  const fileSizeLimitMb = Number(input.fileSizeLimitMb ?? input.filesizeLimitMb ?? 0);
  const requestTimeoutSeconds = Number(input.requestTimeoutSeconds || 12);
  const streamTimeoutSeconds = Number(input.streamTimeoutSeconds || 0);
  const disconnectionTimeoutSeconds = Number(input.disconnectionTimeoutSeconds || input.disconnectionTimeout || 600);
  const bufferSizeKb = Number(input.bufferSizeKb || 8);
  const spaceCheckIntervalSeconds = Number(input.spaceCheckIntervalSeconds || 60);
  const spaceThresholdMb = Number(input.spaceThresholdMb || 1024);
  return {
    backend,
    outputDir: String(input.outputDir || recordingsRoot || path.join(workbenchRoot, "recordings")),
    host: isLoopbackHost(host) ? host : "127.0.0.1",
    port: Number.isFinite(port) && port > 0 ? Math.round(port) : 2233,
    apiKey: String(input.apiKey || ""),
    maxConfiguredRooms: Math.max(1, Math.min(50, Number(input.maxConfiguredRooms || 10))),
    maxConcurrentRecordings: Math.max(1, Math.min(12, Number(input.maxConcurrentRecordings || 3))),
    autoMonitorEnabled: input.autoMonitorEnabled !== false,
    stabilityHours: Math.max(1, Math.min(168, Number(input.stabilityHours || 24))),
    enableWebhooks: input.enableWebhooks !== false,
    webhookUrl: String(input.webhookUrl || ""),
    biliApiBase: String(input.biliApiBase || process.env.BILI_LIVE_API_BASE || "https://api.live.bilibili.com").trim(),
    biliWebApiBase: String(input.biliWebApiBase || process.env.BILI_WEB_API_BASE || "https://api.bilibili.com").trim(),
    cookiePath: String(input.cookiePath || ""),
    enableWbiSigning: input.enableWbiSigning !== false,
    roomFolderTemplate: String(input.roomFolderTemplate || "{anchorName}_{roomId}"),
    filenameTemplate: String(input.filenameTemplate || "{start}_{title}_{roomId}_{backend}"),
    segmentSeconds: Number.isFinite(segmentSeconds) ? Math.max(0, Math.min(24 * 3600, Math.round(segmentSeconds))) : 0,
    fileSizeLimitMb: Number.isFinite(fileSizeLimitMb) ? Math.max(0, Math.min(1024 * 1024, Math.round(fileSizeLimitMb))) : 0,
    qualityNumber: Math.max(80, Math.min(30000, Number(input.qualityNumber || 10000))),
    streamFormat: normalizeStreamFormat(input.streamFormat || "flv"),
    streamCodec: normalizeStreamCodec(input.streamCodec || "avc"),
    recordingMode: normalizeRecordingMode(input.recordingMode || "standard"),
    bufferSizeKb: Number.isFinite(bufferSizeKb) ? Math.max(4, Math.min(512 * 1024, Math.round(bufferSizeKb))) : 8,
    requestTimeoutSeconds: Number.isFinite(requestTimeoutSeconds) ? Math.max(3, Math.min(120, Math.round(requestTimeoutSeconds))) : 12,
    streamTimeoutSeconds: Number.isFinite(streamTimeoutSeconds) ? Math.max(0, Math.min(24 * 3600, Math.round(streamTimeoutSeconds))) : 0,
    disconnectionTimeoutSeconds: Number.isFinite(disconnectionTimeoutSeconds) ? Math.max(0, Math.min(30 * 60, Math.round(disconnectionTimeoutSeconds))) : 600,
    pollIntervalSeconds: Math.max(1, Math.min(900, Number(input.pollIntervalSeconds || 600))),
    reconnectSeconds: Math.max(1, Math.min(120, Number(input.reconnectSeconds || 5))),
    enableDanmaku: input.enableDanmaku !== false,
    saveRawDanmaku: Boolean(input.saveRawDanmaku),
    danmakuServer: String(input.danmakuServer || "auto").trim() || "auto",
    danmuUname: Boolean(input.danmuUname),
    recordGiftSend: input.recordGiftSend !== false,
    recordFreeGifts: input.recordFreeGifts !== false,
    recordGuardBuy: input.recordGuardBuy !== false,
    recordSuperChat: input.recordSuperChat !== false,
    saveCover: Boolean(input.saveCover),
    coverSaveStrategy: String(input.coverSaveStrategy || "default"),
    remuxToMp4: input.remuxToMp4 !== false,
    injectExtraMetadata: input.injectExtraMetadata !== false,
    deleteSourceAfterRemux: normalizeDeleteSourceStrategy(input.deleteSourceAfterRemux || input.deleteSource || "always"),
    spaceCheckIntervalSeconds: Number.isFinite(spaceCheckIntervalSeconds) ? Math.max(0, Math.min(600, Math.round(spaceCheckIntervalSeconds))) : 60,
    spaceThresholdMb: Number.isFinite(spaceThresholdMb) ? Math.max(0, Math.min(1024 * 1024, Math.round(spaceThresholdMb))) : 1024,
    recycleRecords: Boolean(input.recycleRecords)
  };
}

function normalizeRecordingBackend(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["internal", "builtin", "bili", "bilibili"].includes(normalized)) return "internal";
  if (["auto", "automatic", "external"].includes(normalized)) return "internal";
  return "internal";
}

function normalizeStreamFormat(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["flv", "fmp4", "ts"].includes(normalized) ? normalized : "flv";
}

function normalizeStreamCodec(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["avc", "hevc"].includes(normalized) ? normalized : "avc";
}

function normalizeRecordingMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["standard", "raw"].includes(normalized) ? normalized : "standard";
}

function normalizeDeleteSourceStrategy(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["always", "true", "delete"].includes(normalized)) return "always";
  if (["never", "false", "keep"].includes(normalized)) return "never";
  return "auto";
}

function isLoopbackHost(host) {
  return ["127.0.0.1", "localhost", "::1"].includes(String(host || "").toLowerCase());
}

function getRecordingLimits(recordingSettings = {}) {
  return {
    maxConfiguredRooms: Number(recordingSettings.maxConfiguredRooms || 10),
    maxConcurrentRecordings: Number(recordingSettings.maxConcurrentRecordings || 3),
    stabilityHours: Number(recordingSettings.stabilityHours || 24)
  };
}

async function readFixedRooms(options = {}) {
  if (!fs.existsSync(fixedRoomsPath)) return [];
  try {
    const parsed = JSON.parse(await fsp.readFile(fixedRoomsPath, "utf8"));
    const rooms = asArray(parsed.rooms || parsed).map(normalizeFixedRoom).filter((room) => room.roomId);
    return options.enrichMetadata ? await enrichFixedRoomsMetadata(rooms) : rooms;
  } catch {
    return [];
  }
}

function readFixedRoomsSync() {
  if (!fs.existsSync(fixedRoomsPath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(fixedRoomsPath, "utf8"));
    return asArray(parsed.rooms || parsed).map(normalizeFixedRoom).filter((room) => room.roomId);
  } catch {
    return [];
  }
}

async function writeFixedRooms(rooms) {
  const payload = {
    rooms: rooms.map(normalizeFixedRoom).filter((room) => room.roomId),
    updatedAt: new Date().toISOString()
  };
  await fsp.writeFile(fixedRoomsPath, JSON.stringify(payload, null, 2), "utf8");
}

async function readHiddenMaterialRooms() {
  if (!fs.existsSync(hiddenMaterialRoomsPath)) return new Set();
  try {
    const parsed = JSON.parse(await fsp.readFile(hiddenMaterialRoomsPath, "utf8"));
    return new Set(asArray(parsed.rooms || parsed).map((item) => normalizeStoredRoomKey(item)).filter(Boolean));
  } catch {
    return new Set();
  }
}

async function writeHiddenMaterialRooms(keys) {
  const rooms = [...keys].map((item) => normalizeStoredRoomKey(item)).filter(Boolean).sort();
  await fsp.writeFile(hiddenMaterialRoomsPath, JSON.stringify({ rooms, updatedAt: new Date().toISOString() }, null, 2), "utf8");
}

async function hideMaterialRoom(roomPath) {
  assertInsideRecordings(roomPath);
  const stat = safeStat(roomPath);
  if (!stat?.isDirectory()) throw new Error("素材房间目录不存在。");
  const key = materialRoomHiddenKey(roomPath);
  const hidden = await readHiddenMaterialRooms();
  hidden.add(key);
  await writeHiddenMaterialRooms(hidden);
  return key;
}

function isMaterialRoomHidden(roomPath, hiddenRooms) {
  return hiddenRooms.has(materialRoomHiddenKey(roomPath));
}

function materialRoomHiddenKey(roomPath) {
  assertInsideRecordings(roomPath);
  const recordingsRoot = path.resolve(getRecordingsRoot());
  const relative = path.relative(recordingsRoot, path.resolve(roomPath));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("只能隐藏录制素材目录里的房间文件夹。");
  return normalizeStoredRoomKey(relative);
}

function normalizeStoredRoomKey(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").trim().toLowerCase();
}

function normalizeFixedRoom(input = {}) {
  const roomId = normalizeRoomId(input.roomId || input.inputRoomId);
  const name = String(input.name || input.title || (roomId ? `房间 ${roomId}` : "新房间"));
  return {
    roomId,
    inputRoomId: String(input.inputRoomId || input.roomId || roomId),
    name,
    title: String(input.title || (!isDefaultFixedRoomName(name, roomId) ? name : "")),
    realRoomId: normalizeRoomId(input.realRoomId || input.real_room_id || roomId),
    shortId: normalizeRoomId(input.shortId || input.short_id || ""),
    anchorName: String(input.anchorName || input.uname || input.anchor?.name || ""),
    anchorUid: String(input.anchorUid || input.uid || input.anchor?.uid || ""),
    avatarUrl: String(input.avatarUrl || input.face || input.anchor?.face || ""),
    coverUrl: String(input.coverUrl || input.user_cover || input.cover || input.keyframe || ""),
    keyframeUrl: String(input.keyframeUrl || input.keyframe || ""),
    areaName: String(input.areaName || input.area_name || ""),
    parentAreaName: String(input.parentAreaName || input.parent_area_name || ""),
    biliLiveStatus: normalizeBiliLiveStatus(input.biliLiveStatus ?? input.live_status ?? input.liveStatus),
    liveTime: String(input.liveTime || input.live_time || ""),
    metadataUpdatedAt: input.metadataUpdatedAt || null,
    enabled: input.enabled !== false,
    priority: Math.max(0, Math.min(999, Number(input.priority || 100))),
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

async function enrichFixedRoomsMetadata(rooms) {
  const needsMetadata = rooms.some((room) => shouldFetchFixedRoomMetadata(room));
  if (!needsMetadata) return rooms;
  const settings = await readServiceSettings().catch(() => null);
  const recordingSettings = settings?.recording || {};
  let changed = false;
  const enriched = [];
  for (const room of rooms) {
    const next = await enrichFixedRoomMetadata(room, recordingSettings);
    if (fixedRoomMetadataSignature(next) !== fixedRoomMetadataSignature(room)) changed = true;
    enriched.push(next);
  }
  if (changed) await writeFixedRooms(enriched);
  return enriched;
}

async function enrichFixedRoomMetadata(room, recordingSettings = {}) {
  const normalized = normalizeFixedRoom(room);
  if (!shouldFetchFixedRoomMetadata(normalized)) return normalized;
  const failedAt = fixedRoomMetadataFailureAt.get(normalized.roomId);
  if (failedAt && Date.now() - failedAt < 5 * 60 * 1000) return normalized;
  try {
    const info = await resolveBiliRoomInfo(normalized.roomId, recordingSettings);
    fixedRoomMetadataFailureAt.delete(normalized.roomId);
    return mergeFixedRoomMetadata(normalized, info);
  } catch {
    fixedRoomMetadataFailureAt.set(normalized.roomId, Date.now());
    return normalized;
  }
}

function shouldFetchFixedRoomMetadata(room) {
  const normalized = normalizeFixedRoom(room);
  if (!normalized.roomId) return false;
  if (!normalized.metadataUpdatedAt) return true;
  const updatedAt = Date.parse(normalized.metadataUpdatedAt);
  return !Number.isFinite(updatedAt) || Date.now() - updatedAt > 30 * 60 * 1000;
}

function mergeFixedRoomMetadata(room, info = {}) {
  const normalized = normalizeFixedRoom(room);
  const title = String(info.title || normalized.title || "").trim();
  const keepsCustomName = !isDefaultFixedRoomName(normalized.name, normalized.roomId);
  return normalizeFixedRoom({
    ...normalized,
    name: keepsCustomName ? normalized.name : title || normalized.name,
    title,
    realRoomId: info.realRoomId || normalized.realRoomId,
    shortId: info.shortId || normalized.shortId,
    anchorName: info.anchorName || normalized.anchorName,
    anchorUid: info.anchorUid || normalized.anchorUid,
    avatarUrl: info.avatarUrl || normalized.avatarUrl,
    coverUrl: info.coverUrl || normalized.coverUrl,
    keyframeUrl: info.keyframeUrl || normalized.keyframeUrl,
    areaName: info.areaName || normalized.areaName,
    parentAreaName: info.parentAreaName || normalized.parentAreaName,
    biliLiveStatus: info.biliLiveStatus || normalized.biliLiveStatus,
    liveTime: info.liveTime || normalized.liveTime,
    metadataUpdatedAt: new Date().toISOString()
  });
}

function isDefaultFixedRoomName(name, roomId) {
  const value = String(name || "").trim();
  return !value || value === "新房间" || value === "New room" || value === `房间 ${roomId}` || value === `Room ${roomId}`;
}

function normalizeBiliLiveStatus(value) {
  if (value === "live" || value === "offline" || value === "replay" || value === "unknown") return value;
  const numeric = Number(value);
  if (numeric === 1) return "live";
  if (numeric === 0) return "offline";
  if (numeric === 2) return "replay";
  return "unknown";
}

function fixedRoomMetadataSignature(room) {
  const normalized = normalizeFixedRoom(room);
  return JSON.stringify({
    name: normalized.name,
    title: normalized.title,
    realRoomId: normalized.realRoomId,
    shortId: normalized.shortId,
    anchorName: normalized.anchorName,
    anchorUid: normalized.anchorUid,
    avatarUrl: normalized.avatarUrl,
    coverUrl: normalized.coverUrl,
    keyframeUrl: normalized.keyframeUrl,
    areaName: normalized.areaName,
    parentAreaName: normalized.parentAreaName,
    biliLiveStatus: normalized.biliLiveStatus,
    liveTime: normalized.liveTime,
    metadataUpdatedAt: normalized.metadataUpdatedAt
  });
}

function normalizeRoomId(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d+$/.test(raw)) return raw;

  const livePathMatch = raw.match(/(?:https?:\/\/)?(?:www\.)?live\.bilibili\.com\/(?:blanc\/)?(\d+)(?:[/?#]|$)/i);
  if (livePathMatch) return livePathMatch[1];

  try {
    const parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
    const queryRoomId = parsed.searchParams.get("room_id") || parsed.searchParams.get("roomId") || parsed.searchParams.get("id");
    if (queryRoomId && /^\d+$/.test(queryRoomId)) return queryRoomId;
    const segment = parsed.pathname.split("/").find((part) => /^\d+$/.test(part));
    if (segment) return segment;
  } catch {
    // Fall through to loose text extraction for inputs such as "房间 12345".
  }

  return raw.match(/\d+/)?.[0] || "";
}

async function findFixedRoom(roomId) {
  const normalized = normalizeRoomId(roomId);
  return (await readFixedRooms()).find((room) => room.roomId === normalized) || null;
}

function publicFixedRoom(room) {
  const status = getRoomRuntimeStatus(room.roomId);
  const effectiveStatus = shouldExposeRoomAsMonitoring(room, status)
    ? buildMonitoringRoomStatus(room, status)
    : status;
  return {
    ...room,
    ...effectiveStatus,
    taskStatus: effectiveStatus.taskStatus || "idle",
    liveStatus: effectiveStatus.liveStatus || "unknown",
    message: effectiveStatus.message || "就绪",
    nextAction: effectiveStatus.nextAction || "start",
    log: redactSecrets(effectiveStatus.log || "")
  };
}

function shouldExposeRoomAsMonitoring(room, status = {}) {
  if (room?.enabled === false) return false;
  const settings = normalizeServiceSettings(readRawServiceSettingsSync());
  if (settings.recording.autoMonitorEnabled === false) return false;
  const taskStatus = String(status.taskStatus || "idle");
  if (["starting", "waiting", "recording", "finalizing"].includes(taskStatus)) return false;
  if (taskStatus === "completed" && status.recordingPath) return false;
  if (taskStatus === "error") return isOfflineRecordingStatus(room, status) || isRecoverableStreamRecordingStatus(status);
  return taskStatus === "idle" || taskStatus === "completed";
}

function buildMonitoringRoomStatus(room, status = {}) {
  const statusLive = normalizeBiliLiveStatus(status.liveStatus);
  const roomLive = normalizeBiliLiveStatus(room?.biliLiveStatus);
  const recoverableStreamIssue = isRecoverableStreamRecordingStatus(status);
  const staleIssueWhileLive = roomLive === "live" && (recoverableStreamIssue || String(status.taskStatus || "") === "error");
  const liveStatus = staleIssueWhileLive ? "live" : (statusLive !== "unknown" ? statusLive : roomLive);
  const message = recoverableStreamIssue && liveStatus !== "offline"
    ? liveStatus === "live"
      ? "取流重连中"
      : "等待开播"
    : liveStatus === "live"
    ? "开播，准备录制"
    : liveStatus === "offline"
      ? "等待开播"
      : "等待开播";
  return publicRecordingStatus(room.roomId, {
    ...status,
    taskStatus: "waiting",
    liveStatus,
    message,
    nextAction: "stop"
  });
}

function isOfflineRecordingStatus(room = {}, status = {}) {
  if (normalizeBiliLiveStatus(room.biliLiveStatus) === "live") return false;
  const statuses = [room.biliLiveStatus, status.liveStatus]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
  const text = `${status.message || ""}\n${status.log || ""}`;
  return statuses.some((value) => ["offline", "0", "ended", "not_live", "not-live"].includes(value))
    || /Bili stream request failed:\s*404|404 Not Found|live ended|主播已下播|未开播|下播/i.test(text);
}

function isRecoverableStreamRecordingStatus(status = {}) {
  const text = `${status.message || ""}\n${status.log || ""}`;
  return /Bili stream request failed:\s*(403|404|408|409|425|429|5\d\d)|fetch failed|network|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|AbortError|terminated|socket|当前没有可用/i.test(text);
}

function getRoomRuntimeStatus(roomId) {
  return recordingRoomStatuses.get(String(roomId)) || {
    roomId: String(roomId),
    taskStatus: "idle",
    liveStatus: "unknown",
    message: "就绪",
    nextAction: "start",
    log: "",
    updatedAt: null
  };
}

function setRoomRuntimeStatus(roomId, patch) {
  const current = getRoomRuntimeStatus(roomId);
  const next = publicRecordingStatus(roomId, { ...current, ...patch, updatedAt: new Date().toISOString() });
  recordingRoomStatuses.set(String(roomId), next);
  return next;
}

export const __testing = {
  createInternalRecordingPaths,
  postprocessInternalRecordingSegment,
  getRoomRuntimeStatus,
  setRoomRuntimeStatus,
  resetAutomationReconcileClock() {
    automationReconcileLastAt = 0;
  },
  clearRoomRuntimeStatus(roomId) {
    recordingRoomStatuses.delete(String(roomId));
  }
};

function publicRecordingStatus(roomId, input = {}) {
  const bytesWritten = Number(input.bytesWritten ?? input.videoSize ?? 0);
  const speedBytesPerSecond = Number(input.speedBytesPerSecond || 0);
  const averageSpeedBytesPerSecond = Number(input.averageSpeedBytesPerSecond || 0);
  const elapsedSeconds = Number(input.elapsedSeconds || 0);
  const staleSeconds = Number(input.staleSeconds || 0);
  return {
    roomId: String(input.roomId || roomId),
    taskStatus: String(input.taskStatus || "idle"),
    liveStatus: String(input.liveStatus || "unknown"),
    recordingPath: input.recordingPath || null,
    danmakuPath: input.danmakuPath || null,
    videoSize: Number(input.videoSize || bytesWritten || 0),
    bytesWritten,
    segmentBytes: Number(input.segmentBytes || 0),
    speedBytesPerSecond,
    averageSpeedBytesPerSecond,
    elapsedSeconds,
    staleSeconds,
    lastBytesAt: input.lastBytesAt || null,
    stalled: Boolean(input.stalled),
    danmakuSize: Number(input.danmakuSize || 0),
    danmakuCount: Number(input.danmakuCount || 0),
    danmakuStatus: input.danmakuStatus || null,
    monitorCheckedAt: input.monitorCheckedAt || null,
    nextMonitorAt: input.nextMonitorAt || null,
    refreshed: Boolean(input.refreshed),
    sync: input.sync || "待验证（目标 <= 1s）",
    message: String(input.message || ""),
    nextAction: String(input.nextAction || "start"),
    log: redactSecrets(String(input.log || "")),
    updatedAt: input.updatedAt || new Date().toISOString()
  };
}

async function ingestRecordingEventWebhook(payload) {
  const event = normalizeRecordingEventWebhook(payload);
  await appendJsonLine(recordingEventsPath, event);
  applyRecordingTimelineEvent(event);
  await maybeQueueAutomationFromRecordingEvent(event);
  return event;
}

function normalizeRecordingEventWebhook(payload = {}) {
  const data = payload?.data && typeof payload.data === "object" ? payload.data : {};
  const type = String(payload?.type || payload?.event || "UnknownEvent");
  const roomInfo = data.room_info || data.roomInfo || data.user_info || {};
  const roomId = normalizeRoomId(data.room_id || data.roomId || roomInfo.room_id || roomInfo.roomId || roomInfo.roomid);
  const eventPath = data.path ? path.resolve(String(data.path)) : null;
  const date = normalizeIsoDate(payload?.date || payload?.time || payload?.createdAt);
  const stableInput = JSON.stringify({ type, date, roomId, path: eventPath, data });
  return {
    id: String(payload?.id || crypto.createHash("sha1").update(stableInput).digest("hex").slice(0, 16)),
    type,
    date,
    roomId,
    path: eventPath,
    data,
    receivedAt: new Date().toISOString()
  };
}

function normalizeIsoDate(value) {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

async function appendJsonLine(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.appendFile(file, `${JSON.stringify(value)}\n`, "utf8");
}

async function readRecordingEvents(options = {}) {
  const limit = Math.max(1, Math.min(500, Number(options.limit || 100)));
  const roomId = normalizeRoomId(options.roomId || "");
  if (!fs.existsSync(recordingEventsPath)) return [];
  const text = await fsp.readFile(recordingEventsPath, "utf8");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((event) => event && (!roomId || event.roomId === roomId))
    .sort((a, b) => Date.parse(a.receivedAt || a.date || "") - Date.parse(b.receivedAt || b.date || ""))
    .slice(-limit)
    .reverse();
}

function applyRecordingTimelineEvent(event) {
  const roomId = normalizeRoomId(event.roomId);
  if (!roomId) return;
  const patch = statusPatchFromRecordingEvent(event);
  if (!patch) return;
  setRoomRuntimeStatus(roomId, {
    ...patch,
    log: `${event.date} ${event.type}${event.path ? ` ${event.path}` : ""}\n`
  });
}

function statusPatchFromRecordingEvent(event) {
  const stat = event.path ? safeStat(event.path) : null;
  const pathPatch = event.path ? pathPatchFromRecordingEvent(event, stat) : {};
  if (/InternalRecorderStartedEvent/.test(event.type)) {
    const live = Number(event.data?.live_status) === 1;
    return { liveStatus: live ? "live" : "offline", taskStatus: live ? "starting" : "waiting", message: live ? "开播，准备录制" : "等待开播", nextAction: "stop", ...pathPatch };
  }
  if (/LiveBeganEvent/.test(event.type)) {
    return { liveStatus: "live", taskStatus: "waiting", message: "开播，准备录制", nextAction: "stop", ...pathPatch };
  }
  if (/RecordingStartedEvent/.test(event.type)) {
    return { liveStatus: "live", taskStatus: "recording", message: "录制中", nextAction: "stop", ...pathPatch };
  }
  if (/VideoFileCreatedEvent/.test(event.type)) {
    return { liveStatus: "live", taskStatus: "recording", message: "录制文件已创建", nextAction: "stop", ...pathPatch };
  }
  if (/VideoFileCompletedEvent/.test(event.type)) {
    return { liveStatus: "live", taskStatus: "recording", message: "录制片段已入库", nextAction: "stop", refreshed: true, ...pathPatch };
  }
  if (/DanmakuFileCreatedEvent/.test(event.type)) {
    return { liveStatus: "live", taskStatus: "recording", message: "弹幕采集中", nextAction: "stop", ...pathPatch };
  }
  if (/DanmakuFileCompletedEvent|RawDanmakuFileCompletedEvent/.test(event.type)) {
    return { liveStatus: "live", taskStatus: "recording", message: "弹幕已保存", nextAction: "stop", refreshed: true, ...pathPatch };
  }
  if (/RoomMonitorLiveEndedEvent/.test(event.type)) {
    return { liveStatus: "offline", taskStatus: "waiting", message: "等待开播", nextAction: "stop", ...pathPatch };
  }
  if (/LiveEndedEvent/.test(event.type)) {
    return { liveStatus: "offline", taskStatus: "finalizing", message: "下播，正在收尾", nextAction: "wait", ...pathPatch };
  }
  if (/RecordingFinishedEvent|PostprocessingCompletedEvent/.test(event.type)) {
    return { liveStatus: "offline", taskStatus: "completed", message: "录制完成，可剪辑", nextAction: "open", refreshed: true, ...pathPatch };
  }
  if (/RecordingCancelledEvent|Error/.test(event.type)) {
    return { taskStatus: "error", message: "录制事件报告异常", nextAction: "retry", ...pathPatch };
  }
  return pathPatch;
}

function pathPatchFromRecordingEvent(event, stat) {
  const patch = {};
  if (/VideoFile|VideoPostprocessing/.test(event.type)) {
    patch.recordingPath = event.path;
    patch.videoSize = stat?.size || 0;
  }
  if (/DanmakuFile|RawDanmakuFile/.test(event.type)) {
    patch.danmakuPath = event.path;
    patch.danmakuSize = stat?.size || 0;
    patch.danmakuCount = event.path && fs.existsSync(event.path) ? parseDanmakuFile(event.path, 0).total : 0;
  }
  return patch;
}

async function maybeQueueAutomationFromRecordingEvent(event) {
  if (!event.path || !videoExtensions.has(path.extname(event.path).toLowerCase())) return null;
  if (!/VideoFileCompletedEvent|VideoPostprocessingCompletedEvent|PostprocessingCompletedEvent/.test(event.type)) return null;
  const settings = await readServiceSettings();
  if (!settings.automation.enabled) return null;
  if (settings.automation.triggerOnRecordingComplete === false) return null;
  const job = await createAutomationJob({
    roomId: event.roomId,
    videoPath: event.path,
    trigger: event.type,
    triggerEventId: event.id,
    uploadPolicy: settings.automation.uploadPolicy
  });
  if (settings.automation.autoAnalyze) {
    void runAutomationJob(job.id).catch((error) => markAutomationJobError(job.id, error));
  }
  return job;
}

async function listAutomationJobs() {
  await loadAutomationJobs();
  await reconcileAutomationJobsFromRecordings();
  return [...automationJobs.values()].sort((a, b) => Date.parse(b.updatedAt || b.createdAt || "") - Date.parse(a.updatedAt || a.createdAt || ""));
}

async function loadAutomationJobs() {
  if (automationJobs.size || !fs.existsSync(automationJobsPath)) return;
  try {
    const parsed = JSON.parse(await fsp.readFile(automationJobsPath, "utf8"));
    for (const job of asArray(parsed.jobs || parsed)) {
      if (job?.id) automationJobs.set(job.id, normalizeAutomationJob(job));
    }
  } catch {
    automationJobs.clear();
  }
}

async function persistAutomationJobs() {
  await fsp.mkdir(path.dirname(automationJobsPath), { recursive: true });
  await fsp.writeFile(
    automationJobsPath,
    JSON.stringify({ jobs: [...automationJobs.values()], updatedAt: new Date().toISOString() }, null, 2),
    "utf8"
  );
}

async function createAutomationJob(input) {
  await loadAutomationJobs();
  const resolvedVideoPath = path.resolve(input.videoPath);
  const existing = [...automationJobs.values()].find((job) => path.resolve(job.videoPath) === resolvedVideoPath);
  if (existing) return existing;
  const now = new Date().toISOString();
  const id = crypto.createHash("sha1").update(`${resolvedVideoPath}:${input.trigger || ""}:${input.triggerEventId || ""}:${now}`).digest("hex").slice(0, 16);
  const job = normalizeAutomationJob({
    id,
    roomId: normalizeRoomId(input.roomId || ""),
    videoPath: resolvedVideoPath,
    trigger: input.trigger || "manual",
    triggerEventId: input.triggerEventId || null,
    uploadPolicy: normalizeUploadPolicy({ uploadPolicy: input.uploadPolicy || "review" }),
    status: "queued",
    stage: "queued",
    message: "Queued for high-confidence clip analysis.",
    candidates: [],
    acceptedClips: [],
    exportedClips: [],
    error: "",
    createdAt: now,
    updatedAt: now
  });
  automationJobs.set(job.id, job);
  await persistAutomationJobs();
  return job;
}

async function reconcileAutomationJobsFromRecordings({ force = false } = {}) {
  if (automationReconcileRunning) return [];
  const now = Date.now();
  if (!force && now - automationReconcileLastAt < 45_000) return [];
  automationReconcileLastAt = now;
  automationReconcileRunning = true;
  try {
    await loadAutomationJobs();
    const settings = await readServiceSettings();
    if (!settings.automation.enabled || settings.automation.triggerOnRecordingComplete === false) return [];
    const recordingsRoot = getRecordingsRoot();
    if (!recordingsRoot || !fs.existsSync(recordingsRoot)) return [];
    const activePaths = new Set();
    for (const recorder of internalRecorders.values()) {
      if (recorder?.segment?.videoPath) activePaths.add(path.resolve(recorder.segment.videoPath));
    }
    for (const status of recordingRoomStatuses.values()) {
      if (["recording", "starting", "finalizing"].includes(String(status.taskStatus || "")) && status.recordingPath) {
        activePaths.add(path.resolve(status.recordingPath));
      }
    }
    const existingPaths = new Set([...automationJobs.values()].map((job) => path.resolve(job.videoPath)));
    const staleMs = 60_000;
    const recentMs = 48 * 60 * 60 * 1000;
    const files = dedupeVideoFiles(collectFiles(recordingsRoot, 3).filter((file) => videoExtensions.has(path.extname(file).toLowerCase())))
      .map((file) => ({ file: path.resolve(file), stat: safeStat(file) }))
      .filter((item) => item.stat?.isFile?.())
      .filter((item) => now - item.stat.mtimeMs >= staleMs && now - item.stat.mtimeMs <= recentMs)
      .filter((item) => !activePaths.has(item.file) && !existingPaths.has(item.file))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
      .slice(0, 6);
    const queued = [];
    for (const item of files) {
      const roomPath = findRoomPath(item.file);
      const roomFiles = collectFiles(roomPath, 2);
      const room = parseRoomName(path.basename(roomPath), roomFiles, roomPath);
      const xmlFiles = roomFiles.filter((file) => path.extname(file).toLowerCase() === ".xml");
      const xml = findCompanionFile(item.file, xmlFiles, ".xml");
      if (!xml) continue;
      const job = await createAutomationJob({
        roomId: room.roomId,
        videoPath: item.file,
        trigger: "recording-file-reconcile",
        triggerEventId: `reconcile:${crypto.createHash("sha1").update(item.file).digest("hex").slice(0, 16)}`,
        uploadPolicy: settings.automation.uploadPolicy
      });
      queued.push(job);
      if (settings.automation.autoAnalyze && job.status === "queued") {
        void runAutomationJob(job.id).catch((error) => markAutomationJobError(job.id, error));
      }
    }
    return queued;
  } finally {
    automationReconcileRunning = false;
  }
}

function normalizeAutomationJob(job) {
  return {
    id: String(job.id || ""),
    roomId: normalizeRoomId(job.roomId || ""),
    videoPath: String(job.videoPath || ""),
    trigger: String(job.trigger || "manual"),
    triggerEventId: job.triggerEventId || null,
    uploadPolicy: normalizeUploadPolicy({ uploadPolicy: job.uploadPolicy || "review" }),
    status: String(job.status || "queued"),
    stage: String(job.stage || "queued"),
    message: String(job.message || ""),
    candidates: Array.isArray(job.candidates) ? job.candidates : [],
    acceptedClips: Array.isArray(job.acceptedClips) ? job.acceptedClips : [],
    exportedClips: Array.isArray(job.exportedClips)
      ? job.exportedClips
      : (Array.isArray(job.acceptedClips) ? job.acceptedClips.filter((clip) => clip.exportPath) : []),
    uploadDraftPath: job.uploadDraftPath || null,
    uploadPreflight: job.uploadPreflight || null,
    uploadJobId: job.uploadJobId || null,
    projectPath: job.projectPath || null,
    error: String(job.error || ""),
    createdAt: job.createdAt || new Date().toISOString(),
    updatedAt: job.updatedAt || new Date().toISOString()
  };
}

async function runAutomationJob(jobId, overrides = {}) {
  await loadAutomationJobs();
  const job = automationJobs.get(String(jobId));
  if (!job) throw new Error(`Automation job not found: ${jobId}`);
  const settings = await readServiceSettings();
  const automation = { ...settings.automation, ...(overrides.automation || {}) };
  Object.assign(job, {
    status: "running",
    stage: "analyzing",
    message: "Analyzing danmaku/subtitle signals for high-confidence clips.",
    error: "",
    updatedAt: new Date().toISOString()
  });
  await persistAutomationJobs();

  const context = await getVideoContext(job.videoPath);
  const localCandidates = buildSliceCandidates(context, {
    sources: automation.sources,
    clipCount: automation.clipCount,
    precisionMode: "high"
  });
  const candidates = await enhanceSliceCandidatesWithModel(context, automation, localCandidates, settings);
  const acceptedClips = candidates
    .filter((candidate) => passesAutomationClipPolicy(candidate, automation))
    .slice(0, automation.clipCount)
    .map((candidate) => ({
      ...candidate,
      status: "draft",
      uploadPolicy: job.uploadPolicy,
      automation: candidate.automation
    }));

  let finalClips = acceptedClips;
  let projectPath = await writeAutomationProjectDraft(job.videoPath, finalClips);
  let uploadDraftPath = null;
  let uploadPreflight = null;
  let uploadJobId = null;
  let exportedClips = [];
  let stage = finalClips.length ? "clips-ready" : "no-high-confidence-clips";
  let message = finalClips.length
    ? `Prepared ${finalClips.length} high-confidence clip draft(s).`
    : "No high-confidence clip passed the current precision threshold.";

  if (finalClips.length && automation.autoExport) {
    Object.assign(job, {
      status: "running",
      stage: "exporting",
      message: `Exporting ${finalClips.length} accepted clip(s).`,
      candidates,
      acceptedClips: finalClips,
      projectPath,
      updatedAt: new Date().toISOString()
    });
    await persistAutomationJobs();
    finalClips = await exportAutomationClips(job.videoPath, finalClips, context, automation);
    exportedClips = finalClips.filter((clip) => clip.exportPath);
    projectPath = await writeAutomationProjectDraft(job.videoPath, finalClips);
    stage = "exported";
    message = `Exported ${exportedClips.length} accepted clip(s).`;
  }

  if (finalClips.some((clip) => clip.exportPath)) {
    if (!exportedClips.length) exportedClips = finalClips.filter((clip) => clip.exportPath);
    const uploadResult = await prepareAutomationUpload(job, finalClips, context, automation);
    uploadDraftPath = uploadResult.uploadDraftPath;
    uploadPreflight = uploadResult.uploadPreflight;
    uploadJobId = uploadResult.uploadJobId;
    if (uploadResult.stage) stage = uploadResult.stage;
    if (uploadResult.message) message = uploadResult.message;
  }

  Object.assign(job, {
    status: "ready",
    stage,
    message,
    candidates,
    acceptedClips: finalClips,
    exportedClips,
    uploadDraftPath,
    uploadPreflight,
    uploadJobId,
    projectPath,
    updatedAt: new Date().toISOString()
  });
  await persistAutomationJobs();
  return job;
}

function passesAutomationClipPolicy(candidate, automation = {}) {
  const evidenceCount = Array.isArray(candidate.evidence) ? candidate.evidence.length : 0;
  if (Number(candidate.score || 0) < Number(automation.minScore || 72)) return false;
  if (evidenceCount < Number(automation.minEvidenceCount || 2)) return false;
  if (automation.requireHighConfidence !== false && candidate.automation?.eligibleForAutoUpload === false) return false;
  return true;
}

async function exportAutomationClips(videoPath, clips, context, automation) {
  const burnSubtitles = Boolean(automation.burnSubtitles);
  const subtitles = Array.isArray(context.subtitles) ? context.subtitles : [];
  const exported = [];
  for (const clip of clips) {
    const result = await exportClip(videoPath, {
      ...clip,
      burnSubtitles: clip.burnSubtitles ?? burnSubtitles,
      subtitles
    });
    exported.push({
      ...clip,
      status: "exported",
      exportPath: result.path,
      mediaUrl: result.mediaUrl
    });
  }
  return exported;
}

async function prepareAutomationUpload(job, clips, context, automation) {
  const parts = clips
    .filter((clip) => clip.exportPath)
    .map((clip, index) => ({
      id: clip.id || `automation-${index + 1}`,
      title: clip.title || `P${index + 1}`,
      path: clip.exportPath,
      source: "automation"
    }));
  if (!parts.length) {
    return { uploadDraftPath: null, uploadPreflight: null, uploadJobId: null, stage: "", message: "" };
  }

  const policyName = normalizeUploadPolicy({ uploadPolicy: job.uploadPolicy || automation.uploadPolicy || "review" });
  const score = Math.max(...clips.map((clip) => Number(clip.automation?.score ?? clip.score ?? 0)), 0);
  const evidenceCount = clips.reduce((count, clip) => count + (Array.isArray(clip.evidence) ? clip.evidence.length : 0), 0);
  const tools = getUploadTools();
  const draft = {
    ...getUploadDefaults(),
    publishMode: "upload",
    uploadPolicy: policyName,
    automationPolicy: policyName,
    ...(policyName === "auto-only-self" ? { visibility: "onlySelf", isOnlySelf: 1 } : {}),
    ...(policyName === "auto-public" ? { visibility: "public", isOnlySelf: 0 } : {}),
    title: clips[0]?.title || context.room?.name || "Bilibili live clip",
    desc: buildAutomationUploadDescription(context, clips),
    tag: getUploadDefaults().tag || "live,clip",
    parts,
    cookiePath: tools.cookiePath || path.join(draftsDir, "cookies.json"),
    autoSubmit: Boolean(automation.autoUpload),
    automation: {
      eligibleForAutoUpload: clips.every((clip) => clip.automation?.eligibleForAutoUpload !== false),
      score,
      evidenceCount,
      signalFamilies: [...new Set(clips.flatMap((clip) => clip.automation?.signalFamilies || []))]
    }
  };

  const uploadDraftPath = path.join(draftsDir, `automation-${job.id}.json`);
  await fsp.mkdir(path.dirname(uploadDraftPath), { recursive: true });
  await fsp.writeFile(uploadDraftPath, JSON.stringify({ ...draft, updatedAt: new Date().toISOString() }, null, 2), "utf8");

  if (!automation.autoUpload) {
    return {
      uploadDraftPath,
      uploadPreflight: null,
      uploadJobId: null,
      stage: "upload-draft-ready",
      message: `Prepared upload draft for ${parts.length} exported clip(s).`
    };
  }

  if (!["auto-only-self", "auto-public"].includes(policyName)) {
    return {
      uploadDraftPath,
      uploadPreflight: null,
      uploadJobId: null,
      stage: "review-ready",
      message: `Prepared upload draft; ${policyName} policy requires manual review.`
    };
  }

  const policy = evaluateUploadPolicy(draft, { confirmed: true });
  Object.assign(draft, policy.effectiveDraft);
  const uploadPreflight = preflightUpload(draft);
  if (!policy.canRun || !uploadPreflight.ok) {
    return {
      uploadDraftPath,
      uploadPreflight,
      uploadJobId: null,
      stage: "upload-blocked",
      message: (policy.issues[0] || uploadPreflight.issues[0] || "Upload preflight blocked automation.")
    };
  }

  const payload = buildBiliupCommand({ draft });
  const uploadJob = createUploadJob("automation-biliup-run", policyName === "auto-only-self" ? "Automation private upload" : "Automation public upload");
  uploadJob.policy = policy;
  runProcessJob(uploadJob, payload.executablePath, payload.args, { cwd: process.cwd(), timeoutMs: 1000 * 60 * 60 * 6 });
  return {
    uploadDraftPath,
    uploadPreflight,
    uploadJobId: uploadJob.id,
    stage: "upload-started",
    message: `Started biliup upload job ${uploadJob.id}.`
  };
}

function buildAutomationUploadDescription(context, clips) {
  const lines = [
    `Source: ${context.name || path.basename(context.path || "")}`,
    "",
    ...clips.map((clip, index) => [
      `P${index + 1}: ${clip.title}`,
      `${formatTime(clip.start)} - ${formatTime(clip.end)}`,
      clip.reason || "",
      ...(Array.isArray(clip.evidence) ? clip.evidence.slice(0, 3) : [])
    ].filter(Boolean).join("\n"))
  ];
  return lines.join("\n\n").slice(0, 1800);
}

async function writeAutomationProjectDraft(videoPath, clips) {
  const projectPath = getProjectPath(videoPath);
  let current = {};
  if (fs.existsSync(projectPath)) {
    try {
      current = JSON.parse(await fsp.readFile(projectPath, "utf8"));
    } catch {
      current = {};
    }
  }
  const existingClips = Array.isArray(current.clips) ? current.clips : [];
  const byId = new Map(existingClips.map((clip) => [clip.id, clip]));
  for (const clip of clips) {
    byId.set(clip.id, { ...byId.get(clip.id), ...clip });
  }
  const payload = {
    ...current,
    videoPath,
    clips: [...byId.values()],
    danmakuEdits: current.danmakuEdits || {},
    subtitles: current.subtitles || null,
    automation: {
      ...(current.automation || {}),
      updatedAt: new Date().toISOString(),
      acceptedClipIds: clips.map((clip) => clip.id)
    },
    updatedAt: new Date().toISOString()
  };
  await fsp.mkdir(path.dirname(projectPath), { recursive: true });
  await fsp.writeFile(projectPath, JSON.stringify(payload, null, 2), "utf8");
  return projectPath;
}

async function markAutomationJobError(jobId, error) {
  await loadAutomationJobs();
  const job = automationJobs.get(String(jobId));
  if (!job) return;
  Object.assign(job, {
    status: "error",
    stage: "error",
    message: readableError(error),
    error: readableError(error),
    updatedAt: new Date().toISOString()
  });
  await persistAutomationJobs();
}

function getInternalRecorderHealth(recordingSettings = {}) {
  const outputDir = path.resolve(recordingSettings.outputDir || getRecordingsRoot() || path.join(workbenchRoot, "recordings"));
  return {
    available: true,
    activeRooms: internalRecorders.size,
    outputDir,
    backend: "internal",
    message: `直播录制可用：FLV ${recordingSettings.streamCodec || "avc"}，弹幕 ${recordingSettings.enableDanmaku === false ? "关闭" : "开启"}`
  };
}

export function startRecordingAutoMonitor(options = {}) {
  ensureWorkspace();
  recordingMonitorActivated = true;
  scheduleRecordingAutoMonitor(Number(options.initialDelayMs ?? 1500));
  void reconcileRecordingLiveMonitors().catch((error) => {
    recordingMonitorLastResult = {
      status: "error",
      checked: 0,
      started: 0,
      waiting: 0,
      skipped: 0,
      errors: 1,
      messages: [`自动录制监听启动失败：${readableError(error)}`],
      updatedAt: new Date().toISOString(),
      nextDelayMs: 30000
    };
    scheduleRecordingAutoMonitor(30000);
  });
  return { ok: true, running: Boolean(recordingMonitorTimer || recordingMonitorRunning || roomLiveMonitors.size) };
}

export function stopRecordingAutoMonitor() {
  recordingMonitorActivated = false;
  if (recordingMonitorTimer) {
    clearTimeout(recordingMonitorTimer);
    recordingMonitorTimer = null;
  }
  recordingMonitorNextRunAt = null;
  stopAllRoomLiveMonitors();
  return { ok: true };
}

function applyRecordingMonitorSettings(recordingSettings = {}) {
  if (recordingSettings.autoMonitorEnabled === false) {
    stopRecordingAutoMonitor();
    return;
  }
  if (!recordingMonitorActivated) return;
  scheduleRecordingAutoMonitor(1000);
  void reconcileRecordingLiveMonitors().catch((error) => {
    recordingMonitorLastResult = {
      status: "error",
      checked: 0,
      started: 0,
      waiting: 0,
      skipped: 0,
      errors: 1,
      messages: [`自动录制监听刷新失败：${readableError(error)}`],
      updatedAt: new Date().toISOString(),
      nextDelayMs: 30000
    };
  });
}

function scheduleRecordingAutoMonitor(delayMs = 30000) {
  const safeDelay = Math.max(1000, Number(delayMs || 30000));
  if (recordingMonitorTimer) clearTimeout(recordingMonitorTimer);
  recordingMonitorNextRunAt = new Date(Date.now() + safeDelay).toISOString();
  recordingMonitorTimer = setTimeout(async () => {
    recordingMonitorTimer = null;
    recordingMonitorNextRunAt = null;
    try {
      const result = await runRecordingAutoMonitorSweep();
      scheduleRecordingAutoMonitor(result?.nextDelayMs || 30000);
    } catch {
      scheduleRecordingAutoMonitor(30000);
    }
  }, safeDelay);
  if (typeof recordingMonitorTimer.unref === "function") recordingMonitorTimer.unref();
}

async function getRecordingAutoMonitorStatus() {
  const settings = await readServiceSettings();
  const rooms = await readFixedRooms();
  const enabledRooms = rooms.filter((room) => room.enabled !== false);
  const roomStatuses = enabledRooms.map((room) => publicFixedRoom(room));
  return {
    enabled: settings.recording.autoMonitorEnabled !== false,
    running: recordingMonitorRunning || roomLiveMonitors.size > 0,
    scheduled: Boolean(recordingMonitorTimer),
    nextRunAt: recordingMonitorNextRunAt,
    lastResult: recordingMonitorLastResult,
    intervalSeconds: Number(settings.recording.pollIntervalSeconds || 600),
    eventMonitorRooms: roomLiveMonitors.size,
    enabledRooms: enabledRooms.length,
    activeRecordings: activeInternalRecordingSlotCount(),
    waitingRooms: roomStatuses.filter((status) => String(status.taskStatus || "") === "waiting").length,
    updatedAt: new Date().toISOString()
  };
}

async function runRecordingAutoMonitorSweep(options = {}) {
  if (recordingMonitorRunning) {
    return recordingMonitorLastResult || { status: "busy", checked: 0, started: 0, waiting: 0, skipped: 0, errors: 0 };
  }
  recordingMonitorRunning = true;
  const result = {
    status: "ok",
    checked: 0,
    started: 0,
    waiting: 0,
    skipped: 0,
    errors: 0,
    messages: [],
    updatedAt: new Date().toISOString(),
    nextDelayMs: 30000
  };
  try {
    const settings = await readServiceSettings();
    result.nextDelayMs = Math.max(5000, Number(settings.recording.pollIntervalSeconds || 600) * 1000);
    const monitorCheckedAt = result.updatedAt;
    const nextMonitorAt = new Date(Date.now() + result.nextDelayMs).toISOString();
    if (settings.recording.autoMonitorEnabled === false) {
      result.status = "disabled";
      result.messages.push("自动录制已关闭。");
      recordingMonitorLastResult = result;
      return result;
    }

    const allRooms = await readFixedRooms({ enrichMetadata: !options.fast });
    const rooms = allRooms.filter((room) => room.enabled !== false);
    if (recordingMonitorActivated) reconcileRecordingLiveMonitors(settings, allRooms);
    let roomsChanged = false;
    for (const room of rooms.sort((a, b) => Number(a.priority || 100) - Number(b.priority || 100))) {
      result.checked += 1;
      const roomId = room.roomId;
      const current = getRoomRuntimeStatus(roomId);
      if (internalRecorders.has(roomId) || isActiveRecordingStatus(current)) {
        setRoomRuntimeStatus(roomId, {
          ...current,
          monitorCheckedAt,
          nextMonitorAt
        });
        result.skipped += 1;
        continue;
      }
      try {
        const info = await resolveBiliRoomInfo(room.realRoomId || roomId, settings.recording);
        const refreshedRoom = mergeFixedRoomMetadata(room, info);
        if (fixedRoomMetadataSignature(refreshedRoom) !== fixedRoomMetadataSignature(room)) {
          Object.assign(room, refreshedRoom);
          roomsChanged = true;
        }
        if (info.liveStatus === 1) {
          if (activeInternalRecordingSlotCount() >= Number(settings.recording.maxConcurrentRecordings || 3)) {
            setRoomRuntimeStatus(roomId, {
              taskStatus: "waiting",
              liveStatus: "live",
              monitorCheckedAt,
              nextMonitorAt,
              message: "已开播，等待录制空位",
              nextAction: "stop",
              log: `开播事件已收到，但录制并发已满：${roomId}\n`
            });
            result.waiting += 1;
            result.messages.push(`${roomId} 已开播但并发已满`);
            continue;
          }
          const status = await startRecordingRoom(roomId, { trigger: "auto-monitor" });
          if (status.taskStatus === "error") {
            result.errors += 1;
            result.messages.push(`${roomId} 自动启动失败：${status.message}`);
          } else {
            setRoomRuntimeStatus(roomId, {
              ...getRoomRuntimeStatus(roomId),
              monitorCheckedAt,
              nextMonitorAt
            });
            result.started += 1;
            result.messages.push(`${roomId} 已开播，自动启动录制`);
          }
          continue;
        }
        const assets = await scanRecordingAssetsForRoom(roomId);
        setRoomRuntimeStatus(roomId, {
          ...assets,
          taskStatus: "waiting",
          liveStatus: "offline",
          monitorCheckedAt,
          nextMonitorAt,
          message: "等待开播",
          nextAction: "stop",
          refreshed: Boolean(assets.recordingPath),
          log: `自动录制：${roomId} 等待开播\n`
        });
        result.waiting += 1;
      } catch (error) {
        result.errors += 1;
        const message = readableError(error);
        const invalidRoom = /not found|invalid|不存在|无效/i.test(message);
        setRoomRuntimeStatus(roomId, {
          taskStatus: invalidRoom ? "error" : "waiting",
          liveStatus: "unknown",
          monitorCheckedAt,
          nextMonitorAt,
          message: invalidRoom ? message : `自动录制暂时不可用，稍后重试：${message}`,
          nextAction: invalidRoom ? "edit" : "stop",
          log: `自动录制状态更新失败 ${roomId}：${message}\n`
        });
        result.messages.push(`${roomId} 自动录制状态更新失败：${message}`);
      }
    }
    if (roomsChanged) await writeFixedRooms(allRooms);
    recordingMonitorLastResult = result;
    return result;
  } finally {
    recordingMonitorRunning = false;
  }
}

function activeInternalRecordingSlotCount() {
  return [...internalRecorders.keys()].filter((roomId) => isActiveRecordingStatus(getRoomRuntimeStatus(roomId))).length;
}

function isActiveRecordingStatus(status = {}) {
  const taskStatus = String(status.taskStatus || "");
  const liveStatus = String(status.liveStatus || "");
  if (["starting", "recording", "finalizing"].includes(taskStatus)) return true;
  return taskStatus === "waiting" && liveStatus === "live" && Boolean(status.recordingPath || status.bytesWritten);
}

async function reconcileRecordingLiveMonitors(settingsInput = null, roomsInput = null) {
  if (!recordingMonitorActivated) return;
  let settings = settingsInput;
  if (!settings) settings = await readServiceSettings();
  const recordingSettings = settings.recording || settings;
  if (recordingSettings.autoMonitorEnabled === false) {
    stopAllRoomLiveMonitors();
    return;
  }
  const rooms = roomsInput || await readFixedRooms({ enrichMetadata: true }).catch(() => []);
  const enabledRooms = rooms.filter((room) => room.enabled !== false && normalizeRoomId(room.roomId));
  const enabledIds = new Set(enabledRooms.map((room) => normalizeRoomId(room.roomId)));
  for (const roomId of [...roomLiveMonitors.keys()]) {
    if (!enabledIds.has(roomId)) stopRoomLiveMonitor(roomId);
  }
  for (const room of enabledRooms) {
    const roomId = normalizeRoomId(room.roomId);
    const status = getRoomRuntimeStatus(roomId);
    if (internalRecorders.has(roomId) || isActiveRecordingStatus(status)) {
      stopRoomLiveMonitor(roomId);
      continue;
    }
    const liveStatus = normalizeBiliLiveStatus(status.liveStatus) !== "unknown"
      ? normalizeBiliLiveStatus(status.liveStatus)
      : normalizeBiliLiveStatus(room.biliLiveStatus);
    if (liveStatus === "live") {
      void handleRoomMonitorLiveBegan(room, recordingSettings, "metadata").catch((error) => {
        setRoomRuntimeStatus(roomId, {
          taskStatus: "waiting",
          liveStatus: "live",
          message: `开播监听启动录制失败，稍后重试：${readableError(error)}`,
          nextAction: "stop",
          log: `开播监听启动录制失败 ${roomId}：${readableError(error)}\n`
        });
        scheduleRecordingAutoMonitor(5000);
      });
      continue;
    }
    startRoomLiveMonitor(room, recordingSettings);
  }
}

function startRoomLiveMonitor(room, recordingSettings = null) {
  const roomId = normalizeRoomId(room?.roomId);
  if (!roomId || room?.enabled === false) return null;
  const current = getRoomRuntimeStatus(roomId);
  if (internalRecorders.has(roomId) || isActiveRecordingStatus(current)) return null;
  if (roomLiveMonitors.has(roomId)) return roomLiveMonitors.get(roomId);
  const realRoomId = normalizeRoomId(room.realRoomId || roomId);
  const state = {
    roomId,
    realRoomId,
    ws: null,
    heartbeat: null,
    reconnectTimer: null,
    closed: false,
    failures: 0,
    lastError: ""
  };
  roomLiveMonitors.set(roomId, state);
  if (!["waiting", "starting", "recording", "finalizing"].includes(String(current.taskStatus || "")) && !(current.taskStatus === "completed" && current.recordingPath)) {
    setRoomRuntimeStatus(roomId, {
      taskStatus: "waiting",
      liveStatus: normalizeBiliLiveStatus(room.biliLiveStatus),
      message: "等待开播",
      nextAction: "stop",
      log: `房间 ${roomId} 自动录制已开启\n`
    });
  }
  void connectRoomLiveMonitor(state, room, recordingSettings);
  return state;
}

async function connectRoomLiveMonitor(state, room, recordingSettingsInput = null) {
  try {
    const recordingSettings = recordingSettingsInput || (await readServiceSettings()).recording;
    const info = await resolveBiliDanmakuInfo(state.realRoomId, recordingSettings);
    const host = asArray(info.host_list)[0];
    if (!host?.host) throw new Error("Bili danmaku host is missing.");
    if (state.closed) return;
    const scheme = host.scheme || "wss";
    const port = scheme === "ws" ? (host.ws_port || host.port || 2243) : (host.wss_port || host.port || 443);
    const url = `${scheme}://${host.host}:${port}/sub`;
    const ws = new WebSocket(url, { headers: getBiliHeaders(state.realRoomId, recordingSettings) });
    state.ws = ws;
    ws.binaryType = "nodebuffer";
    ws.on("open", () => {
      state.failures = 0;
      ws.send(createDanmakuPacket(7, JSON.stringify(createBiliDanmakuAuthPayload(state.realRoomId, info.token || "", recordingSettings))));
      state.heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(createDanmakuPacket(2, ""));
      }, 30000);
      if (typeof state.heartbeat.unref === "function") state.heartbeat.unref();
      const current = getRoomRuntimeStatus(state.roomId);
      if (!isActiveRecordingStatus(current) && !(current.taskStatus === "completed" && current.recordingPath)) {
        setRoomRuntimeStatus(state.roomId, {
          taskStatus: "waiting",
          liveStatus: normalizeBiliLiveStatus(room.biliLiveStatus),
          message: "等待开播",
          nextAction: "stop",
          log: `房间 ${state.roomId} 开播/下播事件连接已建立\n`
        });
      }
    });
    ws.on("message", (data) => {
      for (const message of parseDanmakuPacketBuffer(Buffer.from(data))) {
        void handleRoomLiveMonitorMessage(state, room, recordingSettings, message).catch((error) => {
          state.lastError = readableError(error);
          setRoomRuntimeStatus(state.roomId, {
            taskStatus: "waiting",
            liveStatus: "unknown",
            message: `开播监听事件处理失败，稍后重试：${state.lastError}`,
            nextAction: "stop",
            log: `开播监听事件处理失败 ${state.roomId}：${state.lastError}\n`
          });
          scheduleRecordingAutoMonitor(5000);
        });
      }
    });
    ws.on("error", (error) => {
      state.lastError = readableError(error);
    });
    ws.on("close", () => {
      if (state.heartbeat) clearInterval(state.heartbeat);
      state.heartbeat = null;
      scheduleRoomLiveMonitorReconnect(state, room, recordingSettings);
    });
  } catch (error) {
    state.lastError = readableError(error);
    scheduleRoomLiveMonitorReconnect(state, room, recordingSettingsInput);
  }
}

async function handleRoomLiveMonitorMessage(state, room, recordingSettings, message) {
  const cmd = String(message?.cmd || "").split(":")[0];
  if (cmd === "LIVE") {
    await handleRoomMonitorLiveBegan(room, recordingSettings, "danmaku");
  } else if (cmd === "PREPARING") {
    await handleRoomMonitorLiveEnded(room, recordingSettings, "danmaku");
  } else if (cmd === "ROOM_CHANGE") {
    void refreshFixedRoomMetadataFromMonitor(room.roomId, recordingSettings);
  }
}

async function handleRoomMonitorLiveBegan(room, recordingSettingsInput = null, trigger = "monitor") {
  const roomId = normalizeRoomId(room?.roomId);
  if (!roomId) return null;
  const settings = recordingSettingsInput || (await readServiceSettings()).recording;
  if (settings.autoMonitorEnabled === false) return null;
  const configured = await findFixedRoom(roomId);
  if (!configured || configured.enabled === false) return null;
  const current = getRoomRuntimeStatus(roomId);
  if (internalRecorders.has(roomId) || isActiveRecordingStatus(current)) return current;
  stopRoomLiveMonitor(roomId);
  await emitRoomMonitorTimelineEvent("RoomMonitorLiveBeganEvent", configured, { trigger });
  if (activeInternalRecordingSlotCount() >= Number(settings.maxConcurrentRecordings || 3)) {
    return setRoomRuntimeStatus(roomId, {
      taskStatus: "waiting",
      liveStatus: "live",
      message: "已开播，等待录制空位",
      nextAction: "stop",
      log: `开播事件已收到，但录制并发已满：${roomId}\n`
    });
  }
  setRoomRuntimeStatus(roomId, {
    taskStatus: "starting",
    liveStatus: "live",
    message: "开播，准备录制",
    nextAction: "wait",
    log: `开播事件已收到：${roomId}\n`
  });
  const status = await startRecordingRoom(roomId, { trigger: `event-${trigger}` });
  if (status.taskStatus === "error" && isRecoverableStreamRecordingStatus(status)) {
    scheduleRecordingAutoMonitor(5000);
    return setRoomRuntimeStatus(roomId, {
      ...status,
      taskStatus: "waiting",
      liveStatus: "live",
      message: "开播，准备录制",
      nextAction: "stop"
    });
  }
  return status;
}

async function handleRoomMonitorLiveEnded(room, recordingSettingsInput = null, trigger = "monitor") {
  const roomId = normalizeRoomId(room?.roomId);
  if (!roomId) return null;
  const current = getRoomRuntimeStatus(roomId);
  if (isActiveRecordingStatus(current)) return current;
  const configured = await findFixedRoom(roomId);
  if (!configured || configured.enabled === false) return null;
  await emitRoomMonitorTimelineEvent("RoomMonitorLiveEndedEvent", configured, { trigger });
  return getRoomRuntimeStatus(roomId);
}

async function refreshFixedRoomMetadataFromMonitor(roomId, recordingSettings) {
  try {
    const rooms = await readFixedRooms();
    const index = rooms.findIndex((room) => room.roomId === normalizeRoomId(roomId));
    if (index < 0) return;
    const info = await resolveBiliRoomInfo(rooms[index].realRoomId || rooms[index].roomId, recordingSettings);
    rooms[index] = mergeFixedRoomMetadata(rooms[index], info);
    await writeFixedRooms(rooms);
  } catch {
    // Room-change metadata is opportunistic; normal sweeps will repair it later.
  }
}

function scheduleRoomLiveMonitorReconnect(state, room, recordingSettings = null) {
  if (state.closed || !recordingMonitorActivated) return;
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  state.failures += 1;
  const delayMs = Math.min(120000, 5000 * Math.max(1, state.failures));
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    if (!state.closed && recordingMonitorActivated) void connectRoomLiveMonitor(state, room, recordingSettings);
  }, delayMs);
  if (typeof state.reconnectTimer.unref === "function") state.reconnectTimer.unref();
}

function stopRoomLiveMonitor(roomId) {
  const normalizedRoomId = normalizeRoomId(roomId);
  const state = roomLiveMonitors.get(normalizedRoomId);
  if (!state) return false;
  state.closed = true;
  if (state.heartbeat) clearInterval(state.heartbeat);
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  if (state.ws && state.ws.readyState < WebSocket.CLOSING) state.ws.close();
  roomLiveMonitors.delete(normalizedRoomId);
  return true;
}

function stopAllRoomLiveMonitors() {
  for (const roomId of [...roomLiveMonitors.keys()]) stopRoomLiveMonitor(roomId);
}

async function emitRoomMonitorTimelineEvent(type, room, extraData = {}) {
  const roomId = normalizeRoomId(room.roomId);
  const realRoomId = normalizeRoomId(room.realRoomId || roomId);
  return ingestRecordingEventWebhook({
    type,
    date: new Date().toISOString(),
    data: {
      room_id: Number(roomId),
      real_room_id: Number(realRoomId || roomId),
      room_info: {
        room_id: Number(roomId),
        real_room_id: Number(realRoomId || roomId),
        title: room.name || room.title || `房间 ${roomId}`
      },
      backend: "monitor",
      ...extraData
    }
  });
}

function stopIdleInternalRoomMonitor(roomId) {
  const normalizedRoomId = normalizeRoomId(roomId);
  const recorder = internalRecorders.get(normalizedRoomId);
  if (!recorder) return false;
  const status = getRoomRuntimeStatus(normalizedRoomId);
  if (isActiveRecordingStatus(status)) return false;
  recorder.stopping = true;
  recorder.controller.abort();
  internalRecorders.delete(normalizedRoomId);
  return true;
}

async function startRecordingRoom(roomId, body = {}) {
  const normalizedRoomId = normalizeRoomId(roomId);
  if (!normalizedRoomId) throw new Error("直播间 ID 无效。");
  const room = await findFixedRoom(normalizedRoomId);
  if (!room && body.requireConfigured !== false) throw new Error(`房间 ${normalizedRoomId} 不存在。`);

  setRoomRuntimeStatus(normalizedRoomId, {
    taskStatus: "starting",
    message: "正在启动录制任务",
    nextAction: "wait",
    log: `正在启动 ${normalizedRoomId}\n`
  });

  try {
    const settings = await readServiceSettings();
    return await startInternalBiliRecorder(settings.recording, room || { roomId: normalizedRoomId, name: `房间 ${normalizedRoomId}` });
  } catch (error) {
    return setRoomRuntimeStatus(normalizedRoomId, {
      taskStatus: "error",
      message: readableError(error),
      nextAction: "retry",
      log: readableError(error)
    });
  }
}

async function stopRecordingRoom(roomId) {
  const normalizedRoomId = normalizeRoomId(roomId);
  if (!normalizedRoomId) throw new Error("直播间 ID 无效。");
  if (internalRecorders.has(normalizedRoomId)) {
    return await stopInternalBiliRecorder(normalizedRoomId);
  }
  const assets = await scanRecordingAssetsForRoom(normalizedRoomId);
  const current = getRoomRuntimeStatus(normalizedRoomId);
  mediaCache.clear();
  return setRoomRuntimeStatus(normalizedRoomId, {
    ...assets,
    taskStatus: assets.recordingPath ? "completed" : "waiting",
    liveStatus: current.liveStatus || "unknown",
    message: assets.recordingPath ? "已完成" : "当前没有正在录制的任务，自动录制会继续等待开播。",
    nextAction: assets.recordingPath ? "open" : "wait",
    refreshed: Boolean(assets.recordingPath),
    log: `停止检查 ${normalizedRoomId}\n${assets.recordingPath || "没有正在写入的视频文件"}\n${assets.danmakuPath || "没有弹幕文件"}\n`
  });
}

async function startInternalBiliRecorder(recordingSettings, room) {
  const roomId = normalizeRoomId(room.roomId);
  stopRoomLiveMonitor(roomId);
  if (internalRecorders.has(roomId)) {
    const status = getRoomRuntimeStatus(roomId);
    return setRoomRuntimeStatus(roomId, {
      ...status,
      message: status.message || "直播录制已在运行",
      nextAction: "stop"
    });
  }
  if (activeInternalRecordingSlotCount() >= Number(recordingSettings.maxConcurrentRecordings || 3)) {
    throw new Error(`直播录制并发已达到上限：${recordingSettings.maxConcurrentRecordings || 3}`);
  }

  const roomInfo = await resolveBiliRoomInfo(roomId, recordingSettings);
  const controller = new AbortController();
  const recorder = {
    roomId,
    realRoomId: normalizeRoomId(roomInfo.realRoomId || roomId),
    roomName: room.name || roomInfo.title || `房间 ${roomId}`,
    recordingSettings,
    controller,
    stopping: false,
    segment: null,
    finalizingSegment: null,
    finalizedSegments: new Set(),
    danmaku: null,
    danmakuCount: 0,
    danmakuCurrentPath: null,
    danmakuSegmentStartedAtMs: null,
    danmakuStatus: null,
    metrics: createEmptyRecordingMetrics(),
    log: "",
    startedAt: new Date().toISOString(),
    done: null
  };
  internalRecorders.set(roomId, recorder);

  await emitRecordingTimelineEvent("InternalRecorderStartedEvent", recorder, null, { live_status: roomInfo.liveStatus });
  recorder.done = runInternalBiliRecorderLoop(recorder).catch(async (error) => {
    if (!recorder.stopping) {
      await emitRecordingTimelineEvent("InternalRecorderErrorEvent", recorder, recorder.segment?.videoPath || null, { error: readableError(error) });
      setRoomRuntimeStatus(roomId, {
        taskStatus: "error",
        liveStatus: "unknown",
        message: readableError(error),
        nextAction: "retry",
        log: `${recorder.log}${readableError(error)}\n`
      });
    }
  }).finally(() => {
    internalRecorders.delete(roomId);
  });

  return setRoomRuntimeStatus(roomId, {
    taskStatus: roomInfo.liveStatus === 1 ? "starting" : "waiting",
    liveStatus: roomInfo.liveStatus === 1 ? "live" : "offline",
    startedAt: recorder.startedAt,
    elapsedSeconds: 0,
    message: roomInfo.liveStatus === 1 ? "开播，准备录制" : "等待开播",
    nextAction: "stop",
    log: `B 站直播录制已启动 ${roomId}${recorder.realRoomId !== roomId ? ` -> ${recorder.realRoomId}` : ""}\n`
  });
}

async function stopInternalBiliRecorder(roomId) {
  const normalizedRoomId = normalizeRoomId(roomId);
  const recorder = internalRecorders.get(normalizedRoomId);
  if (!recorder) {
    const assets = await scanRecordingAssetsForRoom(normalizedRoomId);
    return setRoomRuntimeStatus(normalizedRoomId, {
      ...assets,
      taskStatus: assets.recordingPath ? "completed" : "idle",
      message: assets.recordingPath ? "已完成" : "直播录制未运行",
      nextAction: assets.recordingPath ? "open" : "start",
      refreshed: Boolean(assets.recordingPath)
    });
  }

  recorder.stopping = true;
  setRoomRuntimeStatus(normalizedRoomId, {
    taskStatus: "finalizing",
    message: "正在停止直播录制",
    nextAction: "wait",
    log: `${recorder.log}正在停止直播录制 ${normalizedRoomId}\n`
  });
  closeInternalDanmaku(recorder);
  recorder.controller.abort();
  const completed = await waitForRecorderDone(recorder.done || Promise.resolve(), 15000);
  if (!completed && recorder.segment) {
    await finalizeInternalSegment(recorder, true);
  }
  internalRecorders.delete(normalizedRoomId);

  const assets = await scanRecordingAssetsForRoom(normalizedRoomId);
  mediaCache.clear();
  return setRoomRuntimeStatus(normalizedRoomId, {
    ...assets,
    ...buildRecordingMetricStatus(recorder),
    taskStatus: assets.recordingPath ? "completed" : "error",
    liveStatus: "offline",
    message: assets.recordingPath ? "已完成" : "停止后没有找到已完成的视频文件。",
    nextAction: assets.recordingPath ? "open" : "retry",
    refreshed: Boolean(assets.recordingPath),
    log: `${recorder.log}已完成停止 ${normalizedRoomId}\n${assets.recordingPath || "没有视频文件"}\n${assets.danmakuPath || "没有弹幕文件"}\n`
  });
}

async function runInternalBiliRecorderLoop(recorder) {
  while (!recorder.controller.signal.aborted) {
    const roomInfo = await resolveBiliRoomInfo(recorder.realRoomId, recorder.recordingSettings);
    if (roomInfo.liveStatus !== 1) {
      closeInternalDanmaku(recorder);
      await emitRecordingTimelineEvent("LiveEndedEvent", recorder, null, { live_status: roomInfo.liveStatus });
      setRoomRuntimeStatus(recorder.roomId, {
        taskStatus: "waiting",
        liveStatus: "offline",
        message: "等待开播",
        nextAction: "stop",
        log: `${recorder.log}未开播，继续等待开播\n`
      });
      await delay(Number(recorder.recordingSettings.pollIntervalSeconds || 600) * 1000, recorder.controller.signal);
      continue;
    }

    try {
      await recordInternalBiliSegment(recorder, roomInfo);
    } catch (error) {
      if (recorder.controller.signal.aborted || recorder.stopping) break;
      if (await moveRecorderToOfflineWaitIfLiveEnded(recorder, error)) {
        await delay(Number(recorder.recordingSettings.pollIntervalSeconds || 600) * 1000, recorder.controller.signal);
        continue;
      }
      if (!isRecoverableInternalRecordingError(error)) throw error;
      const retrySeconds = Number(recorder.recordingSettings.reconnectSeconds || 5);
      const message = "取流重连中";
      recorder.log += `${message}：${readableError(error)}\n`;
      await emitRecordingTimelineEvent("InternalRecorderReconnectEvent", recorder, recorder.segment?.videoPath || null, {
        error: readableError(error),
        retry_seconds: retrySeconds
      });
      const assets = await scanRecordingAssetsForRoom(recorder.roomId);
      setRoomRuntimeStatus(recorder.roomId, {
        ...assets,
        ...buildRecordingMetricStatus(recorder),
        taskStatus: "waiting",
        liveStatus: "live",
        message,
        nextAction: "stop",
        refreshed: Boolean(assets.recordingPath),
        log: recorder.log
      });
      await delay(Math.max(0.1, retrySeconds) * 1000, recorder.controller.signal);
      continue;
    }
    if (!recorder.controller.signal.aborted && !recorder.stopping) {
      setRoomRuntimeStatus(recorder.roomId, {
        taskStatus: "waiting",
        liveStatus: "live",
        message: "取流重连中",
        nextAction: "stop",
        log: `${recorder.log}直播流中断，自动重连\n`
      });
      await delay(Number(recorder.recordingSettings.reconnectSeconds || 5) * 1000, recorder.controller.signal);
    }
  }
}

async function moveRecorderToOfflineWaitIfLiveEnded(recorder, error) {
  if (!isRecoverableInternalRecordingError(error)) return false;
  let roomInfo = null;
  try {
    roomInfo = await resolveBiliRoomInfo(recorder.realRoomId, recorder.recordingSettings);
  } catch {
    return false;
  }
  if (roomInfo.liveStatus === 1) return false;
  const message = "主播已下播，已收尾并继续等待开播";
  closeInternalDanmaku(recorder);
  recorder.log += `${message}：${readableError(error)}\n`;
  await emitRecordingTimelineEvent("LiveEndedEvent", recorder, null, { live_status: roomInfo.liveStatus });
  const assets = await scanRecordingAssetsForRoom(recorder.roomId);
  setRoomRuntimeStatus(recorder.roomId, {
    ...assets,
    ...buildRecordingMetricStatus(recorder),
    taskStatus: "waiting",
    liveStatus: "offline",
    message,
    nextAction: "stop",
    refreshed: Boolean(assets.recordingPath),
    log: recorder.log
  });
  return true;
}

function isRecoverableInternalRecordingError(error) {
  const message = readableError(error);
  return /Bili stream request failed:\s*(403|404|408|409|425|429|5\d\d)|fetch failed|network|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|AbortError|terminated|socket|当前没有可用/i.test(message);
}

async function recordInternalBiliSegment(recorder, roomInfo) {
  const stream = await resolveBiliStreamUrl(recorder.realRoomId, recorder.recordingSettings);
  const paths = await createInternalRecordingPaths(recorder, roomInfo);
  await ensureInternalRecordingSpace(recorder, paths.roomDir);
  recorder.segment = { ...paths, streamUrl: stream.url, startedAtMs: Date.now() };
  recorder.danmakuCurrentPath = paths.danmakuPath;
  recorder.danmakuSegmentStartedAtMs = recorder.segment.startedAtMs;
  resetRecordingSegmentMetrics(recorder);
  recorder.danmakuCount = 0;
  recorder.segmentRolling = false;
  recorder.log += `取流 ${stream.quality || ""} ${stream.host || ""}\n${paths.videoPath}\n`;

  await fsp.writeFile(paths.danmakuPath, `<?xml version="1.0" encoding="UTF-8"?>\n<i>\n`, "utf8");
  if (recorder.recordingSettings.saveRawDanmaku) {
    await fsp.writeFile(paths.rawDanmakuPath, "", "utf8");
    await emitRecordingTimelineEvent("RawDanmakuFileCreatedEvent", recorder, paths.rawDanmakuPath);
  }
  await emitRecordingTimelineEvent("LiveBeganEvent", recorder, null, { live_status: 1 });
  await emitRecordingTimelineEvent("DanmakuFileCreatedEvent", recorder, paths.danmakuPath);
  await emitRecordingTimelineEvent("VideoFileCreatedEvent", recorder, paths.videoPath);
  await emitRecordingTimelineEvent("RecordingStartedEvent", recorder, paths.videoPath);

  if (recorder.recordingSettings.enableDanmaku === false) {
    closeInternalDanmaku(recorder);
  } else if (!recorder.danmaku || recorder.danmaku.closed) {
    recorder.danmaku = startInternalDanmakuCapture(recorder);
  }
  setRoomRuntimeStatus(recorder.roomId, {
    taskStatus: "recording",
    liveStatus: "live",
    recordingPath: paths.videoPath,
    danmakuPath: paths.danmakuPath,
    ...buildRecordingMetricStatus(recorder),
    message: "直播录制中",
    nextAction: "stop",
    log: recorder.log
  });

  let completed = false;
  const streamController = new AbortController();
  const abortStream = () => streamController.abort();
  recorder.controller.signal.addEventListener("abort", abortStream, { once: true });
  const segmentSeconds = Number(recorder.recordingSettings.segmentSeconds || 0);
  const fileSizeLimitBytes = Number(recorder.recordingSettings.fileSizeLimitMb || 0) * 1024 * 1024;
  const streamTimeoutSeconds = Number(recorder.recordingSettings.streamTimeoutSeconds || 0);
  const segmentTimer = segmentSeconds > 0
    ? setTimeout(() => {
        recorder.segmentRolling = true;
        streamController.abort();
      }, segmentSeconds * 1000)
    : null;
  const streamTimer = streamTimeoutSeconds > 0
    ? setTimeout(() => {
        recorder.log += `取流超过 ${streamTimeoutSeconds}s，准备重连\n`;
        streamController.abort();
      }, streamTimeoutSeconds * 1000)
    : null;
  try {
    const response = await fetch(stream.url, {
      headers: getBiliHeaders(recorder.realRoomId, recorder.recordingSettings),
      signal: streamController.signal
    });
    if (!response.ok || !response.body) throw new Error(`Bili stream request failed: ${response.status} ${response.statusText}`);
    const writeOptions = {
      highWaterMark: Math.max(4096, Math.min(512 * 1024 * 1024, Number(recorder.recordingSettings.bufferSizeKb || 8) * 1024))
    };
    const source = Readable.fromWeb(response.body);
    await pipeline(
      source,
      createRecordingProgressTransform(recorder, {
        maxBytes: fileSizeLimitBytes,
        onLimit: () => {
          recorder.segmentRolling = true;
          streamController.abort();
        }
      }),
      fs.createWriteStream(paths.videoPath, writeOptions)
    );
    completed = true;
  } catch (error) {
    if (recorder.segmentRolling) {
      completed = true;
      recorder.log += `达到分段条件${segmentSeconds ? ` ${segmentSeconds}s` : ""}${fileSizeLimitBytes ? ` / ${recorder.recordingSettings.fileSizeLimitMb}MB` : ""}，开始新分段\n`;
    } else if (!recorder.controller.signal.aborted) {
      recorder.log += `录制中断：${readableError(error)}\n`;
      throw error;
    }
  } finally {
    if (segmentTimer) clearTimeout(segmentTimer);
    if (streamTimer) clearTimeout(streamTimer);
    recorder.controller.signal.removeEventListener("abort", abortStream);
    try {
      recorder.finalizingSegment = finalizeInternalSegment(recorder, completed || recorder.stopping);
      await recorder.finalizingSegment;
    } finally {
      recorder.finalizingSegment = null;
    }
    recorder.segmentRolling = false;
  }
}

function createEmptyRecordingMetrics() {
  const now = Date.now();
  return {
    bytesWritten: 0,
    segmentBytes: 0,
    speedBytesPerSecond: 0,
    averageSpeedBytesPerSecond: 0,
    startedAtMs: now,
    segmentStartedAtMs: now,
    lastBytesAtMs: null,
    lastStatusAtMs: 0,
    lastSampleAtMs: now,
    lastSampleBytes: 0
  };
}

function resetRecordingSegmentMetrics(recorder) {
  const now = Date.now();
  const metrics = recorder.metrics || createEmptyRecordingMetrics();
  recorder.metrics = {
    ...metrics,
    segmentBytes: 0,
    segmentStartedAtMs: now,
    lastStatusAtMs: 0,
    lastSampleAtMs: now,
    lastSampleBytes: metrics.bytesWritten || 0
  };
}

function createRecordingProgressTransform(recorder, { maxBytes = 0, onLimit = () => null } = {}) {
  let limited = false;
  return new Transform({
    transform(chunk, _encoding, callback) {
      updateRecordingMetrics(recorder, chunk.length);
      if (maxBytes > 0 && !limited && (recorder.metrics?.segmentBytes || 0) >= maxBytes) {
        limited = true;
        onLimit();
      }
      callback(null, chunk);
    }
  });
}

function updateRecordingMetrics(recorder, byteCount) {
  const now = Date.now();
  if (!recorder.metrics) recorder.metrics = createEmptyRecordingMetrics();
  const metrics = recorder.metrics;
  const bytes = Number(byteCount || 0);
  metrics.bytesWritten += bytes;
  metrics.segmentBytes += bytes;
  metrics.lastBytesAtMs = now;
  const sampleSeconds = Math.max(0.001, (now - (metrics.lastSampleAtMs || now)) / 1000);
  if (now - (metrics.lastSampleAtMs || 0) >= 900) {
    metrics.speedBytesPerSecond = Math.max(0, (metrics.bytesWritten - (metrics.lastSampleBytes || 0)) / sampleSeconds);
    metrics.lastSampleBytes = metrics.bytesWritten;
    metrics.lastSampleAtMs = now;
  }
  const elapsedSeconds = Math.max(0.001, (now - (metrics.startedAtMs || now)) / 1000);
  metrics.averageSpeedBytesPerSecond = Math.max(0, metrics.bytesWritten / elapsedSeconds);
  if (now - (metrics.lastStatusAtMs || 0) >= 1000) {
    metrics.lastStatusAtMs = now;
    publishRecordingMetricStatus(recorder);
  }
}

function buildRecordingMetricStatus(recorder) {
  const metrics = recorder.metrics || createEmptyRecordingMetrics();
  const now = Date.now();
  const lastBytesAtMs = metrics.lastBytesAtMs || null;
  const elapsedSeconds = Math.max(0, Math.round((now - (metrics.startedAtMs || now)) / 1000));
  const staleSeconds = lastBytesAtMs ? Math.max(0, Math.round((now - lastBytesAtMs) / 1000)) : elapsedSeconds;
  const disconnectionTimeoutSeconds = Number(recorder.recordingSettings?.disconnectionTimeoutSeconds || 0);
  const stalled = Boolean(disconnectionTimeoutSeconds > 0 && staleSeconds >= disconnectionTimeoutSeconds);
  return {
    bytesWritten: Math.round(metrics.bytesWritten || 0),
    segmentBytes: Math.round(metrics.segmentBytes || 0),
    videoSize: Math.round(metrics.bytesWritten || 0),
    speedBytesPerSecond: Math.round(metrics.speedBytesPerSecond || metrics.averageSpeedBytesPerSecond || 0),
    averageSpeedBytesPerSecond: Math.round(metrics.averageSpeedBytesPerSecond || 0),
    elapsedSeconds,
    staleSeconds,
    lastBytesAt: lastBytesAtMs ? new Date(lastBytesAtMs).toISOString() : null,
    stalled,
    danmakuCount: Number(recorder.danmakuCount || 0),
    danmakuStatus: recorder.danmakuStatus || null,
    startedAt: recorder.startedAt || null
  };
}

function publishRecordingMetricStatus(recorder) {
  if (!recorder?.segment) return;
  const metrics = buildRecordingMetricStatus(recorder);
  const sizeLabel = formatBytes(metrics.bytesWritten);
  const speedLabel = `${formatBytes(metrics.speedBytesPerSecond)}/s`;
  const staleLabel = metrics.staleSeconds > 3 ? `，${metrics.staleSeconds}s 未收到数据` : "";
  setRoomRuntimeStatus(recorder.roomId, {
    taskStatus: metrics.stalled ? "waiting" : "recording",
    liveStatus: "live",
    recordingPath: recorder.segment.videoPath,
    danmakuPath: recorder.segment.danmakuPath,
    ...metrics,
    message: metrics.stalled
      ? `疑似卡住：已写入 ${sizeLabel}，当前 ${speedLabel}${staleLabel}`
      : `直播录制中：${speedLabel}，已写入 ${sizeLabel}${staleLabel}`,
    nextAction: "stop",
    log: recorder.log
  });
}

async function finalizeInternalSegment(recorder, completed) {
  const segment = recorder.segment;
  if (!segment) return;
  const segmentKey = segment.videoPath || segment.danmakuPath;
  if (segmentKey && recorder.finalizedSegments?.has(segmentKey)) return;
  recorder.finalizedSegments?.add(segmentKey);
  if (recorder.danmakuCurrentPath === segment.danmakuPath) {
    recorder.danmakuCurrentPath = null;
    recorder.danmakuSegmentStartedAtMs = null;
  }
  if (recorder.stopping || recorder.controller?.signal?.aborted) {
    closeInternalDanmaku(recorder);
  }
  await ensureDanmakuXmlClosed(segment.danmakuPath);
  const videoStat = safeStat(segment.videoPath);
  const hasVideo = Boolean(videoStat && videoStat.size > 0);
  await emitRecordingTimelineEvent("DanmakuFileCompletedEvent", recorder, segment.danmakuPath, { danmaku_count: recorder.danmakuCount });
  if (recorder.recordingSettings.saveRawDanmaku && segment.rawDanmakuPath) {
    await emitRecordingTimelineEvent("RawDanmakuFileCompletedEvent", recorder, segment.rawDanmakuPath, { danmaku_count: recorder.danmakuCount });
  }
  if (hasVideo) {
    await emitRecordingTimelineEvent("VideoFileCompletedEvent", recorder, segment.videoPath, { completed });
    const postprocess = await postprocessInternalRecordingSegment(recorder, segment);
    if (postprocess.coverPath) {
      await emitRecordingTimelineEvent("CoverImageDownloadedEvent", recorder, postprocess.coverPath, { source_path: segment.videoPath });
    }
    if (postprocess.videoPath && postprocess.videoPath !== segment.videoPath) {
      await emitRecordingTimelineEvent("VideoPostprocessingCompletedEvent", recorder, postprocess.videoPath, {
        source_path: segment.videoPath,
        deleted_source: postprocess.deletedSource
      });
    }
  }
  const assets = await scanRecordingAssetsForRoom(recorder.roomId);
  if (recorder.stopping) {
    await emitRecordingTimelineEvent("RecordingFinishedEvent", recorder, assets.recordingPath || segment.videoPath);
  }
  setRoomRuntimeStatus(recorder.roomId, {
    ...assets,
    ...buildRecordingMetricStatus(recorder),
    taskStatus: recorder.stopping ? (hasVideo ? "completed" : "error") : "waiting",
    liveStatus: recorder.stopping ? "offline" : "live",
    message: recorder.stopping ? (hasVideo ? "已完成" : "停止后没有找到已完成的视频文件。") : "分段完成，等待下一段",
    nextAction: recorder.stopping ? (hasVideo ? "open" : "retry") : "stop",
    refreshed: hasVideo,
    log: recorder.log
  });
  recorder.segment = null;
}

async function ensureDanmakuXmlClosed(filePath) {
  if (!filePath) return;
  try {
    const handle = await fsp.open(filePath, "r");
    try {
      const stat = await handle.stat();
      const length = Math.min(512, stat.size);
      const buffer = Buffer.alloc(length);
      if (length > 0) {
        await handle.read(buffer, 0, length, Math.max(0, stat.size - length));
      }
      if (buffer.toString("utf8").includes("</i>")) return;
    } finally {
      await handle.close();
    }
    await fsp.appendFile(filePath, `</i>\n`, "utf8");
  } catch {
    // Keep video finalization moving even if the auxiliary danmaku XML cannot be closed.
  }
}

async function postprocessInternalRecordingSegment(recorder, segment) {
  const settings = recorder.recordingSettings || {};
  const result = {
    videoPath: segment.videoPath,
    coverPath: null,
    deletedSource: false
  };

  if (settings.saveCover) {
    try {
      result.coverPath = await saveInternalRecordingCover(recorder, segment.videoPath, segment.coverPath);
      recorder.log += `保存直播封面 ${result.coverPath}\n`;
    } catch (error) {
      recorder.log += `保存直播封面失败：${readableError(error)}\n`;
    }
  }

  if (settings.remuxToMp4 && path.extname(segment.videoPath).toLowerCase() !== ".mp4") {
    try {
      const mp4Path = segment.mp4Path || segment.videoPath.replace(/\.[^.]+$/, ".mp4");
      await remuxInternalRecordingToMp4(recorder, segment.videoPath, mp4Path);
      if (await isValidPostprocessVideo(mp4Path)) {
        result.videoPath = mp4Path;
        recorder.log += `转封装 MP4 ${mp4Path}\n`;
        if (shouldDeleteSourceAfterRemux(settings.deleteSourceAfterRemux, segment.videoPath, mp4Path)) {
          await fsp.rm(segment.videoPath, { force: true });
          result.deletedSource = true;
          recorder.log += `删除源录制 ${segment.videoPath}\n`;
        }
      } else {
        recorder.log += `转封装 MP4 验证失败，已保留源录制 ${segment.videoPath}\n`;
      }
    } catch (error) {
      recorder.log += `转封装 MP4 失败：${readableError(error)}\n`;
    }
  }

  return result;
}

async function saveInternalRecordingCover(recorder, videoPath, coverPath) {
  const outPath = coverPath || videoPath.replace(/\.[^.]+$/, ".cover.jpg");
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  const at = Math.max(0, Math.min(8, Number((Date.now() - (recorder.segment?.startedAtMs || Date.now())) / 1000) || 1));
  await execFfmpeg(["-y", "-ss", String(at), "-i", videoPath, "-frames:v", "1", "-vf", "scale=1280:-1", "-q:v", "2", outPath], {
    timeout: 30000,
    maxBuffer: 1024 * 1024 * 4
  });
  return outPath;
}

async function remuxInternalRecordingToMp4(recorder, sourcePath, mp4Path) {
  await fsp.mkdir(path.dirname(mp4Path), { recursive: true });
  const args = ["-y", "-i", sourcePath, "-map", "0", "-c", "copy"];
  if (recorder.recordingSettings.injectExtraMetadata !== false) {
    args.push(
      "-metadata",
      `title=${recorder.roomName || recorder.roomId}`,
      "-metadata",
      `comment=Recorded by Bilive Workbench; room=${recorder.roomId}; real_room=${recorder.realRoomId || recorder.roomId}`
    );
  }
  args.push("-movflags", "+faststart", mp4Path);
  await execFfmpeg(args, {
    timeout: 1000 * 60 * 60,
    maxBuffer: 1024 * 1024 * 8
  });
  return mp4Path;
}

function execFfmpeg(args, options = {}) {
  const invocation = getFfmpegInvocation(args);
  return execFileAsync(invocation.command, invocation.args, {
    timeout: options.timeout,
    maxBuffer: options.maxBuffer || 1024 * 1024 * 8,
    windowsHide: true,
    env: makeCliEnv()
  });
}

function execFfprobe(args, options = {}) {
  const invocation = getFfprobeInvocation(args);
  return execFileAsync(invocation.command, invocation.args, {
    timeout: options.timeout,
    maxBuffer: options.maxBuffer || 1024 * 1024,
    windowsHide: true,
    env: makeCliEnv()
  });
}

async function isValidPostprocessVideo(videoPath) {
  if (!safeStat(videoPath)?.size) return false;
  try {
    const { stdout } = await execFfprobe([
      "-v",
      "error",
      "-show_entries",
      "format=format_name,duration",
      "-of",
      "json",
      videoPath
    ], {
      timeout: 30000,
      maxBuffer: 1024 * 1024
    });
    const parsed = JSON.parse(stdout || "{}");
    return Boolean(parsed?.format);
  } catch {
    return false;
  }
}

function runFfmpegSpawnLogged(job, args, options = {}) {
  const invocation = getFfmpegInvocation(args);
  return runSpawnLogged(job, invocation.command, invocation.args, options);
}

function shouldDeleteSourceAfterRemux(strategy, sourcePath, targetPath) {
  const normalized = normalizeDeleteSourceStrategy(strategy || "auto");
  if (normalized === "never") return false;
  const source = path.resolve(sourcePath);
  const target = path.resolve(targetPath);
  if (source === target || !safeStat(target)?.size) return false;
  assertInsideRecordings(source);
  assertInsideRecordings(target);
  return normalized === "always" || normalized === "auto";
}

async function ensureInternalRecordingSpace(recorder, targetDir) {
  const settings = recorder.recordingSettings || {};
  const thresholdBytes = Number(settings.spaceThresholdMb || 0) * 1024 * 1024;
  if (!thresholdBytes) return;
  const freeBytes = await getAvailableDiskBytes(targetDir);
  if (freeBytes == null) {
    recorder.log += "磁盘空间检查不可用，跳过空间保护\n";
    return;
  }
  if (freeBytes >= thresholdBytes) return;
  if (!settings.recycleRecords) {
    throw new Error(`磁盘剩余空间低于阈值：${formatByteSize(freeBytes)} < ${formatByteSize(thresholdBytes)}`);
  }
  const reclaimed = await recycleOldRecordingFiles(settings.outputDir || getRecordingsRoot(), thresholdBytes, targetDir);
  recorder.log += `磁盘空间不足，已回收旧视频 ${formatByteSize(reclaimed)}\n`;
  const afterBytes = await getAvailableDiskBytes(targetDir);
  if (afterBytes != null && afterBytes < thresholdBytes) {
    throw new Error(`回收后磁盘空间仍低于阈值：${formatByteSize(afterBytes)} < ${formatByteSize(thresholdBytes)}`);
  }
}

async function getAvailableDiskBytes(targetDir) {
  if (typeof fsp.statfs !== "function") return null;
  let dir = path.resolve(targetDir || getRecordingsRoot() || process.cwd());
  while (!fs.existsSync(dir) && dir !== path.dirname(dir)) {
    dir = path.dirname(dir);
  }
  try {
    const stat = await fsp.statfs(dir);
    return Number(stat.bavail || 0) * Number(stat.bsize || 0);
  } catch {
    return null;
  }
}

async function recycleOldRecordingFiles(root, thresholdBytes, activeDir) {
  const resolvedRoot = path.resolve(root || getRecordingsRoot() || "");
  if (!resolvedRoot || !fs.existsSync(resolvedRoot)) return 0;
  assertInsideRecordings(resolvedRoot);
  const active = path.resolve(activeDir || "");
  const candidates = collectFiles(resolvedRoot, 5)
    .filter((file) => videoExtensions.has(path.extname(file).toLowerCase()))
    .filter((file) => {
      const resolved = path.resolve(file);
      return active ? !resolved.startsWith(`${active}${path.sep}`) : true;
    })
    .map((file) => ({ file, stat: safeStat(file) }))
    .filter((item) => item.stat)
    .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
  let reclaimed = 0;
  for (const item of candidates) {
    if ((await getAvailableDiskBytes(resolvedRoot)) >= thresholdBytes) break;
    reclaimed += item.stat.size;
    await fsp.rm(item.file, { force: true });
  }
  return reclaimed;
}

async function createInternalRecordingPaths(recorder, roomInfo) {
  const root = path.resolve(recorder.recordingSettings.outputDir || getRecordingsRoot() || path.join(workbenchRoot, "recordings"));
  const title = roomInfo.title || recorder.roomName || `房间 ${recorder.roomId}`;
  const anchorName = roomInfo.anchorName || recorder.anchorName || recorder.roomName || title || `房间 ${recorder.roomId}`;
  const anchorUid = roomInfo.anchorUid || recorder.anchorUid || "";
  const startedAt = new Date();
  const templateValues = {
    roomId: recorder.roomId,
    realRoomId: recorder.realRoomId || recorder.roomId,
    title,
    anchorName,
    anchor: anchorName,
    anchorUid,
    backend: "internal",
    format: normalizeStreamFormat(recorder.recordingSettings.streamFormat || "flv"),
    codec: normalizeStreamCodec(recorder.recordingSettings.streamCodec || "avc"),
    start: formatRecordingTimestamp(startedAt)
  };
  const roomName = sanitizeFileSegment(renderRecordingTemplate(recorder.recordingSettings.roomFolderTemplate || "{anchorName}_{roomId}", templateValues));
  let roomDir = path.join(root, roomName || sanitizeFileSegment(`${anchorName}_${recorder.roomId}`) || recorder.roomId);
  const existingInfo = readRecordingRoomInfo(roomDir);
  if (existingInfo?.roomId && normalizeRoomId(existingInfo.roomId) !== recorder.roomId) {
    roomDir = path.join(root, sanitizeFileSegment(`${roomName || anchorName || title} - ${recorder.roomId}`));
  }
  await fsp.mkdir(roomDir, { recursive: true });
  await writeRecordingRoomInfo(roomDir, {
    roomId: recorder.roomId,
    realRoomId: recorder.realRoomId || recorder.roomId,
    title,
    anchorName,
    anchorUid,
    backend: "internal",
    updatedAt: new Date().toISOString()
  });
  const base = sanitizeFileSegment(renderRecordingTemplate(recorder.recordingSettings.filenameTemplate || "{start}_{title}_{roomId}_{backend}", templateValues) || `${templateValues.start}_${title}_${recorder.roomId}_internal`);
  const extension = templateValues.format === "fmp4" ? "mp4" : templateValues.format;
  const videoPath = path.join(roomDir, `${base}.${extension}`);
  return {
    roomDir,
    videoPath,
    mp4Path: path.join(roomDir, `${base}.mp4`),
    coverPath: path.join(roomDir, `${base}.cover.jpg`),
    danmakuPath: path.join(roomDir, `${base}.xml`),
    rawDanmakuPath: path.join(roomDir, `${base}.raw.jsonl`)
  };
}

function renderRecordingTemplate(template, values) {
  return String(template || "").replace(/\{(roomId|realRoomId|title|anchorName|anchor|anchorUid|backend|format|codec|start)\}/g, (_match, key) => String(values[key] ?? ""));
}

function formatRecordingTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function formatByteSize(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return "0 MB";
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(value / 1024))} KB`;
}

async function resolveBiliRoomInfo(roomId, recordingSettings = {}) {
  const data = await fetchBiliJson(recordingSettings, "/room/v1/Room/room_init", { id: roomId });
  const realRoomId = normalizeRoomId(data.room_id || roomId);
  const info = {
    realRoomId,
    shortId: normalizeRoomId(data.short_id || ""),
    liveStatus: Number(data.live_status || 0),
    biliLiveStatus: normalizeBiliLiveStatus(data.live_status),
    liveTime: data.live_time ? String(data.live_time) : "",
    title: "",
    anchorName: "",
    anchorUid: data.uid ? String(data.uid) : "",
    avatarUrl: "",
    coverUrl: "",
    keyframeUrl: "",
    areaName: "",
    parentAreaName: ""
  };
  try {
    const roomInfo = await fetchBiliJson(recordingSettings, "/room/v1/Room/get_info", { room_id: realRoomId });
    info.title = String(roomInfo.title || roomInfo.room_info?.title || "");
    info.coverUrl = String(roomInfo.user_cover || roomInfo.cover || roomInfo.keyframe || "");
    info.keyframeUrl = String(roomInfo.keyframe || "");
    info.areaName = String(roomInfo.area_name || "");
    info.parentAreaName = String(roomInfo.parent_area_name || "");
    info.liveTime = String(roomInfo.live_time || info.liveTime || "");
    info.biliLiveStatus = normalizeBiliLiveStatus(roomInfo.live_status ?? info.biliLiveStatus);
    info.liveStatus = Number(roomInfo.live_status ?? info.liveStatus);
  } catch {
    // Title and cover are nice-to-have during import; room_init already validated the room.
  }
  try {
    const anchor = await fetchBiliJson(recordingSettings, "/live_user/v1/UserInfo/get_anchor_in_room", { roomid: realRoomId });
    const anchorInfo = anchor.info || anchor.card || anchor.user || {};
    info.anchorName = String(anchorInfo.uname || anchorInfo.name || "");
    info.anchorUid = String(anchorInfo.uid || info.anchorUid || "");
    info.avatarUrl = String(anchorInfo.face || anchorInfo.avatar || "");
  } catch {
    // Some room metadata endpoints rate-limit independently; keep the import usable.
  }
  return info;
}

async function resolveBiliStreamUrl(roomId, recordingSettings = {}) {
  const data = await fetchBiliJson(recordingSettings, "/xlive/web-room/v2/index/getRoomPlayInfo", {
    room_id: roomId,
    no_playurl: 0,
    mask: 1,
    protocol: "0,1",
    format: "0,1,2",
    codec: "0,1",
    qn: Number(recordingSettings.qualityNumber || 10000),
    platform: "web",
    ptype: 8,
    web_location: "444.8"
  }, { wbi: true });
  const candidates = extractBiliStreamCandidates(data, recordingSettings);
  if (!candidates.length) {
    throw new Error(`直播间 ${roomId} 当前没有可用 ${recordingSettings.streamFormat || "flv"} 流。`);
  }
  return candidates[0];
}

function extractBiliStreamCandidates(data, recordingSettings = {}) {
  const wantedFormat = normalizeStreamFormat(recordingSettings.streamFormat || "flv");
  const wantedCodec = normalizeStreamCodec(recordingSettings.streamCodec || "avc");
  const wantedQn = Number(recordingSettings.qualityNumber || 10000);
  const streams = asArray(data?.playurl_info?.playurl?.stream);
  const candidates = [];
  for (const stream of streams) {
    for (const format of asArray(stream?.format)) {
      if (String(format?.format_name || "").toLowerCase() !== wantedFormat) continue;
      for (const codec of asArray(format?.codec)) {
        if (String(codec?.codec_name || "").toLowerCase() !== wantedCodec) continue;
        for (const info of asArray(codec?.url_info)) {
          const url = `${info?.host || ""}${codec?.base_url || ""}${info?.extra || ""}`;
          if (!/^https?:\/\//i.test(url)) continue;
          candidates.push({
            url,
            host: info?.host || "",
            quality: Number(codec?.current_qn || 0),
            exactQuality: Number(codec?.current_qn || 0) === wantedQn
          });
        }
      }
    }
  }
  return candidates.sort((a, b) => Number(b.exactQuality) - Number(a.exactQuality) || b.quality - a.quality || hostScore(a.host) - hostScore(b.host));
}

function hostScore(host) {
  const value = String(host || "");
  if (/gotcha0?4/i.test(value)) return 0;
  if (/gotcha/i.test(value)) return 10;
  if (/mcdn/i.test(value)) return 50;
  return 100;
}

async function fetchBiliJson(recordingSettings, apiPath, params = {}, options = {}) {
  const url = new URL(apiPath, getBiliLiveApiBase(recordingSettings));
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  if (options.wbi) {
    await signBiliWbiUrl(url, recordingSettings);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(3, Number(recordingSettings.requestTimeoutSeconds || 12)) * 1000);
  try {
    const response = await fetch(url, {
      headers: getBiliHeaders(params.room_id || params.roomid || params.id || "", recordingSettings),
      signal: controller.signal
    });
    const json = await response.json();
    if (!response.ok) throw new Error(`Bili API request failed: ${response.status}`);
    if (json?.code && json.code !== 0) {
      if (Number(json.code) === 60004) throw new Error("Bilibili room was not found");
      throw new Error(json.message || json.msg || `Bili API code ${json.code}`);
    }
    return json.data || {};
  } finally {
    clearTimeout(timeout);
  }
}

function getBiliLiveApiBase(recordingSettings = {}) {
  const configured = String(recordingSettings.biliApiBase || process.env.BILI_LIVE_API_BASE || "https://api.live.bilibili.com").trim();
  return configured.endsWith("/") ? configured : `${configured}/`;
}

function getBiliWebApiBase(recordingSettings = {}) {
  const configured = String(recordingSettings.biliWebApiBase || process.env.BILI_WEB_API_BASE || "https://api.bilibili.com").trim();
  return configured.endsWith("/") ? configured : `${configured}/`;
}

function shouldUseBiliWbi(recordingSettings = {}) {
  if (recordingSettings.enableWbiSigning === false || recordingSettings.wbiSigning === false) return false;
  if (recordingSettings.biliWebApiBase || process.env.BILI_WEB_API_BASE) return true;
  try {
    const host = new URL(getBiliLiveApiBase(recordingSettings)).hostname.toLowerCase();
    return host === "api.live.bilibili.com" || host.endsWith(".bilibili.com");
  } catch {
    return false;
  }
}

async function signBiliWbiUrl(url, recordingSettings = {}) {
  if (!shouldUseBiliWbi(recordingSettings)) return false;
  try {
    const keys = await getBiliWbiKeys(recordingSettings);
    const mixinKey = getBiliWbiMixinKey(keys.imgKey, keys.subKey);
    if (!mixinKey) return false;
    url.searchParams.delete("w_rid");
    url.searchParams.set("wts", String(Math.floor(Date.now() / 1000)));
    const pairs = [...url.searchParams.entries()]
      .filter(([key]) => key !== "w_rid")
      .sort(([a], [b]) => a.localeCompare(b));
    const query = pairs
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeBiliWbiValue(value)}`)
      .join("&");
    const sign = crypto.createHash("md5").update(`${query}${mixinKey}`).digest("hex");
    url.searchParams.set("w_rid", sign);
    return true;
  } catch {
    return false;
  }
}

async function getBiliWbiKeys(recordingSettings = {}) {
  const cacheKey = getBiliWebApiBase(recordingSettings);
  const now = Date.now();
  if (biliWbiKeyCache?.cacheKey === cacheKey && biliWbiKeyCache.expiresAt > now) {
    return biliWbiKeyCache.keys;
  }
  const url = new URL("/x/web-interface/nav", cacheKey);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(3, Number(recordingSettings.requestTimeoutSeconds || 12)) * 1000);
  try {
    const response = await fetch(url, {
      headers: getBiliHeaders("", recordingSettings),
      signal: controller.signal
    });
    const json = await response.json();
    if (!response.ok || json?.code !== 0) throw new Error(json?.message || `Bili WBI nav failed: ${response.status}`);
    const imgKey = extractBiliWbiKey(json?.data?.wbi_img?.img_url);
    const subKey = extractBiliWbiKey(json?.data?.wbi_img?.sub_url);
    if (!imgKey || !subKey) throw new Error("Bili WBI keys missing");
    const keys = { imgKey, subKey };
    biliWbiKeyCache = { cacheKey, keys, expiresAt: now + 10 * 60 * 60 * 1000 };
    return keys;
  } finally {
    clearTimeout(timeout);
  }
}

function extractBiliWbiKey(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw, "https://www.bilibili.com");
    return path.basename(parsed.pathname).replace(/\.[^.]+$/, "");
  } catch {
    return "";
  }
}

function getBiliWbiMixinKey(imgKey, subKey) {
  const raw = `${imgKey || ""}${subKey || ""}`;
  return biliWbiMixinKeyEncTab.map((index) => raw[index] || "").join("").slice(0, 32);
}

function encodeBiliWbiValue(value) {
  return encodeURIComponent(String(value ?? "").replace(/[!'()*]/g, ""));
}

function getBiliHeaders(roomId, recordingSettings = {}) {
  const cookie = readBiliCookieHeader(recordingSettings);
  return {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.5",
    "Cache-Control": "no-cache",
    ...(cookie ? { "Cookie": cookie } : {}),
    "Origin": "https://live.bilibili.com",
    "Pragma": "no-cache",
    "Referer": `https://live.bilibili.com/${roomId || ""}`,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36"
  };
}

function readBiliCookieHeader(recordingSettings = {}) {
  const cookies = readBiliCookies(recordingSettings);
  const header = cookies
    .filter((item) => item?.name && item.value !== undefined && item.value !== null)
    .map((item) => `${String(item.name).trim()}=${String(item.value)}`)
    .join("; ");
  return header;
}

function readBiliCookies(recordingSettings = {}) {
  const configured = String(recordingSettings.cookiePath || "").trim();
  const candidates = [configured, path.join(draftsDir, "cookies.json")].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const filePath = path.resolve(candidate);
      if (!fs.existsSync(filePath)) continue;
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const cookies = normalizeBiliCookies(parsed);
      if (cookies.length) return cookies;
    } catch {
      // Cookie login state is optional for live capture; avoid logging secrets or noisy parse errors.
    }
  }
  return [];
}

function normalizeBiliCookies(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.cookies)) return value.cookies;
  if (Array.isArray(value?.cookie_info?.cookies)) return value.cookie_info.cookies;
  if (value && typeof value === "object") {
    return Object.entries(value)
      .filter(([, cookieValue]) => ["string", "number", "boolean"].includes(typeof cookieValue))
      .map(([name, cookieValue]) => ({ name, value: cookieValue }));
  }
  return [];
}

function getBiliCookieValue(recordingSettings = {}, names = []) {
  const wanted = new Set(asArray(names).map((name) => String(name).toLowerCase()));
  for (const cookie of readBiliCookies(recordingSettings)) {
    const name = String(cookie?.name || "").toLowerCase();
    if (wanted.has(name) && cookie.value !== undefined && cookie.value !== null) {
      return String(cookie.value);
    }
  }
  return "";
}

function getBiliAuthInfo(recordingSettings = {}) {
  const cookies = readBiliCookies(recordingSettings);
  const cookieMap = new Map(cookies.map((item) => [String(item?.name || "").toLowerCase(), item?.value]));
  const uid = Number(cookieMap.get("dedeuserid") || cookieMap.get("uid") || 0);
  const buvid = String(cookieMap.get("buvid3") || cookieMap.get("buvid4") || "").trim();
  return {
    cookieLoaded: cookies.length > 0,
    uid: Number.isFinite(uid) && uid > 0 ? Math.floor(uid) : 0,
    uidPresent: Number.isFinite(uid) && uid > 0,
    buvid,
    buvidPresent: Boolean(buvid)
  };
}

function createBiliDanmakuAuthPayload(roomId, token = "", recordingSettings = {}) {
  const auth = getBiliAuthInfo(recordingSettings);
  return {
    uid: auth.uid || 0,
    roomid: Number(roomId),
    protover: 3,
    ...(auth.buvid ? { buvid: auth.buvid } : {}),
    platform: "web",
    type: 2,
    key: token || ""
  };
}

function validateProxyImageUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("缺少图片地址。");
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:") throw new Error("只允许代理 HTTPS 图片。");
  const host = parsed.hostname.toLowerCase();
  const allowed = host === "hdslb.com" || host.endsWith(".hdslb.com") || host === "bilibili.com" || host.endsWith(".bilibili.com");
  if (!allowed) throw new Error("只允许代理 B 站图片。");
  return parsed.toString();
}

async function emitRecordingTimelineEvent(type, recorder, filePath = null, extraData = {}) {
  return ingestRecordingEventWebhook({
    type,
    date: new Date().toISOString(),
    data: {
      room_id: Number(recorder.roomId),
      real_room_id: Number(recorder.realRoomId || recorder.roomId),
      room_info: {
        room_id: Number(recorder.roomId),
        real_room_id: Number(recorder.realRoomId || recorder.roomId),
        title: recorder.roomName
      },
      path: filePath || undefined,
      backend: "internal",
      ...extraData
    }
  });
}

function startInternalDanmakuCapture(recorder) {
  const authInfo = getBiliAuthInfo(recorder.recordingSettings);
  const state = {
    ws: null,
    heartbeat: null,
    reconnectTimer: null,
    closed: false,
    attempt: 0,
    hostIndex: 0,
    connected: false,
    authenticated: false,
    lastMessageAt: null,
    lastCloseCode: null,
    lastCloseReason: "",
    reconnects: 0
  };
  updateInternalDanmakuStatus(recorder, {
    enabled: true,
    connected: false,
    authenticated: false,
    source: "connecting",
    cookieLoaded: authInfo.cookieLoaded,
    uidPresent: authInfo.uidPresent,
    buvidPresent: authInfo.buvidPresent,
    reconnects: 0,
    message: "弹幕连接中"
  });
  void (async () => {
    try {
      const info = await resolveBiliDanmakuInfo(recorder.realRoomId, recorder.recordingSettings);
      if (info.fallback) {
        recorder.log += "弹幕接口被风控，改用默认弹幕服务器\n";
      }
      const hosts = asArray(info.host_list).filter((host) => host?.host);
      if (!hosts.length) throw new Error("Bili danmaku host is missing.");

      const connect = () => {
        if (state.closed) return;
        if (state.heartbeat) {
          clearInterval(state.heartbeat);
          state.heartbeat = null;
        }
        const host = hosts[state.hostIndex % hosts.length];
        state.hostIndex = (state.hostIndex + 1) % hosts.length;
        const scheme = host.scheme || "wss";
        const port = scheme === "ws" ? (host.ws_port || host.port || 2243) : (host.wss_port || host.port || 443);
        const url = `${scheme}://${host.host}:${port}/sub`;
        const ws = new WebSocket(url, { headers: getBiliHeaders(recorder.realRoomId, recorder.recordingSettings) });
        state.ws = ws;
        ws.binaryType = "nodebuffer";
        ws.on("open", () => {
          state.attempt = 0;
          state.connected = true;
          state.lastCloseCode = null;
          state.lastCloseReason = "";
          updateInternalDanmakuStatus(recorder, {
            connected: true,
            authenticated: false,
            source: `${scheme}://${host.host}:${port}`,
            tokenPresent: Boolean(info.token),
            message: "弹幕已连接，等待鉴权"
          });
          ws.send(createDanmakuPacket(7, JSON.stringify(createBiliDanmakuAuthPayload(recorder.realRoomId, info.token || "", recorder.recordingSettings))));
          state.heartbeat = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(createDanmakuPacket(2, ""));
          }, 30000);
        });
        ws.on("message", (data) => {
          for (const message of parseDanmakuPacketBuffer(Buffer.from(data))) {
            state.lastMessageAt = new Date().toISOString();
            if (message?.__operation === 8 || message?.code === 0) {
              state.authenticated = true;
              updateInternalDanmakuStatus(recorder, {
                connected: true,
                authenticated: true,
                lastMessageAt: state.lastMessageAt,
                message: "弹幕已鉴权"
              });
              continue;
            }
            const event = normalizeInternalDanmakuEvent(message, recorder.recordingSettings);
            if (event) {
              updateInternalDanmakuStatus(recorder, {
                connected: true,
                authenticated: state.authenticated,
                lastMessageAt: state.lastMessageAt,
                message: "弹幕接收中"
              });
              appendInternalDanmaku(recorder, event.text, message, event);
            }
          }
        });
        ws.on("error", (error) => {
          if (!state.closed) {
            const message = readableError(error);
            recorder.log += `弹幕连接错误：${message}\n`;
            updateInternalDanmakuStatus(recorder, { message: `弹幕连接错误：${message}` });
          }
        });
        ws.on("close", (code, reason) => {
          if (state.heartbeat) {
            clearInterval(state.heartbeat);
            state.heartbeat = null;
          }
          state.connected = false;
          state.authenticated = false;
          state.lastCloseCode = code || null;
          state.lastCloseReason = reason ? reason.toString("utf8") : "";
          if (state.closed) return;
          state.attempt += 1;
          state.reconnects += 1;
          const baseDelayMs = Math.max(200, Number(recorder.recordingSettings?.danmakuReconnectSeconds || recorder.recordingSettings?.reconnectSeconds || 2) * 1000);
          const delayMs = Math.min(15000, baseDelayMs * Math.min(state.attempt, 5));
          recorder.log += `弹幕连接已断开${code ? `（${code}）` : ""}，${Math.round(delayMs / 1000)} 秒后重连\n`;
          updateInternalDanmakuStatus(recorder, {
            connected: false,
            authenticated: false,
            lastCloseCode: state.lastCloseCode,
            lastCloseReason: state.lastCloseReason,
            reconnects: state.reconnects,
            message: `弹幕连接已断开${code ? `（${code}）` : ""}，准备重连`
          });
          state.reconnectTimer = setTimeout(connect, delayMs);
        });
      };
      connect();
    } catch (error) {
      recorder.log += `弹幕连接失败：${readableError(error)}\n`;
      updateInternalDanmakuStatus(recorder, { connected: false, authenticated: false, message: `弹幕连接失败：${readableError(error)}` });
    }
  })();
  return state;
}

function updateInternalDanmakuStatus(recorder, patch = {}) {
  if (!recorder) return null;
  const current = recorder.danmakuStatus || {};
  const next = {
    enabled: recorder.recordingSettings?.enableDanmaku !== false,
    connected: false,
    authenticated: false,
    source: "",
    cookieLoaded: false,
    uidPresent: false,
    buvidPresent: false,
    tokenPresent: false,
    reconnects: 0,
    lastMessageAt: null,
    lastCloseCode: null,
    lastCloseReason: "",
    message: "",
    ...current,
    ...patch
  };
  recorder.danmakuStatus = next;
  return next;
}

async function resolveBiliDanmakuInfo(roomId, recordingSettings = {}) {
  const configuredServer = String(recordingSettings.danmakuServer || "").trim();
  if (configuredServer && configuredServer !== "auto") {
    const schemeMatch = configuredServer.match(/^(wss?):\/\//i);
    const scheme = schemeMatch?.[1]?.toLowerCase() || "wss";
    const [host, portText] = configuredServer.replace(/^wss?:\/\//i, "").replace(/\/.*$/, "").split(":");
    return {
      token: "",
      host_list: [{ scheme, host, wss_port: Number(portText || 443), ws_port: Number(portText || 2243), port: Number(portText || 2243) }]
    };
  }
  try {
    return await fetchBiliJson(recordingSettings, "/xlive/web-room/v1/index/getDanmuInfo", {
      id: roomId,
      type: 0,
      web_location: "444.8"
    }, { wbi: true });
  } catch (error) {
    const message = readableError(error);
    if (!/-352|risk|风控|forbidden|blocked/i.test(message)) throw error;
    try {
      return await fetchBiliJson(recordingSettings, "/xlive/app-room/v1/index/getDanmuInfo", signBiliAppParams({
        actionKey: "appkey",
        build: 6640400,
        channel: "bili",
        device: "android",
        mobi_app: "android",
        platform: "android",
        room_id: roomId,
        ts: Math.floor(Date.now() / 1000)
      }));
    } catch (fallbackError) {
      if (!/-352|risk|风控|forbidden|blocked/i.test(readableError(fallbackError))) throw fallbackError;
      return {
        token: "",
        fallback: true,
        host_list: [
          { host: "broadcastlv.chat.bilibili.com", wss_port: 443, ws_port: 2243, port: 2243 }
        ]
      };
    }
  }
}

function signBiliAppParams(params) {
  const appkey = "1d8b6e7d45233436";
  const appsec = "560c52ccd288fed045859ed18bffd973";
  const sorted = Object.fromEntries(Object.entries({ ...params, appkey }).sort(([a], [b]) => a.localeCompare(b)));
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(sorted)) {
    query.append(key, String(value));
  }
  const sign = crypto.createHash("md5").update(`${query.toString()}${appsec}`).digest("hex");
  return { ...sorted, sign };
}

function closeInternalDanmaku(recorder) {
  const state = recorder.danmaku;
  if (!state || state.closed) {
    updateInternalDanmakuStatus(recorder, { connected: false, authenticated: false, message: "弹幕连接已关闭" });
    return;
  }
  state.closed = true;
  if (state.heartbeat) clearInterval(state.heartbeat);
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  if (state.ws && state.ws.readyState < WebSocket.CLOSING) state.ws.close();
  recorder.danmaku = null;
  updateInternalDanmakuStatus(recorder, { connected: false, authenticated: false, message: "弹幕连接已关闭" });
}

function normalizeInternalDanmakuEvent(message, recordingSettings = {}) {
  const cmd = String(message?.cmd || "").split(":")[0];
  if (cmd === "DANMU_MSG") {
    return {
      kind: "danmaku",
      text: message.info?.[1] || "",
      mode: 1,
      fontSize: 25,
      color: 16777215
    };
  }

  if (cmd === "SEND_GIFT" || cmd === "COMBO_SEND") {
    const data = message.data || {};
    const coinType = String(data.coin_type || data.coinType || "").toLowerCase();
    const price = Number(data.price || data.total_coin || data.discount_price || 0);
    const isFree = coinType === "silver" || coinType === "free" || price <= 0;
    if (isFree && recordingSettings.recordFreeGifts === false) return null;
    if (!isFree && recordingSettings.recordGiftSend === false) return null;
    const user = data.uname || data.username || data.user_name || "观众";
    const gift = data.giftName || data.gift_name || data.gift || "礼物";
    const count = Math.max(1, Number(data.num || data.combo_num || data.comboNum || 1));
    const suffix = count > 1 ? ` x${count}` : "";
    return {
      kind: isFree ? "free_gift" : "gift",
      text: `[礼物] ${user} 送出 ${gift}${suffix}`,
      mode: 5,
      fontSize: 25,
      color: isFree ? 10066329 : 16753920,
      price
    };
  }

  if (cmd === "SUPER_CHAT_MESSAGE" || cmd === "SUPER_CHAT_MESSAGE_JPN") {
    if (recordingSettings.recordSuperChat === false) return null;
    const data = message.data || {};
    const user = data.user_info?.uname || data.uname || data.username || "观众";
    const price = Number(data.price || data.message_price || 0);
    const content = data.message || data.message_jpn || data.trans_mark || "醒目留言";
    const amount = price > 0 ? ` ¥${price}` : "";
    return {
      kind: "super_chat",
      text: `[醒目留言${amount}] ${user}: ${content}`,
      mode: 5,
      fontSize: 25,
      color: 16737095,
      price
    };
  }

  if (cmd === "GUARD_BUY") {
    if (recordingSettings.recordGuardBuy === false) return null;
    const data = message.data || {};
    const user = data.username || data.uname || "观众";
    const guardLevel = Number(data.guard_level || data.guardLevel || 0);
    const guardName = ({ 1: "总督", 2: "提督", 3: "舰长" })[guardLevel] || "大航海";
    const count = Math.max(1, Number(data.num || 1));
    const suffix = count > 1 ? ` x${count}` : "";
    return {
      kind: "guard",
      text: `[上舰] ${user} 开通 ${guardName}${suffix}`,
      mode: 5,
      fontSize: 25,
      color: 6724095
    };
  }

  return null;
}

function appendInternalDanmaku(recorder, text, rawMessage = null, event = {}) {
  const clean = String(text || "").trim();
  const danmakuPath = recorder.danmakuCurrentPath || recorder.segment?.danmakuPath;
  const segmentStartedAtMs = recorder.danmakuSegmentStartedAtMs || recorder.segment?.startedAtMs || Date.now();
  if (!clean || !danmakuPath) return;
  const sequence = Number(recorder.danmakuSequence || recorder.danmakuCount || 0) + 1;
  recorder.danmakuSequence = sequence;
  const time = Math.max(0, (Date.now() - segmentStartedAtMs) / 1000).toFixed(3);
  const unix = Math.floor(Date.now() / 1000);
  const mode = Math.max(1, Number(event.mode || 1));
  const fontSize = Math.max(12, Number(event.fontSize || 25));
  const color = Math.max(0, Number(event.color || 16777215));
  const line = `<d p="${time},${mode},${fontSize},${color},${unix},0,0,${sequence}">${escapeXml(clean)}</d>\n`;
  fsp.appendFile(danmakuPath, line, "utf8")
    .then(() => {
      recorder.danmakuCount = Math.max(Number(recorder.danmakuCount || 0), sequence);
    })
    .catch((error) => {
      recorder.log += `弹幕写入失败：${readableError(error)}\n`;
    });
  if (recorder.recordingSettings.saveRawDanmaku && recorder.segment?.rawDanmakuPath && recorder.danmakuCurrentPath === recorder.segment.danmakuPath) {
    const rawPayload = rawMessage && typeof rawMessage === "object"
      ? { ...rawMessage, internal_event: { ...event, text: clean, time: Number(time) } }
      : { text: clean, time: Number(time), internal_event: event };
    fsp.appendFile(recorder.segment.rawDanmakuPath, `${JSON.stringify(rawPayload)}\n`, "utf8")
      .catch((error) => {
        recorder.log += `原始弹幕写入失败：${readableError(error)}\n`;
      });
  }
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

function parseDanmakuPacketBuffer(buffer) {
  const messages = [];
  let offset = 0;
  while (offset + 16 <= buffer.length) {
    const packetLen = buffer.readUInt32BE(offset);
    const headerLen = buffer.readUInt16BE(offset + 4);
    const version = buffer.readUInt16BE(offset + 6);
    const operation = buffer.readUInt32BE(offset + 8);
    if (!packetLen || offset + packetLen > buffer.length) break;
    const body = buffer.subarray(offset + headerLen, offset + packetLen);
    if (operation === 5) {
      if (version === 3) {
        try {
          messages.push(...parseDanmakuPacketBuffer(zlib.brotliDecompressSync(body)));
        } catch {
          // Ignore malformed compressed frames; reconnect logic will recover if the stream is broken.
        }
      } else if (version === 2) {
        try {
          messages.push(...parseDanmakuPacketBuffer(zlib.inflateSync(body)));
        } catch {
          // Ignore malformed compressed frames; reconnect logic will recover if the stream is broken.
        }
      } else {
        for (const line of body.toString("utf8").split(/[\x00\r\n]+/).filter(Boolean)) {
          try {
            messages.push(JSON.parse(line));
          } catch {
            // Ignore non-JSON heartbeat or partial payload fragments.
          }
        }
      }
    } else if (operation === 8) {
      const text = body.toString("utf8").trim();
      if (text) {
        try {
          messages.push({ ...JSON.parse(text), __operation: 8 });
        } catch {
          messages.push({ __operation: 8, raw: text });
        }
      } else {
        messages.push({ __operation: 8, code: 0 });
      }
    }
    offset += packetLen;
  }
  return messages;
}

function delay(ms, signal = null) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    }, { once: true });
  });
}

async function waitForRecorderDone(donePromise, timeoutMs) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve(donePromise).then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        if (typeof timer.unref === "function") timer.unref();
      })
    ]);
  } catch {
    // Stop should still return the best finalized asset state even if the loop rejects while aborting.
    return true;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sanitizeFileSegment(value) {
  return String(value || "room")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "room";
}

async function scanRecordingAssetsForRoom(roomId) {
  const recordingsRoot = getRecordingsRoot();
  const empty = { recordingPath: null, danmakuPath: null, videoSize: 0, danmakuSize: 0, danmakuCount: 0 };
  if (!recordingsRoot || !fs.existsSync(recordingsRoot)) return empty;
  const files = collectFiles(recordingsRoot, 5).filter((file) => file.includes(String(roomId)));
  const videos = dedupeVideoFiles(files.filter((file) => videoExtensions.has(path.extname(file).toLowerCase())));
  const xmlFiles = files.filter((file) => path.extname(file).toLowerCase() === ".xml");
  const latestVideo = latestFile(videos);
  const latestXml = latestFile(xmlFiles);
  const videoStat = latestVideo ? safeStat(latestVideo) : null;
  const xmlStat = latestXml ? safeStat(latestXml) : null;
  const danmaku = latestXml ? parseDanmakuFile(latestXml, 0) : null;
  return {
    recordingPath: latestVideo || null,
    danmakuPath: latestXml || null,
    videoSize: videoStat?.size || 0,
    danmakuSize: xmlStat?.size || 0,
    danmakuCount: danmaku?.total || 0
  };
}

function latestFile(files) {
  return files
    .map((file) => ({ file, stat: safeStat(file) }))
    .filter((item) => item.stat)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0]?.file || null;
}


function publicRecordingJob(job) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.progress,
    message: job.message,
    log: redactSecrets(job.log),
    command: redactSecrets(job.command || ""),
    outputPath: job.outputPath || null,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt
  };
}

function redactSecrets(text) {
  return String(text || "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]")
    .replace(/(--api-key\s+)("[^"]+"|\S+)/g, "$1[redacted]")
    .replace(/(cookie(?:Path)?["':=\s]+)([^,\s}]+)/gi, "$1[redacted]");
}

export function evaluateUploadPolicy(draft = {}, options = {}) {
  const policy = normalizeUploadPolicy(draft);
  const issues = [];
  const warnings = [];
  const effectiveDraft = { ...draft };
  const automation = draft.automation || draft.autoApproval || {};
  const score = Number(automation.score ?? automation.clipScore ?? draft.clipScore ?? 0);
  const evidenceCount = Number(automation.evidenceCount ?? (Array.isArray(draft.evidence) ? draft.evidence.length : 0));
  const eligible = automation.eligibleForAutoUpload !== false;

  if (!options.confirmed) {
    issues.push("Real upload still requires an explicit confirm=true execution request.");
  }
  if (options.assumeAutoSubmit) {
    effectiveDraft.autoSubmit = true;
  }
  if (effectiveDraft.autoSubmit !== true) {
    issues.push("真实投稿需要最终执行确认。");
  }
  if (policy === "auto-only-self") {
    effectiveDraft.visibility = "onlySelf";
    effectiveDraft.isOnlySelf = 1;
    warnings.push("auto-only-self policy forces Bilibili only-self visibility.");
  }
  if (policy === "auto-public") {
    effectiveDraft.visibility = "public";
    effectiveDraft.isOnlySelf = 0;
    if (!eligible || score < 72 || evidenceCount < 2) {
      issues.push("auto-public requires a high-confidence clip: score >= 72 and at least two evidence items.");
    }
    if (!String(effectiveDraft.title || "").trim()) {
      issues.push("auto-public requires a non-empty title.");
    }
    if (!String(effectiveDraft.tag || "").trim()) {
      issues.push("auto-public requires tags.");
    }
  }
  return {
    policy,
    canRun: issues.length === 0,
    issues,
    warnings,
    effectiveDraft
  };
}

function normalizeUploadPolicy(draft = {}) {
  const raw = String(draft.uploadPolicy || draft.automationPolicy || "manual-confirm");
  if (["manual-confirm", "review", "auto-public", "auto-only-self"].includes(raw)) return raw;
  return "manual-confirm";
}

function buildBiliupCommand(body) {
  const tools = getUploadTools();
  if (!tools.biliupPath) {
    throw new Error("未检测到 biliup。请先安装本地 biliup。");
  }
  const draft = body?.draft || body || {};
  const parts = normalizeUploadParts(draft.parts || body?.parts || []);
  const publishMode = draft.publishMode === "append" ? "append" : "upload";
  if (!parts.length) {
    throw new Error("分 P 队列为空，至少需要一个本地视频路径。");
  }
  if (publishMode === "append" && !String(draft.vid || "").trim()) {
    throw new Error("追加分 P 需要填写目标稿件 BV 或 av 号。");
  }

  const args = ["-u", draft.cookiePath || path.join(draftsDir, "cookies.json"), publishMode];
  if (publishMode === "append") {
    args.push("--vid", String(draft.vid).trim());
  }
  addCliOption(args, "--submit", draft.submit || "web");
  addCliOption(args, "--copyright", draft.copyright ?? 1);
  addCliOption(args, "--tid", draft.tid ?? 171);
  addCliOption(args, "--title", draft.title || "");
  addCliOption(args, "--desc", draft.desc || "");
  addCliOption(args, "--dynamic", draft.dynamic || "");
  addCliOption(args, "--tag", draft.tag || "");
  addCliOption(args, "--cover", normalizeLocalCliPath(draft.cover));
  addCliOption(args, "--source", draft.source || "");
  addCliOption(args, "--line", draft.line && draft.line !== "auto" ? draft.line : "");
  addCliOption(args, "--limit", draft.limit ?? 3);
  addCliOption(args, "--dolby", draft.dolby ? 1 : 0);
  addCliOption(args, "--hires", draft.hires ? 1 : 0);
  addCliOption(args, "--no-reprint", draft.noReprint ? 1 : 0);
  addCliOption(args, "--is-only-self", draft.visibility === "onlySelf" || draft.isOnlySelf ? 1 : 0);
  addCliOption(args, "--charging-pay", draft.openElec || draft.chargingPay ? 1 : 0);
  if (draft.upSelectionReply) args.push("--up-selection-reply");
  if (draft.upCloseReply) args.push("--up-close-reply");
  if (draft.upCloseDanmu) args.push("--up-close-danmu");
  if (draft.extraFields) addCliOption(args, "--extra-fields", draft.extraFields);
  for (const part of parts) {
    args.push(part.path);
  }

  return {
    ok: true,
    mode: publishMode,
    parts,
    executablePath: tools.biliupPath,
    args,
    command: [tools.biliupPath, ...args].map(quoteArg).join(" "),
    notes: [
      publishMode === "append" ? "会调用 biliup append，把队列中的视频追加到目标稿件。" : "会调用 biliup upload，队列中的多个文件会作为多 P 投稿。",
      draft.visibility === "onlySelf" || draft.isOnlySelf ? "已带 --is-only-self 1，对应仅自己可见。" : "当前是公开可见。"
    ]
  };
}

function preflightUpload(draft) {
  const issues = [];
  const warnings = [];
  const policy = evaluateUploadPolicy(draft, { confirmed: true, assumeAutoSubmit: true });
  issues.push(...policy.issues);
  warnings.push(...policy.warnings);
  const tools = getUploadTools();
  if (!tools.biliupPath) {
    issues.push("未检测到 biliup。请先安装本地 biliup。");
  }
  const cookiePath = String(draft.cookiePath || tools.cookiePath);
  if (!fs.existsSync(cookiePath)) {
    issues.push(`未找到 cookie 文件：${cookiePath}`);
  }
  const parts = normalizeUploadParts(draft.parts || []);
  if (!parts.length) {
    issues.push("分 P 队列为空。");
  }
  for (const [index, part] of parts.entries()) {
    const stat = safeStat(part.path);
    if (!stat) {
      issues.push(`P${index + 1} 文件不存在：${part.path}`);
    } else if (!stat.isFile()) {
      issues.push(`P${index + 1} 不是文件：${part.path}`);
    }
  }
  const cover = normalizeLocalCliPath(draft.cover);
  if (draft.cover && !cover) {
    warnings.push("封面是 URL 或接口地址，biliup CLI 会忽略它；请先抽取本地封面帧。");
  } else if (cover && !safeStat(cover)) {
    issues.push(`封面文件不存在：${cover}`);
  }
  if (draft.publishMode === "append" && !String(draft.vid || "").trim()) {
    issues.push("追加分 P 需要目标 BV 或 av 号。");
  }

  let command = "";
  if (tools.biliupPath && parts.length) {
    try {
      command = buildBiliupCommand({ draft: { ...policy.effectiveDraft, cookiePath } }).command;
    } catch (error) {
      warnings.push(readableError(error));
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    warnings,
    policy,
    command,
    tools
  };
}

function normalizeUploadParts(parts) {
  return (Array.isArray(parts) ? parts : [])
    .map((part, index) => ({
      id: String(part?.id || `part-${index + 1}`),
      title: String(part?.title || `P${index + 1}`),
      path: String(part?.path || "").trim()
    }))
    .filter((part) => part.path);
}

function normalizeLocalCliPath(value) {
  const text = String(value || "").trim();
  if (!text || text.startsWith("/api/") || /^https?:\/\//i.test(text)) return "";
  return text;
}

function addCliOption(args, name, value) {
  if (value === undefined || value === null || value === "") return;
  args.push(name, String(value));
}

function quoteArg(value) {
  const text = String(value);
  if (!/[\s"'&|<>]/.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

function quoteCmdArg(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function quotePowerShellString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function formatProcessError(error) {
  const output = `${error?.stdout || ""}${error?.stderr || ""}`.trim();
  return output || readableError(error);
}

async function runBiliupReadCommand(kind, body) {
  const tools = getUploadTools();
  if (!tools.biliupPath) {
    return {
      ok: false,
      message: "当前系统 PATH 没有 biliup，不能读取历史稿件或已有分 P。",
      command: kind === "list" ? "biliup -u .workbench/drafts/cookies.json list --max-pages 1" : `biliup -u .workbench/drafts/cookies.json show ${body.vid || "<BV/av>"}`
    };
  }
  const cookiePath = String(body?.cookiePath || tools.cookiePath);
  if (!fs.existsSync(cookiePath)) {
    return {
      ok: false,
      message: `未找到 cookie 文件：${cookiePath}。需要先扫码登录。`,
      command: `biliup -u ${quoteArg(cookiePath)} login`
    };
  }

  const args = ["-u", cookiePath];
  if (kind === "list") {
    args.push("list", "--max-pages", String(Math.min(5, Math.max(1, Number(body?.maxPages || 1)))));
  } else {
    args.push("show", String(body.vid));
  }

  const command = [tools.biliupPath, ...args].map(quoteArg).join(" ");
  try {
    const result = await execFileAsync(tools.biliupPath, args, {
      cwd: workbenchRoot,
      timeout: 60000,
      maxBuffer: 1024 * 1024 * 8,
      env: makeCliEnv()
    });
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
    return {
      ok: true,
      command,
      output,
      ...(kind === "list" ? { archives: parseBiliupList(output) } : parseBiliupShow(output))
    };
  } catch (error) {
    return {
      ok: false,
      command,
      message: "biliup 读取失败，请检查 cookie 是否有效或账号是否有权限。",
      output: formatProcessError(error)
    };
  }
}

function parseBiliupList(output) {
  return stripAnsi(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [bvid, title, status] = line.split("\t");
      return {
        bvid: String(bvid || "").trim(),
        title: String(title || "").trim(),
        status: String(status || "").trim()
      };
    })
    .filter((item) => item.bvid);
}

function parseBiliupShow(output) {
  try {
    const payload = JSON.parse(stripAnsi(output));
    const archive = payload?.archive || {};
    const videos = Array.isArray(payload?.videos) ? payload.videos : [];
    return {
      archive: {
        bvid: String(archive.bvid || ""),
        aid: archive.aid || null,
        title: String(archive.title || ""),
        cover: String(archive.cover || ""),
        tag: String(archive.tag || ""),
        tid: archive.tid || null,
        duration: Number(archive.duration || 0),
        isOnlySelf: Number(archive.is_only_self || 0),
        state: archive.state ?? null,
        stateDesc: String(archive.state_desc || "")
      },
      videos: videos.map((video, index) => ({
        index: Number(video.index || index + 1),
        title: String(video.title || ""),
        duration: Number(video.duration || 0),
        status: Number(video.status || 0),
        statusDesc: String(video.status_desc || ""),
        cid: video.cid || null,
        filename: String(video.filename || ""),
        failDesc: String(video.fail_desc || "")
      }))
    };
  } catch {
    return {};
  }
}

function stripAnsi(value) {
  return String(value || "").replace(/\u001b\[[0-9;]*m/g, "");
}

async function startBiliupLoginJob(tools, cookiePath, launch = true) {
  const job = createUploadJob("biliup-login", launch ? "正在打开扫码登录终端" : "已生成扫码登录脚本");
  const scriptPath = path.join(draftsDir, "biliup-login.cmd");
  job.scriptPath = scriptPath;
  const args = ["-u", cookiePath, "login"];
  const command = [tools.biliupPath, ...args].map(quoteArg).join(" ");
  const script = [
    "@echo off",
    "chcp 65001 >nul",
    "set PYTHONUTF8=1",
    "set PYTHONIOENCODING=utf-8",
    `cd /d ${quoteCmdArg(process.cwd())}`,
    "echo 使用手机扫码登录 B 站。",
    "echo 登录成功后 cookie 会写入：",
    `echo ${cookiePath}`,
    "echo.",
    `${quoteCmdArg(tools.biliupPath)} -u ${quoteCmdArg(cookiePath)} login`,
    "set LOGIN_EXIT=%ERRORLEVEL%",
    "echo.",
    "if %LOGIN_EXIT% EQU 0 (",
    "  echo 登录命令已结束，请回到工作台点击刷新或重新打开投稿页确认 Cookie 状态。",
    ") else (",
    "  echo 登录命令失败，退出码 %LOGIN_EXIT%。",
    ")",
    "echo.",
    "pause",
    "exit /b %LOGIN_EXIT%"
  ].join("\r\n");
  await fsp.mkdir(path.dirname(cookiePath), { recursive: true });
  await fsp.writeFile(scriptPath, script, "utf8");
  job.command = command;
  appendJobLog(job, `脚本：${scriptPath}\n`);
  appendJobLog(job, `命令：${command}\n`);
  appendJobLog(job, "biliup login 需要真实终端，二维码会显示在新打开的命令行窗口里，不会显示在网页日志中。\n");

  if (launch) {
    launchInteractiveScript(scriptPath);
    job.message = "已打开扫码登录终端";
  }
  job.status = "completed";
  job.progress = 100;
  job.exitCode = 0;
  job.updatedAt = new Date().toISOString();
  return job;
}

function launchInteractiveScript(scriptPath) {
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `Start-Process -FilePath 'cmd.exe' -ArgumentList @('/k', ${quotePowerShellString(scriptPath)}) -WindowStyle Normal`
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: false,
    timeout: 10000,
    env: makeCliEnv()
  });
  if (result.status !== 0) {
    throw new Error(`${result.stderr || result.stdout || "无法打开扫码登录终端"}`.trim());
  }
}

function createUploadJob(type, message) {
  const id = crypto.createHash("sha1").update(`${type}:${Date.now()}:${Math.random()}`).digest("hex").slice(0, 16);
  const job = {
    id,
    type,
    status: "running",
    progress: 1,
    message,
    log: "",
    command: "",
    exitCode: null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  uploadJobs.set(id, job);
  return job;
}

function publicUploadJob(job) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.progress,
    message: job.message,
    log: job.log,
    command: job.command,
    scriptPath: job.scriptPath,
    policy: job.policy || null,
    exitCode: job.exitCode,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt
  };
}

function runBiliupInstallJob(job) {
  void (async () => {
    try {
      await fsp.mkdir(toolsDir, { recursive: true });
      const pythonPath = commandPath("python") || commandPath("py");
      if (!pythonPath) {
        throw new Error("未检测到 Python，无法创建本地 biliup 虚拟环境。");
      }
      if (!fs.existsSync(path.join(biliupVenvDir, "Scripts", "python.exe"))) {
        job.message = "正在创建 Python 虚拟环境";
        job.progress = 10;
        await execFileLogged(job, pythonPath, ["-m", "venv", biliupVenvDir], { timeout: 1000 * 60 * 5 });
      }
      const venvPython = path.join(biliupVenvDir, "Scripts", "python.exe");
      job.message = "正在安装 biliup==1.1.29";
      job.progress = 35;
      await execFileLogged(job, venvPython, ["-m", "pip", "install", "--disable-pip-version-check", "biliup==1.1.29"], { timeout: 1000 * 60 * 10 });
      job.status = "ready";
      job.progress = 100;
      job.message = "本地 biliup 已安装";
      job.updatedAt = new Date().toISOString();
    } catch (error) {
      job.status = "error";
      job.progress = 0;
      job.message = readableError(error);
      job.updatedAt = new Date().toISOString();
    }
  })();
}

async function execFileLogged(job, command, args, options = {}) {
  job.command = [command, ...args].map(quoteArg).join(" ");
  appendJobLog(job, `> ${job.command}\n`);
  try {
    const result = await execFileAsync(command, args, {
      cwd: process.cwd(),
      timeout: options.timeout,
      maxBuffer: 1024 * 1024 * 12,
      env: makeCliEnv(options.env)
    });
    appendJobLog(job, result.stdout || "");
    appendJobLog(job, result.stderr || "");
    job.exitCode = 0;
  } catch (error) {
    appendJobLog(job, error.stdout || "");
    appendJobLog(job, error.stderr || "");
    throw error;
  }
}

function runProcessJob(job, command, args, options = {}) {
  job.command = [command, ...args].map(quoteArg).join(" ");
  appendJobLog(job, `> ${job.command}\n`);
  const shell = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
  const child = spawn(command, args, {
    cwd: options.cwd || process.cwd(),
    shell,
    windowsHide: true,
    env: makeCliEnv(options.env)
  });
  job.childPid = child.pid;
  const timer = options.timeoutMs
    ? setTimeout(() => {
        appendJobLog(job, "\n[workbench] 任务超时，已请求结束进程。\n");
        child.kill();
      }, options.timeoutMs)
    : null;

  child.stdout.on("data", (chunk) => appendJobLog(job, decodeProcessChunk(chunk, options.outputEncoding)));
  child.stderr.on("data", (chunk) => appendJobLog(job, decodeProcessChunk(chunk, options.outputEncoding)));
  child.on("error", (error) => {
    if (timer) clearTimeout(timer);
    job.status = "error";
    job.progress = 0;
    job.message = readableError(error);
    job.updatedAt = new Date().toISOString();
  });
  child.on("close", (code) => {
    if (timer) clearTimeout(timer);
    job.exitCode = code;
    job.status = code === 0 ? "ready" : "error";
    job.progress = code === 0 ? 100 : 0;
    job.message = code === 0 ? "任务完成" : `任务失败，退出码 ${code}`;
    job.updatedAt = new Date().toISOString();
  });
}

function appendJobLog(job, text) {
  if (!text) return;
  job.log = `${job.log}${text}`.slice(-30000);
  job.updatedAt = new Date().toISOString();
}

function decodeProcessChunk(chunk, encoding = "utf8") {
  if (typeof chunk === "string") return chunk;
  const name = String(encoding || "utf8").toLowerCase();
  if (name === "utf8" || name === "utf-8") return chunk.toString("utf8");
  try {
    return new TextDecoder(name).decode(chunk);
  } catch {
    return chunk.toString("utf8");
  }
}

function createTranscodeJob(message) {
  const id = crypto.createHash("sha1").update(`transcode:${Date.now()}:${Math.random()}`).digest("hex").slice(0, 16);
  const job = {
    id,
    type: "flv-convert",
    status: "running",
    progress: 1,
    message,
    log: "",
    command: "",
    outputPath: null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  transcodeJobs.set(id, job);
  return job;
}

function publicTranscodeJob(job) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.progress,
    message: job.message,
    log: job.log,
    command: job.command,
    outputPath: job.outputPath,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt
  };
}

function runSpawnLogged(job, command, args, options = {}) {
  return new Promise((resolve, reject) => {
    job.command = [command, ...args].map(quoteArg).join(" ");
    appendJobLog(job, `> ${job.command}\n`);
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      windowsHide: true,
      env: makeCliEnv(options.env)
    });
    job.childPid = child.pid;
    let stdout = "";
    let stderr = "";
    const timer = options.timeoutMs
      ? setTimeout(() => {
          appendJobLog(job, "\n[workbench] 任务超时，已请求结束进程。\n");
          child.kill();
        }, options.timeoutMs)
      : null;
    child.stdout.on("data", (chunk) => {
      const text = decodeProcessChunk(chunk, options.outputEncoding);
      stdout += text;
      appendJobLog(job, text);
      options.onStdout?.(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = decodeProcessChunk(chunk, options.outputEncoding);
      stderr += text;
      appendJobLog(job, text);
      options.onStderr?.(text);
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new Error(`${path.basename(command)} 退出码 ${code}`);
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

async function listRooms() {
  const recordingsRoot = getRecordingsRoot();
  if (!recordingsRoot || !fs.existsSync(recordingsRoot)) {
    return [];
  }
  const entries = await fsp.readdir(recordingsRoot, { withFileTypes: true });
  const roomDirs = entries.filter((entry) => entry.isDirectory());
  const hiddenRooms = await readHiddenMaterialRooms();
  const rooms = [];
  for (const entry of roomDirs) {
    const fullPath = path.join(recordingsRoot, entry.name);
    if (isMaterialRoomHidden(fullPath, hiddenRooms)) continue;
    const files = collectFiles(fullPath, 2);
    const videos = dedupeVideoFiles(files.filter((file) => videoExtensions.has(path.extname(file).toLowerCase())));
    const xmlCount = files.filter((file) => path.extname(file).toLowerCase() === ".xml").length;
    const latest = videos
      .map((file) => ({ file, stat: safeStat(file) }))
      .filter((item) => item.stat)
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0];
    const parsed = parseRoomName(entry.name, files, fullPath);
    rooms.push({
      key: encodeKey(fullPath),
      path: fullPath,
      folderName: entry.name,
      roomId: parsed.roomId,
      name: parsed.name,
      videoCount: videos.length,
      xmlCount,
      latestVideo: latest
        ? {
            key: encodeKey(latest.file),
            name: path.basename(latest.file),
            mtime: latest.stat.mtime.toISOString(),
            size: latest.stat.size
          }
        : null,
      coverUrl: latest ? `/api/thumbnail?key=${encodeURIComponent(encodeKey(latest.file))}` : null
    });
  }
  return rooms.sort((a, b) => {
    const at = a.latestVideo ? Date.parse(a.latestVideo.mtime) : 0;
    const bt = b.latestVideo ? Date.parse(b.latestVideo.mtime) : 0;
    return bt - at;
  });
}

async function getRoomDetail(roomPath) {
  assertInsideRecordings(roomPath);
  const folderName = path.basename(roomPath);
  const files = collectFiles(roomPath, 3);
  const parsed = parseRoomName(folderName, files, roomPath);
  const settings = await readServiceSettings();
  const xmlFiles = files.filter((file) => path.extname(file).toLowerCase() === ".xml");
  const subtitleFiles = files.filter((file) => subtitleExtensions.has(path.extname(file).toLowerCase()));
  const videoFiles = dedupeVideoFiles(files.filter((file) => videoExtensions.has(path.extname(file).toLowerCase())));
  const videos = [];

  for (const videoPath of videoFiles) {
    const stat = safeStat(videoPath);
    const media = await getMediaMetadata(videoPath);
    const xml = findCompanionFile(videoPath, xmlFiles, ".xml");
    const subs = findCompanionFiles(videoPath, subtitleFiles);
    const danmaku = xml ? parseDanmakuFile(xml, media.duration) : emptyDanmaku();
    const remuxTargetPath = path.extname(videoPath).toLowerCase() === ".flv"
      ? getFlvTargetPath(videoPath, settings.media)
      : null;
    const remuxTargetStat = remuxTargetPath ? safeStat(remuxTargetPath) : null;
    videos.push({
      key: encodeKey(videoPath),
      path: videoPath,
      name: path.basename(videoPath),
      extension: path.extname(videoPath).slice(1).toLowerCase(),
      size: stat?.size || 0,
      mtime: stat?.mtime.toISOString() || null,
      duration: media.duration,
      width: media.width,
      height: media.height,
      playable: isBrowserPlayable(videoPath),
      xml: xml ? { key: encodeKey(xml), path: xml, name: path.basename(xml) } : null,
      danmakuCount: danmaku.total,
      danmakuDuration: danmaku.duration,
      subtitles: subs.map((file) => ({ key: encodeKey(file), path: file, name: path.basename(file) })),
      remuxTarget: remuxTargetPath
        ? {
            key: encodeKey(remuxTargetPath),
            path: remuxTargetPath,
            name: path.basename(remuxTargetPath),
            exists: Boolean(remuxTargetStat?.size),
            size: remuxTargetStat?.size || 0
          }
        : null,
      thumbnailUrl: `/api/thumbnail?key=${encodeURIComponent(encodeKey(videoPath))}`
    });
  }

  videos.sort((a, b) => Date.parse(b.mtime || "0") - Date.parse(a.mtime || "0"));

  return {
    key: encodeKey(roomPath),
    path: roomPath,
    folderName,
    roomId: parsed.roomId,
    name: parsed.name,
    videos,
    xmlFiles: xmlFiles.length,
    subtitleFiles: subtitleFiles.length
  };
}

async function getVideoContext(videoPath) {
  assertInsideRecordings(videoPath);
  const roomPath = findRoomPath(videoPath);
  const roomFiles = collectFiles(roomPath, 3);
  const room = parseRoomName(path.basename(roomPath), roomFiles, roomPath);
  const xmlFiles = roomFiles.filter((file) => path.extname(file).toLowerCase() === ".xml");
  const subtitleFiles = roomFiles.filter((file) => subtitleExtensions.has(path.extname(file).toLowerCase()));
  const media = await getMediaMetadata(videoPath);
  const xml = findCompanionFile(videoPath, xmlFiles, ".xml");
  const subtitles = findCompanionFiles(videoPath, subtitleFiles).flatMap((file) => parseSubtitleFile(file));
  const danmakuData = xml ? parseDanmakuFile(xml, media.duration) : emptyDanmaku();
  const duration = media.duration || danmakuData.duration || maxCueEnd(subtitles) || 0;
  const histogram = buildHistogram(danmakuData.allComments, duration, 30);

  return {
    key: encodeKey(videoPath),
    path: videoPath,
    name: path.basename(videoPath),
    extension: path.extname(videoPath).slice(1).toLowerCase(),
    room,
    media,
    playable: isBrowserPlayable(videoPath),
    mediaUrl: `/api/media?key=${encodeURIComponent(encodeKey(videoPath))}`,
    thumbnailUrl: `/api/thumbnail?key=${encodeURIComponent(encodeKey(videoPath))}`,
    preview: await getPreviewStatus(videoPath),
    xml: xml ? { key: encodeKey(xml), path: xml, name: path.basename(xml) } : null,
    danmaku: danmakuData.comments,
    danmakuTotal: danmakuData.total,
    danmakuMetadata: danmakuData.metadata,
    subtitles,
    histogram,
    duration
  };
}

async function getMediaMetadata(videoPath) {
  const stat = safeStat(videoPath);
  const cacheKey = `${videoPath}:${stat?.mtimeMs || 0}:${stat?.size || 0}`;
  if (mediaCache.has(cacheKey)) {
    return mediaCache.get(cacheKey);
  }
  let metadata = { duration: 0, width: null, height: null, streams: [] };
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration:stream=width,height,codec_type", "-of", "json", videoPath],
      { timeout: 20000, maxBuffer: 1024 * 1024 * 4 }
    );
    const parsed = JSON.parse(stdout);
    const videoStream = (parsed.streams || []).find((stream) => stream.codec_type === "video");
    metadata = {
      duration: Number(parsed.format?.duration || 0),
      width: videoStream?.width || null,
      height: videoStream?.height || null,
      streams: parsed.streams || []
    };
  } catch {
    metadata = { duration: 0, width: null, height: null, streams: [] };
  }
  mediaCache.set(cacheKey, metadata);
  return metadata;
}

function parseDanmakuFile(xmlPath, mediaDuration) {
  try {
    const text = fs.readFileSync(xmlPath, "utf8");
    const parsed = parser.parse(text);
    const root = parsed?.i || {};
    const rawItems = asArray(root.d);
    const comments = rawItems
      .map((item, index) => normalizeDanmakuItem(item, index))
      .filter((item) => Number.isFinite(item.time) && item.text)
      .sort((a, b) => a.time - b.time);
    const maxTime = comments.reduce((max, item) => Math.max(max, item.time), 0);
    return {
      comments: comments.slice(0, 5000),
      allComments: comments,
      total: comments.length,
      duration: Math.max(maxTime, Number(mediaDuration || 0)),
      metadata: normalizeMetadata(root.metadata || {})
    };
  } catch {
    return emptyDanmaku();
  }
}

function normalizeDanmakuItem(item, index) {
  if (typeof item === "string") {
    return { id: `d-${index}`, time: 0, mode: 1, color: 16777215, user: "", text: item };
  }
  const p = String(item?.p || "");
  const parts = p.split(",");
  const mode = Number(parts[1] || 1);
  const rawText = String(item?.text || "");
  const text = mode >= 7 ? extractAdvancedDanmakuText(rawText) : rawText;
  return {
    id: `${String(item?.dbid || parts[7] || "d")}-${index}`,
    time: Number(parts[0] || 0),
    mode,
    size: Number(parts[2] || 25),
    color: Number(parts[3] || 16777215),
    date: Number(parts[4] || 0),
    user: String(item?.user || ""),
    uid: String(item?.uid || parts[6] || ""),
    text: cleanText(text)
  };
}

function extractAdvancedDanmakuText(text) {
  try {
    const payload = JSON.parse(text);
    if (Array.isArray(payload)) {
      return String(payload[4] || payload[payload.length - 1] || "");
    }
  } catch {
    // Fall through to raw text.
  }
  return text;
}

function normalizeMetadata(metadata) {
  return Object.fromEntries(Object.entries(metadata).map(([key, value]) => [key, typeof value === "string" ? cleanText(value) : value]));
}

function emptyDanmaku() {
  return { comments: [], allComments: [], total: 0, duration: 0, metadata: {} };
}

function parseSubtitleFile(file) {
  const ext = path.extname(file).toLowerCase();
  try {
    const text = fs.readFileSync(file, "utf8");
    if (ext === ".srt" || ext === ".vtt") {
      return parseSrtLike(text, file);
    }
    if (ext === ".ass") {
      return parseAss(text, file);
    }
  } catch {
    return [];
  }
  return [];
}

function parseSrtLike(text, file) {
  const normalized = text.replace(/\r/g, "").replace(/^WEBVTT.*?\n\n/s, "");
  return normalized
    .split(/\n{2,}/)
    .map((block, index) => {
      const lines = block.split("\n").filter(Boolean);
      const timeLine = lines.find((line) => line.includes("-->"));
      if (!timeLine) return null;
      const [startRaw, endRaw] = timeLine.split("-->").map((part) => part.trim().split(/\s+/)[0]);
      const textLines = lines.slice(lines.indexOf(timeLine) + 1);
      return {
        id: `${path.basename(file)}-${index}`,
        start: parseSubtitleTime(startRaw),
        end: parseSubtitleTime(endRaw),
        text: cleanText(textLines.join("\n")),
        source: path.basename(file)
      };
    })
    .filter(Boolean);
}

function parseAss(text, file) {
  const lines = text.replace(/\r/g, "").split("\n");
  const formatLine = lines.find((line) => line.startsWith("Format:"));
  const fields = formatLine ? formatLine.replace("Format:", "").split(",").map((field) => field.trim().toLowerCase()) : [];
  const startIndex = Math.max(fields.indexOf("start"), 1);
  const endIndex = Math.max(fields.indexOf("end"), 2);
  const textIndex = Math.max(fields.indexOf("text"), 9);
  return lines
    .filter((line) => line.startsWith("Dialogue:"))
    .map((line, index) => {
      const body = line.replace("Dialogue:", "").trim();
      const parts = body.split(",");
      const textParts = parts.slice(textIndex);
      return {
        id: `${path.basename(file)}-${index}`,
        start: parseAssTime(parts[startIndex]),
        end: parseAssTime(parts[endIndex]),
        text: cleanText(textParts.join(",").replace(/\\N/g, "\n").replace(/\{.*?\}/g, "")),
        source: path.basename(file)
      };
    })
    .filter((cue) => Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.text);
}

function parseSubtitleTime(value) {
  const match = String(value || "").match(/(?:(\d+):)?(\d{2}):(\d{2})[,.](\d{1,3})/);
  if (!match) return 0;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  const millis = Number(match[4].padEnd(3, "0"));
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

function parseAssTime(value) {
  const match = String(value || "").match(/(\d+):(\d{2}):(\d{2})\.(\d{1,2})/);
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4].padEnd(2, "0")) / 100;
}

function roundTime(seconds) {
  return Math.round(Number(seconds || 0) * 10) / 10;
}

function getFallbackSliceDuration(context) {
  const totalDuration = Math.max(Number(context?.duration || 0), Number(context?.media?.duration || 0), 1);
  const maxSeconds = Math.max(1, Math.min(180, totalDuration));
  return Math.max(1, Math.min(maxSeconds, Math.max(20, Math.round(totalDuration * 0.08) || 90)));
}

function getModelSliceDurationPolicy() {
  return {
    mode: "model-decides"
  };
}

function buildHistogram(comments, duration, binSize) {
  const safeDuration = Math.max(Number(duration || 0), 1);
  const binCount = Math.max(1, Math.ceil(safeDuration / binSize));
  const bins = Array.from({ length: binCount }, (_, index) => ({
    index,
    start: index * binSize,
    end: Math.min((index + 1) * binSize, safeDuration),
    count: 0,
    score: 0
  }));
  for (const comment of comments) {
    const index = Math.min(binCount - 1, Math.max(0, Math.floor(comment.time / binSize)));
    bins[index].count += 1;
  }
  const max = bins.reduce((value, bin) => Math.max(value, bin.count), 0) || 1;
  return bins.map((bin) => ({ ...bin, score: Math.round((bin.count / max) * 100) }));
}

function buildSliceCandidates(context, options) {
  const sources = new Set(Array.isArray(options.sources) && options.sources.length ? options.sources : ["danmaku"]);
  const precisionMode = String(options.precisionMode || "high");
  const requestedDuration = getFallbackSliceDuration(context);
  const count = Math.min(12, Math.max(1, Number(options.clipCount || 5)));
  const knownDuration = Math.max(Number(context.duration || 0), Number(context.media?.duration || 0));
  const totalDuration = knownDuration > 0 ? knownDuration : requestedDuration;
  const duration = Math.min(requestedDuration, totalDuration);
  const sourceComments = sources.has("danmaku") ? applyDanmakuEdits(context.danmaku, options.danmakuEdits) : [];
  const optionSubtitles = Array.isArray(options.subtitles) ? normalizeOptionSubtitles(options.subtitles) : context.subtitles;
  const sourceSubtitles = sources.has("subtitle") ? optionSubtitles : [];
  const bins = context.histogram?.length ? context.histogram : buildHistogram(sourceComments, totalDuration, 30);
  const peaks = bins
    .map((bin) => {
      const binComments = sourceComments.filter((item) => item.time >= bin.start && item.time < bin.end);
      const binSubtitles = sourceSubtitles.filter((cue) => cue.start < bin.end && cue.end > bin.start);
      const texts = [...binComments.map((item) => item.text), ...binSubtitles.map((cue) => cue.text)];
      const funnyHits = countKeywordHits(texts, funnyKeywords);
      const reactionHits = countKeywordHits(texts, reactionKeywords);
      const questionHits = countKeywordHits(texts, questionKeywords);
      const danmakuScore = sources.has("danmaku") ? binComments.length + funnyHits * 5 + reactionHits * 3 + questionHits * 2 : 0;
      const subtitleScore = sources.has("subtitle") ? binSubtitles.length * 2 + reactionHits * 2 + questionHits * 2 : 0;
      return {
        ...bin,
        count: binComments.length,
        subtitleCount: binSubtitles.length,
        funnyHits,
        reactionHits,
        questionHits,
        combinedScore: danmakuScore + subtitleScore
      };
    })
    .filter((bin) => bin.combinedScore > 0)
    .sort((a, b) => b.combinedScore - a.combinedScore);

  const chosen = [];
  for (const peak of peaks) {
    const start = clamp(peak.start - duration * 0.25, 0, Math.max(0, totalDuration - duration));
    const end = Math.min(totalDuration, start + duration);
    if (chosen.some((item) => overlapsEnough(item, { start, end }))) {
      continue;
    }
    const candidate = makeCandidate(context, start, end, peak, sources, sourceComments, sourceSubtitles);
    if (precisionMode === "high" && !candidate.automation.eligibleForAutoUpload) {
      continue;
    }
    chosen.push(candidate);
    if (chosen.length >= count) break;
  }

  if (!chosen.length && precisionMode !== "high") {
    const fallbackStart = clamp(totalDuration * 0.35, 0, Math.max(0, totalDuration - duration));
    chosen.push({
      id: `fallback-${Math.round(fallbackStart)}`,
      title: `${context.room.name} 候选片段`,
      start: fallbackStart,
      end: Math.min(totalDuration, fallbackStart + duration),
      score: 10,
      reason: "当前视频没有可用的弹幕密度或字幕信号，先给出一个可编辑的候选区间。",
      evidence: []
    });
  }

  return chosen;
}

function makeCandidate(context, start, end, peak, sources, comments, subtitles) {
  const windowComments = comments.filter((item) => item.time >= start && item.time <= end);
  const windowSubtitles = subtitles.filter((cue) => cue.start < end && cue.end > start);
  const hotText = pickInterestingText(windowComments, windowSubtitles);
  const title = hotText ? `${trimForTitle(hotText)}｜${context.room.name}` : `${context.room.name} 高能片段`;
  const interestingComments = windowComments.slice().sort((a, b) => interestingScore(b.text) - interestingScore(a.text));
  const interestingSubtitles = windowSubtitles.slice().sort((a, b) => interestingScore(b.text) - interestingScore(a.text));
  const evidence = [
    ...interestingComments.slice(0, 4).map((item) => `弹幕 ${formatTime(item.time)}：${item.text}`),
    ...interestingSubtitles.slice(0, 4).map((cue) => `字幕 ${formatTime(cue.start)}：${cue.text}`)
  ];
  const texts = [...windowComments.map((item) => item.text), ...windowSubtitles.map((cue) => cue.text)];
  const signal = {
    funnyHits: countKeywordHits(texts, funnyKeywords),
    reactionHits: countKeywordHits(texts, reactionKeywords),
    questionHits: countKeywordHits(texts, questionKeywords),
    danmakuCount: windowComments.length,
    subtitleCount: windowSubtitles.length,
    peakCount: peak.count || 0,
    hotText
  };
  const automation = evaluateClipAutomation(signal, peak, sources);
  return {
    id: `clip-${Math.round(start)}-${Math.round(end)}`,
    title,
    start,
    end,
    score: automation.score,
    reason: buildCandidateReason(signal, sources),
    evidence,
    signal,
    automation
  };
}

const funnyKeywords = ["哈", "哈哈", "hhh", "233", "草", "笑死", "绷", "乐", "蚌", "典"];
const reactionKeywords = ["救命", "卧槽", "好怪", "离谱", "破防", "急了", "太强", "可爱", "逆天", "名场面"];
const questionKeywords = ["？", "?", "什么", "怎么", "为何", "啊", "哇", "欸"];

function evaluateClipAutomation(signal, peak, sources) {
  const signalFamilies = [];
  const keywordHits = signal.funnyHits + signal.reactionHits + signal.questionHits;
  if (sources.has("danmaku") && signal.danmakuCount >= Math.max(12, signal.peakCount)) {
    signalFamilies.push("danmaku-burst");
  }
  if (keywordHits >= 2 || signal.reactionHits >= 1) {
    signalFamilies.push("reaction-keywords");
  }
  if (sources.has("subtitle") && signal.subtitleCount >= 2 && keywordHits >= 1) {
    signalFamilies.push("subtitle-context");
  }
  if (signal.hotText && interestingScore(signal.hotText) >= 4) {
    signalFamilies.push("quotable-line");
  }
  const rawScore = Number(peak.combinedScore || 0)
    + signalFamilies.length * 12
    + Math.min(20, signal.danmakuCount)
    + Math.min(16, keywordHits * 4);
  const score = Math.min(100, Math.max(1, Math.round(rawScore)));
  const veryStrongDanmaku = signal.danmakuCount >= 30 && keywordHits >= 2;
  const eligibleForAutoUpload = score >= 72 && (signalFamilies.length >= 2 || veryStrongDanmaku);
  return {
    eligibleForAutoUpload,
    confidence: eligibleForAutoUpload ? "high" : "review",
    score,
    signalFamilies,
    policyReason: eligibleForAutoUpload
      ? "High precision candidate: multiple live signals agree."
      : "Needs review: not enough independent live signals."
  };
}

function normalizeOptionSubtitles(subtitles) {
  return subtitles
    .map((cue, index) => ({
      id: String(cue?.id || `option-subtitle-${index}`),
      start: Number(cue?.start || 0),
      end: Number(cue?.end || cue?.start || 0),
      text: String(cue?.text || "").trim(),
      source: cue?.source,
      timebase: cue?.timebase,
      originalTimebase: cue?.originalTimebase
    }))
    .filter((cue) => cue.text && Number.isFinite(cue.start) && Number.isFinite(cue.end));
}

function applyDanmakuEdits(comments, edits = {}) {
  return comments
    .map((item) => ({
      ...item,
      text: String(edits[item.id] ?? item.text ?? "").trim()
    }))
    .filter((item) => item.text);
}

function countKeywordHits(texts, keywords) {
  return texts.reduce((total, text) => total + keywords.filter((keyword) => String(text).toLowerCase().includes(keyword.toLowerCase())).length, 0);
}

function interestingScore(text) {
  const value = String(text || "");
  return countKeywordHits([value], funnyKeywords) * 6
    + countKeywordHits([value], reactionKeywords) * 4
    + countKeywordHits([value], questionKeywords) * 2
    + Math.min(4, Math.floor(value.length / 8));
}

function pickInterestingText(comments, subtitles) {
  const text = [
    ...comments.map((item) => item.text),
    ...subtitles.map((cue) => cue.text)
  ]
    .map((value) => String(value || "").replace(/\s+/g, " ").trim())
    .filter((value) => value.length >= 2 && value.length <= 42)
    .sort((a, b) => interestingScore(b) - interestingScore(a))[0] || "";
  return text.replace(/\s+/g, " ").trim();
}

function buildCandidateReason(signal, sources) {
  const reasons = [];
  if (signal.funnyHits) {
    reasons.push(`笑点：弹幕/字幕里出现 ${signal.funnyHits} 个笑点词，观众反应集中`);
  }
  if (signal.reactionHits) {
    reasons.push(`看点：出现 ${signal.reactionHits} 个强反应词，像是惊讶、破防或名场面`);
  }
  if (signal.questionHits) {
    reasons.push("转折：疑问/惊叹词变多，适合做悬念或反差切入");
  }
  if (sources.has("danmaku")) {
    reasons.push(`热度：该段有 ${signal.danmakuCount} 条弹幕，峰值约 ${signal.peakCount} 条/30秒`);
  }
  if (sources.has("subtitle")) {
    reasons.push(`字幕：命中 ${signal.subtitleCount} 条字幕，可用台词支撑标题和字幕剪辑`);
  }
  if (signal.hotText) {
    reasons.push(`核心句：${trimForReason(signal.hotText)}`);
  }
  return reasons.length ? reasons.join("；") : "该区间弹幕或字幕信号较集中，适合作为候选切片。";
}

async function enhanceSliceCandidatesWithModel(context, options, localCandidates, settings) {
  const result = await enhanceSliceCandidatesWithModelResult(context, options, localCandidates, settings);
  return result.candidates;
}

async function enhanceSliceCandidatesWithModelResult(context, options, localCandidates, settings) {
  if (!settings?.vision?.endpoint || settings.vision.provider === "manual") {
    return {
      candidates: [],
      diagnostics: {
        engine: "model-only",
        modelStatus: "not-configured",
        modelUsed: false,
        message: "未配置视频理解接口，模型切片未运行。"
      }
    };
  }
  const sources = Array.isArray(options.sources) && options.sources.length ? options.sources : ["danmaku"];
  const input = await buildModelSliceInput(context, options, sources, settings);
  const { mediaImages = [], ...modelInput } = input;
  const payload = {
    task: "bilibili_ai_slice_candidates",
    model: settings.vision.model,
    room: context.room,
    sourceVideo: context.name,
    duration: input.duration,
    sources,
    durationPolicy: getModelSliceDurationPolicy(),
    clipCount: options.clipCount,
    inputs: modelInput,
    images: mediaImages,
    instruction: [
      "你要从 B 站直播素材里直接挑可剪片段。可以看弹幕、字幕、热度摘要、画面帧、音频频谱，但不要依赖本地候选，也不要硬凑数量。",
      "一个视频里可以有多个精彩点；候选之间尽量错开，每段只抓一个核心包袱或转折。",
      "先找“为什么值得剪”：弹幕突然接梗、主播反应变了、画面出现可截图的动作/表情、声音能量突然抬起来、台词能当标题。",
      "标题要像真实短切片标题，口语、具体、有钩子；不要写成报告标题，不要滥用“高能”“名场面”“爆笑”。",
      "reason 写一两句人话，告诉剪辑师这个点好在哪、应该怎么卖；不要写“多信号综合判断”“适合传播”这种空话。",
      "evidence 每条都要短而具体，可以写弹幕原话、字幕台词、画面描述或频谱变化，最好带时间。",
      "start/end 必须是源视频秒数；片段长度由你按内容决定，优先保证一个笑点、反转或完整包袱自然结束，不要为了凑固定秒数硬切。",
      "score 0-100；只有真的像能直接剪出来给人看的片段才给 72 分以上。",
      "如果 sources 包含 visual 或 audio，必须检查 inputs.mediaSamples 和随请求附带的图片样本，并在 reason 或 evidence 里体现画面/频谱依据。",
      settings.vision.slicePrompt ? `剪辑口味：\n${settings.vision.slicePrompt}` : "",
      "只返回 JSON：{candidates:[{id,title,start,end,score,reason,evidence:[...] }]}。"
    ].filter(Boolean).join("\n")
  };

  try {
    const { response, imageRetry } = await callSliceModelEndpoint(settings.vision, payload);
    const enhanced = parseGeneratedSliceModelResponse(response, context, options, sources);
    return {
      candidates: enhanced,
      diagnostics: {
        engine: "model-only",
        modelStatus: enhanced.length ? "ok" : "empty-response",
        modelUsed: true,
        endpoint: settings.vision.endpoint,
        wireApi: settings.vision.wireApi,
        model: settings.vision.model,
        mediaImagesRequested: mediaImages.length,
        mediaImagesUsed: imageRetry ? 0 : mediaImages.length,
        warnings: imageRetry ? [imageRetry.message] : [],
        message: enhanced.length
          ? imageRetry
            ? "视频理解接口已生成切片候选；当前模型网关不接受图片，已用同一模型的文本信号重试。"
            : "视频理解接口已直接生成切片候选。"
          : "模型没有返回可用候选；未使用本地规则兜底。"
      }
    };
  } catch (error) {
    return {
      candidates: [],
      diagnostics: {
        engine: "model-only",
        modelStatus: "error",
        modelUsed: false,
        endpoint: settings.vision.endpoint,
        wireApi: settings.vision.wireApi,
        model: settings.vision.model,
        message: `视频理解接口不可用，未使用本地规则：${readableVisionError(error).message}`
      }
    };
  }
}

async function callSliceModelEndpoint(settings, payload) {
  try {
    return { response: await callJsonEndpoint(settings, payload), imageRetry: null };
  } catch (error) {
    if (!shouldRetrySliceWithoutImages(error, payload)) throw error;
    const diagnostic = readableVisionError(error);
    const retryPayload = buildTextOnlySlicePayload(payload, diagnostic);
    return {
      response: await callJsonEndpoint(settings, retryPayload),
      imageRetry: diagnostic
    };
  }
}

function shouldRetrySliceWithoutImages(error, payload) {
  if (!Array.isArray(payload?.images) || !payload.images.length) return false;
  const raw = readableError(error);
  const payloadText = JSON.stringify(parseErrorPayload(raw) || {});
  const text = `${raw}\n${payloadText}`;
  return /image_url|input_image|multimodal|vision|invalid_value|invalid_request|invalid_responses_request|bad response status code 400|unsupported|not support|fetch failed|ECONNRESET|ETIMEDOUT|socket|terminated/i.test(text);
}

function buildTextOnlySlicePayload(payload, diagnostic) {
  const skippedImages = (payload.images || []).map((image) => ({
    type: image.type || "image",
    label: image.label || "",
    time: image.time ?? null
  }));
  return {
    ...payload,
    images: [],
    inputs: {
      ...(payload.inputs || {}),
      mediaImagesSkipped: skippedImages,
      mediaImageRetryReason: diagnostic.message
    },
    instruction: [
      payload.instruction,
      "注意：当前模型网关不接受图片输入，这次不能直接看帧图或频谱图。仍然只用模型生成候选；请根据弹幕、字幕、热度窗、mediaSamples 的时间窗和样本标签判断，不要假装看到了具体画面内容。若画面/频谱证据不足，就把理由写成弹幕、字幕或热度为主。"
    ].filter(Boolean).join("\n")
  };
}

async function buildModelSliceInput(context, options, sources, settings) {
  const totalDuration = Math.max(Number(context.duration || 0), Number(context.media?.duration || 0), 1);
  const sourceComments = sources.includes("danmaku") ? applyDanmakuEdits(context.danmaku, options.danmakuEdits) : [];
  const optionSubtitles = Array.isArray(options.subtitles) ? normalizeOptionSubtitles(options.subtitles) : context.subtitles;
  const sourceSubtitles = sources.includes("subtitle") ? optionSubtitles : [];
  const histogram = context.histogram?.length ? context.histogram : buildHistogram(sourceComments, totalDuration, 30);
  const topBins = histogram
    .slice()
    .sort((a, b) => Number(b.count || b.score || 0) - Number(a.count || a.score || 0))
    .slice(0, 24)
    .sort((a, b) => a.start - b.start)
    .map((bin) => ({
      start: bin.start,
      end: bin.end,
      count: bin.count,
      score: bin.score,
      danmaku: sourceComments
        .filter((item) => item.time >= bin.start && item.time < bin.end)
        .slice(0, 12)
        .map((item) => ({ time: item.time, text: item.text })),
      subtitles: sourceSubtitles
        .filter((cue) => cue.start < bin.end && cue.end > bin.start)
        .slice(0, 8)
        .map((cue) => ({ start: cue.start, end: cue.end, text: cue.text }))
    }));
  const mediaSamples = await collectModelMediaSamples(context, topBins, options, sources, settings);
  return {
    duration: totalDuration,
    danmakuTotal: context.danmakuTotal,
    subtitleTotal: sourceSubtitles.length,
    enabledSignals: {
      danmaku: sources.includes("danmaku"),
      subtitles: sources.includes("subtitle"),
      visualFrames: sources.includes("visual") && settings?.vision?.sendFrames !== false,
      audioSpectrum: sources.includes("audio") && settings?.vision?.audioSpectrum !== false
    },
    topBins,
    mediaSamples: mediaSamples.samples,
    mediaSampleErrors: mediaSamples.errors,
    mediaImages: mediaSamples.images,
    recentDanmaku: sourceComments.slice(-80).map((item) => ({ time: item.time, text: item.text })),
    subtitles: sourceSubtitles.slice(0, 160).map((cue) => ({ start: cue.start, end: cue.end, text: cue.text }))
  };
}

async function collectModelMediaSamples(context, topBins, options, sources, settings) {
  const wantsFrames = sources.includes("visual") && settings?.vision?.sendFrames !== false;
  const wantsSpectrum = sources.includes("audio") && settings?.vision?.audioSpectrum !== false;
  if (!wantsFrames && !wantsSpectrum) return { samples: [], images: [], errors: [] };

  const frameBudget = Math.max(1, Math.min(12, Number(settings?.vision?.frameSampleCount || 6)));
  const clipCount = Math.max(1, Math.min(6, Number(options.clipCount || 3)));
  const windows = pickMediaSampleWindows(topBins, context.duration, clipCount);
  const sampleRoot = path.join(
    modelAssetsDir,
    "slice-samples",
    crypto.createHash("sha1").update(`${context.path}:${Date.now()}:${Math.random()}`).digest("hex").slice(0, 12)
  );
  await fsp.mkdir(sampleRoot, { recursive: true });

  const samples = [];
  const images = [];
  const errors = [];
  let frameIndex = 0;

  if (wantsFrames) {
    const times = [];
    for (const win of windows) {
      const mid = win.start + (win.end - win.start) / 2;
      times.push({ time: mid, window: win });
      if (times.length >= frameBudget) break;
    }
    for (const item of times) {
      const outPath = path.join(sampleRoot, `frame-${String(frameIndex + 1).padStart(2, "0")}.jpg`);
      try {
        await execFileAsync("ffmpeg", ["-y", "-ss", String(Math.max(0, item.time)), "-i", context.path, "-frames:v", "1", "-vf", "scale=384:-1", "-q:v", "5", outPath], {
          timeout: 20000,
          maxBuffer: 1024 * 1024 * 4
        });
        const dataUrl = await imageFileToDataUrl(outPath, "image/jpeg");
        const label = `frame ${formatTime(item.time)} (${formatTime(item.window.start)}-${formatTime(item.window.end)})`;
        samples.push({ type: "frame", time: item.time, windowStart: item.window.start, windowEnd: item.window.end, label });
        images.push({ type: "frame", time: item.time, label, dataUrl });
      } catch (error) {
        errors.push({ type: "frame", time: item.time, message: readableError(error).slice(0, 240) });
      }
      frameIndex += 1;
    }
  }

  if (wantsSpectrum) {
    for (let index = 0; index < Math.min(3, windows.length); index += 1) {
      const win = windows[index];
      const duration = Math.max(1, Math.min(120, win.end - win.start));
      const outPath = path.join(sampleRoot, `spectrum-${String(index + 1).padStart(2, "0")}.jpg`);
      try {
        await execFileAsync("ffmpeg", ["-y", "-ss", String(Math.max(0, win.start)), "-t", String(duration), "-i", context.path, "-lavfi", "showspectrumpic=s=480x180:legend=disabled", "-frames:v", "1", outPath], {
          timeout: 25000,
          maxBuffer: 1024 * 1024 * 4
        });
        const dataUrl = await imageFileToDataUrl(outPath, "image/jpeg");
        const label = `audio spectrum ${formatTime(win.start)}-${formatTime(win.end)}`;
        samples.push({ type: "audio-spectrum", windowStart: win.start, windowEnd: win.end, duration, label });
        images.push({ type: "audio-spectrum", time: win.start, label, dataUrl });
      } catch (error) {
        errors.push({ type: "audio-spectrum", windowStart: win.start, windowEnd: win.end, message: readableError(error).slice(0, 240) });
      }
    }
  }

  return { samples, images, errors };
}

function pickMediaSampleWindows(topBins, duration, count) {
  const ranked = (topBins || [])
    .slice()
    .sort((a, b) => Number(b.count || b.score || 0) - Number(a.count || a.score || 0))
    .slice(0, count)
    .map((bin) => ({
      start: Math.max(0, Number(bin.start || 0)),
      end: Math.min(Math.max(Number(duration || 0), 1), Math.max(Number(bin.end || 0), Number(bin.start || 0) + 30))
    }))
    .filter((bin) => bin.end > bin.start);
  if (ranked.length) return ranked;
  const total = Math.max(Number(duration || 0), 1);
  return Array.from({ length: count }, (_, index) => {
    const center = total * ((index + 1) / (count + 1));
    return { start: Math.max(0, center - 15), end: Math.min(total, center + 15) };
  });
}

async function imageFileToDataUrl(filePath, mimeType) {
  const data = await fsp.readFile(filePath);
  return `data:${mimeType};base64,${data.toString("base64")}`;
}

function parseGeneratedSliceModelResponse(response, context, options, sources) {
  const parsed = normalizeModelJsonResponse(response);
  const list = Array.isArray(parsed?.candidates)
    ? parsed.candidates
    : Array.isArray(parsed?.clips)
      ? parsed.clips
      : Array.isArray(parsed)
        ? parsed
        : [];
  if (!list.length) return [];

  const precisionMode = String(options.precisionMode || "high");
  const count = Math.min(12, Math.max(1, Number(options.clipCount || 5)));
  const fallbackDuration = getFallbackSliceDuration(context);
  const totalDuration = Math.max(Number(context.duration || 0), Number(context.media?.duration || 0), fallbackDuration);
  const sourceComments = sources.includes("danmaku") ? applyDanmakuEdits(context.danmaku, options.danmakuEdits) : [];
  const optionSubtitles = Array.isArray(options.subtitles) ? normalizeOptionSubtitles(options.subtitles) : context.subtitles;
  const sourceSubtitles = sources.includes("subtitle") ? optionSubtitles : [];
  const candidates = [];
  const used = new Set();
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index] || {};
    const start = clamp(Number(item.start ?? item.from ?? 0), 0, Math.max(0, totalDuration - 1));
    const rawEnd = Number.isFinite(Number(item.end ?? item.to))
      ? Number(item.end ?? item.to)
      : Math.min(totalDuration, start + fallbackDuration);
    const end = clamp(Math.max(start + 1, rawEnd), start + 1, totalDuration);
    const id = String(item.id || `model-${Math.round(start)}-${Math.round(end)}`).trim();
    if (used.has(id)) continue;
    used.add(id);
    const candidate = makeModelSliceCandidate(context, item, { id, start, end, index, sources, sourceComments, sourceSubtitles });
    if (precisionMode === "high" && !candidate.automation.eligibleForAutoUpload) continue;
    candidates.push(candidate);
    if (candidates.length >= count) break;
  }
  return candidates;
}

function makeModelSliceCandidate(context, item, { id, start, end, index, sources, sourceComments, sourceSubtitles }) {
  const windowComments = sourceComments.filter((comment) => comment.time >= start && comment.time <= end);
  const windowSubtitles = sourceSubtitles.filter((cue) => cue.start < end && cue.end > start);
  const texts = [...windowComments.map((comment) => comment.text), ...windowSubtitles.map((cue) => cue.text)];
  const evidence = normalizeEvidence(item.evidence).length
    ? normalizeEvidence(item.evidence)
    : [
        ...windowComments.slice(0, 3).map((comment) => `弹幕 ${formatTime(comment.time)}：${comment.text}`),
        ...windowSubtitles.slice(0, 3).map((cue) => `字幕 ${formatTime(cue.start)}：${cue.text}`)
      ].slice(0, 6);
  const modelScore = Math.max(1, Math.min(100, Math.round(Number(item.score || item.confidenceScore || 70))));
  const signal = {
    funnyHits: countKeywordHits(texts, funnyKeywords),
    reactionHits: countKeywordHits(texts, reactionKeywords),
    questionHits: countKeywordHits(texts, questionKeywords),
    danmakuCount: windowComments.length,
    subtitleCount: windowSubtitles.length,
    peakCount: windowComments.length,
    hotText: String(item.hotText || item.hook || pickInterestingText(windowComments, windowSubtitles) || "").trim()
  };
  const automation = evaluateClipAutomation(signal, { count: windowComments.length, combinedScore: modelScore }, new Set(sources));
  automation.score = modelScore;
  automation.confidence = modelScore >= 72 ? "high" : "review";
  automation.eligibleForAutoUpload = modelScore >= 72 && evidence.length > 0;
  automation.signalFamilies = [...new Set([...(automation.signalFamilies || []), "model-selection"])];
  automation.policyReason = automation.eligibleForAutoUpload
    ? "Model-selected high-confidence clip."
    : "Model-selected review candidate.";
  return {
    id,
    title: String(item.title || `${context.room.name} AI 切片 ${index + 1}`).trim().slice(0, 80),
    start,
    end,
    score: modelScore,
    reason: String(item.reason || "模型根据弹幕、字幕和热度摘要直接挑选的候选片段。").trim(),
    evidence,
    signal,
    automation
  };
}

function parseSliceModelResponse(response, localCandidates) {
  const parsed = normalizeModelJsonResponse(response);
  const list = Array.isArray(parsed?.candidates)
    ? parsed.candidates
    : Array.isArray(parsed?.clips)
      ? parsed.clips
      : Array.isArray(parsed)
        ? parsed
        : [];
  if (!list.length) return [];

  const byId = new Map(localCandidates.map((candidate) => [candidate.id, candidate]));
  const used = new Set();
  const enhanced = [];
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index] || {};
    const local = byId.get(String(item.id || "")) || localCandidates[index];
    if (!local || used.has(local.id)) continue;
    used.add(local.id);
    const start = Number.isFinite(Number(item.start)) ? Math.max(0, Number(item.start)) : local.start;
    const rawEnd = Number.isFinite(Number(item.end)) ? Number(item.end) : local.end;
    const end = Math.max(start + 1, rawEnd);
    enhanced.push({
      ...local,
      title: String(item.title || local.title).trim().slice(0, 80) || local.title,
      start,
      end,
      score: Math.max(1, Math.min(100, Math.round(Number(item.score || local.score || 1)))),
      reason: String(item.reason || local.reason).trim() || local.reason,
      evidence: normalizeEvidence(item.evidence).length ? normalizeEvidence(item.evidence) : local.evidence
    });
  }
  for (const local of localCandidates) {
    if (!used.has(local.id)) enhanced.push(local);
  }
  return enhanced.slice(0, localCandidates.length);
}

function normalizeEvidence(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 8);
}

function trimForReason(text) {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  return compact.length > 34 ? `${compact.slice(0, 34)}...` : compact;
}

function trimForTitle(text) {
  const compact = text.replace(/[^\p{Letter}\p{Number}\p{Script=Han}？！!?，,。～~ ]/gu, "").trim();
  return compact.length > 18 ? `${compact.slice(0, 18)}...` : compact || "高能瞬间";
}

async function generateTitleSuggestion(context, body, settings, job) {
  try {
    job.progress = 15;
    job.message = "正在整理弹幕和字幕信号";
    job.updatedAt = new Date().toISOString();
    const signal = collectClipSignals(context, body);
    const payload = {
      task: "bilibili_clip_title",
      model: settings.vision.model,
      room: context.room,
      sourceVideo: context.name,
      clip: {
        title: body.clip?.title || body.title || "",
        start: signal.start,
        end: signal.end,
        reason: body.clip?.reason || body.reason || ""
      },
      inputs: {
        danmaku: signal.comments.slice(0, 80),
        subtitles: signal.subtitles.slice(0, 80),
        evidence: signal.evidence,
        hotText: signal.hotText
      },
      instruction: "生成 3 个适合 B 站直播切片的短标题，优先突出笑点、反差或名场面。返回 JSON：{title, alternatives, reason}。"
    };

    if (settings.vision.endpoint && settings.vision.provider !== "manual") {
      job.progress = 35;
      job.message = "正在调用外部视频理解模型";
      appendJobLog(job, `POST ${settings.vision.endpoint}\n`);
      try {
        const response = await callJsonEndpoint(settings.vision, payload);
        const parsed = parseTitleModelResponse(response);
        if (parsed.title) {
          job.status = "ready";
          job.progress = 100;
          job.message = "外部模型标题已生成";
          job.output = parsed;
          job.updatedAt = new Date().toISOString();
          appendJobLog(job, `${JSON.stringify(parsed, null, 2)}\n`);
          return parsed;
        }
        appendJobLog(job, "外部模型没有返回可用标题，改用本地规则。\n");
      } catch (error) {
        appendJobLog(job, `外部模型调用失败，改用本地规则：${readableError(error)}\n`);
      }
    }

    const local = makeLocalTitleSuggestion(context, signal, body);
    job.status = "ready";
    job.progress = 100;
    job.message = "本地规则标题已生成";
    job.output = local;
    job.updatedAt = new Date().toISOString();
    appendJobLog(job, `${JSON.stringify(local, null, 2)}\n`);
    return local;
  } catch (error) {
    job.status = "error";
    job.progress = 0;
    job.message = readableError(error);
    job.updatedAt = new Date().toISOString();
    throw error;
  }
}

async function generateCoverImage(videoPath, body, settings, job) {
  try {
    assertInsideRecordings(videoPath);
    const context = await getVideoContext(videoPath);
    const signal = collectClipSignals(context, body);
    const payload = {
      task: "bilibili_clip_cover",
      model: settings.cover.model,
      room: context.room,
      sourceVideo: context.name,
      stylePrompt: settings.cover.stylePrompt,
      clip: {
        title: body.clip?.title || body.title || signal.hotText || context.room.name,
        start: signal.start,
        end: signal.end,
        reason: body.clip?.reason || body.reason || ""
      },
      inputs: {
        evidence: signal.evidence,
        subtitles: signal.subtitles.slice(0, 40),
        danmaku: signal.comments.slice(0, 40)
      },
      instruction: "生成适合 B 站视频封面的 16:9 图片。若无法直接返回图片，请返回 imageUrl、dataUrl、imageBase64 或封面设计说明。"
    };

    if (settings.cover.endpoint && settings.cover.provider !== "frame-template") {
      job.progress = 35;
      job.message = "正在调用外部图像模型";
      appendJobLog(job, `POST ${settings.cover.endpoint}\n`);
      try {
        const response = await callJsonEndpoint(settings.cover, payload);
        const external = await parseCoverModelResponse(response, body, job);
        if (external) {
          job.status = "ready";
          job.progress = 100;
          job.message = "外部模型封面已生成";
          job.output = external;
          job.outputPath = external.path || external.mediaUrl || null;
          job.updatedAt = new Date().toISOString();
          return external;
        }
        appendJobLog(job, "外部模型没有返回图片，改用本地模板封面。\n");
      } catch (error) {
        appendJobLog(job, `外部图像模型调用失败，改用本地模板封面：${readableError(error)}\n`);
      }
    }

    const local = await generateTemplateCover(videoPath, body, settings, signal, job);
    job.status = "ready";
    job.progress = 100;
    job.message = local.templateFallback ? "模板封面失败，已降级为封面帧" : "本地模板封面已生成";
    job.output = local;
    job.outputPath = local.path;
    job.updatedAt = new Date().toISOString();
    return local;
  } catch (error) {
    job.status = "error";
    job.progress = 0;
    job.message = readableError(error);
    job.updatedAt = new Date().toISOString();
    throw error;
  }
}

function collectClipSignals(context, body) {
  const clip = body.clip || {};
  const start = Math.max(0, Number(body.start ?? clip.start ?? 0));
  const requestedEnd = Number(body.end ?? clip.end ?? 0);
  const duration = Math.max(context.duration || context.media.duration || 0, 1);
  const end = requestedEnd > start ? Math.min(duration, requestedEnd) : Math.min(duration, start + 90);
  const comments = applyDanmakuEdits(context.danmaku, body.danmakuEdits).filter((item) => item.time >= start && item.time <= end);
  const subtitles = normalizeOptionSubtitles(Array.isArray(body.subtitles) ? body.subtitles : context.subtitles).filter((cue) => cue.start < end && cue.end > start);
  const hotText = pickInterestingText(comments, subtitles);
  const interestingComments = comments.slice().sort((a, b) => interestingScore(b.text) - interestingScore(a.text));
  const interestingSubtitles = subtitles.slice().sort((a, b) => interestingScore(b.text) - interestingScore(a.text));
  const evidence = [
    ...interestingComments.slice(0, 5).map((item) => `弹幕 ${formatTime(item.time)}：${item.text}`),
    ...interestingSubtitles.slice(0, 5).map((cue) => `字幕 ${formatTime(cue.start)}：${cue.text}`)
  ];
  return { start, end, comments, subtitles, hotText, evidence };
}

function makeLocalTitleSuggestion(context, signal, body) {
  const base = signal.hotText || body.clip?.title || body.title || context.room.name;
  const title = `${trimForTitle(base)}｜${trimForTitle(context.room.name)}`;
  const alternatives = [
    `${trimForTitle(base)}，这段太有节目效果了`,
    `${trimForTitle(context.room.name)}高能切片：${trimForTitle(base)}`,
    `弹幕突然爆了：${trimForTitle(base)}`
  ].filter((value, index, arr) => value && arr.indexOf(value) === index);
  return {
    title,
    alternatives,
    reason: signal.evidence.length
      ? `标题来自该片段最集中的弹幕/字幕信号：${signal.evidence[0]}`
      : "当前片段缺少强弹幕或字幕信号，标题使用房间名和片段原始标题兜底。",
    evidence: signal.evidence
  };
}

async function callJsonEndpoint(settings, payload) {
  if (String(settings.provider || "").toLowerCase().includes("openai")) {
    return callOpenAiCompatibleEndpoint(settings, payload);
  }
  const headers = { "Content-Type": "application/json" };
  if (settings.apiKey) {
    headers.Authorization = `Bearer ${settings.apiKey}`;
  }
  const response = await fetch(settings.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || response.statusText);
  }
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

async function callOpenAiCompatibleEndpoint(settings, payload) {
  const base = String(settings.endpoint || "").replace(/\/+$/, "");
  if (!base) {
    throw new Error("未配置 OpenAI 兼容接口地址。");
  }
  const wireApi = normalizeVisionWireApi(settings.wireApi || settings.wire_api);
  const call = (candidateBase) => wireApi === "responses"
    ? callOpenAiResponsesEndpoint(candidateBase, settings, payload)
    : callOpenAiChatCompletionsEndpoint(candidateBase, settings, payload);
  try {
    return await call(base);
  } catch (error) {
    const fallbackBase = getLocalhostFallbackBase(base);
    if (!fallbackBase || !/fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(readableError(error))) {
      throw error;
    }
    return call(fallbackBase);
  }
}

function getLocalhostFallbackBase(base) {
  try {
    const url = new URL(base);
    if (url.hostname !== "localhost") return null;
    url.hostname = "127.0.0.1";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

async function callOpenAiChatCompletionsEndpoint(base, settings, payload) {
  const url = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
  const headers = { "Content-Type": "application/json" };
  if (settings.apiKey) {
    headers.Authorization = `Bearer ${settings.apiKey}`;
  }
  const input = { ...payload };
  delete input.instruction;
  delete input.images;
  const userText = buildOpenAiTaskText(payload, input);
  const content = buildOpenAiChatContent(userText, payload.images);
  const baseBody = {
      model: payload.model || settings.model,
      temperature: Number(settings.sliceTemperature ?? settings.temperature ?? 0.35),
      messages: [
        {
          role: "system",
          content: "你是直播切片工作台的模型适配层。必须优先返回 JSON，不要输出解释性前后缀。"
        },
        {
          role: "user",
          content
        }
      ]
  };
  const call = async (withResponseFormat) => {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(withResponseFormat ? { ...baseBody, response_format: { type: "json_object" } } : baseBody)
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(text || response.statusText);
    }
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  };
  try {
    return normalizeOpenAiCompatibleResponse(await call(true));
  } catch (error) {
    const message = readableError(error);
    if (!/response_format|json_object|unsupported|not support|不支持/i.test(message)) {
      throw error;
    }
    return normalizeOpenAiCompatibleResponse(await call(false));
  }
}

async function callOpenAiResponsesEndpoint(base, settings, payload) {
  const url = base.endsWith("/responses") ? base : `${base}/responses`;
  const headers = { "Content-Type": "application/json" };
  if (settings.apiKey) {
    headers.Authorization = `Bearer ${settings.apiKey}`;
  }
  const input = { ...payload };
  delete input.instruction;
  delete input.images;
  const systemText = "你是直播切片工作台的模型适配层。必须优先返回 JSON，不要输出解释性前后缀。需要标题和理由时用中文。";
  const userText = buildOpenAiTaskText(payload, input);
  const responseContent = buildOpenAiResponsesContent(userText, payload.images);
  const codexInput = [
    { type: "message", role: "user", content: responseContent }
  ];
  const structuredInput = [
    { role: "system", content: [{ type: "input_text", text: systemText }] },
    { role: "user", content: responseContent }
  ];
  const baseBody = {
    model: payload.model || settings.model,
    temperature: Number(settings.sliceTemperature ?? settings.temperature ?? 0.35),
    input: structuredInput
  };
  const call = async (body) => {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(text || response.statusText);
    }
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  };
  const attempts = [
    {
      model: payload.model || settings.model,
      instructions: systemText,
      input: codexInput,
      reasoning: { effort: "low", summary: "auto" },
      include: ["reasoning.encrypted_content"],
      store: false
    },
    { ...baseBody, text: { format: { type: "json_object" } } },
    baseBody,
    { model: payload.model || settings.model, input: `${systemText}\n\n${userText}` }
  ];
  let lastError = null;
  for (const body of attempts) {
    try {
      return normalizeOpenAiCompatibleResponse(await call(body));
    } catch (error) {
      lastError = error;
      const message = readableError(error);
      if (!/response_format|json_object|format|schema|temperature|unsupported|not support|invalid|不支持/i.test(message)) {
        throw error;
      }
    }
  }
  throw lastError || new Error("Responses request failed.");
}

function buildOpenAiTaskText(payload, input) {
  return [
    payload.instruction ? `任务要求：\n${payload.instruction}` : "",
    "输入数据：",
    JSON.stringify(input, null, 2)
  ].filter(Boolean).join("\n\n");
}

function normalizePayloadImages(images) {
  return Array.isArray(images)
    ? images
        .map((item) => ({
          label: String(item?.label || item?.type || "image").slice(0, 120),
          dataUrl: String(item?.dataUrl || item?.image_url || item?.url || "")
        }))
        .filter((item) => /^data:image\/(?:png|jpe?g|webp);base64,/i.test(item.dataUrl))
        .slice(0, 16)
    : [];
}

function buildOpenAiChatContent(userText, images) {
  const normalized = normalizePayloadImages(images);
  if (!normalized.length) return userText;
  return [
    { type: "text", text: userText },
    ...normalized.map((image) => ({
      type: "image_url",
      image_url: { url: image.dataUrl, detail: "low" }
    }))
  ];
}

function buildOpenAiResponsesContent(userText, images) {
  const normalized = normalizePayloadImages(images);
  return [
    { type: "input_text", text: userText },
    ...normalized.map((image) => ({
      type: "input_image",
      image_url: image.dataUrl,
      detail: "low"
    }))
  ];
}

function normalizeOpenAiCompatibleResponse(response) {
  const content = collectOpenAiResponseText(response);
  if (!content) return response;
  const parsed = extractJsonObject(content);
  if (parsed) return { ...parsed, raw: summarizeOpenAiRawResponse(response) };
  return { ...response, text: content };
}

function summarizeOpenAiRawResponse(response) {
  if (!response || typeof response !== "object") return response;
  return {
    id: response.id || null,
    object: response.object || null,
    model: response.model || null,
    status: response.status || null,
    usage: response.usage || null,
    outputTypes: Array.isArray(response.output)
      ? response.output.map((item) => ({
        type: item?.type || null,
        role: item?.role || null,
        status: item?.status || null,
        contentTypes: Array.isArray(item?.content) ? item.content.map((content) => content?.type || null) : []
      }))
      : []
  };
}

function collectOpenAiResponseText(response) {
  const chunks = [];
  const push = (value) => {
    const text = String(value || "").trim();
    if (text) chunks.push(text);
  };
  push(response?.choices?.[0]?.message?.content);
  push(response?.choices?.[0]?.text);
  push(response?.output_text);
  push(response?.text);
  if (Array.isArray(response?.output)) {
    for (const item of response.output) {
      if (item?.type === "reasoning") continue;
      push(item?.text);
      if (Array.isArray(item?.content)) {
        for (const content of item.content) {
          push(content?.text);
          push(content?.output_text);
        }
      }
    }
  }
  if (Array.isArray(response?.content)) {
    for (const content of response.content) {
      push(content?.text);
      push(content?.output_text);
    }
  }
  return chunks.join("\n").trim();
}


function normalizeModelJsonResponse(response) {
  if (!response) return null;
  if (typeof response === "string") return extractJsonObject(response);
  const direct = extractJsonObject(response.text || response.message || response.output_text || response.choices?.[0]?.message?.content || "");
  return direct || response;
}

function parseTitleModelResponse(response) {
  if (!response) return {};
  if (response.title) {
    return {
      title: String(response.title).trim(),
      alternatives: Array.isArray(response.alternatives) ? response.alternatives.map(String).filter(Boolean) : [],
      reason: String(response.reason || "外部模型返回标题。"),
      evidence: Array.isArray(response.evidence) ? response.evidence.map(String).filter(Boolean) : []
    };
  }
  const text = String(
    response.output_text
      || response.text
      || response.message
      || response.choices?.[0]?.message?.content
      || response.choices?.[0]?.text
      || ""
  ).trim();
  const parsed = extractJsonObject(text);
  if (parsed?.title) {
    return parseTitleModelResponse(parsed);
  }
  const firstLine = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] || "";
  return firstLine ? { title: firstLine.slice(0, 80), alternatives: [], reason: "外部模型返回纯文本标题。", evidence: [] } : {};
}

function extractJsonObject(text) {
  const value = String(text || "").trim();
  if (!value) return null;
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : value.slice(value.indexOf("{"), value.lastIndexOf("}") + 1);
  if (!candidate || !candidate.includes("{")) return null;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

async function parseCoverModelResponse(response, body, job) {
  const imageUrl = response?.imageUrl || response?.image_url || response?.url || response?.data?.[0]?.url;
  if (imageUrl) {
    const result = { path: String(imageUrl), mediaUrl: String(imageUrl), prompt: response.prompt || body.title || "", provider: "external-url" };
    appendJobLog(job, `${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  const dataUrl = response?.dataUrl || response?.data_url || response?.imageDataUrl || response?.data?.[0]?.dataUrl;
  const base64 = response?.imageBase64 || response?.image_base64 || response?.b64_json || response?.data?.[0]?.b64_json;
  if (dataUrl || base64) {
    const outPath = await saveGeneratedImage(dataUrl || base64, body.title || "cover");
    const result = {
      path: outPath,
      mediaUrl: `/api/media?key=${encodeURIComponent(encodeKey(outPath))}`,
      prompt: response.prompt || body.title || "",
      provider: "external-base64"
    };
    appendJobLog(job, `${JSON.stringify({ ...result, path: outPath }, null, 2)}\n`);
    return result;
  }
  appendJobLog(job, `${JSON.stringify(response, null, 2).slice(0, 6000)}\n`);
  return null;
}

async function saveGeneratedImage(value, title) {
  await fsp.mkdir(coversDir, { recursive: true });
  const text = String(value || "");
  const match = text.match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/i);
  const mimeType = match?.[1] || "image/png";
  const extension = mimeType.includes("webp") ? ".webp" : mimeType.includes("jpeg") || mimeType.includes("jpg") ? ".jpg" : ".png";
  const base64 = match?.[2] || text;
  const outPath = path.join(coversDir, `${slugify(title || "cover")}_${Date.now()}${extension}`);
  await fsp.writeFile(outPath, Buffer.from(base64, "base64"));
  return outPath;
}

async function generateTemplateCover(videoPath, body, settings, signal, job) {
  const clip = body.clip || {};
  const at = signal.start + Math.max(1, (signal.end - signal.start) * 0.35);
  const title = String(clip.title || body.title || signal.hotText || "直播高能切片").trim();
  const subtitle = signal.hotText && signal.hotText !== title ? signal.hotText : (settings.cover.stylePrompt || "直播切片");
  const safeName = `${slugify(path.basename(videoPath, path.extname(videoPath)))}_${Math.round(signal.start)}-${Math.round(signal.end)}_${Date.now()}`;
  await fsp.mkdir(coversDir, { recursive: true });
  const titleFile = path.join(coversDir, `${safeName}_title.txt`);
  const subtitleFile = path.join(coversDir, `${safeName}_subtitle.txt`);
  const outPath = path.join(coversDir, `${safeName}_cover.jpg`);
  await fsp.writeFile(titleFile, wrapCoverTitle(title), "utf8");
  await fsp.writeFile(subtitleFile, trimForReason(subtitle), "utf8");

  const titleOptions = [
    "font=Microsoft YaHei",
    `textfile=${path.basename(titleFile)}`,
    "fontcolor=white",
    "fontsize=54",
    "x=64",
    "y=466",
    "line_spacing=12",
    "borderw=2",
    "bordercolor=black@0.7"
  ].filter(Boolean).join(":");
  const subtitleOptions = [
    "font=Microsoft YaHei",
    `textfile=${path.basename(subtitleFile)}`,
    "fontcolor=#dff2ef",
    "fontsize=28",
    "x=68",
    "y=628",
    "borderw=1",
    "bordercolor=black@0.75"
  ].filter(Boolean).join(":");
  const filter = [
    "scale=1280:720:force_original_aspect_ratio=increase",
    "crop=1280:720",
    "drawbox=x=0:y=430:w=1280:h=290:color=black@0.58:t=fill",
    `drawtext=${titleOptions}`,
    `drawtext=${subtitleOptions}`
  ].join(",");
  const args = ["-y", "-ss", String(at), "-i", videoPath, "-frames:v", "1", "-vf", filter, "-q:v", "2", outPath];
  job.progress = 55;
  job.message = "正在生成本地模板封面";
  job.command = ["ffmpeg", ...args].map(quoteArg).join(" ");
  appendJobLog(job, `> ${job.command}\n`);
  try {
    const result = await execFileAsync("ffmpeg", args, { cwd: coversDir, timeout: 45000, maxBuffer: 1024 * 1024 * 8 });
    appendJobLog(job, result.stderr || result.stdout || "");
    return {
      path: outPath,
      mediaUrl: `/api/media?key=${encodeURIComponent(encodeKey(outPath))}`,
      prompt: `${settings.cover.stylePrompt || ""}\n${title}`.trim(),
      provider: "frame-template"
    };
  } catch (error) {
    appendJobLog(job, `${error.stdout || ""}${error.stderr || ""}${readableError(error)}\n`);
    const fallback = await extractCoverFrame(videoPath, { ...body, time: at, title });
    return {
      ...fallback,
      prompt: `${settings.cover.stylePrompt || ""}\n${title}`.trim(),
      provider: "frame-template-fallback",
      templateFallback: true
    };
  }
}

function wrapCoverTitle(text) {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  if (compact.length <= 18) return compact;
  return `${compact.slice(0, 18)}\n${compact.slice(18, 36)}`;
}

async function exportClip(videoPath, body) {
  assertInsideRecordings(videoPath);
  const start = Math.max(0, Number(body.start || 0));
  const end = Math.max(start + 1, Number(body.end || start + 90));
  const title = String(body.title || "clip");
  const roomPath = findRoomPath(videoPath);
  const roomSlug = slugify(path.basename(roomPath));
  const outDir = path.join(exportsDir, roomSlug);
  await fsp.mkdir(outDir, { recursive: true });
  const burnSubtitles = Boolean(body.burnSubtitles);
  const subtitleCues = Array.isArray(body.subtitles) ? body.subtitles : [];
  const subtitleFile = burnSubtitles ? await writeClipSubtitles(outDir, start, end, subtitleCues) : null;
  const outName = `${slugify(path.basename(videoPath, path.extname(videoPath)))}_${Math.round(start)}-${Math.round(end)}_${slugify(title)}${subtitleFile ? "_sub" : ""}.mp4`;
  const outPath = path.join(outDir, outName);
  if (subtitleFile) {
    const encodeArgs = [
      "-y",
      "-ss",
      String(start),
      "-to",
      String(end),
      "-i",
      videoPath,
      "-vf",
      `subtitles=${path.basename(subtitleFile)}:force_style='FontName=Microsoft YaHei,FontSize=20,Outline=1,Shadow=0,MarginV=36'`,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      outPath
    ];
    await execFileAsync("ffmpeg", encodeArgs, { cwd: outDir, timeout: 1000 * 60 * 40, maxBuffer: 1024 * 1024 * 8 });
    return {
      ok: true,
      path: outPath,
      mediaUrl: `/api/media?key=${encodeURIComponent(encodeKey(outPath))}`
    };
  }
  const copyArgs = ["-y", "-ss", String(start), "-to", String(end), "-i", videoPath, "-c", "copy", "-avoid_negative_ts", "make_zero", outPath];
  try {
    await execFileAsync("ffmpeg", copyArgs, { timeout: 1000 * 60 * 20, maxBuffer: 1024 * 1024 * 8 });
  } catch {
    const encodeArgs = ["-y", "-ss", String(start), "-to", String(end), "-i", videoPath, "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-movflags", "+faststart", outPath];
    await execFileAsync("ffmpeg", encodeArgs, { timeout: 1000 * 60 * 40, maxBuffer: 1024 * 1024 * 8 });
  }
  return {
    ok: true,
    path: outPath,
    mediaUrl: `/api/media?key=${encodeURIComponent(encodeKey(outPath))}`
  };
}

async function writeClipSubtitles(outDir, start, end, cues) {
  const overlapping = cues
    .map((cue) => ({
      start: Number(cue.start),
      end: Number(cue.end),
      text: cleanText(cue.text)
    }))
    .filter((cue) => Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.text && cue.start < end && cue.end > start)
    .map((cue) => ({
      start: Math.max(0, cue.start - start),
      end: Math.min(end - start, cue.end - start),
      text: cue.text
    }))
    .filter((cue) => cue.end > cue.start);

  if (!overlapping.length) {
    return null;
  }

  const srt = overlapping
    .map((cue, index) => [String(index + 1), `${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}`, cue.text.replace(/\n{3,}/g, "\n\n"), ""].join("\n"))
    .join("\n");
  const file = path.join(outDir, `clip-subtitles-${Date.now()}.srt`);
  await fsp.writeFile(file, srt, "utf8");
  return file;
}

async function packageModelAssets(videoPath, body) {
  assertInsideRecordings(videoPath);
  const start = Math.max(0, Number(body.start || 0));
  const end = Math.max(start + 1, Number(body.end || start + 90));
  const title = String(body.title || "clip");
  const context = await getVideoContext(videoPath);
  const safeName = `${slugify(path.basename(videoPath, path.extname(videoPath)))}_${Math.round(start)}-${Math.round(end)}_${slugify(title)}`;
  const outDir = path.join(modelAssetsDir, safeName);
  const framesDir = path.join(outDir, "frames");
  await fsp.mkdir(framesDir, { recursive: true });

  const frameCount = Math.min(12, Math.max(1, Number(body.frameCount || 5)));
  const framePaths = [];
  for (let index = 0; index < frameCount; index += 1) {
    const ratio = frameCount === 1 ? 0.5 : index / (frameCount - 1);
    const timestamp = start + (end - start) * ratio;
    const framePath = path.join(framesDir, `frame-${String(index + 1).padStart(2, "0")}.jpg`);
    await execFileAsync("ffmpeg", ["-y", "-ss", String(timestamp), "-i", videoPath, "-frames:v", "1", "-vf", "scale=1280:-1", "-q:v", "3", framePath], {
      timeout: 30000,
      maxBuffer: 1024 * 1024 * 4
    });
    framePaths.push(framePath);
  }

  let audioPath = null;
  if (body.includeAudio !== false) {
    audioPath = path.join(outDir, "audio.wav");
    await extractAudioSegment(videoPath, audioPath, start, end);
  }

  const subtitles = Array.isArray(body.subtitles) ? body.subtitles : context.subtitles;
  const subtitlePath = await writeClipSubtitles(outDir, start, end, subtitles);
  const danmaku = context.danmaku.filter((item) => item.time >= start && item.time <= end);
  const contextPath = path.join(outDir, "context.json");
  await fsp.writeFile(
    contextPath,
    JSON.stringify(
      {
        sourceVideo: videoPath,
        room: context.room,
        title,
        start,
        end,
        duration: end - start,
        framePaths,
        audioPath,
        subtitlePath,
        subtitles: subtitles.filter((cue) => cue.start < end && cue.end > start),
        danmaku
      },
      null,
      2
    ),
    "utf8"
  );

  return {
    ok: true,
    path: outDir,
    framePaths,
    audioPath,
    subtitlePath,
    contextPath
  };
}

async function extractCoverFrame(videoPath, body) {
  assertInsideRecordings(videoPath);
  const at = Math.max(0, Number(body.time ?? body.start ?? 0));
  const title = String(body.title || path.basename(videoPath, path.extname(videoPath)));
  await fsp.mkdir(coversDir, { recursive: true });
  const outPath = path.join(coversDir, `${slugify(title)}_${Math.round(at)}.jpg`);
  await execFileAsync("ffmpeg", ["-y", "-ss", String(at), "-i", videoPath, "-frames:v", "1", "-vf", "scale=1280:-1", "-q:v", "2", outPath], {
    timeout: 30000,
    maxBuffer: 1024 * 1024 * 4
  });
  return {
    ok: true,
    path: outPath,
    mediaUrl: `/api/media?key=${encodeURIComponent(encodeKey(outPath))}`
  };
}

function resolveAsrProviderConfig(asrSettings) {
  const mode = String(asrSettings?.mode || "");
  const provider = String(asrSettings?.provider || "");
  if (mode === "qwen3-local" || provider === "qwen3-asr-gguf") {
    return {
      key: "qwen3-asr-gguf",
      modelId: String(asrSettings?.model || "HaujetZhao/Qwen3-ASR-GGUF"),
      size: String(asrSettings?.modelSize || "0.6B")
    };
  }
  return {
    key: "funasr-nano",
    modelId: String(asrSettings?.model || "FunAudioLLM/Fun-ASR-Nano-2512"),
    size: String(asrSettings?.modelSize || "nano-2512")
  };
}

function resolveBootstrapPython() {
  const py = commandPath("py");
  if (py) return { command: py, args: ["-3"] };
  const python = commandPath("python");
  if (python) return { command: python, args: [] };
  return null;
}

function resolveAsrDevice(value) {
  const desired = String(value || "cpu").toLowerCase();
  const hasCuda = Boolean(commandPath("nvidia-smi"));
  if (desired === "auto") return hasCuda ? "cuda" : "cpu";
  if (desired === "cuda" && !hasCuda) {
    throw new Error("你选了 CUDA，但这台机器当前没有可用的 NVIDIA CUDA 环境。");
  }
  return desired === "cuda" ? "cuda" : "cpu";
}

function isTorchCudaBuild(pythonPath) {
  if (!pythonPath || !fs.existsSync(pythonPath)) return false;
  const result = spawnSync(
    pythonPath,
    ["-c", "import torch; print(torch.version.cuda or '')"],
    { encoding: "utf8", timeout: 15000, env: makeCliEnv() }
  );
  return result.status === 0 && Boolean(String(result.stdout || "").trim());
}

function getTorchRuntimeInfo(pythonPath) {
  if (!pythonPath || !fs.existsSync(pythonPath)) {
    return {
      version: "",
      build: "",
      cudaBuild: false,
      cudaAvailable: false
    };
  }
  const result = spawnSync(
    pythonPath,
    [
      "-c",
      [
        "import json, torch",
        "print(json.dumps({",
        "  'version': getattr(torch, '__version__', ''),",
        "  'build': getattr(getattr(torch, 'version', None), 'cuda', '') or '',",
        "  'cuda_available': bool(torch.cuda.is_available())",
        "}, ensure_ascii=False))"
      ].join("\n")
    ],
    { encoding: "utf8", timeout: 15000, env: makeCliEnv() }
  );
  if (result.status !== 0) {
    return {
      version: "",
      build: "",
      cudaBuild: false,
      cudaAvailable: false
    };
  }
  try {
    const parsed = JSON.parse(String(result.stdout || "{}").trim() || "{}");
    return {
      version: String(parsed.version || ""),
      build: String(parsed.build || ""),
      cudaBuild: Boolean(parsed.build),
      cudaAvailable: Boolean(parsed.cuda_available)
    };
  } catch {
    return {
      version: "",
      build: "",
      cudaBuild: false,
      cudaAvailable: false
    };
  }
}

async function ensureFunAsrRuntime(job, desiredDevice = "cpu") {
  await fsp.mkdir(modelsRoot, { recursive: true });
  await fsp.mkdir(toolsDir, { recursive: true });
  const resolvedDevice = resolveAsrDevice(desiredDevice);
  let pythonPath = getLocalAsrPython();
  if (!pythonPath) {
    const bootstrap = resolveBootstrapPython();
    if (!bootstrap) {
      throw new Error("本机没找到 Python，无法创建本地 ASR 运行环境。");
    }
    job.progress = Math.max(job.progress || 1, 8);
    job.message = "正在创建本地 ASR 虚拟环境";
    await execFileLogged(job, bootstrap.command, [...bootstrap.args, "-m", "venv", asrVenvDir], { timeout: 1000 * 60 * 8 });
    pythonPath = getLocalAsrPython();
  }
  if (!pythonPath) {
    throw new Error("ASR 虚拟环境创建失败，未找到 python.exe。");
  }
  if (!hasPythonPackage("pip")) {
    job.progress = Math.max(job.progress || 1, 15);
    job.message = "正在补齐 pip";
    await execFileLogged(job, pythonPath, ["-m", "ensurepip", "--upgrade"], { timeout: 1000 * 60 * 6 });
  }
  if (!hasPythonPackage("funasr") || !hasPythonPackage("torch") || (resolvedDevice === "cuda" && !isTorchCudaBuild(pythonPath))) {
    job.progress = Math.max(job.progress || 1, 20);
    job.message = resolvedDevice === "cuda" ? "正在安装 CUDA 版 Fun-ASR 依赖" : "正在安装 Fun-ASR 依赖";
    await execFileLogged(job, pythonPath, ["-m", "pip", "install", "--upgrade", "pip", "wheel", "setuptools<82"], { timeout: 1000 * 60 * 12 });
    const torchArgs = resolvedDevice === "cuda"
      ? ["-m", "pip", "install", "--upgrade", "--index-url", "https://download.pytorch.org/whl/cu124", "torch", "torchaudio"]
      : ["-m", "pip", "install", "--upgrade", "--index-url", "https://download.pytorch.org/whl/cpu", "torch", "torchaudio"];
    await execFileLogged(job, pythonPath, torchArgs, { timeout: 1000 * 60 * 30 });
    await execFileLogged(job, pythonPath, ["-m", "pip", "install", "funasr>=1.3.3"], { timeout: 1000 * 60 * 20 });
  }
  return { pythonPath, device: resolvedDevice };
}

async function ensureFunAsrRuntimeGpuAware(job, desiredDevice = "cpu") {
  await fsp.mkdir(modelsRoot, { recursive: true });
  await fsp.mkdir(toolsDir, { recursive: true });
  const resolvedDevice = resolveAsrDevice(desiredDevice);
  let pythonPath = getLocalAsrPython();
  if (!pythonPath) {
    const bootstrap = resolveBootstrapPython();
    if (!bootstrap) {
      throw new Error("本机没找到 Python，无法创建本地 ASR 运行环境。");
    }
    job.progress = Math.max(job.progress || 1, 8);
    job.message = "正在创建本地 ASR 虚拟环境";
    await execFileLogged(job, bootstrap.command, [...bootstrap.args, "-m", "venv", asrVenvDir], { timeout: 1000 * 60 * 8 });
    pythonPath = getLocalAsrPython();
  }
  if (!pythonPath) {
    throw new Error("ASR 虚拟环境创建失败，没找到 python.exe。");
  }
  if (!hasPythonPackage("pip")) {
    job.progress = Math.max(job.progress || 1, 15);
    job.message = "正在补齐 pip";
    await execFileLogged(job, pythonPath, ["-m", "ensurepip", "--upgrade"], { timeout: 1000 * 60 * 6 });
  }

  const torchRuntime = getTorchRuntimeInfo(pythonPath);
  const needsTorchInstall = !hasPythonPackage("torch") || (resolvedDevice === "cuda" && (!torchRuntime.cudaBuild || !torchRuntime.cudaAvailable));
  if (!hasPythonPackage("funasr") || needsTorchInstall) {
    job.progress = Math.max(job.progress || 1, 20);
    job.message = resolvedDevice === "cuda" ? "正在安装 CUDA 版 Fun-ASR 依赖" : "正在安装 Fun-ASR 依赖";
    await execFileLogged(job, pythonPath, ["-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"], { timeout: 1000 * 60 * 12 });

    if (needsTorchInstall && hasPythonPackage("torch")) {
      job.progress = Math.max(job.progress || 1, 28);
      job.message = resolvedDevice === "cuda" ? "正在把 Torch 切到 GPU 版" : "正在重装 Torch";
      await execFileLogged(job, pythonPath, ["-m", "pip", "uninstall", "-y", "torch", "torchaudio", "torchvision"], { timeout: 1000 * 60 * 12 });
    }

    const torchArgs = resolvedDevice === "cuda"
      ? ["-m", "pip", "install", "--upgrade", "--force-reinstall", "--no-cache-dir", "--index-url", "https://download.pytorch.org/whl/cu124", "torch", "torchaudio"]
      : ["-m", "pip", "install", "--upgrade", "--force-reinstall", "--no-cache-dir", "--index-url", "https://download.pytorch.org/whl/cpu", "torch", "torchaudio"];
    await execFileLogged(job, pythonPath, torchArgs, { timeout: 1000 * 60 * 30 });
    await execFileLogged(job, pythonPath, ["-m", "pip", "install", "funasr>=1.3.3"], { timeout: 1000 * 60 * 20 });
  }

  let verifiedTorch = getTorchRuntimeInfo(pythonPath);
  if (resolvedDevice === "cuda" && (!verifiedTorch.cudaBuild || !verifiedTorch.cudaAvailable)) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      verifiedTorch = getTorchRuntimeInfo(pythonPath);
      if (verifiedTorch.cudaBuild && verifiedTorch.cudaAvailable) break;
    }
  }
  if (resolvedDevice === "cuda" && (!verifiedTorch.cudaBuild || !verifiedTorch.cudaAvailable)) {
    const reason = verifiedTorch.version
      ? `当前 torch=${verifiedTorch.version}，build=${verifiedTorch.build || "cpu"}，cuda_available=${verifiedTorch.cudaAvailable}`
      : "当前 Python 没有拿到可用的 CUDA Torch";
    throw new Error(`本地 ASR 还没切到 GPU。${reason}`);
  }
  return { pythonPath, device: resolvedDevice };
}

function getFunAsrEnv() {
  return {
    HF_HOME: path.join(modelsRoot, "hf"),
    MODELSCOPE_CACHE: path.join(modelsRoot, "modelscope")
  };
}

async function prepareAsrProvider(job, asrSettings) {
  const config = resolveAsrProviderConfig(asrSettings);
  if (config.key === "qwen3-asr-gguf") {
    await prepareQwenAsrProvider(job, asrSettings);
    return;
  }
  const runtime = await ensureFunAsrRuntimeGpuAware(job, asrSettings.device || "cpu");
  job.progress = Math.max(job.progress, 55);
  job.message = "正在预下载 Fun-ASR 模型";
  const outPath = path.join(modelAssetsDir, `asr-prepare-${job.id}.json`);
  await runSpawnLogged(
    job,
    runtime.pythonPath,
    [funasrRunnerPath, "prepare", "--output", outPath, "--model-id", config.modelId, "--device", runtime.device],
    {
      timeoutMs: 1000 * 60 * 45,
      env: getFunAsrEnv()
    }
  );
  job.status = "completed";
  job.progress = 100;
  job.message = `本地 ASR 模型已就绪：${config.modelId}`;
  job.outputPath = outPath;
  job.updatedAt = new Date().toISOString();
}

async function prepareQwenAsrProvider(job, asrSettings) {
  job.message = "正在准备 Qwen3-ASR 工具";
  job.progress = Math.max(job.progress || 1, 8);
  await ensureQwenReleaseTool(job);

  job.message = "正在准备 Qwen3-ASR 模型";
  job.progress = Math.max(job.progress, 35);
  const modelDir = await ensureQwenModel(job, asrSettings);

  job.status = "ready";
  job.progress = 100;
  job.message = `Qwen3-ASR 已就绪：${normalizeQwenModelSize(asrSettings?.modelSize)}`;
  job.outputPath = modelDir;
  job.output = getQwenAsrStatus();
  job.updatedAt = new Date().toISOString();
}

async function ensureQwenReleaseTool(job) {
  await fsp.mkdir(downloadsDir, { recursive: true });
  await fsp.mkdir(qwenReleaseDir, { recursive: true });
  if (!fs.existsSync(qwenTranscribeExe)) {
    const zipPath = await ensureDownloadedZip(job, {
      name: qwenReleaseZipName,
      url: qwenReleaseZipUrl,
      minBytes: 90_000_000
    });
    job.message = "正在解压 Qwen3-ASR 工具";
    job.progress = Math.max(job.progress, 20);
    await expandZip(job, zipPath, qwenReleaseDir);
  }
  if (!fs.existsSync(qwenTranscribeExe)) {
    throw new Error(`Qwen3-ASR 工具安装失败，未找到 ${qwenTranscribeExe}`);
  }
  await patchQwenReleaseExporter();
}

async function ensureQwenModel(job, asrSettings) {
  const size = normalizeQwenModelSize(asrSettings?.modelSize);
  const modelDir = resolveQwenModelDir({ modelSize: size }, { allowLegacyFlat: true });
  if (isQwenModelDirReady(modelDir)) {
    await ensureQwenModelAliases(modelDir);
    return modelDir;
  }

  const targetDir = path.join(qwenModelRoot, size);
  await fsp.mkdir(targetDir, { recursive: true });
  const asrAsset = qwenModelAssets[size] || qwenModelAssets["0.6B"];
  const assets = [asrAsset, qwenAlignerAsset];
  for (const asset of assets) {
    job.message = `正在下载 ${asset.name}`;
    job.progress = Math.max(job.progress, asset === asrAsset ? 45 : 65);
    const zipPath = await ensureDownloadedZip(job, asset);
    job.message = `正在解压 ${asset.name}`;
    await expandZip(job, zipPath, targetDir);
  }
  await ensureQwenModelAliases(targetDir);
  if (!isQwenModelDirReady(targetDir)) {
    const missing = getQwenRequiredFiles(targetDir).filter((file) => !fs.existsSync(file)).map((file) => path.basename(file));
    throw new Error(`Qwen3-ASR 模型仍不完整：${missing.join(", ")}`);
  }
  return targetDir;
}

async function ensureDownloadedZip(job, asset) {
  const target = path.join(downloadsDir, asset.name);
  const exists = fs.existsSync(target);
  const okSize = exists && fs.statSync(target).size >= Number(asset.minBytes || 1);
  if (okSize) {
    appendJobLog(job, `[skip] 已有下载文件：${target}\n`);
    return target;
  }
  await fsp.mkdir(downloadsDir, { recursive: true });
  await execFileLogged(
    job,
    "curl.exe",
    ["-L", "--retry", "3", "--retry-delay", "2", "-o", target, asset.url],
    { timeout: 1000 * 60 * 40 }
  );
  if (!fs.existsSync(target) || fs.statSync(target).size < Number(asset.minBytes || 1)) {
    throw new Error(`下载文件不完整：${asset.name}`);
  }
  return target;
}

async function expandZip(job, zipPath, destination) {
  await fsp.mkdir(destination, { recursive: true });
  await execFileLogged(
    job,
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Expand-Archive -Force -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(destination)}`
    ],
    { timeout: 1000 * 60 * 12 }
  );
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function patchQwenReleaseExporter() {
  const exporter = path.join(qwenReleaseRoot, "qwen_asr_gguf", "inference", "exporters.py");
  if (!fs.existsSync(exporter)) return;
  const text = await fsp.readFile(exporter, "utf8");
  const patched = text
    .replaceAll('print(f"✅ 已生成字幕文件: {path}")', 'print(f"已生成字幕文件: {path}")')
    .replaceAll('print(f"✅ 已导出时间戳: {path}")', 'print(f"已导出时间戳: {path}")')
    .replaceAll('print(f"✅ 已保存文本文件: {path}")', 'print(f"已保存文本文件: {path}")');
  if (patched !== text) await fsp.writeFile(exporter, patched, "utf8");
}

async function ensureQwenModelAliases(modelDir) {
  const pairs = [
    ["qwen3_asr_llm.q4_k.gguf", "qwen3_asr_llm.q5_k.gguf"],
    ["qwen3_aligner_llm.q4_k.gguf", "qwen3_aligner_llm.q5_k.gguf"]
  ];
  for (const [sourceName, aliasName] of pairs) {
    const source = path.join(modelDir, sourceName);
    const alias = path.join(modelDir, aliasName);
    if (!fs.existsSync(source) || fs.existsSync(alias)) continue;
    try {
      await fsp.link(source, alias);
    } catch {
      await fsp.copyFile(source, alias);
    }
  }
}

async function runFunAsrLocalJob(job, asrSettings) {
  const config = resolveAsrProviderConfig(asrSettings);
  if (config.key === "qwen3-asr-gguf") {
    throw new Error("Qwen3-ASR-GGUF 请走 Qwen3 外部命令模板；Fun-ASR runner 不负责加载 GGUF。");
  }
  const runtime = await ensureFunAsrRuntimeGpuAware(job, asrSettings.device || "cpu");
  if (asrSettings.autoPrepareModel !== false && !hasDownloadedAsrModel(config)) {
    job.progress = Math.max(job.progress, 45);
    job.message = "正在确认本地 ASR 模型";
    const preparePath = path.join(job.outDir, "prepare.json");
    await runSpawnLogged(
      job,
      runtime.pythonPath,
      [funasrRunnerPath, "prepare", "--output", preparePath, "--model-id", config.modelId, "--device", runtime.device],
      {
        timeoutMs: 1000 * 60 * 45,
        env: getFunAsrEnv()
      }
    );
  }
  job.progress = Math.max(job.progress, 60);
  job.message = "正在运行 Fun-ASR 本地识别";
  const outPath = path.join(job.outDir, "funasr-result.json");
  await runSpawnLogged(
    job,
    runtime.pythonPath,
    [
      funasrRunnerPath,
      "transcribe",
      "--audio",
      job.audioPath,
      "--output",
      outPath,
      "--model-id",
      config.modelId,
      "--device",
      runtime.device,
      "--language",
      asrSettings.language || "zh",
      "--chunk-seconds",
      String(Math.max(0, Number(asrSettings.chunkSeconds || 0)))
    ],
    {
      timeoutMs: 1000 * 60 * 60,
      env: getFunAsrEnv()
    }
  );
  const payload = JSON.parse(await fsp.readFile(outPath, "utf8"));
  const subtitles = normalizeAsrCuesForTimeline(
    Array.isArray(payload.subtitles) ? payload.subtitles : [],
    job.rangeStart,
    job.rangeEnd,
    "funasr"
  );
  job.subtitles = subtitles;
  job.subtitlePath = subtitles.length ? await writeStandaloneSubtitles(job.outDir, subtitles, asrSettings.outputFormat || "srt") : null;
  job.status = "ready";
  job.progress = 100;
  job.message = subtitles.length
    ? `Fun-ASR 完成，识别到 ${subtitles.length} 条字幕。`
    : "Fun-ASR 已完成，但没有生成可用字幕。";
  job.updatedAt = new Date().toISOString();
}

async function runLegacyQwenAsrLocalJob(job, videoPath, asrSettings) {
  const commandTemplate = String(asrSettings.qwenCommand || "").trim();
  if (!commandTemplate) {
    throw new Error("Qwen3-ASR 外部命令为空。请在设置里填 transcribe.py 命令模板。");
  }
  const command = renderCommandTemplate(commandTemplate, {
    audio: job.audioPath,
    outDir: job.outDir,
    video: videoPath,
    srt: job.subtitlePath,
    language: asrSettings.language,
    model: asrSettings.model,
    apiKey: asrSettings.apiKey,
    nCtx: asrSettings.qwenContextTokens || 4096
  });
  job.progress = Math.max(job.progress, 50);
  job.message = "正在运行 Qwen3-ASR 外部命令";
  job.command = command;
  job.updatedAt = new Date().toISOString();

  await runShellCommand(command, job);
  const subtitlePath = findFirstFile(job.outDir, [".srt", ".vtt", ".ass"]) || job.subtitlePath;
  job.subtitlePath = subtitlePath && fs.existsSync(subtitlePath) ? subtitlePath : null;
  job.subtitles = job.subtitlePath
    ? normalizeAsrCuesForTimeline(parseSubtitleFile(job.subtitlePath), job.rangeStart, job.rangeEnd, "qwen3-asr")
    : [];
  if (job.subtitles.length) {
    job.subtitlePath = await writeStandaloneSubtitles(job.outDir, job.subtitles, asrSettings.outputFormat || "srt");
  }
  job.status = "completed";
  job.progress = 100;
  job.message = job.subtitles.length ? `Qwen3-ASR 完成，识别到 ${job.subtitles.length} 条字幕。` : "Qwen3-ASR 命令完成，但未在输出目录找到字幕文件。";
  job.updatedAt = new Date().toISOString();
}

async function runQwenAsrLocalJob(job, videoPath, asrSettings) {
  if (asrSettings.autoPrepareModel !== false) {
    await ensureQwenReleaseTool(job);
    await ensureQwenModel(job, asrSettings);
  }

  const modelDir = resolveQwenModelDir(asrSettings, { allowLegacyFlat: true });
  if (fs.existsSync(qwenTranscribeExe) && isQwenModelDirReady(modelDir)) {
    await patchQwenReleaseExporter();
    const args = [
      job.audioPath,
      "--model-dir",
      modelDir,
      "--prec",
      "int4",
      "--chunk-size",
      String(Math.max(15, Math.min(300, Number(asrSettings.chunkSeconds || 40)))),
      "--n-ctx",
      String(Math.max(1024, Math.min(8192, Number(asrSettings.qwenContextTokens || 4096)))),
      "--quiet",
      "-y"
    ];
    const language = mapQwenLanguage(asrSettings.language);
    if (language) args.push("--language", language);
    if (String(asrSettings.device || "auto").toLowerCase() === "cpu") {
      args.push("--no-dml", "--no-vulkan");
    }
    job.progress = Math.max(job.progress, 55);
    job.message = "正在运行 Qwen3-ASR 本地识别";
    await runSpawnLogged(job, qwenTranscribeExe, args, {
      timeoutMs: 1000 * 60 * 90,
      cwd: job.outDir,
      outputEncoding: "gb18030",
      env: {
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1"
      }
    });
    const subtitlePath = findFirstNamedFile(job.outDir, ["audio.srt", "result.srt"]) || findFirstFile(job.outDir, [".srt", ".vtt", ".ass"]);
    job.subtitlePath = subtitlePath && fs.existsSync(subtitlePath) ? subtitlePath : null;
    job.subtitles = job.subtitlePath
      ? normalizeAsrCuesForTimeline(parseSubtitleFile(job.subtitlePath), job.rangeStart, job.rangeEnd, "qwen3-asr")
      : [];
    if (job.subtitles.length) {
      job.subtitlePath = await writeStandaloneSubtitles(job.outDir, job.subtitles, asrSettings.outputFormat || "srt");
    }
    job.status = "completed";
    job.progress = 100;
    job.message = job.subtitles.length
      ? `Qwen3-ASR 完成，识别到 ${job.subtitles.length} 条字幕。`
      : "Qwen3-ASR 完成，但没有生成可用字幕；可查看任务日志和 audio.txt。";
    job.updatedAt = new Date().toISOString();
    return;
  }

  await runLegacyQwenAsrLocalJob(job, videoPath, asrSettings);
}

function mapQwenLanguage(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.toLowerCase() === "auto") return "";
  const lower = raw.toLowerCase();
  if (["zh", "zh-cn", "cn", "chinese", "中文", "汉语"].includes(lower)) return "Chinese";
  if (["en", "english", "英文"].includes(lower)) return "English";
  if (["ja", "jp", "japanese", "日语"].includes(lower)) return "Japanese";
  if (["ko", "kr", "korean", "韩语"].includes(lower)) return "Korean";
  return raw;
}

function findFirstNamedFile(root, names) {
  for (const name of names) {
    const file = path.join(root, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

async function startAsrJob(videoPath, body) {
  assertInsideRecordings(videoPath);
  const baseSettings = await readServiceSettings();
  const settings = body.asrOverride
    ? { ...baseSettings, asr: normalizeServiceSettings({ asr: { ...baseSettings.asr, ...body.asrOverride } }).asr }
    : baseSettings;
  const start = Math.max(0, Number(body.start || 0));
  const requestedEnd = Number(body.end || 0);
  const media = await getMediaMetadata(videoPath);
  const end = requestedEnd > start ? requestedEnd : Math.max(start + 1, media.duration || start + 600);
  const id = crypto.createHash("sha1").update(`${videoPath}:${start}:${end}:${Date.now()}`).digest("hex").slice(0, 16);
  const outDir = path.join(asrDir, id);
  await fsp.mkdir(outDir, { recursive: true });

  const job = {
    id,
    status: "running",
    progress: 1,
    message: "正在提取 16k 单声道音频",
    log: "",
    outDir,
    audioPath: path.join(outDir, "audio.wav"),
    subtitlePath: path.join(outDir, "result.srt"),
    subtitles: [],
    rangeStart: start,
    rangeEnd: end,
    timebase: "global",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  asrJobs.set(id, job);

  void runAsrJob(job, videoPath, start, end, settings).catch((error) => {
    job.status = "error";
    job.progress = 0;
    job.message = readableError(error);
    job.updatedAt = new Date().toISOString();
  });

  return publicJob(job);
}

async function runAsrJob(job, videoPath, start, end, settings) {
  await extractAudioSegment(videoPath, job.audioPath, start, end);
  job.progress = 35;
  job.message = "音频已提取";
  job.updatedAt = new Date().toISOString();

  if (settings.asr.mode === "cloud-endpoint") {
    if (!settings.asr.endpoint) {
      throw new Error("ASR 云端接口模式需要先配置 endpoint。");
    }
    job.progress = 45;
    job.message = "正在调用云端 ASR 接口";
    appendJobLog(job, `POST ${settings.asr.endpoint}\n`);
    const audioBase64 = (await fsp.readFile(job.audioPath)).toString("base64");
    const response = await callJsonEndpoint(
      { endpoint: settings.asr.endpoint, apiKey: settings.asr.apiKey, provider: settings.asr.provider },
      {
        task: "asr",
        model: settings.asr.model,
        language: settings.asr.language,
        outputFormat: settings.asr.outputFormat,
        audio: {
          path: job.audioPath,
          mimeType: "audio/wav",
          base64: audioBase64
        },
        instruction: "识别音频并返回字幕。支持返回 {subtitles:[{start,end,text}]}、{segments:[{start,end,text}]} 或 {text}。"
      }
    );
    job.subtitles = normalizeAsrCuesForTimeline(parseAsrEndpointResponse(response, end - start), start, end, "cloud-asr");
    job.subtitlePath = job.subtitles.length ? await writeStandaloneSubtitles(job.outDir, job.subtitles, settings.asr.outputFormat) : null;
    job.status = "ready";
    job.progress = 100;
    job.message = job.subtitles.length ? `云端 ASR 完成，识别到 ${job.subtitles.length} 条字幕。` : "云端 ASR 完成，但返回内容里没有字幕。";
    appendJobLog(job, `${JSON.stringify({ subtitles: job.subtitles.slice(0, 20), total: job.subtitles.length }, null, 2)}\n`);
    job.updatedAt = new Date().toISOString();
    return;
  }

  if (settings.asr.mode === "qwen3-local" || settings.asr.provider === "qwen3-asr-gguf") {
    await runQwenAsrLocalJob(job, videoPath, settings.asr);
    return;
  }

  if (settings.asr.mode === "funasr-local" || settings.asr.provider === "funasr-nano") {
    await runFunAsrLocalJob(job, settings.asr);
    return;
  }

  if (settings.asr.mode !== "local-command") {
    job.status = "ready";
    job.progress = 100;
    job.subtitlePath = null;
    job.message = "音频已提取；当前模式只抽音频，没有继续做字幕识别。";
    job.updatedAt = new Date().toISOString();
    return;
  }

  const command = renderCommandTemplate(settings.asr.localCommand, {
    audio: job.audioPath,
    outDir: job.outDir,
    video: videoPath,
    srt: job.subtitlePath,
    language: settings.asr.language,
    model: settings.asr.model,
    apiKey: settings.asr.apiKey
  });
  job.message = "正在运行本地 ASR 命令";
  job.command = command;
  job.updatedAt = new Date().toISOString();

  await runShellCommand(command, job);
  const subtitlePath = findFirstFile(job.outDir, [".srt", ".vtt", ".ass"]) || job.subtitlePath;
  job.subtitlePath = subtitlePath && fs.existsSync(subtitlePath) ? subtitlePath : null;
  job.subtitles = job.subtitlePath ? normalizeAsrCuesForTimeline(parseSubtitleFile(job.subtitlePath), start, end, "local-command-asr") : [];
  if (job.subtitles.length) {
    job.subtitlePath = await writeStandaloneSubtitles(job.outDir, job.subtitles, settings.asr.outputFormat || "srt");
  }
  job.status = "completed";
  job.progress = 100;
  job.message = job.subtitles.length ? `ASR 完成，识别到 ${job.subtitles.length} 条字幕。` : "ASR 命令完成，但未在输出目录找到字幕文件。";
  job.updatedAt = new Date().toISOString();
}

function parseAsrEndpointResponse(response, duration) {
  const cues = response?.subtitles || response?.segments || response?.data?.subtitles || response?.data?.segments || [];
  if (Array.isArray(cues) && cues.length) {
    return normalizeOptionSubtitles(cues).map((cue, index) => ({
      ...cue,
      id: cue.id || `cloud-asr-${index + 1}`,
      source: cue.source || "cloud-asr"
    }));
  }
  const text = String(response?.text || response?.data?.text || response?.choices?.[0]?.message?.content || "").trim();
  if (!text) return [];
  return [
    {
      id: "cloud-asr-1",
      start: 0,
      end: Math.max(1, Number(duration || 1)),
      text,
      source: "cloud-asr"
    }
  ];
}

export function normalizeAsrCuesForTimeline(cues, segmentStart = 0, segmentEnd = null, source = "asr") {
  const normalized = normalizeOptionSubtitles(Array.isArray(cues) ? cues : []);
  const start = Math.max(0, Number(segmentStart || 0));
  const end = Number(segmentEnd || 0);
  const duration = end > start ? end - start : 0;
  const shouldOffset = shouldOffsetSegmentLocalCues(normalized, start, duration);
  return normalized.map((cue, index) => ({
    ...cue,
    id: cue.id || `${source}-${index + 1}`,
    start: roundTime((shouldOffset ? start : 0) + cue.start),
    end: roundTime((shouldOffset ? start : 0) + cue.end),
    source: cue.source || source,
    timebase: "global",
    originalTimebase: shouldOffset ? "segment" : "global"
  }));
}

function shouldOffsetSegmentLocalCues(cues, segmentStart, segmentDuration) {
  if (!cues.length || segmentStart <= 0 || segmentDuration <= 0) return false;
  const minStart = Math.min(...cues.map((cue) => Number(cue.start || 0)));
  const maxEnd = Math.max(...cues.map((cue) => Number(cue.end || 0)));
  if (minStart >= segmentStart - 1) return false;
  return maxEnd <= segmentDuration + 2;
}

async function writeStandaloneSubtitles(outDir, cues, outputFormat = "srt") {
  const extension = String(outputFormat || "srt").toLowerCase() === "vtt" ? ".vtt" : ".srt";
  const file = path.join(outDir, `result${extension}`);
  const body = extension === ".vtt"
    ? `WEBVTT\n\n${cues.map((cue, index) => `${index + 1}\n${formatVttTime(cue.start)} --> ${formatVttTime(cue.end)}\n${cleanText(cue.text)}\n`).join("\n")}`
    : cues.map((cue, index) => [String(index + 1), `${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}`, cleanText(cue.text), ""].join("\n")).join("\n");
  await fsp.writeFile(file, body, "utf8");
  return file;
}

async function extractAudioSegment(videoPath, outPath, start, end) {
  await execFfmpeg(
    ["-y", "-ss", String(start), "-to", String(end), "-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", outPath],
    { timeout: 1000 * 60 * 20, maxBuffer: 1024 * 1024 * 8 }
  );
}

function renderCommandTemplate(template, values) {
  return String(template || "").replace(/\{(audio|outDir|video|srt|language|model|apiKey|nCtx)\}/g, (_match, key) => values[key]);
}

function runShellCommand(command, job) {
  return new Promise((resolve, reject) => {
    if (!command.trim()) {
      reject(new Error("ASR 本地命令为空。"));
      return;
    }
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
      cwd: job.outDir,
      windowsHide: true
    });
    job.childPid = child.pid;
    const appendLog = (chunk) => {
      job.log = `${job.log}${chunk.toString("utf8")}`.slice(-12000);
      job.updatedAt = new Date().toISOString();
    };
    child.stdout.on("data", appendLog);
    child.stderr.on("data", appendLog);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ASR 命令退出码 ${code}`));
      }
    });
  });
}

function findFirstFile(root, extensions) {
  if (!fs.existsSync(root)) return null;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      if (entry.isFile() && extensions.includes(path.extname(entry.name).toLowerCase())) return fullPath;
    }
  }
  return null;
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    message: job.message,
    outDir: job.outDir,
    audioPath: job.audioPath,
    subtitlePath: job.subtitlePath,
    subtitles: job.subtitles,
    rangeStart: job.rangeStart ?? 0,
    rangeEnd: job.rangeEnd ?? null,
    timebase: job.timebase || "global",
    log: job.log,
    command: job.command,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt
  };
}

function createModelJob(type, message) {
  const id = crypto.createHash("sha1").update(`${type}:${Date.now()}:${Math.random()}`).digest("hex").slice(0, 16);
  const job = {
    id,
    type,
    status: "running",
    progress: 1,
    message,
    log: "",
    command: "",
    outputPath: null,
    output: null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  modelJobs.set(id, job);
  return job;
}

function publicModelJob(job) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.progress,
    message: job.message,
    log: job.log,
    command: job.command,
    outputPath: job.outputPath,
    output: job.output,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt
  };
}

function listWorkbenchTasks() {
  const fixedRoomsById = new Map(readFixedRoomsSync().map((room) => [room.roomId, room]));
  const tasks = [
    ...[...recordingJobs.values()].map((job) => normalizeTask("recording", "Recording tool", publicRecordingJob(job))),
    ...[...recordingRoomStatuses.values()].map((status) => normalizeTask("recording", recordingTaskLabel(status, fixedRoomsById.get(String(status.roomId))), {
      id: `recording-room-${status.roomId}`,
      type: "recording-room",
      status: recordingTaskStatus(status),
      progress: recordingTaskProgress(status),
      message: status.message,
      log: status.log,
      outputPath: status.recordingPath || status.danmakuPath || null,
      bytesWritten: status.bytesWritten,
      speedBytesPerSecond: status.speedBytesPerSecond,
      averageSpeedBytesPerSecond: status.averageSpeedBytesPerSecond,
      elapsedSeconds: status.elapsedSeconds,
      staleSeconds: status.staleSeconds,
      stalled: status.stalled,
      danmakuCount: status.danmakuCount,
      updatedAt: status.updatedAt
    })),
    ...[...uploadJobs.values()].map((job) => normalizeTask("upload", "??/??", publicUploadJob(job))),
    ...[...asrJobs.values()].map((job) => normalizeTask("asr", "ASR 字幕", publicJob(job), {
      type: "asr",
      outputPath: job.subtitlePath || job.audioPath,
      startedAt: job.startedAt || null
    })),
    ...[...transcodeJobs.values()].map((job) => normalizeTask("transcode", "FLV 转 MP4", publicTranscodeJob(job))),
    ...[...previewJobs.entries()].map(([id, job]) => normalizeTask("preview", "本地预览", {
      id,
      type: "preview",
      status: job.status,
      progress: job.progress,
      message: job.message,
      log: job.log || "",
      command: job.command || "",
      outputPath: job.outputPath || null,
      startedAt: job.startedAt || null,
      updatedAt: job.updatedAt
    })),
    ...[...modelJobs.values()].map((job) => normalizeTask("model", modelJobLabel(job.type), publicModelJob(job)))
  ];
  return tasks.sort((a, b) => Date.parse(b.updatedAt || b.startedAt || "") - Date.parse(a.updatedAt || a.startedAt || ""));
}

function recordingTaskLabel(status = {}, room = null) {
  const roomId = String(status.roomId || room?.roomId || "").trim();
  const candidates = [room?.name, room?.title, room?.anchorName]
    .map((value) => String(value || "").trim())
    .filter((value) => value && !isDefaultFixedRoomName(value, roomId));
  const name = candidates[0] || "";
  return name && roomId ? `${name}（${roomId}）` : `房间 ${roomId || "未知"}`;
}

function recordingTaskStatus(status = {}) {
  if (status.taskStatus === "error") return "error";
  if (["recording", "starting", "finalizing", "waiting"].includes(status.taskStatus)) return "running";
  return "ready";
}

function recordingTaskProgress(status = {}) {
  if (status.taskStatus === "completed") return 100;
  if (status.taskStatus === "error") return 0;
  if (status.taskStatus === "recording" || (status.taskStatus === "waiting" && (status.stalled || status.bytesWritten))) {
    const seconds = Number(status.elapsedSeconds || 0);
    // Live streams do not have a finite percent. This keeps the bar moving enough to show life without pretending to know an ETA.
    return Math.max(8, Math.min(95, Math.round(8 + seconds / 12)));
  }
  if (status.taskStatus === "finalizing") return 96;
  if (status.taskStatus === "starting") return 6;
  if (status.taskStatus === "waiting") return 3;
  return 0;
}

function modelJobLabel(type) {
  if (type === "cover-generate") return "封面生成";
  if (type === "title-generate") return "标题生成";
  if (type === "asr-prepare") return "ASR 模型准备";
  return "模型任务";
}

function normalizeTask(source, label, job, patch = {}) {
  return {
    id: job.id,
    source,
    type: job.type || patch.type || source,
    label,
    status: job.status,
    progress: Number(job.progress || 0),
    message: job.message || "",
    log: job.log || "",
    command: job.command || "",
    outputPath: job.outputPath || patch.outputPath || null,
    bytesWritten: Number(job.bytesWritten || patch.bytesWritten || 0),
    speedBytesPerSecond: Number(job.speedBytesPerSecond || patch.speedBytesPerSecond || 0),
    averageSpeedBytesPerSecond: Number(job.averageSpeedBytesPerSecond || patch.averageSpeedBytesPerSecond || 0),
    elapsedSeconds: Number(job.elapsedSeconds || patch.elapsedSeconds || 0),
    staleSeconds: Number(job.staleSeconds || patch.staleSeconds || 0),
    stalled: Boolean(job.stalled || patch.stalled),
    danmakuCount: Number(job.danmakuCount || patch.danmakuCount || 0),
    startedAt: job.startedAt || patch.startedAt || null,
    updatedAt: job.updatedAt || null
  };
}

async function runFlvConvertJob(job, settings, roomPath = null, selectedVideoPaths = []) {
  const roots = roomPath ? [roomPath] : [getRecordingsRoot()];
  if (!roots[0]) {
    throw new Error("未设置录制素材目录。请先在设置页填写录制输出目录。");
  }
  const flvFiles = selectedVideoPaths.length
    ? dedupeVideoFiles(selectedVideoPaths.map((file) => {
        assertInsideRecordings(file);
        return file;
      }).filter((file) => path.extname(file).toLowerCase() === ".flv"))
    : dedupeVideoFiles(
        roots.flatMap((root) => collectFiles(root, roomPath ? 4 : 5)).filter((file) => path.extname(file).toLowerCase() === ".flv")
      );
  if (!flvFiles.length) {
    job.status = "ready";
    job.progress = 100;
    job.message = "没有找到需要转换的 FLV 文件。";
    job.updatedAt = new Date().toISOString();
    return;
  }

  let converted = 0;
  for (const file of flvFiles) {
    const target = getFlvTargetPath(file, settings.media);
    if (settings.media.skipIfMp4Exists !== false && fs.existsSync(target)) {
      appendJobLog(job, `[skip] ${target}\n`);
      converted += 1;
      job.progress = Math.max(5, Math.round((converted / flvFiles.length) * 100));
      job.message = `已跳过已存在的 MP4（${converted}/${flvFiles.length}）`;
      job.outputPath = target;
      job.updatedAt = new Date().toISOString();
      continue;
    }
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const args = buildFlvConvertArgs(file, target, settings.media);
    job.progress = Math.max(5, Math.round((converted / flvFiles.length) * 100));
    job.message = `正在转换 ${path.basename(file)}（${converted + 1}/${flvFiles.length}）`;
    job.outputPath = target;
    await runFfmpegSpawnLogged(job, args, { timeoutMs: 1000 * 60 * 60 * 4 });
    if (settings.media.deleteSourceAfterConvert && fs.existsSync(target)) {
      await fsp.rm(file, { force: true });
      appendJobLog(job, `[delete] ${file}\n`);
    }
    converted += 1;
    job.progress = Math.max(5, Math.round((converted / flvFiles.length) * 100));
    job.updatedAt = new Date().toISOString();
  }

  job.status = "ready";
  job.progress = 100;
  job.message = `FLV 转 MP4 完成，共处理 ${flvFiles.length} 个文件。`;
  job.updatedAt = new Date().toISOString();
}

async function getPreviewStatus(videoPath) {
  assertInsideRecordings(videoPath);
  const info = getPreviewInfo(videoPath);
  const job = previewJobs.get(info.id);
  if (job && job.status === "running") {
    return {
      status: job.status,
      progress: job.progress,
      path: null,
      mediaUrl: null,
      message: job.message,
      updatedAt: job.updatedAt
    };
  }

  const stat = safeStat(info.outPath);
  if (stat && stat.size > 0) {
    const media = await getMediaMetadata(info.outPath);
    if (Number(media.duration || 0) > 0) {
      return {
        status: "ready",
        progress: 100,
        path: info.outPath,
        mediaUrl: `/api/media?key=${encodeURIComponent(encodeKey(info.outPath))}`,
        message: "预览已生成",
        updatedAt: stat.mtime.toISOString()
      };
    }
    return {
      status: "error",
      progress: 0,
      path: null,
      mediaUrl: null,
      message: "预览文件不完整，请重新生成。",
      updatedAt: stat.mtime.toISOString()
    };
  }

  if (job) {
    return {
      status: job.status,
      progress: job.progress,
      path: job.status === "ready" ? info.outPath : null,
      mediaUrl: job.status === "ready" ? `/api/media?key=${encodeURIComponent(encodeKey(info.outPath))}` : null,
      message: job.message,
      updatedAt: job.updatedAt
    };
  }

  return {
    status: "idle",
    progress: 0,
    path: null,
    mediaUrl: null,
    message: "尚未生成本地 MP4 预览",
    updatedAt: null
  };
}

async function startPreviewJob(videoPath) {
  assertInsideRecordings(videoPath);
  const info = getPreviewInfo(videoPath);
  const current = await getPreviewStatus(videoPath);
  if (current.status === "ready" || current.status === "running") {
    return current;
  }

  await fsp.mkdir(info.outDir, { recursive: true });
  const media = await getMediaMetadata(videoPath);
  const duration = Math.max(1, Number(media.duration || 0));
  const job = {
    id: info.id,
    type: "preview",
    status: "running",
    progress: 1,
    message: "正在快速封装 MP4 预览",
    log: "",
    command: "",
    outputPath: info.outPath,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  previewJobs.set(info.id, job);

  launchPreviewAttempt(job, videoPath, info, duration, "copy");

  return getPreviewStatus(videoPath);
}

function previewArgs(videoPath, outPath, mode) {
  if (mode === "copy") {
    return [
      "-y",
      "-i",
      videoPath,
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      outPath
    ];
  }
  return [
    "-y",
    "-i",
    videoPath,
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    "-vf",
    "scale='min(1280,iw)':-2",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "28",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    outPath
  ];
}

function launchPreviewAttempt(job, videoPath, info, duration, mode) {
  if (fs.existsSync(info.outPath)) {
    fs.rmSync(info.outPath, { force: true });
  }
  const args = previewArgs(videoPath, info.outPath, mode);
  const invocation = getFfmpegInvocation(args);
  const command = [invocation.command, ...invocation.args].map(quoteArg).join(" ");
  job.command = command;
  job.log = `${job.log}${job.log ? "\n" : ""}> ${command}\n`;
  job.message = mode === "copy" ? "正在快速封装 MP4 预览" : "快速封装失败，正在兼容转码预览";
  job.updatedAt = new Date().toISOString();

  const child = spawn(invocation.command, invocation.args, { windowsHide: true, env: makeCliEnv() });
  job.childPid = child.pid;

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    job.log = `${job.log}${text}`.slice(-12000);
    const match = text.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!match) return;
    const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    job.progress = Math.max(job.progress, Math.min(99, Math.round((seconds / duration) * 100)));
    job.message = mode === "copy" ? `正在快速封装 ${job.progress}%` : `正在兼容转码 ${job.progress}%`;
    job.updatedAt = new Date().toISOString();
  });

  child.on("error", (error) => {
    if (mode === "copy") {
      job.log = `${job.log}\n[workbench] 快速封装启动失败，降级兼容转码：${readableError(error)}\n`;
      launchPreviewAttempt(job, videoPath, info, duration, "transcode");
      return;
    }
    job.status = "error";
    job.progress = 0;
    job.message = readableError(error);
    job.updatedAt = new Date().toISOString();
  });

  child.on("close", (code) => {
    void (async () => {
      const stat = safeStat(info.outPath);
      const media = stat && stat.size > 0 ? await getMediaMetadata(info.outPath) : null;
      if (code === 0 && stat && stat.size > 0 && Number(media?.duration || 0) > 0) {
        job.status = "ready";
        job.progress = 100;
        job.message = mode === "copy" ? "预览已快速生成" : "预览已生成";
      } else if (mode === "copy") {
        job.log = `${job.log}\n[workbench] 快速封装失败，降级兼容转码。\n`;
        launchPreviewAttempt(job, videoPath, info, duration, "transcode");
        return;
      } else {
        job.status = "error";
        job.progress = 0;
        job.message = code === 0 ? "ffmpeg 输出的预览文件不完整。" : `ffmpeg 退出码 ${code ?? "unknown"}`;
        if (fs.existsSync(info.outPath)) {
          fs.rmSync(info.outPath, { force: true });
        }
      }
      job.updatedAt = new Date().toISOString();
    })();
  });
}

function getPreviewInfo(videoPath) {
  const stat = safeStat(videoPath);
  const id = crypto
    .createHash("sha1")
    .update(`${path.resolve(videoPath)}:${stat?.mtimeMs || 0}:${stat?.size || 0}:preview-v1`)
    .digest("hex");
  const outDir = path.join(previewsDir, id);
  const outPath = path.join(outDir, `${slugify(path.basename(videoPath, path.extname(videoPath)))}_preview.mp4`);
  return { id, outDir, outPath };
}

async function ensureThumbnail(videoPath) {
  assertInsideRecordings(videoPath);
  const stat = safeStat(videoPath);
  const hash = crypto.createHash("sha1").update(`${videoPath}:${stat?.mtimeMs || 0}:${stat?.size || 0}`).digest("hex");
  const thumbPath = path.join(thumbsDir, `${hash}.jpg`);
  if (fs.existsSync(thumbPath)) {
    return thumbPath;
  }
  try {
    await execFileAsync(
      "ffmpeg",
      ["-y", "-ss", "00:00:05", "-i", videoPath, "-frames:v", "1", "-vf", "scale=640:-1", "-q:v", "4", thumbPath],
      { timeout: 30000, maxBuffer: 1024 * 1024 * 4 }
    );
    return fs.existsSync(thumbPath) ? thumbPath : null;
  } catch {
    return null;
  }
}

async function streamMedia(req, res, filePath) {
  assertAllowedFile(filePath);
  const stat = await fsp.stat(filePath);
  const contentType = mime.lookup(filePath) || "application/octet-stream";
  const range = req.headers.range;
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", contentType);
  if (!range) {
    res.setHeader("Content-Length", stat.size);
    fs.createReadStream(filePath).pipe(res);
    return;
  }
  const match = String(range).match(/bytes=(\d*)-(\d*)/);
  const start = match?.[1] ? Number(match[1]) : 0;
  const end = match?.[2] ? Number(match[2]) : stat.size - 1;
  const safeStart = clamp(start, 0, stat.size - 1);
  const safeEnd = clamp(end, safeStart, stat.size - 1);
  res.status(206);
  res.setHeader("Content-Range", `bytes ${safeStart}-${safeEnd}/${stat.size}`);
  res.setHeader("Content-Length", safeEnd - safeStart + 1);
  fs.createReadStream(filePath, { start: safeStart, end: safeEnd }).pipe(res);
}

function collectFiles(root, maxDepth, depth = 0) {
  if (depth > maxDepth || !fs.existsSync(root)) return [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath, maxDepth, depth + 1));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function findCompanionFile(videoPath, files, extension) {
  const normalizedBase = normalizeBase(path.basename(videoPath, path.extname(videoPath)));
  return files.find((file) => path.extname(file).toLowerCase() === extension && normalizeBase(path.basename(file, path.extname(file))) === normalizedBase)
    || files.find((file) => normalizeBase(path.basename(file, path.extname(file))).startsWith(normalizedBase) || normalizedBase.startsWith(normalizeBase(path.basename(file, path.extname(file)))))
    || null;
}

function findCompanionFiles(videoPath, files) {
  const normalizedBase = normalizeBase(path.basename(videoPath, path.extname(videoPath)));
  return files.filter((file) => {
    const base = normalizeBase(path.basename(file, path.extname(file)));
    return base === normalizedBase || base.startsWith(normalizedBase) || normalizedBase.startsWith(base);
  });
}

function normalizeBase(base) {
  return base.replace(/_cmp$/i, "").replace(/_compressed$/i, "");
}

function parseRoomName(folderName, files = [], roomPath = null) {
  const metadata = roomPath ? readRecordingRoomInfo(roomPath) : null;
  const match = String(folderName || "").match(/^(\d+)\s*-\s*(.+)$/);
  const fileRoomId = inferRoomIdFromFiles(files);
  return {
    roomId: normalizeRoomId(metadata?.roomId || match?.[1] || fileRoomId || ""),
    name: String(metadata?.title || match?.[2] || folderName || "")
  };
}

function inferRoomIdFromFiles(files = []) {
  for (const file of files) {
    const base = path.basename(String(file || ""));
    const internalMatch = base.match(/(?:^|_)(\d+)_internal(?:[_.]|$)/);
    if (internalMatch?.[1]) return internalMatch[1];
    const longMatch = base.match(/(?:^|_)(\d{5,})(?:_|\.|$)/);
    if (longMatch?.[1]) return longMatch[1];
  }
  return "";
}

function readRecordingRoomInfo(roomPath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(roomPath, ".room.json"), "utf8"));
  } catch {
    return null;
  }
}

async function writeRecordingRoomInfo(roomDir, info) {
  await fsp.writeFile(path.join(roomDir, ".room.json"), JSON.stringify(info, null, 2), "utf8");
}

function findRoomPath(filePath) {
  const recordingsRoot = getRecordingsRoot();
  if (!recordingsRoot) {
    throw new Error("未设置录制素材目录。");
  }
  const resolved = path.resolve(filePath);
  const relative = path.relative(recordingsRoot, resolved);
  const first = relative.split(path.sep)[0];
  return path.join(recordingsRoot, first);
}

function isBrowserPlayable(filePath) {
  return [".mp4", ".mov"].includes(path.extname(filePath).toLowerCase());
}

function getProjectPath(videoPath) {
  const hash = crypto.createHash("sha1").update(path.resolve(videoPath)).digest("hex");
  return path.join(projectsDir, `${hash}.json`);
}

function makeFallbackCover(label) {
  const safeLabel = escapeXml(label.slice(0, 24));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="#20242b"/><rect x="24" y="24" width="592" height="312" fill="#2b313a" stroke="#4b5563"/><text x="40" y="190" fill="#f4f7fb" font-family="Arial, sans-serif" font-size="28">${safeLabel}</text></svg>`;
}

function encodeKey(filePath) {
  return Buffer.from(path.resolve(filePath), "utf8").toString("base64url");
}

function decodeAllowedKey(key) {
  const decoded = path.resolve(Buffer.from(String(key), "base64url").toString("utf8"));
  assertAllowedFile(decoded);
  return decoded;
}

function assertAllowedFile(filePath) {
  const resolved = path.resolve(filePath);
  const allowedRoots = [getRecordingsRoot(), workbenchRoot].filter(Boolean);
  if (!allowedRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
    throw new Error("Path is outside allowed workspace roots.");
  }
}

function assertInsideRecordings(filePath) {
  const recordingsRoot = getRecordingsRoot();
  if (!recordingsRoot) {
    throw new Error("未设置录制素材目录。请先在设置页填写录制输出目录。");
  }
  const resolved = path.resolve(filePath);
  if (!(resolved === recordingsRoot || resolved.startsWith(`${recordingsRoot}${path.sep}`))) {
    throw new Error("Path is outside recordings root.");
  }
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function cleanText(text) {
  return String(text || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeXml(text) {
  return String(text).replace(/[<>&'"]/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[char]);
}

function readableError(error) {
  return error instanceof Error ? error.message : String(error);
}

function readableVisionError(error) {
  const raw = readableError(error);
  const payload = parseErrorPayload(raw);
  const payloadText = payload ? JSON.stringify(payload) : "";
  const text = `${raw}\n${payloadText}`;
  const providerCode = payload?.error?.code || payload?.code || null;
  const providerMessage = payload?.error?.message || payload?.message || payload?.error || "";
  if (/get_channel_failed|负载已经达到上限|overloaded|capacity/i.test(text)) {
    return {
      kind: "provider-overloaded",
      message: "模型通道当前满载，稍后重试或临时换模型；AI 切片不会用本地规则冒充候选。",
      providerCode,
      providerMessage,
      raw: raw.slice(0, 1200)
    };
  }
  if (/invalid_responses_request|invalid codex request/i.test(text)) {
    return {
      kind: "invalid-responses-request",
      message: "模型网关不接受当前 Responses 请求格式；请切换 wire_api 或换支持标准 Responses 的模型。",
      providerCode,
      providerMessage,
      raw: raw.slice(0, 1200)
    };
  }
  if (/image_url|input_image|multimodal|vision|invalid_value|bad response status code 400/i.test(text)) {
    return {
      kind: "image-input-unsupported",
      message: "模型网关不接受图片输入；AI 切片会先尝试多模态，失败时改用同一模型的文本信号重试，不会用本地规则冒充候选。",
      providerCode,
      providerMessage,
      raw: raw.slice(0, 1200)
    };
  }
  if (/fetch failed|ENOTFOUND|ETIMEDOUT|ECONNRESET|network|TLS handshake timeout|EOF/i.test(text)) {
    return {
      kind: "network",
      message: "模型接口暂时连不上；请检查 endpoint、网络或网关状态；AI 切片不会用本地规则冒充候选。",
      providerCode,
      providerMessage,
      raw: raw.slice(0, 1200)
    };
  }
  return {
    kind: "unknown",
    message: providerMessage || raw || "视频理解接口测试失败。",
    providerCode,
    providerMessage,
    raw: raw.slice(0, 1200)
  };
}

function parseErrorPayload(text) {
  const value = String(text || "").trim();
  if (!value || !/^[\[{]/.test(value)) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return "0 KB";
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(value / 1024))} KB`;
}

function maxCueEnd(cues) {
  return cues.reduce((max, cue) => Math.max(max, cue.end || 0), 0);
}

function overlapsEnough(a, b) {
  const overlap = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  return overlap > Math.min(a.end - a.start, b.end - b.start) * 0.45;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function slugify(value) {
  return String(value || "clip")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80);
}

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function formatSrtTime(seconds) {
  const totalMillis = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMillis / 3_600_000);
  const minutes = Math.floor((totalMillis % 3_600_000) / 60_000);
  const secs = Math.floor((totalMillis % 60_000) / 1000);
  const millis = totalMillis % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

function formatVttTime(seconds) {
  return formatSrtTime(seconds).replace(",", ".");
}
