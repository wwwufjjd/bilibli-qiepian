import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import express from "express";
import { XMLParser } from "fast-xml-parser";
import mime from "mime-types";

const execFileAsync = promisify(execFile);

const defaultRecordingsRoot = "";
const workbenchRoot = path.resolve(process.cwd(), ".workbench");
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
      asrTools: getLocalAsrStatus()
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

  router.post("/service-settings", async (req, res) => {
    try {
      const settings = normalizeServiceSettings(req.body);
      await fsp.writeFile(serviceSettingsPath, JSON.stringify(settings, null, 2), "utf8");
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
        model: settings.vision.model,
        response
      });
    } catch (error) {
      res.status(500).json({ error: readableError(error) });
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
      const candidates = await enhanceSliceCandidatesWithModel(context, req.body, localCandidates, settings);
      res.json({ candidates });
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
      const roomPath = req.body?.roomKey ? decodeAllowedKey(req.body.roomKey) : null;
      const job = createTranscodeJob(roomPath ? `正在转换房间 FLV：${path.basename(roomPath)}` : "正在批量转换全部 FLV");
      void runFlvConvertJob(job, settings, roomPath).catch((error) => {
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
      if (!req.body?.confirm) {
        res.status(400).json({ error: "执行真实投稿需要 confirm=true。" });
        return;
      }
      if (draft.autoSubmit !== true) {
        res.status(400).json({ error: "执行真实投稿需要先开启全自动投稿。" });
        return;
      }
      const preflight = preflightUpload(draft);
      if (!preflight.ok) {
        res.status(400).json(preflight);
        return;
      }
      const payload = buildBiliupCommand({ draft });
      const job = createUploadJob("biliup-run", draft.publishMode === "append" ? "正在追加分 P" : "正在投稿");
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
  for (const dir of [workbenchRoot, thumbsDir, projectsDir, exportsDir, draftsDir, previewsDir, modelAssetsDir, coversDir, asrDir, modelsRoot, toolsDir, downloadsDir]) {
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

function getLegacyLocalAsrStatus() {
  const pythonPath = getLocalAsrPython();
  const funAsrInstalled = hasPythonPackage("funasr");
  const torchInstalled = hasPythonPackage("torch");
  const torchRuntime = getTorchRuntimeInfo(pythonPath);
  const torchCuda = torchRuntime.cudaBuild;
  const downloadedModels = listDownloadedAsrModels();
  const qwenModelPresent = downloadedModels.some((item) => item.toLowerCase().includes("qwen3"));
  const llamaCppFound = Boolean(commandPath("llama-cli") || commandPath("llama-server"));
  const hasCuda = Boolean(commandPath("nvidia-smi"));
  const notes = [];
  if (!pythonPath) notes.push("未发现本地 ASR Python 运行环境。");
  if (pythonPath && !funAsrInstalled) notes.push("已创建 ASR 虚拟环境，但还没装 Fun-ASR。");
  if (funAsrInstalled && !downloadedModels.length) notes.push("ASR 运行库已就绪，但还没下载模型。");
  if (hasCuda && torchInstalled && !torchCuda) notes.push("本机有 NVIDIA GPU，但当前 ASR 环境装的是 CPU 版 Torch；把设备切到 CUDA 后会自动补装 GPU 版。");
  if (!llamaCppFound) notes.push("Qwen3-ASR-GGUF 需要外部命令和 llama.cpp/模型包；填好 Qwen3 命令模板后可用 ASR 对比测试。");
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
    cacheRoot: modelsRoot,
    downloadedModels,
    notes
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
  return resolveRecordingsRoot(readRawServiceSettingsSync()?.recordingsRoot);
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
        found.push({ path: fullPath, reason: "磁盘根目录发现疑似录播目录" });
      }
      for (const childName of ["录播文件", "recordings", "records", "video", "videos"]) {
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
  return /blrec|录播|record|recording|直播/.test(String(name || "").toLowerCase());
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
    recordingsRoot: resolveRecordingsRoot(input?.recordingsRoot),
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
      endpoint: String(vision.endpoint || "http://localhost:8317/v1"),
      apiKey: String(vision.apiKey || "your-api-key-1"),
      model: String(vision.model || "gpt-5.4"),
      sendFrames: vision.sendFrames !== false,
      sendAudio: Boolean(vision.sendAudio),
      sendSubtitles: vision.sendSubtitles !== false,
      sendDanmaku: vision.sendDanmaku !== false
    },
    cover: {
      provider: String(cover.provider || "frame-template"),
      endpoint: String(cover.endpoint || ""),
      apiKey: String(cover.apiKey || ""),
      model: String(cover.model || ""),
      stylePrompt: String(cover.stylePrompt || "清晰、有标题空间、适合 B 站直播切片封面")
    },
    media: {
      flvOutputMode: String(media.flvOutputMode || "same-dir"),
      deleteSourceAfterConvert: Boolean(media.deleteSourceAfterConvert),
      skipIfMp4Exists: media.skipIfMp4Exists !== false
    }
  };
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
      command = buildBiliupCommand({ draft: { ...draft, cookiePath } }).command;
    } catch (error) {
      warnings.push(readableError(error));
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    warnings,
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
  job.status = "ready";
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
  const child = spawn(command, args, {
    cwd: options.cwd || process.cwd(),
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
  const rooms = [];
  for (const entry of roomDirs) {
    const fullPath = path.join(recordingsRoot, entry.name);
    const files = collectFiles(fullPath, 2);
    const videos = dedupeVideoFiles(files.filter((file) => videoExtensions.has(path.extname(file).toLowerCase())));
    const xmlCount = files.filter((file) => path.extname(file).toLowerCase() === ".xml").length;
    const latest = videos
      .map((file) => ({ file, stat: safeStat(file) }))
      .filter((item) => item.stat)
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0];
    const parsed = parseRoomName(entry.name);
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
  const parsed = parseRoomName(folderName);
  const files = collectFiles(roomPath, 3);
  const xmlFiles = files.filter((file) => path.extname(file).toLowerCase() === ".xml");
  const subtitleFiles = files.filter((file) => subtitleExtensions.has(path.extname(file).toLowerCase()));
  const videoFiles = dedupeVideoFiles(files.filter((file) => videoExtensions.has(path.extname(file).toLowerCase())));
  const videos = [];

  for (const videoPath of videoFiles) {
    const stat = safeStat(videoPath);
    const media = await getMediaMetadata(videoPath);
    const xml = findCompanionFile(videoPath, xmlFiles, ".xml");
    const subs = findCompanionFiles(videoPath, subtitleFiles);
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
      subtitles: subs.map((file) => ({ key: encodeKey(file), path: file, name: path.basename(file) })),
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
  const room = parseRoomName(path.basename(roomPath));
  const roomFiles = collectFiles(roomPath, 3);
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
  const duration = Math.max(20, Number(options.clipDuration || 90));
  const count = Math.min(12, Math.max(1, Number(options.clipCount || 5)));
  const totalDuration = Math.max(context.duration || context.media.duration || 0, duration);
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
    chosen.push(makeCandidate(context, start, end, peak, sources, sourceComments, sourceSubtitles));
    if (chosen.length >= count) break;
  }

  if (!chosen.length) {
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
  return {
    id: `clip-${Math.round(start)}-${Math.round(end)}`,
    title,
    start,
    end,
    score: Math.min(100, Math.max(1, Math.round(peak.combinedScore))),
    reason: buildCandidateReason(signal, sources),
    evidence
  };
}

const funnyKeywords = ["哈", "哈哈", "hhh", "233", "草", "笑死", "绷", "乐", "蚌", "典"];
const reactionKeywords = ["救命", "卧槽", "好怪", "离谱", "破防", "急了", "太强", "可爱", "逆天", "名场面"];
const questionKeywords = ["？", "?", "什么", "怎么", "为何", "啊", "哇", "欸"];

function normalizeOptionSubtitles(subtitles) {
  return subtitles
    .map((cue, index) => ({
      id: String(cue?.id || `option-subtitle-${index}`),
      start: Number(cue?.start || 0),
      end: Number(cue?.end || cue?.start || 0),
      text: String(cue?.text || "").trim(),
      source: cue?.source
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
  if (!settings?.vision?.endpoint || settings.vision.provider === "manual" || !localCandidates.length) {
    return localCandidates;
  }
  const sources = Array.isArray(options.sources) && options.sources.length ? options.sources : ["danmaku"];
  const candidateSignals = localCandidates.map((candidate) => {
    const signal = collectClipSignals(context, { ...options, clip: candidate });
    return {
      id: candidate.id,
      start: candidate.start,
      end: candidate.end,
      score: candidate.score,
      localTitle: candidate.title,
      localReason: candidate.reason,
      evidence: candidate.evidence,
      hotText: signal.hotText,
      danmaku: signal.comments.slice(0, 40).map((item) => ({ time: item.time, text: item.text })),
      subtitles: signal.subtitles.slice(0, 40).map((cue) => ({ start: cue.start, end: cue.end, text: cue.text }))
    };
  });
  const payload = {
    task: "bilibili_ai_slice_candidates",
    model: settings.vision.model,
    room: context.room,
    sourceVideo: context.name,
    sources,
    clipDuration: options.clipDuration,
    clipCount: options.clipCount,
    candidates: candidateSignals,
    instruction: [
      "你要从候选直播片段里生成更像人写的 B 站切片建议。",
      "不要发散新增太多时间段，优先沿用输入候选 id/start/end。",
      "每个 reason 必须写清具体笑点、反差、名场面、弹幕爆点或台词依据，避免空话。",
      "返回 JSON：{candidates:[{id,title,start,end,score,reason,evidence:[...] }]}。"
    ].join("\n")
  };

  try {
    const response = await callJsonEndpoint(settings.vision, payload);
    const enhanced = parseSliceModelResponse(response, localCandidates);
    return enhanced.length ? enhanced : localCandidates;
  } catch {
    return localCandidates;
  }
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
  const url = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
  const headers = { "Content-Type": "application/json" };
  if (settings.apiKey) {
    headers.Authorization = `Bearer ${settings.apiKey}`;
  }
  const input = { ...payload };
  delete input.instruction;
  const baseBody = {
      model: payload.model || settings.model,
      temperature: 0.4,
      messages: [
        {
          role: "system",
          content: "你是直播切片工作台的模型适配层。必须优先返回 JSON，不要输出解释性前后缀。"
        },
        {
          role: "user",
          content: [
            payload.instruction ? `任务要求：\n${payload.instruction}` : "",
            "输入数据：",
            JSON.stringify(input, null, 2)
          ].filter(Boolean).join("\n\n")
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

function normalizeOpenAiCompatibleResponse(response) {
  const content = String(
    response?.choices?.[0]?.message?.content
      || response?.choices?.[0]?.text
      || response?.output_text
      || response?.text
      || ""
  ).trim();
  if (!content) return response;
  const parsed = extractJsonObject(content);
  if (parsed) return { ...parsed, raw: response };
  return { ...response, text: content };
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
  job.status = "ready";
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
  const subtitles = normalizeOptionSubtitles(Array.isArray(payload.subtitles) ? payload.subtitles : []);
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
  job.subtitles = job.subtitlePath ? parseSubtitleFile(job.subtitlePath) : [];
  job.status = "ready";
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
    job.subtitles = job.subtitlePath ? parseSubtitleFile(job.subtitlePath) : [];
    if (job.subtitles.length && String(asrSettings.outputFormat || "srt").toLowerCase() === "vtt") {
      job.subtitlePath = await writeStandaloneSubtitles(job.outDir, job.subtitles, "vtt");
    }
    job.status = "ready";
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
    job.subtitles = parseAsrEndpointResponse(response, end - start);
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
  job.subtitles = job.subtitlePath ? parseSubtitleFile(job.subtitlePath) : [];
  job.status = "ready";
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
  await execFileAsync(
    "ffmpeg",
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
  const tasks = [
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
    startedAt: job.startedAt || patch.startedAt || null,
    updatedAt: job.updatedAt || null
  };
}

async function runFlvConvertJob(job, settings, roomPath = null) {
  const roots = roomPath ? [roomPath] : [getRecordingsRoot()];
  if (!roots[0]) {
    throw new Error("未设置录播目录。请先在设置页填写 blrec 录播文件目录。");
  }
  const flvFiles = dedupeVideoFiles(
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
    const args = [
      "-y",
      "-i",
      file,
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-c:a",
      "aac",
      "-b:a",
      "160k",
      "-movflags",
      "+faststart",
      target
    ];
    job.progress = Math.max(5, Math.round((converted / flvFiles.length) * 100));
    job.message = `正在转换 ${path.basename(file)}（${converted + 1}/${flvFiles.length}）`;
    job.outputPath = target;
    await runSpawnLogged(job, "ffmpeg", args, { timeoutMs: 1000 * 60 * 60 * 4 });
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

function getFlvTargetPath(file, mediaSettings) {
  const extless = file.replace(/\.flv$/i, "");
  if (mediaSettings?.flvOutputMode === "compressed-dir") {
    return path.join(path.dirname(file), "_compressed", `${path.basename(extless)}.mp4`);
  }
  return `${extless}.mp4`;
}

async function getPreviewStatus(videoPath) {
  assertInsideRecordings(videoPath);
  const info = getPreviewInfo(videoPath);
  const stat = safeStat(info.outPath);
  if (stat && stat.size > 0) {
    return {
      status: "ready",
      progress: 100,
      path: info.outPath,
      mediaUrl: `/api/media?key=${encodeURIComponent(encodeKey(info.outPath))}`,
      message: "预览已生成",
      updatedAt: stat.mtime.toISOString()
    };
  }

  const job = previewJobs.get(info.id);
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
    message: "正在生成 720p MP4 预览",
    log: "",
    command: "",
    outputPath: info.outPath,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  previewJobs.set(info.id, job);

  const args = [
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
    info.outPath
  ];
  job.command = ["ffmpeg", ...args].map(quoteArg).join(" ");
  job.log = `> ${job.command}\n`;

  const child = spawn("ffmpeg", args, { windowsHide: true });
  job.childPid = child.pid;

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    job.log = `${job.log}${text}`.slice(-12000);
    const match = text.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!match) return;
    const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    job.progress = Math.max(job.progress, Math.min(99, Math.round((seconds / duration) * 100)));
    job.message = `正在生成预览 ${job.progress}%`;
    job.updatedAt = new Date().toISOString();
  });

  child.on("error", (error) => {
    job.status = "error";
    job.progress = 0;
    job.message = readableError(error);
    job.updatedAt = new Date().toISOString();
  });

  child.on("close", (code) => {
    const stat = safeStat(info.outPath);
    if (code === 0 && stat && stat.size > 0) {
      job.status = "ready";
      job.progress = 100;
      job.message = "预览已生成";
    } else {
      job.status = "error";
      job.progress = 0;
      job.message = `ffmpeg 退出码 ${code ?? "unknown"}`;
      if (fs.existsSync(info.outPath)) {
        fs.rmSync(info.outPath, { force: true });
      }
    }
    job.updatedAt = new Date().toISOString();
  });

  return getPreviewStatus(videoPath);
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

function parseRoomName(folderName) {
  const match = folderName.match(/^(\d+)\s*-\s*(.+)$/);
  return {
    roomId: match?.[1] || "",
    name: match?.[2] || folderName
  };
}

function findRoomPath(filePath) {
  const recordingsRoot = getRecordingsRoot();
  if (!recordingsRoot) {
    throw new Error("未设置录播目录。");
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
    throw new Error("未设置录播目录。请先在设置页填写 blrec 录播文件目录。");
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
