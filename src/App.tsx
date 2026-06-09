import { useEffect, useMemo, useRef, useState } from "react";
import {
  BadgeCheck,
  Bot,
  Clapperboard,
  Clock3,
  Download,
  Film,
  FolderOpen,
  ListVideo,
  Loader2,
  MessageSquareText,
  Play,
  Plus,
  RefreshCw,
  Save,
  Scissors,
  Search,
  Send,
  Settings2,
  Sparkles,
  Upload,
  Wand2,
  X
} from "lucide-react";
import {
  convertAllFlv,
  extractCover,
  generateClipTitle,
  generateCover,
  generateUploadCommand,
  getAsrJob,
  getUploadJob,
  getJson,
  installBiliup,
  loadArchiveDetail,
  loadPreviewStatus,
  loadRecordingRootCandidates,
  loadSettings,
  loadTasks,
  loadUploadHistory,
  packageModelAssets,
  preflightUpload,
  postJson,
  prepareAsrModel,
  requestSliceCandidates,
  saveServiceSettings,
  saveUploadDraft,
  runBiliupUpload,
  startBiliupLogin,
  startAsr,
  startPreview,
  testVisionSettings
} from "./api";
import type {
  ClipCandidate,
  ClipDraft,
  DanmakuItem,
  HistogramBin,
  LocalAsrStatus,
  PreviewStatus,
  RecordingRootCandidate,
  RemoteArchiveInfo,
  RemoteArchivePart,
  Room,
  RoomDetail,
  Settings,
  ServiceSettings,
  SubtitleCue,
  UploadDraft,
  UploadHistoryItem,
  UploadJob,
  UploadPart,
  UploadPreflight,
  UploadTools,
  VideoAsset,
  WorkbenchTask,
  VideoContext
} from "./types";

type ProjectState = {
  clips: ClipDraft[];
  danmakuEdits: Record<string, string>;
  subtitles: SubtitleCue[] | null;
  updatedAt: string | null;
};

type AsrCompareColumn = {
  label: string;
  message: string;
  outDir: string;
  cues: SubtitleCue[];
};

type AsrComparison = {
  range: { start: number; end: number };
  fun: AsrCompareColumn;
  qwen: AsrCompareColumn;
  updatedAt: string;
};

type RemoteArchiveDetail = {
  archive: RemoteArchiveInfo;
  videos: RemoteArchivePart[];
};

type View = "library" | "workspace" | "upload" | "tasks" | "settings";

const emptyProject: ProjectState = {
  clips: [],
  danmakuEdits: {},
  subtitles: null,
  updatedAt: null
};

export function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [roomDetail, setRoomDetail] = useState<RoomDetail | null>(null);
  const [selectedVideo, setSelectedVideo] = useState<VideoAsset | null>(null);
  const [context, setContext] = useState<VideoContext | null>(null);
  const [project, setProject] = useState<ProjectState>(emptyProject);
  const [previewStatus, setPreviewStatus] = useState<PreviewStatus | null>(null);
  const [activeView, setActiveView] = useState<View>("library");
  const [query, setQuery] = useState("");
  const [danmakuQuery, setDanmakuQuery] = useState("");
  const [currentTime, setCurrentTime] = useState(0);
  const [selectionStart, setSelectionStart] = useState(0);
  const [selectionEnd, setSelectionEnd] = useState(90);
  const [sources, setSources] = useState<string[]>(["danmaku"]);
  const [clipDuration, setClipDuration] = useState(90);
  const [clipCount, setClipCount] = useState(5);
  const [candidates, setCandidates] = useState<ClipCandidate[]>([]);
  const [asrComparison, setAsrComparison] = useState<AsrComparison | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void bootstrap();
  }, []);

  useEffect(() => {
    if (!context || previewStatus?.status !== "running") return;
    const id = window.setInterval(async () => {
      try {
        const status = await loadPreviewStatus(context.key);
        setPreviewStatus(status);
        if (status.status === "ready" && videoRef.current) {
          videoRef.current.load();
        }
      } catch (err) {
        setError(readableError(err));
      }
    }, 2200);
    return () => window.clearInterval(id);
  }, [context, previewStatus?.status]);

  const editedDanmaku = useMemo(() => {
    if (!context) return [];
    return context.danmaku.map((item) => ({
      ...item,
      text: project.danmakuEdits[item.id] ?? item.text
    }));
  }, [context, project.danmakuEdits]);

  const editedSubtitles = project.subtitles ?? context?.subtitles ?? [];

  const activeDanmaku = useMemo(
    () => editedDanmaku.filter((item) => item.time >= currentTime - 1 && item.time <= currentTime + 8).slice(0, 8),
    [editedDanmaku, currentTime]
  );

  const activeSubtitle = useMemo(
    () => editedSubtitles.find((cue) => cue.start <= currentTime && cue.end >= currentTime) || null,
    [editedSubtitles, currentTime]
  );

  const filteredRooms = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rooms;
    return rooms.filter((room) => `${room.name} ${room.roomId} ${room.folderName}`.toLowerCase().includes(needle));
  }, [rooms, query]);

  async function bootstrap() {
    setBusy("loading");
    setError(null);
    try {
      const [loadedSettings, roomPayload] = await Promise.all([
        loadSettings(),
        getJson<{ root: string; rooms: Room[] }>("/api/rooms")
      ]);
      setSettings(loadedSettings);
      setRooms(roomPayload.rooms);
    } catch (err) {
      setError(readableError(err));
    } finally {
      setBusy(null);
    }
  }

  async function openRoom(room: Room) {
    setBusy("room");
    setError(null);
    setActiveView("workspace");
    try {
      const detail = await getJson<RoomDetail>(`/api/rooms/${room.key}`);
      setRoomDetail(detail);
      const firstReadable = detail.videos.find((video) => Number(video.duration) > 0) || detail.videos[0];
      if (firstReadable) {
        await openVideo(firstReadable);
      } else {
        setSelectedVideo(null);
        setContext(null);
        setPreviewStatus(null);
        setProject(emptyProject);
      }
    } catch (err) {
      setError(readableError(err));
    } finally {
      setBusy(null);
    }
  }

  async function openVideo(video: VideoAsset) {
    setBusy("video");
    setError(null);
    setSelectedVideo(video);
    try {
      const [loadedContext, loadedProject] = await Promise.all([
        getJson<VideoContext>(`/api/videos/${video.key}/context`),
        getJson<ProjectState>(`/api/projects/${video.key}`)
      ]);
      setContext(loadedContext);
      setProject({
        clips: loadedProject.clips || [],
        danmakuEdits: loadedProject.danmakuEdits || {},
        subtitles: loadedProject.subtitles ?? loadedContext.subtitles,
        updatedAt: loadedProject.updatedAt || null
      });
      setPreviewStatus(loadedContext.preview);
      setCandidates([]);
      setAsrComparison(null);
      setCurrentTime(0);
      setSelectionStart(0);
      setSelectionEnd(Math.min(90, loadedContext.duration || 90));
    } catch (err) {
      setError(readableError(err));
    } finally {
      setBusy(null);
    }
  }

  function seekTo(seconds: number) {
    const safe = Math.max(0, Math.min(seconds, context?.duration || seconds));
    setCurrentTime(safe);
    if (videoRef.current) {
      videoRef.current.currentTime = safe;
    }
  }

  function updateDanmaku(id: string, text: string) {
    setProject((prev) => ({
      ...prev,
      danmakuEdits: { ...prev.danmakuEdits, [id]: text }
    }));
  }

  function updateSubtitle(id: string, patch: Partial<SubtitleCue>) {
    setProject((prev) => ({
      ...prev,
      subtitles: (prev.subtitles ?? context?.subtitles ?? []).map((cue) => (cue.id === id ? { ...cue, ...patch } : cue))
    }));
  }

  function addSubtitle() {
    const start = Math.max(0, currentTime);
    const cue: SubtitleCue = {
      id: `manual-${Date.now()}`,
      start,
      end: start + 4,
      text: "新字幕"
    };
    setProject((prev) => ({
      ...prev,
      subtitles: [...(prev.subtitles ?? context?.subtitles ?? []), cue]
    }));
  }

  async function runAiSlicing() {
    if (!context) return;
    setBusy("ai");
    setError(null);
    try {
      const result = await requestSliceCandidates({
        videoKey: context.key,
        sources,
        clipDuration,
        clipCount,
        subtitles: editedSubtitles,
        danmakuEdits: project.danmakuEdits
      });
      setCandidates(result.candidates);
      if (result.candidates[0]) {
        previewClip(result.candidates[0]);
      }
    } catch (err) {
      setError(readableError(err));
    } finally {
      setBusy(null);
    }
  }

  async function generatePreview() {
    if (!context) return;
    setBusy("preview");
    setError(null);
    try {
      const status = await startPreview(context.key);
      setPreviewStatus(status);
    } catch (err) {
      setError(readableError(err));
    } finally {
      setBusy(null);
    }
  }

  function previewClip(clip: Pick<ClipCandidate, "start" | "end">) {
    setSelectionStart(roundTime(clip.start));
    setSelectionEnd(roundTime(clip.end));
    seekTo(clip.start);
  }

  function addClip(candidate?: ClipCandidate) {
    const clip: ClipDraft = candidate
      ? { ...candidate, status: "draft" }
      : {
          id: `manual-${Date.now()}`,
          title: `${context?.room.name || "手动"} 切片`,
          start: selectionStart,
          end: selectionEnd,
          score: 0,
          reason: "手动选择的切片区间。",
          evidence: [],
          status: "draft"
        };
    setProject((prev) => ({ ...prev, clips: [...prev.clips, clip] }));
    setMessage("已加入切片草稿");
  }

  function updateClip(id: string, patch: Partial<ClipDraft>) {
    setProject((prev) => ({
      ...prev,
      clips: prev.clips.map((clip) => (clip.id === id ? { ...clip, ...patch } : clip))
    }));
  }

  async function exportClip(clip: ClipDraft) {
    if (!context) return;
    setBusy(`export-${clip.id}`);
    setError(null);
    try {
      const result = await postJson<{ ok: boolean; path: string }>("/api/clips/export", {
        videoKey: context.key,
        title: clip.title,
        start: clip.start,
        end: clip.end,
        burnSubtitles: Boolean(clip.burnSubtitles),
        subtitles: editedSubtitles
      });
      updateClip(clip.id, { status: "exported", exportPath: result.path });
      setMessage(`已导出：${result.path}`);
    } catch (err) {
      setError(readableError(err));
    } finally {
      setBusy(null);
    }
  }

  async function packageClipForModel(clip: ClipDraft) {
    if (!context) return;
    setBusy(`assets-${clip.id}`);
    setError(null);
    try {
      const result = await packageModelAssets({
        videoKey: context.key,
        title: clip.title,
        start: clip.start,
        end: clip.end,
        subtitles: editedSubtitles,
        frameCount: 6,
        includeAudio: true
      });
      setMessage(`已生成模型素材包：${result.path}`);
    } catch (err) {
      setError(readableError(err));
    } finally {
      setBusy(null);
    }
  }

  async function extractClipCover(clip: ClipDraft) {
    if (!context) return;
    setBusy(`cover-${clip.id}`);
    setError(null);
    try {
      const result = await extractCover({
        videoKey: context.key,
        title: clip.title,
        time: clip.start + Math.max(1, (clip.end - clip.start) * 0.35)
      });
      updateClip(clip.id, { coverPath: result.path });
      setMessage(`已抽取封面帧：${result.path}`);
    } catch (err) {
      setError(readableError(err));
    } finally {
      setBusy(null);
    }
  }

  async function generateTitleForClip(clip: ClipDraft) {
    if (!context) return;
    setBusy(`title-${clip.id}`);
    setError(null);
    try {
      const result = await generateClipTitle({
        videoKey: context.key,
        clip,
        subtitles: editedSubtitles,
        danmakuEdits: project.danmakuEdits
      });
      updateClip(clip.id, {
        title: result.title || clip.title,
        reason: result.reason || clip.reason,
        evidence: result.evidence?.length ? result.evidence : clip.evidence
      });
      setMessage(result.reason ? `标题已生成：${result.reason}` : "标题已生成。");
    } catch (err) {
      setError(readableError(err));
    } finally {
      setBusy(null);
    }
  }

  async function generateAiCoverForClip(clip: ClipDraft) {
    if (!context) return;
    setBusy(`ai-cover-${clip.id}`);
    setError(null);
    try {
      const result = await generateCover({
        videoKey: context.key,
        clip,
        subtitles: editedSubtitles,
        danmakuEdits: project.danmakuEdits
      });
      updateClip(clip.id, { coverPath: result.path });
      setMessage(result.templateFallback ? `AI封面降级为封面帧：${result.path}` : `封面已生成：${result.path}`);
    } catch (err) {
      setError(readableError(err));
    } finally {
      setBusy(null);
    }
  }

  async function runAsrForRange(
    start: number,
    end: number,
    options: {
      busyKey: string;
      label: string;
      writeBack?: boolean;
      asrOverride?: Partial<ServiceSettings["asr"]>;
    }
  ) {
    if (!context) return;
    setBusy(options.busyKey);
    setError(null);
    try {
      const job = await startAsr({
        videoKey: context.key,
        start,
        end,
        asrOverride: options.asrOverride
      });
      setMessage(`${job.message}：${job.outDir}`);
      const finished = await waitForAsrJob(job.id);
      if (finished.status === "ready" && finished.subtitles.length && options.writeBack !== false) {
        const shifted = shiftAsrCues(finished.subtitles, start, `asr-${job.id}`);
        writeSubtitlesToRange(shifted, { start, end });
        setMessage(`${options.label} ASR 完成，已写入 ${shifted.length} 条可编辑字幕。`);
      } else if (finished.status === "ready" && finished.subtitles.length) {
        setMessage(`${options.label} ASR 完成，识别到 ${finished.subtitles.length} 条字幕：${finished.outDir}`);
      } else if (finished.status === "ready") {
        setMessage(`${finished.message}：${finished.outDir}`);
      } else {
        throw new Error(finished.message || "ASR 任务失败。");
      }
      return finished;
    } catch (err) {
      setError(readableError(err));
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function runAsrForSelection() {
    await runAsrForRange(selectionStart, selectionEnd, { busyKey: "asr", label: "当前区间" });
  }

  async function runAsrForFullVideo() {
    if (!context) return;
    await runAsrForRange(0, context.duration, { busyKey: "asr-full", label: "整片" });
  }

  async function compareAsrForSelection() {
    if (!context) return;
    setBusy("asr-compare");
    setError(null);
    setAsrComparison(null);
    const range = { start: selectionStart, end: selectionEnd };
    try {
      const fun = await runAsrForRange(selectionStart, selectionEnd, {
        busyKey: "asr-compare",
        label: "Fun-ASR",
        writeBack: false,
        asrOverride: { mode: "funasr-local", provider: "funasr-nano" }
      });
      const qwen = await runAsrForRange(selectionStart, selectionEnd, {
        busyKey: "asr-compare",
        label: "Qwen3-ASR",
        writeBack: false,
        asrOverride: { mode: "qwen3-local", provider: "qwen3-asr-gguf" }
      });
      setAsrComparison({
        range,
        fun: {
          label: "Fun-ASR",
          message: fun?.message || "Fun-ASR 没有返回结果",
          outDir: fun?.outDir || "",
          cues: shiftAsrCues(fun?.subtitles || [], range.start, `compare-fun-${Date.now()}`)
        },
        qwen: {
          label: "Qwen3-ASR",
          message: qwen?.message || "Qwen3-ASR 没有返回结果",
          outDir: qwen?.outDir || "",
          cues: shiftAsrCues(qwen?.subtitles || [], range.start, `compare-qwen-${Date.now()}`)
        },
        updatedAt: new Date().toISOString()
      });
      setMessage(`ASR 对比完成：Fun-ASR ${fun?.subtitles.length ?? 0} 条；Qwen3-ASR ${qwen?.subtitles.length ?? 0} 条。`);
    } finally {
      setBusy(null);
    }
  }

  function writeSubtitlesToRange(cues: SubtitleCue[], range: { start: number; end: number }) {
    setProject((prev) => {
      const existing = prev.subtitles ?? context?.subtitles ?? [];
      const replaceMode = settings?.serviceSettings.asr.replaceMode || "range";
      const kept = replaceMode === "all"
        ? []
        : replaceMode === "append"
          ? existing
          : existing.filter((cue) => cue.end <= range.start || cue.start >= range.end);
      return {
        ...prev,
        subtitles: [...kept, ...cues].sort((a, b) => a.start - b.start)
      };
    });
  }

  function applyAsrComparison(column: AsrCompareColumn, range: { start: number; end: number }) {
    if (!column.cues.length) return;
    writeSubtitlesToRange(
      column.cues.map((cue, index) => ({
        ...cue,
        id: `chosen-${column.label}-${Date.now()}-${index}`,
        source: column.label
      })),
      range
    );
    setMessage(`已采用 ${column.label} 的 ${column.cues.length} 条字幕。`);
  }

  async function waitForAsrJob(jobId: string) {
    for (let attempt = 0; attempt < 240; attempt += 1) {
      const job = await getAsrJob(jobId);
      if (job.status !== "running") return job;
      setMessage(`${job.message}：${job.progress}%`);
      await sleep(1500);
    }
    throw new Error("ASR 任务超时。");
  }

  async function saveProject() {
    if (!context) return;
    setBusy("save");
    setError(null);
    try {
      const result = await postJson<{ ok: boolean; path: string; updatedAt: string }>(`/api/projects/${context.key}`, {
        clips: project.clips,
        danmakuEdits: project.danmakuEdits,
        subtitles: editedSubtitles
      });
      setProject((prev) => ({ ...prev, updatedAt: result.updatedAt }));
      setMessage(`已保存工程：${result.path}`);
    } catch (err) {
      setError(readableError(err));
    } finally {
      setBusy(null);
    }
  }

  const shellClass = activeView === "library" ? "shell library-mode" : "shell";

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Clapperboard size={22} />
          <div>
            <strong>Bilive Workbench</strong>
            <span>{settings?.recordingsRoot || "未设置录播目录"}</span>
          </div>
        </div>
        <nav className="view-tabs">
          <button className={activeView === "library" ? "active" : ""} onClick={() => setActiveView("library")}>
            <FolderOpen size={16} />素材库
          </button>
          <button className={activeView === "workspace" ? "active" : ""} onClick={() => setActiveView("workspace")} disabled={!roomDetail}>
            <Scissors size={16} />编辑台
          </button>
          <button className={activeView === "upload" ? "active" : ""} onClick={() => setActiveView("upload")} disabled={!context}>
            <Upload size={16} />投稿
          </button>
          <button className={activeView === "tasks" ? "active" : ""} onClick={() => setActiveView("tasks")}>
            <Clock3 size={16} />任务
          </button>
          <button className={activeView === "settings" ? "active" : ""} onClick={() => setActiveView("settings")}>
            <Settings2 size={16} />设置
          </button>
        </nav>
        <div className="top-actions">
          <StatusPill ok={Boolean(settings?.rootExists)} label="录播目录" />
          <StatusPill ok={Boolean(settings?.ffmpeg && settings.ffprobe)} label="ffmpeg" />
          <button className="icon-button" onClick={() => void bootstrap()} aria-label="刷新">
            <RefreshCw size={17} />
          </button>
        </div>
      </header>

      {error ? <div className="toast error">{error}</div> : null}
      {message ? <div className="toast" onAnimationEnd={() => setMessage(null)}>{message}</div> : null}

      <main className={shellClass}>
        <aside className="room-sidebar">
          <div className="searchbox">
            <Search size={16} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索房间、ID、文件夹" />
          </div>
          <div className="room-list">
            {busy === "loading" ? <LoadingBlock label="扫描录播目录" /> : null}
            {filteredRooms.map((room) => (
              <button
                key={room.key}
                className={`room-card ${roomDetail?.key === room.key ? "active" : ""}`}
                onClick={() => void openRoom(room)}
              >
                <CoverImage src={room.coverUrl} label={room.name} />
                <span className="room-title">{room.name}</span>
                <span className="room-meta">
                  {room.roomId || "本地"} · {room.videoCount} 视频 · {room.xmlCount} 弹幕
                </span>
              </button>
            ))}
          </div>
        </aside>

        <section className="main-panel">
          {activeView === "library" ? (
            <LibraryView rooms={filteredRooms} settings={settings} onOpenRoom={(room) => void openRoom(room)} />
          ) : null}

          {activeView === "workspace" ? (
            <WorkspaceView
              busy={busy}
              context={context}
              roomDetail={roomDetail}
              selectedVideo={selectedVideo}
              videoRef={videoRef}
              currentTime={currentTime}
              selectionStart={selectionStart}
              selectionEnd={selectionEnd}
              sources={sources}
              clipDuration={clipDuration}
              clipCount={clipCount}
              candidates={candidates}
              project={project}
              editedDanmaku={editedDanmaku}
              editedSubtitles={editedSubtitles}
              activeDanmaku={activeDanmaku}
              activeSubtitle={activeSubtitle}
              previewStatus={previewStatus}
              danmakuQuery={danmakuQuery}
              onVideoSelect={(video) => void openVideo(video)}
              onTimeUpdate={setCurrentTime}
              onSeek={seekTo}
              onSelectionStart={setSelectionStart}
              onSelectionEnd={setSelectionEnd}
              onSourceToggle={(source) => setSources((prev) => toggleValue(prev, source))}
              onClipDuration={setClipDuration}
              onClipCount={setClipCount}
              onRunAi={() => void runAiSlicing()}
              onGeneratePreview={() => void generatePreview()}
              onPreviewClip={previewClip}
              onAddClip={addClip}
              onUpdateClip={updateClip}
              onExportClip={(clip) => void exportClip(clip)}
              onPackageClip={(clip) => void packageClipForModel(clip)}
              onExtractCover={(clip) => void extractClipCover(clip)}
              onGenerateTitle={(clip) => void generateTitleForClip(clip)}
              onGenerateCover={(clip) => void generateAiCoverForClip(clip)}
              onRunAsr={() => void runAsrForSelection()}
              onRunFullAsr={() => void runAsrForFullVideo()}
              onCompareAsr={() => void compareAsrForSelection()}
              asrComparison={asrComparison}
              onApplyAsrComparison={applyAsrComparison}
              onSaveProject={() => void saveProject()}
              onDanmakuQuery={setDanmakuQuery}
              onUpdateDanmaku={updateDanmaku}
              onAddSubtitle={addSubtitle}
              onUpdateSubtitle={updateSubtitle}
            />
          ) : null}

          {activeView === "upload" ? (
            <UploadView
              tools={settings?.uploadTools || null}
              defaults={settings?.uploadDefaults || {}}
              roomDetail={roomDetail}
              context={context}
              clips={project.clips}
              onRefreshTools={bootstrap}
            />
          ) : null}

          {activeView === "tasks" ? <TaskCenterView /> : null}

          {activeView === "settings" ? (
            <SettingsView
              initial={settings?.serviceSettings || null}
              asrTools={settings?.asrTools || null}
              uploadTools={settings?.uploadTools || null}
              recordingRootCandidates={settings?.recordingRootCandidates || []}
              onSave={async (value) => {
                await saveServiceSettings(value);
                const [latest, roomPayload] = await Promise.all([
                  loadSettings(),
                  getJson<{ root: string; rooms: Room[] }>("/api/rooms")
                ]);
                setSettings(latest);
                setRooms(roomPayload.rooms);
                setRoomDetail(null);
                setSelectedVideo(null);
                setContext(null);
                setProject(emptyProject);
                setMessage("服务设置已保存，素材库已重新扫描。");
              }}
              onPrepareAsr={async (value) => {
                const result = await prepareAsrModel({
                  provider: value.asr.provider,
                  model: value.asr.model,
                  modelSize: value.asr.modelSize,
                  device: value.asr.device
                });
                setMessage("本地 ASR 模型准备任务已启动，进度去任务中心看。");
                const latest = await loadSettings();
                setSettings(latest);
                return result;
              }}
              onConvertFlv={async () => {
                const result = await convertAllFlv();
                setMessage("FLV 转 MP4 任务已启动，进度去任务中心看。");
                return result;
              }}
              onRefreshRoots={async () => {
                const result = await loadRecordingRootCandidates();
                const latest = await loadSettings();
                setSettings(latest);
                return result.candidates;
              }}
              onTestVision={async (value) => testVisionSettings(value.vision)}
            />
          ) : null}
        </section>
      </main>
    </div>
  );
}

function LibraryView({
  rooms,
  settings,
  onOpenRoom
}: {
  rooms: Room[];
  settings: Settings | null;
  onOpenRoom: (room: Room) => void;
}) {
  return (
    <div className="library-grid">
      <section className="hero-band">
        <div>
          <span className="eyebrow">本地录播素材</span>
          <h1>从房间、弹幕密度、字幕和切片草稿开始剪辑。</h1>
        </div>
        <div className="stat-row">
          <Metric label="房间" value={rooms.length} />
          <Metric label="录播目录" value={settings?.rootExists ? "可读" : "未找到"} />
          <Metric label="投稿 CLI" value={settings?.uploadTools.biliup || settings?.uploadTools.bilitool ? "已检测" : "未安装"} />
        </div>
      </section>

      <section className="room-grid">
        {rooms.slice(0, 24).map((room) => (
          <button key={room.key} className="room-tile" onClick={() => onOpenRoom(room)}>
            <CoverImage src={room.coverUrl} label={room.name} />
            <span>{room.name}</span>
            <small>
              {room.videoCount} 视频 · {room.latestVideo ? formatDate(room.latestVideo.mtime) : "无视频"}
            </small>
          </button>
        ))}
      </section>
    </div>
  );
}

function WorkspaceView(props: {
  busy: string | null;
  context: VideoContext | null;
  roomDetail: RoomDetail | null;
  selectedVideo: VideoAsset | null;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  currentTime: number;
  selectionStart: number;
  selectionEnd: number;
  sources: string[];
  clipDuration: number;
  clipCount: number;
  candidates: ClipCandidate[];
  project: ProjectState;
  editedDanmaku: DanmakuItem[];
  editedSubtitles: SubtitleCue[];
  activeDanmaku: DanmakuItem[];
  activeSubtitle: SubtitleCue | null;
  previewStatus: PreviewStatus | null;
  danmakuQuery: string;
  onVideoSelect: (video: VideoAsset) => void;
  onTimeUpdate: (time: number) => void;
  onSeek: (time: number) => void;
  onSelectionStart: (time: number) => void;
  onSelectionEnd: (time: number) => void;
  onSourceToggle: (source: string) => void;
  onClipDuration: (value: number) => void;
  onClipCount: (value: number) => void;
  onRunAi: () => void;
  onGeneratePreview: () => void;
  onPreviewClip: (clip: Pick<ClipCandidate, "start" | "end">) => void;
  onAddClip: (candidate?: ClipCandidate) => void;
  onUpdateClip: (id: string, patch: Partial<ClipDraft>) => void;
  onExportClip: (clip: ClipDraft) => void;
  onPackageClip: (clip: ClipDraft) => void;
  onExtractCover: (clip: ClipDraft) => void;
  onGenerateTitle: (clip: ClipDraft) => void;
  onGenerateCover: (clip: ClipDraft) => void;
  onRunAsr: () => void;
  onRunFullAsr: () => void;
  onCompareAsr: () => void;
  asrComparison: AsrComparison | null;
  onApplyAsrComparison: (column: AsrCompareColumn, range: { start: number; end: number }) => void;
  onSaveProject: () => void;
  onDanmakuQuery: (value: string) => void;
  onUpdateDanmaku: (id: string, text: string) => void;
  onAddSubtitle: () => void;
  onUpdateSubtitle: (id: string, patch: Partial<SubtitleCue>) => void;
}) {
  const {
    busy,
    context,
    roomDetail,
    selectedVideo,
    videoRef,
    currentTime,
    selectionStart,
    selectionEnd,
    sources,
    clipDuration,
    clipCount,
    candidates,
    project,
    editedDanmaku,
    editedSubtitles,
    activeDanmaku,
    activeSubtitle,
    previewStatus,
    danmakuQuery,
    onVideoSelect,
    onTimeUpdate,
    onSeek,
    onSelectionStart,
    onSelectionEnd,
    onSourceToggle,
    onClipDuration,
    onClipCount,
    onRunAi,
    onGeneratePreview,
    onPreviewClip,
    onAddClip,
    onUpdateClip,
    onExportClip,
    onPackageClip,
    onExtractCover,
    onGenerateTitle,
    onGenerateCover,
    onRunAsr,
    onRunFullAsr,
    onCompareAsr,
    asrComparison,
    onApplyAsrComparison,
    onSaveProject,
    onDanmakuQuery,
    onUpdateDanmaku,
    onAddSubtitle,
    onUpdateSubtitle
  } = props;

  if (!roomDetail) {
    return <EmptyState icon={<FolderOpen />} title="选择一个房间" />;
  }

  if (!context || !selectedVideo) {
    return <LoadingBlock label={busy === "room" ? "读取房间素材" : "读取视频上下文"} />;
  }

  const playbackUrl = context.playable ? context.mediaUrl : previewStatus?.mediaUrl || undefined;
  const needsPreview = !context.playable && previewStatus?.status !== "ready";

  return (
    <div className="workspace">
      <section className="media-column">
        <div className="section-head">
          <div>
            <span className="eyebrow">{roomDetail.roomId || "本地房间"}</span>
            <h2>{roomDetail.name}</h2>
          </div>
          <button className="primary" onClick={onSaveProject} disabled={busy === "save"}>
            <Save size={16} />保存工程
          </button>
        </div>

        <div className="video-strip">
          {roomDetail.videos.map((video) => (
            <button
              key={video.key}
              className={`video-chip ${selectedVideo.key === video.key ? "active" : ""}`}
              onClick={() => onVideoSelect(video)}
            >
              <CoverImage src={video.thumbnailUrl} label={video.name} />
              <span>{video.name}</span>
              <small>
                {formatTime(video.duration)} · {video.extension.toUpperCase()}
              </small>
            </button>
          ))}
        </div>

        <div className="player-frame">
          <video
            ref={videoRef}
            key={playbackUrl || context.key}
            src={playbackUrl}
            poster={context.thumbnailUrl}
            controls
            onTimeUpdate={(event) => onTimeUpdate(event.currentTarget.currentTime)}
          />
          {needsPreview ? (
            <div className="player-warning">
              <Film size={20} />
              <strong>{context.extension.toUpperCase()} 需要本地 MP4 预览</strong>
              <span>{previewStatus?.message || "尚未生成本地预览"}</span>
              {previewStatus?.status === "running" ? (
                <div className="progress-track">
                  <span style={{ width: `${previewStatus.progress}%` }} />
                </div>
              ) : null}
              <button className="primary" onClick={onGeneratePreview} disabled={busy === "preview" || previewStatus?.status === "running"}>
                {busy === "preview" || previewStatus?.status === "running" ? <Loader2 className="spin" size={16} /> : <Film size={16} />}
                {previewStatus?.status === "running" ? `生成中 ${previewStatus.progress}%` : "生成预览"}
              </button>
            </div>
          ) : null}
          <div className="danmaku-overlay">
            {activeDanmaku.map((item, index) => (
              <span key={`${item.id}-${index}`} style={{ top: `${8 + index * 10}%` }}>
                {item.text}
              </span>
            ))}
          </div>
          {activeSubtitle ? <div className="subtitle-overlay">{activeSubtitle.text}</div> : null}
        </div>

        <Timeline
          bins={context.histogram}
          duration={context.duration}
          currentTime={currentTime}
          selection={{ start: selectionStart, end: selectionEnd }}
          candidates={candidates}
          onSeek={onSeek}
        />

        <div className="slice-controls">
          <label>
            起点
            <input
              type="number"
              min={0}
              max={context.duration}
              value={roundTime(selectionStart)}
              onChange={(event) => onSelectionStart(Number(event.target.value))}
            />
          </label>
          <button onClick={() => onSelectionStart(currentTime)}>设为当前</button>
          <label>
            终点
            <input
              type="number"
              min={0}
              max={context.duration}
              value={roundTime(selectionEnd)}
              onChange={(event) => onSelectionEnd(Number(event.target.value))}
            />
          </label>
          <button onClick={() => onSelectionEnd(currentTime)}>设为当前</button>
          <button className="primary" onClick={() => onAddClip()}>
            <Plus size={16} />加入切片
          </button>
          <button className="primary" onClick={onRunAsr} disabled={busy === "asr"}>
            {busy === "asr" ? <Loader2 className="spin" size={16} /> : <ListVideo size={16} />}
            当前区间 ASR
          </button>
          <button onClick={onRunFullAsr} disabled={busy === "asr-full"}>
            {busy === "asr-full" ? <Loader2 className="spin" size={16} /> : <ListVideo size={16} />}
            整片 ASR
          </button>
          <button onClick={onCompareAsr} disabled={busy === "asr-compare"}>
            {busy === "asr-compare" ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />}
            ASR 对比
          </button>
        </div>
        <AsrComparisonPanel comparison={asrComparison} onSeek={onSeek} onApply={onApplyAsrComparison} />
      </section>

      <section className="inspector-column">
        <AiPanel
          busy={busy}
          sources={sources}
          clipDuration={clipDuration}
          clipCount={clipCount}
          candidates={candidates}
          onSourceToggle={onSourceToggle}
          onClipDuration={onClipDuration}
          onClipCount={onClipCount}
          onRunAi={onRunAi}
          onPreviewClip={onPreviewClip}
          onAddClip={onAddClip}
        />

        <ClipPanel
          clips={project.clips}
          busy={busy}
          onPreview={onPreviewClip}
          onUpdate={onUpdateClip}
          onExport={onExportClip}
          onPackage={onPackageClip}
          onCover={onExtractCover}
          onTitle={onGenerateTitle}
          onAiCover={onGenerateCover}
        />
      </section>

      <section className="editors-row">
        <DanmakuEditor
          danmaku={editedDanmaku}
          total={context.danmakuTotal}
          currentTime={currentTime}
          query={danmakuQuery}
          onQuery={onDanmakuQuery}
          onSeek={onSeek}
          onUpdate={onUpdateDanmaku}
        />
        <SubtitleEditor cues={editedSubtitles} currentTime={currentTime} onAdd={onAddSubtitle} onSeek={onSeek} onUpdate={onUpdateSubtitle} />
      </section>
    </div>
  );
}

function AiPanel(props: {
  busy: string | null;
  sources: string[];
  clipDuration: number;
  clipCount: number;
  candidates: ClipCandidate[];
  onSourceToggle: (source: string) => void;
  onClipDuration: (value: number) => void;
  onClipCount: (value: number) => void;
  onRunAi: () => void;
  onPreviewClip: (clip: ClipCandidate) => void;
  onAddClip: (clip: ClipCandidate) => void;
}) {
  return (
    <div className="panel">
      <div className="panel-title">
        <Bot size={18} />
        <h3>AI 切片</h3>
        <span>本地信号</span>
      </div>
      <div className="toggle-row">
        <button className={props.sources.includes("danmaku") ? "selected" : ""} onClick={() => props.onSourceToggle("danmaku")}>
          <MessageSquareText size={15} />弹幕
        </button>
        <button className={props.sources.includes("subtitle") ? "selected" : ""} onClick={() => props.onSourceToggle("subtitle")}>
          <ListVideo size={15} />字幕
        </button>
      </div>
      <div className="compact-fields">
        <label>
          时长
          <input type="number" min={20} max={600} value={props.clipDuration} onChange={(event) => props.onClipDuration(Number(event.target.value))} />
        </label>
        <label>
          数量
          <input type="number" min={1} max={12} value={props.clipCount} onChange={(event) => props.onClipCount(Number(event.target.value))} />
        </label>
      </div>
      <button className="primary wide" onClick={props.onRunAi} disabled={props.busy === "ai"}>
        {props.busy === "ai" ? <Loader2 className="spin" size={16} /> : <Wand2 size={16} />}
        生成候选
      </button>
      <div className="candidate-list">
        {props.candidates.map((candidate) => (
          <article key={candidate.id} className="candidate-card">
            <div>
              <strong>{candidate.title}</strong>
              <span>
                {formatTime(candidate.start)} - {formatTime(candidate.end)} · {candidate.score}
              </span>
            </div>
            <p>
              <b>切片理由：</b>
              {candidate.reason}
            </p>
            {candidate.evidence.length ? (
              <ul>
                {candidate.evidence.slice(0, 5).map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : null}
            <div className="card-actions">
              <button onClick={() => props.onPreviewClip(candidate)}>
                <Play size={15} />预览
              </button>
              <button onClick={() => props.onAddClip(candidate)}>
                <Plus size={15} />加入
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function AsrComparisonPanel({
  comparison,
  onSeek,
  onApply
}: {
  comparison: AsrComparison | null;
  onSeek: (time: number) => void;
  onApply: (column: AsrCompareColumn, range: { start: number; end: number }) => void;
}) {
  if (!comparison) return null;
  return (
    <div className="asr-compare-panel">
      <div className="panel-title">
        <Sparkles size={18} />
        <h3>ASR 对比</h3>
        <span>
          {formatTime(comparison.range.start)} - {formatTime(comparison.range.end)}
        </span>
      </div>
      <div className="asr-compare-grid">
        {[comparison.fun, comparison.qwen].map((column) => (
          <article className="asr-compare-card" key={column.label}>
            <div className="asr-compare-head">
              <div>
                <strong>{column.label}</strong>
                <span>{column.message}</span>
              </div>
              <button onClick={() => onApply(column, comparison.range)} disabled={!column.cues.length}>
                采用这版字幕
              </button>
            </div>
            <div className="asr-compare-list">
              {column.cues.length ? null : <EmptyMini label="没有生成字幕" />}
              {column.cues.slice(0, 24).map((cue) => (
                <button key={cue.id} className="asr-compare-row" onClick={() => onSeek(cue.start)}>
                  <span>{formatTime(cue.start)}</span>
                  <p>{cue.text}</p>
                </button>
              ))}
            </div>
            {column.outDir ? <small>{column.outDir}</small> : null}
          </article>
        ))}
      </div>
    </div>
  );
}

function ClipPanel({
  clips,
  busy,
  onPreview,
  onUpdate,
  onExport,
  onPackage,
  onCover,
  onTitle,
  onAiCover
}: {
  clips: ClipDraft[];
  busy: string | null;
  onPreview: (clip: ClipDraft) => void;
  onUpdate: (id: string, patch: Partial<ClipDraft>) => void;
  onExport: (clip: ClipDraft) => void;
  onPackage: (clip: ClipDraft) => void;
  onCover: (clip: ClipDraft) => void;
  onTitle: (clip: ClipDraft) => void;
  onAiCover: (clip: ClipDraft) => void;
}) {
  return (
    <div className="panel">
      <div className="panel-title">
        <Scissors size={18} />
        <h3>切片草稿</h3>
        <span>{clips.length}</span>
      </div>
      <div className="clip-list">
        {clips.length === 0 ? <EmptyMini label="还没有切片草稿" /> : null}
        {clips.map((clip) => (
          <article key={clip.id} className="clip-row">
            <input value={clip.title} onChange={(event) => onUpdate(clip.id, { title: event.target.value })} />
            <div className="time-pair">
              <input type="number" value={roundTime(clip.start)} onChange={(event) => onUpdate(clip.id, { start: Number(event.target.value) })} />
              <input type="number" value={roundTime(clip.end)} onChange={(event) => onUpdate(clip.id, { end: Number(event.target.value) })} />
            </div>
            <p>{clip.reason}</p>
            <label className="mini-check">
              <input
                type="checkbox"
                checked={Boolean(clip.burnSubtitles)}
                onChange={(event) => onUpdate(clip.id, { burnSubtitles: event.target.checked })}
              />
              烧录字幕
            </label>
            {clip.exportPath ? <small>{clip.exportPath}</small> : null}
            {clip.coverPath ? <small>封面：{clip.coverPath}</small> : null}
            <div className="card-actions">
              <button onClick={() => onPreview(clip)}>
                <Play size={15} />预览
              </button>
              <button onClick={() => onExport(clip)} disabled={busy === `export-${clip.id}`}>
                {busy === `export-${clip.id}` ? <Loader2 className="spin" size={15} /> : <Download size={15} />}
                导出
              </button>
              <button onClick={() => onPackage(clip)} disabled={busy === `assets-${clip.id}`}>
                {busy === `assets-${clip.id}` ? <Loader2 className="spin" size={15} /> : <Sparkles size={15} />}
                素材包
              </button>
              <button onClick={() => onTitle(clip)} disabled={busy === `title-${clip.id}`}>
                {busy === `title-${clip.id}` ? <Loader2 className="spin" size={15} /> : <Bot size={15} />}
                生成标题
              </button>
              <button onClick={() => onCover(clip)} disabled={busy === `cover-${clip.id}`}>
                {busy === `cover-${clip.id}` ? <Loader2 className="spin" size={15} /> : <Film size={15} />}
                封面帧
              </button>
              <button onClick={() => onAiCover(clip)} disabled={busy === `ai-cover-${clip.id}`}>
                {busy === `ai-cover-${clip.id}` ? <Loader2 className="spin" size={15} /> : <Sparkles size={15} />}
                AI封面
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function DanmakuEditor({
  danmaku,
  total,
  currentTime,
  query,
  onQuery,
  onSeek,
  onUpdate
}: {
  danmaku: DanmakuItem[];
  total: number;
  currentTime: number;
  query: string;
  onQuery: (value: string) => void;
  onSeek: (time: number) => void;
  onUpdate: (id: string, text: string) => void;
}) {
  const needle = query.trim().toLowerCase();
  const visible = danmaku
    .filter((item) => (!needle ? Math.abs(item.time - currentTime) < 240 : item.text.toLowerCase().includes(needle) || item.user.includes(needle)))
    .slice(0, 180);

  return (
    <div className="editor-panel">
      <div className="panel-title">
        <MessageSquareText size={18} />
        <h3>弹幕</h3>
        <span>{total}</span>
      </div>
      <div className="searchbox slim">
        <Search size={15} />
        <input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="过滤弹幕" />
      </div>
      <div className="table-list">
        {visible.map((item) => (
          <div className="editable-row" key={item.id}>
            <button onClick={() => onSeek(item.time)}>{formatTime(item.time)}</button>
            <input value={item.text} onChange={(event) => onUpdate(item.id, event.target.value)} />
          </div>
        ))}
      </div>
    </div>
  );
}

function SubtitleEditor({
  cues,
  currentTime,
  onAdd,
  onSeek,
  onUpdate
}: {
  cues: SubtitleCue[];
  currentTime: number;
  onAdd: () => void;
  onSeek: (time: number) => void;
  onUpdate: (id: string, patch: Partial<SubtitleCue>) => void;
}) {
  const visible = cues.filter((cue) => Math.abs(cue.start - currentTime) < 420).slice(0, 120);
  return (
    <div className="editor-panel">
      <div className="panel-title">
        <ListVideo size={18} />
        <h3>字幕</h3>
        <span>{cues.length}</span>
      </div>
      <button className="wide" onClick={onAdd}>
        <Plus size={15} />新增字幕行
      </button>
      <div className="table-list">
        {visible.length === 0 ? <EmptyMini label="当前视频没有字幕文件" /> : null}
        {visible.map((cue) => (
          <div className="subtitle-row" key={cue.id}>
            <button onClick={() => onSeek(cue.start)}>{formatTime(cue.start)}</button>
            <input type="number" value={roundTime(cue.start)} onChange={(event) => onUpdate(cue.id, { start: Number(event.target.value) })} />
            <input type="number" value={roundTime(cue.end)} onChange={(event) => onUpdate(cue.id, { end: Number(event.target.value) })} />
            <textarea value={cue.text} onChange={(event) => onUpdate(cue.id, { text: event.target.value })} />
          </div>
        ))}
      </div>
    </div>
  );
}

function UploadView({
  tools,
  defaults,
  roomDetail,
  context,
  clips,
  onRefreshTools
}: {
  tools: UploadTools | null;
  defaults: UploadDraft;
  roomDetail: RoomDetail | null;
  context: VideoContext | null;
  clips: ClipDraft[];
  onRefreshTools: () => Promise<void>;
}) {
  const uploadScopeKey = roomDetail?.key || context?.key || "";
  const exportedClipKey = clips.filter((clip) => clip.exportPath).map((clip) => `${clip.id}:${clip.exportPath}`).join("|");
  const autoHistoryKeyRef = useRef("");
  const [draft, setDraft] = useState<UploadDraft>(() => ({
    ...defaults,
    publishMode: "upload",
    visibility: "public",
    title: clips[0]?.title || context?.room.name || "",
    desc: "",
    cover: clips.find((clip) => clip.coverPath)?.coverPath || "",
    source: "",
    parts: buildInitialUploadParts(context, clips, roomDetail)
  }));
  const [loginMessage, setLoginMessage] = useState<string | null>(null);
  const [commandPreview, setCommandPreview] = useState<string | null>(null);
  const [archiveOutput, setArchiveOutput] = useState<string | null>(null);
  const [historyItems, setHistoryItems] = useState<UploadHistoryItem[]>([]);
  const [remoteArchive, setRemoteArchive] = useState<RemoteArchiveDetail | null>(null);
  const [remoteArchiveCache, setRemoteArchiveCache] = useState<Record<string, RemoteArchiveDetail>>({});
  const [loadingArchiveVid, setLoadingArchiveVid] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyDetecting, setHistoryDetecting] = useState(false);
  const [preflight, setPreflight] = useState<UploadPreflight | null>(null);
  const [job, setJob] = useState<UploadJob | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const parts = buildInitialUploadParts(context, clips, roomDetail);
    setDraft((prev) => ({
      ...defaults,
      ...prev,
      title: prev.title || clips[0]?.title || context?.room.name || "",
      cover: prev.cover || clips.find((clip) => clip.coverPath)?.coverPath || "",
      cookiePath: prev.cookiePath || tools?.cookiePath,
      parts
    }));
  }, [uploadScopeKey, exportedClipKey]);

  useEffect(() => {
    setHistoryItems([]);
    setRemoteArchive(null);
    setRemoteArchiveCache({});
    setArchiveOutput(null);
    setLoadingArchiveVid(null);
    setHistoryLoading(false);
    setHistoryDetecting(false);
    autoHistoryKeyRef.current = "";
  }, [uploadScopeKey]);

  useEffect(() => {
    if (!tools?.cookiePath) return;
    setDraft((prev) => ({ ...prev, cookiePath: prev.cookiePath || tools.cookiePath }));
  }, [tools?.cookiePath]);

  useEffect(() => {
    if (!context || !tools?.biliup || !tools.cookieExists || !tools.cookiePath || !uploadScopeKey) return;
    const key = `${uploadScopeKey}:${tools.cookiePath}`;
    if (autoHistoryKeyRef.current === key) return;
    autoHistoryKeyRef.current = key;
    window.setTimeout(() => {
      void readHistory();
    }, 0);
  }, [context?.key, tools?.biliup, tools?.cookieExists, tools?.cookiePath, uploadScopeKey]);

  useEffect(() => {
    if (!job || job.status !== "running") return;
    const id = window.setInterval(async () => {
      try {
        const next = await getUploadJob(job.id);
        setJob(next);
        if (next.status !== "running" && next.type === "install-biliup") {
          await onRefreshTools();
        }
      } catch (err) {
        setLoginMessage(readableError(err));
      }
    }, 1500);
    return () => window.clearInterval(id);
  }, [job?.id, job?.status]);

  function patch(patchValue: Partial<UploadDraft>) {
    setDraft((prev) => ({ ...prev, ...patchValue }));
  }

  function patchPart(id: string, patchValue: Partial<UploadPart>) {
    setDraft((prev) => ({
      ...prev,
      parts: (prev.parts || []).map((part) => (part.id === id ? { ...part, ...patchValue } : part))
    }));
  }

  function addPart() {
    setDraft((prev) => ({
      ...prev,
      parts: [
        ...(prev.parts || []),
        {
          id: `manual-${Date.now()}`,
          title: `P${(prev.parts || []).length + 1}`,
          path: "",
          source: "manual"
        }
      ]
    }));
  }

  function rebuildRoomParts() {
    const parts = buildRoomUploadParts(roomDetail, context);
    setDraft((prev) => ({ ...prev, parts }));
    setLoginMessage(parts.length ? `已从当前房间导入 ${parts.length} 个本地视频。` : "当前房间没有可导入的视频。");
  }

  function replacePartPath(part: UploadPart) {
    const nextPath = window.prompt("输入新的本地视频路径", part.path);
    if (nextPath === null) return;
    patchPart(part.id, {
      path: nextPath.trim(),
      source: "manual",
      title: part.title || partTitleFromPath(nextPath)
    });
  }

  function removePart(id: string) {
    setDraft((prev) => ({ ...prev, parts: (prev.parts || []).filter((part) => part.id !== id) }));
  }

  async function login() {
    setBusy(true);
    try {
      const result = await startBiliupLogin({ cookiePath: draft.cookiePath || tools?.cookiePath });
      setJob(result);
      setLoginMessage("已打开可交互扫码终端；扫码完成后回到工作台刷新状态。");
    } catch (err) {
      setLoginMessage(readableError(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveDraft() {
    setBusy(true);
    try {
      const result = await saveUploadDraft({ ...draft, clips });
      setLoginMessage(`投稿草稿已保存：${result.path}`);
    } catch (err) {
      setLoginMessage(readableError(err));
    } finally {
      setBusy(false);
    }
  }

  async function previewCommand() {
    setBusy(true);
    try {
      const result = await generateUploadCommand({ ...draft, cookiePath: draft.cookiePath || tools?.cookiePath });
      setCommandPreview(result.command);
      setLoginMessage(result.notes.join(" "));
    } catch (err) {
      setLoginMessage(readableError(err));
    } finally {
      setBusy(false);
    }
  }

  async function installLocalBiliup() {
    setBusy(true);
    try {
      const result = await installBiliup();
      if ("skipped" in result) {
        setLoginMessage(result.message);
        await onRefreshTools();
      } else {
        setJob(result);
        setLoginMessage("开始安装工作区本地 biliup。");
      }
    } catch (err) {
      setLoginMessage(readableError(err));
    } finally {
      setBusy(false);
    }
  }

  async function runPreflight() {
    setBusy(true);
    try {
      const result = await preflightUpload({ ...draft, cookiePath: draft.cookiePath || tools?.cookiePath });
      setPreflight(result);
      setCommandPreview(result.command || commandPreview);
      setLoginMessage(result.ok ? "预检通过，可以执行投稿命令。" : "预检未通过，先处理问题。");
    } catch (err) {
      setLoginMessage(readableError(err));
    } finally {
      setBusy(false);
    }
  }

  async function runUpload() {
    if (!draft.autoSubmit) {
      setLoginMessage("执行真实投稿前需要先打开“全自动投稿”。");
      return;
    }
    setBusy(true);
    try {
      const result = await runBiliupUpload({ ...draft, cookiePath: draft.cookiePath || tools?.cookiePath });
      setJob(result);
      setLoginMessage("真实投稿任务已启动，请在任务日志里确认进度。");
    } catch (err) {
      setLoginMessage(readableError(err));
    } finally {
      setBusy(false);
    }
  }

  async function readHistory() {
    setBusy(true);
    setHistoryLoading(true);
    try {
      const result = await loadUploadHistory({ cookiePath: draft.cookiePath || tools?.cookiePath, maxPages: 1 });
      const archives = result.archives || [];
      setHistoryItems(archives);
      setArchiveOutput(archives.length ? null : result.output || result.message || "");
      setLoginMessage(result.command || null);
      if (archives.length) {
        void autoDetectHistoryParts(archives);
      }
    } catch (err) {
      setArchiveOutput(readableError(err));
    } finally {
      setBusy(false);
      setHistoryLoading(false);
    }
  }

  function applyRemoteArchive(targetVid: string, detail: RemoteArchiveDetail) {
    setRemoteArchive(detail);
    setArchiveOutput(null);
    patch({
      vid: targetVid,
      publishMode: "append",
      visibility: detail.archive.isOnlySelf ? "onlySelf" : "public",
      isOnlySelf: detail.archive.isOnlySelf ? 1 : 0
    });
  }

  async function readArchive() {
    await readArchiveByVid(draft.vid || "");
  }

  async function readArchiveByVid(vid: string) {
    const targetVid = vid.trim();
    if (!targetVid) {
      setArchiveOutput("需要先填 BV 或 av 号。");
      return;
    }
    const cached = remoteArchiveCache[targetVid];
    if (cached) {
      applyRemoteArchive(targetVid, cached);
      setLoginMessage(`已从缓存读取 ${targetVid} 的分 P。`);
      return;
    }
    setLoadingArchiveVid(targetVid);
    setBusy(true);
    try {
      const result = await loadArchiveDetail({ cookiePath: draft.cookiePath || tools?.cookiePath, vid: targetVid });
      if (result.archive && result.videos) {
        const nextArchive: RemoteArchiveDetail = { archive: result.archive, videos: result.videos };
        setRemoteArchiveCache((prev) => ({ ...prev, [targetVid]: nextArchive }));
        applyRemoteArchive(targetVid, nextArchive);
      } else {
        setArchiveOutput(result.output || result.message || "");
      }
      setLoginMessage(result.command || null);
    } catch (err) {
      setArchiveOutput(readableError(err));
    } finally {
      setBusy(false);
      setLoadingArchiveVid(null);
    }
  }

  async function autoDetectHistoryParts(items: UploadHistoryItem[]) {
    if (!items.length) return;
    setHistoryDetecting(true);
    let nextCache = remoteArchiveCache;
    let selected = Boolean(remoteArchive?.archive.bvid);
    try {
      for (const item of items) {
        if (!item.bvid) continue;
        let detail = nextCache[item.bvid];
        if (!detail) {
          setLoadingArchiveVid(item.bvid);
          const result = await loadArchiveDetail({ cookiePath: draft.cookiePath || tools?.cookiePath, vid: item.bvid });
          if (result.archive && result.videos) {
            detail = { archive: result.archive, videos: result.videos };
            nextCache = { ...nextCache, [item.bvid]: detail };
            setRemoteArchiveCache(nextCache);
          }
        }
        if (!selected && detail?.videos.length) {
          applyRemoteArchive(item.bvid, detail);
          selected = true;
        }
      }
      setLoginMessage(selected ? "历史稿件分 P 已自动识别并展示。" : "历史稿件已识别，未发现可展示的历史分 P。");
    } catch (err) {
      setArchiveOutput(readableError(err));
    } finally {
      setHistoryDetecting(false);
      setLoadingArchiveVid(null);
    }
  }

  async function preloadHistoryParts() {
    if (!historyItems.length) {
      setArchiveOutput("请先读取历史稿件。");
      return;
    }
    await autoDetectHistoryParts(historyItems);
  }

  const historyDetectedCount = historyItems.filter((item) => remoteArchiveCache[item.bvid]).length;
  const historyHasDetectedParts = historyItems.some((item) => Boolean(remoteArchiveCache[item.bvid]?.videos.length));
  const historyDetectionComplete = Boolean(historyItems.length) && historyDetectedCount >= historyItems.length;
  const showHistoryEmpty = historyDetectionComplete && !historyHasDetectedParts && !remoteArchive;
  const historyWorking = historyLoading || historyDetecting;

  if (!context) {
    return <EmptyState icon={<Upload />} title="选择视频后编辑投稿设置" />;
  }

  return (
    <div className="upload-layout">
      <section className="upload-main">
        <div className="section-head">
          <div>
            <span className="eyebrow">B 站投稿设置</span>
            <h2>{context.room.name}</h2>
          </div>
          <button className="primary" onClick={saveDraft} disabled={busy}>
            <Save size={16} />保存草稿
          </button>
        </div>

        <div className="form-grid">
          <label>
            投稿方式
            <select value={draft.publishMode || "upload"} onChange={(event) => patch({ publishMode: event.target.value as UploadDraft["publishMode"] })}>
              <option value="upload">新稿件多 P</option>
              <option value="append">追加到已有稿件</option>
            </select>
          </label>
          <label>
            可见范围
            <select value={draft.visibility || "public"} onChange={(event) => patch({ visibility: event.target.value as UploadDraft["visibility"], isOnlySelf: event.target.value === "onlySelf" ? 1 : 0 })}>
              <option value="public">公开可见</option>
              <option value="onlySelf">仅自己可见</option>
            </select>
          </label>
          {draft.publishMode === "append" ? (
            <label className="span-2">
              目标稿件 BV / av
              <input value={draft.vid || ""} placeholder="例如 BV1xxp8z4EWa 或 av123" onChange={(event) => patch({ vid: event.target.value })} />
            </label>
          ) : null}
          <label className="span-2">
            标题
            <input value={draft.title || ""} maxLength={80} onChange={(event) => patch({ title: event.target.value })} />
          </label>
          <label>
            分区 tid
            <input type="number" value={draft.tid || 0} onChange={(event) => patch({ tid: Number(event.target.value) })} />
          </label>
          <label>
            投稿线路
            <select value={draft.line || "auto"} onChange={(event) => patch({ line: event.target.value })}>
              <option value="auto">auto</option>
              <option value="bda2">bda2</option>
              <option value="qn">qn</option>
              <option value="tx">tx</option>
              <option value="ws">ws</option>
            </select>
          </label>
          <label>
            版权
            <select value={draft.copyright || 1} onChange={(event) => patch({ copyright: Number(event.target.value) })}>
              <option value={1}>自制</option>
              <option value={2}>转载</option>
            </select>
          </label>
          <label>
            来源
            <input value={draft.source || ""} onChange={(event) => patch({ source: event.target.value })} />
          </label>
          <label className="span-2">
            标签
            <input value={draft.tag || ""} onChange={(event) => patch({ tag: event.target.value })} />
          </label>
          <label className="span-2">
            简介
            <textarea value={draft.desc || ""} onChange={(event) => patch({ desc: event.target.value })} />
          </label>
          <label>
            动态
            <input value={draft.dynamic || ""} onChange={(event) => patch({ dynamic: event.target.value })} />
          </label>
          <label>
            定时发布
            <input type="datetime-local" value={draft.dtime || ""} onChange={(event) => patch({ dtime: event.target.value })} />
          </label>
          <label className="span-2">
            封面
            <input value={draft.cover || ""} onChange={(event) => patch({ cover: event.target.value })} />
          </label>
          <label className="span-2">
            Cookie 文件
            <input value={draft.cookiePath || tools?.cookiePath || ""} onChange={(event) => patch({ cookiePath: event.target.value })} />
          </label>
        </div>

        <div className="switch-grid">
          <Switch checked={Boolean(draft.noReprint)} label="禁止转载" onChange={(value) => patch({ noReprint: value ? 1 : 0 })} />
          <Switch checked={Boolean(draft.openElec)} label="充电入口" onChange={(value) => patch({ openElec: value ? 1 : 0 })} />
          <Switch checked={Boolean(draft.dolby)} label="杜比音效" onChange={(value) => patch({ dolby: value ? 1 : 0 })} />
          <Switch checked={Boolean(draft.hires)} label="Hi-Res" onChange={(value) => patch({ hires: value ? 1 : 0 })} />
          <Switch checked={Boolean(draft.subtitleOpen)} label="开启字幕" onChange={(value) => patch({ subtitleOpen: value ? 1 : 0 })} />
          <Switch checked={Boolean(draft.upCloseDanmu)} label="关闭弹幕" onChange={(value) => patch({ upCloseDanmu: value })} />
          <Switch checked={Boolean(draft.upCloseReply)} label="关闭评论" onChange={(value) => patch({ upCloseReply: value })} />
          <Switch checked={Boolean(draft.upSelectionReply)} label="精选评论" onChange={(value) => patch({ upSelectionReply: value })} />
          <Switch checked={Boolean(draft.autoSubmit)} label="全自动投稿" onChange={(value) => patch({ autoSubmit: value })} />
        </div>

        {remoteArchive ? (
          <RemoteArchiveParts archive={remoteArchive.archive} parts={remoteArchive.videos} />
        ) : historyLoading ? (
          <RemoteArchiveStatus title="正在读取历史稿件" message="已检测到 Cookie，正在从 B 站读取历史稿件并识别分 P。" />
        ) : historyDetecting ? (
          <RemoteArchiveStatus title="正在识别历史分 P" message={`已识别 ${historyDetectedCount}/${historyItems.length} 个历史稿件。`} />
        ) : showHistoryEmpty ? (
          <RemoteArchiveStatus title="未发现历史分 P" message="当前历史稿件没有可展示的分 P，可以继续作为新稿件投稿。" />
        ) : null}

        <div className="part-manager">
          <div className="part-manager-head">
            <div className="panel-title">
              <ListVideo size={18} />
              <h3>{remoteArchive && draft.publishMode === "append" ? "待追加分 P" : "分 P 队列"}</h3>
              <span>{draft.parts?.length || 0}</span>
            </div>
            <div className="card-actions">
              <button className="primary" onClick={addPart}>
                <Plus size={15} />添加分 P
              </button>
              <button onClick={rebuildRoomParts}>
                <RefreshCw size={15} />从房间重建
              </button>
            </div>
          </div>
          <div className="bili-part-list">
            {(draft.parts || []).map((part, index) => {
              const displayIndex = remoteArchive && draft.publishMode === "append" ? remoteArchive.videos.length + index + 1 : index + 1;
              return (
              <div className={`bili-part-row ${part.path ? "ready" : "missing"}`} key={part.id}>
                <div className="bili-part-badge">
                  <span>P{displayIndex}</span>
                </div>
                <div className="bili-part-body">
                  <input
                    className="bili-part-title"
                    aria-label={`P${displayIndex} 标题`}
                    value={part.title}
                    onChange={(event) => patchPart(part.id, { title: event.target.value })}
                  />
                  <div className="bili-part-state">
                    <BadgeCheck size={16} />
                    <span>{part.path ? draft.publishMode === "append" ? "待追加" : "已加入队列" : "等待选择视频"}</span>
                  </div>
                  <input
                    className="bili-part-path"
                    aria-label={`P${displayIndex} 本地视频路径`}
                    value={part.path}
                    placeholder="本地视频路径"
                    onChange={(event) => patchPart(part.id, { path: event.target.value })}
                  />
                  <div className="bili-part-progress">
                    <span />
                  </div>
                </div>
                <div className="bili-part-actions">
                  <button onClick={() => replacePartPath(part)} title={`更换 P${displayIndex} 视频`}>
                    <RefreshCw size={17} />更换视频
                  </button>
                  <button className="icon-button" onClick={() => removePart(part.id)} title={`移除 P${displayIndex}`}>
                    <X size={18} />
                  </button>
                </div>
              </div>
              );
            })}
            {!(draft.parts || []).length ? <div className="empty-mini">暂无分 P</div> : null}
          </div>
        </div>
      </section>

      <aside className="upload-side">
        <div className="panel">
          <div className="panel-title">
            <BadgeCheck size={18} />
            <h3>登录</h3>
            <span>{tools?.biliup ? tools.biliupSource === "workspace" ? "本地可用" : "系统可用" : "未安装"}</span>
          </div>
          <div className="qr-box">
            <Sparkles size={40} />
            <span>{tools?.cookieExists ? "Cookie 已存在" : "扫码登录入口"}</span>
          </div>
          {!tools?.biliup ? (
            <button className="wide" onClick={installLocalBiliup} disabled={busy || job?.status === "running"}>
              {job?.type === "install-biliup" && job.status === "running" ? <Loader2 className="spin" size={16} /> : <Download size={16} />}
              安装本地 biliup
            </button>
          ) : null}
          <button className="primary wide" onClick={login} disabled={busy || !tools?.biliup}>
            {busy ? <Loader2 className="spin" size={16} /> : <Send size={16} />}
            打开扫码终端
          </button>
          {loginMessage ? <p className="tool-message">{loginMessage}</p> : null}
          {job ? <JobStatus job={job} /> : null}
          {tools ? <small>Cookie 文件：{tools.cookiePath}</small> : null}
          {tools?.workspaceInstallPath ? <small>本地安装目录：{tools.workspaceInstallPath}</small> : null}
        </div>

        <div className="panel">
          <div className="panel-title">
            <Settings2 size={18} />
            <h3>biliup 能力</h3>
            <span>{tools?.biliupVersion || `已测 ${tools?.testedBiliupVersion || "1.1.29"}`}</span>
          </div>
          <div className="capability-list">
            <span>多文件新稿件分 P</span>
            <span>append 追加分 P</span>
            <span>list/show 查看历史稿件</span>
            <span>--is-only-self 仅自己可见</span>
          </div>
          <div className="card-actions">
            <button onClick={previewCommand} disabled={busy}>
              <Download size={15} />生成命令
            </button>
            <button onClick={runPreflight} disabled={busy}>
              <BadgeCheck size={15} />预检
            </button>
            <button onClick={runUpload} disabled={busy || !draft.autoSubmit}>
              <Send size={15} />执行
            </button>
          </div>
          {preflight ? <PreflightResult result={preflight} /> : null}
          {commandPreview ? <pre className="command-box">{commandPreview}</pre> : null}
        </div>

        <div className="panel">
          <div className="panel-title">
            <ListVideo size={18} />
            <h3>稿件管理</h3>
            <span>{historyLoading ? "读取中" : historyDetecting ? `${historyDetectedCount}/${historyItems.length}` : "需 cookie"}</span>
          </div>
          <div className="card-actions">
            <button onClick={readHistory} disabled={busy || historyWorking}>{historyLoading ? "读取中" : historyDetecting ? "识别中" : "历史稿件"}</button>
            <button onClick={readArchive} disabled={busy || !draft.vid}>已有分 P</button>
            <button onClick={preloadHistoryParts} disabled={busy || historyWorking || !historyItems.length}>重新识别</button>
          </div>
          {historyItems.length ? (
            <div className="archive-list">
              {historyItems.map((item) => (
                <HistoryArchiveItem
                  key={item.bvid}
                  item={item}
                  detail={remoteArchiveCache[item.bvid]}
                  active={remoteArchive?.archive.bvid === item.bvid}
                  loading={loadingArchiveVid === item.bvid}
                  onOpen={() => void readArchiveByVid(item.bvid)}
                />
              ))}
            </div>
          ) : null}
          {archiveOutput ? <pre className="command-box">{archiveOutput}</pre> : null}
        </div>

        <div className="panel">
          <div className="panel-title">
            <Scissors size={18} />
            <h3>待投稿切片</h3>
            <span>{clips.length}</span>
          </div>
          <div className="publish-list">
            {clips.map((clip) => (
              <div key={clip.id}>
                <strong>{clip.title}</strong>
                <span>
                  {formatTime(clip.start)} - {formatTime(clip.end)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}

function HistoryArchiveItem({
  item,
  detail,
  active,
  loading,
  onOpen
}: {
  item: UploadHistoryItem;
  detail?: { archive: RemoteArchiveInfo; videos: RemoteArchivePart[] };
  active: boolean;
  loading: boolean;
  onOpen: () => void;
}) {
  const partLabel = loading ? "识别中" : detail ? detail.videos.length ? `${detail.videos.length} 分 P` : "无分 P" : "待识别";
  return (
    <div className={`archive-item ${active ? "active" : ""}`}>
      <button onClick={onOpen}>
        <strong>{item.bvid}</strong>
        <span>{item.title || "未命名稿件"}</span>
        {item.status ? <small>{item.status}</small> : null}
        <em>{partLabel}</em>
      </button>
    </div>
  );
}

function RemoteArchiveStatus({ title, message }: { title: string; message: string }) {
  return (
    <div className="part-manager remote-parts remote-parts-empty">
      <div className="part-manager-head">
        <div className="panel-title">
          <ListVideo size={18} />
          <h3>{title}</h3>
        </div>
      </div>
      <div className="empty-mini">{message}</div>
    </div>
  );
}

function RemoteArchiveParts({ archive, parts }: { archive: RemoteArchiveInfo; parts: RemoteArchivePart[] }) {
  return (
    <div className="part-manager remote-parts">
      <div className="part-manager-head">
        <div className="panel-title">
          <ListVideo size={18} />
          <h3>历史分 P（B站）</h3>
          <span>{parts.length}</span>
        </div>
        <div className="remote-archive-meta">
          <strong>{archive.bvid}</strong>
          {archive.title ? <span>{archive.title}</span> : null}
          <span>{archive.isOnlySelf ? "仅自己可见" : "公开可见"}</span>
        </div>
      </div>
      <div className="bili-part-list">
        {parts
          .slice()
          .sort((a, b) => a.index - b.index)
          .map((part) => (
            <div className={`bili-part-row remote ${part.failDesc ? "missing" : "ready"}`} key={`${archive.bvid}-${part.index}-${part.cid || part.title}`}>
              <div className="bili-part-badge">
                <span>P{part.index}</span>
              </div>
              <div className="bili-part-body">
                <div className="remote-part-title">{part.title || `P${part.index}`}</div>
                <div className="bili-part-state">
                  <BadgeCheck size={16} />
                  <span>{part.failDesc || part.statusDesc || "上传完成"}</span>
                </div>
                <div className="remote-part-detail">
                  {formatTime(part.duration)}
                  {part.cid ? ` · cid ${part.cid}` : ""}
                </div>
                <div className="bili-part-progress">
                  <span />
                </div>
              </div>
              <div className="bili-part-actions">
                <button disabled title="远端更换视频需要网页助手模式">
                  <RefreshCw size={17} />更换视频
                </button>
                <button className="icon-button" disabled title="远端删除分 P 需要网页助手模式">
                  <X size={18} />
                </button>
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}

function buildInitialUploadParts(context: VideoContext | null, clips: ClipDraft[], roomDetail: RoomDetail | null): UploadPart[] {
  const exported = clips
    .filter((clip) => clip.exportPath)
    .map((clip, index) => ({
      id: clip.id,
      title: clip.title || `P${index + 1}`,
      path: clip.exportPath || "",
      source: "clip"
    }));
  if (exported.length) return exported;
  const roomParts = buildRoomUploadParts(roomDetail, context);
  if (roomParts.length) return roomParts;
  if (!context) return [];
  return [
    {
      id: `source-${context.key}`,
      title: partTitleFromPath(context.name),
      path: context.path,
      source: "source"
    }
  ];
}

function buildRoomUploadParts(roomDetail: RoomDetail | null, context: VideoContext | null): UploadPart[] {
  const roomVideos = roomDetail?.videos || [];
  const readableVideos = roomVideos.filter((video) => Number(video.duration) > 0);
  const videos = readableVideos.length ? readableVideos : roomVideos;
  return [...videos]
    .sort(compareVideosForParts)
    .map((video) => ({
      id: `room-${video.key}`,
      title: partTitleFromPath(video.name),
      path: video.path,
      source: context?.key === video.key ? "selected-room" : "room"
    }));
}

function compareVideosForParts(a: VideoAsset, b: VideoAsset) {
  const aTime = videoSortTime(a);
  const bTime = videoSortTime(b);
  if (aTime !== bTime) return aTime - bTime;
  return a.name.localeCompare(b.name, "zh-Hans-CN");
}

function videoSortTime(video: VideoAsset) {
  const fromName = video.name.match(/(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/);
  if (fromName) {
    return Date.parse(`${fromName[1]}-${fromName[2]}-${fromName[3]}T${fromName[4]}:${fromName[5]}:${fromName[6]}`);
  }
  return Date.parse(video.mtime || "") || 0;
}

function partTitleFromPath(value: string) {
  return String(value || "未命名分 P").replace(/\.[^.\\/]+$/, "");
}

function JobStatus({ job }: { job: UploadJob }) {
  return (
    <div className={`job-box ${job.status}`}>
      <div>
        <strong>{job.message}</strong>
        <span>
          {job.type} · {job.status} · {job.progress}%
        </span>
      </div>
      {job.command ? <code>{job.command}</code> : null}
      {job.scriptPath ? <code>{job.scriptPath}</code> : null}
      {job.log ? <pre className="command-box">{job.log}</pre> : null}
    </div>
  );
}

function PreflightResult({ result }: { result: UploadPreflight }) {
  return (
    <div className={`preflight-box ${result.ok ? "ok" : "bad"}`}>
      <strong>{result.ok ? "预检通过" : "预检未通过"}</strong>
      {result.issues.length ? (
        <ul>
          {result.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      ) : null}
      {result.warnings.length ? (
        <ul>
          {result.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function TaskCenterView() {
  const [tasks, setTasks] = useState<WorkbenchTask[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const result = await loadTasks();
        if (!cancelled) {
          setTasks(result.tasks);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(readableError(err));
      }
    }
    void refresh();
    const id = window.setInterval(() => void refresh(), 1800);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const running = tasks.filter((task) => task.status === "running").length;
  const failed = tasks.filter((task) => task.status === "error").length;

  return (
    <div className="tasks-layout">
      <section className="upload-main">
        <div className="section-head">
          <div>
            <span className="eyebrow">任务中心</span>
            <h2>ASR、标题、封面、投稿日志</h2>
          </div>
          <div className="stat-row task-stats">
            <Metric label="运行中" value={running} />
            <Metric label="失败" value={failed} />
            <Metric label="总任务" value={tasks.length} />
          </div>
        </div>
        {error ? <div className="preflight-box bad">{error}</div> : null}
        <div className="task-grid">
          {tasks.map((task) => (
            <article key={`${task.source}-${task.id}`} className={`task-card ${task.status}`}>
              <div className="task-head">
                <div>
                  <strong>{task.label}</strong>
                  <span>{task.type} · {task.status} · {task.progress}%</span>
                </div>
                <em>{task.updatedAt ? formatDate(task.updatedAt) : ""}</em>
              </div>
              <p>{task.message}</p>
              <div className="task-progress">
                <span style={{ width: `${Math.max(0, Math.min(100, task.progress))}%` }} />
              </div>
              {task.outputPath ? <code>{task.outputPath}</code> : null}
              {task.command ? <code>{task.command}</code> : null}
              {task.log ? <pre className="command-box task-log">{task.log}</pre> : null}
            </article>
          ))}
          {!tasks.length ? <EmptyMini label="还没有任务；运行 ASR、生成标题/封面或投稿后会出现在这里。" /> : null}
        </div>
      </section>
    </div>
  );
}

function SettingsView({
  initial,
  asrTools,
  uploadTools,
  recordingRootCandidates,
  onSave,
  onPrepareAsr,
  onConvertFlv,
  onRefreshRoots,
  onTestVision
}: {
  initial: ServiceSettings | null;
  asrTools: LocalAsrStatus | null;
  uploadTools: UploadTools | null;
  recordingRootCandidates: RecordingRootCandidate[];
  onSave: (value: ServiceSettings) => Promise<void>;
  onPrepareAsr: (value: ServiceSettings) => Promise<unknown>;
  onConvertFlv: () => Promise<unknown>;
  onRefreshRoots: () => Promise<RecordingRootCandidate[]>;
  onTestVision: (value: ServiceSettings) => Promise<unknown>;
}) {
  const [value, setValue] = useState<ServiceSettings>(() => initial || defaultServiceSettings());
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [rootCandidates, setRootCandidates] = useState<RecordingRootCandidate[]>(recordingRootCandidates);

  useEffect(() => {
    if (initial) setValue(initial);
  }, [initial]);

  useEffect(() => {
    setRootCandidates(recordingRootCandidates);
  }, [recordingRootCandidates]);

  function patch(section: "asr" | "vision" | "cover" | "media", patchValue: Record<string, unknown>) {
    setValue((prev) => ({ ...prev, [section]: { ...prev[section], ...patchValue } }));
  }

  function applyAsrMode(mode: string) {
    if (mode === "funasr-local") {
      patch("asr", {
        mode,
        provider: "funasr-nano",
        model: "FunAudioLLM/Fun-ASR-Nano-2512",
        modelSize: "nano-2512"
      });
      return;
    }
    if (mode === "qwen3-local") {
      patch("asr", {
        mode,
        provider: "qwen3-asr-gguf",
        model: "HaujetZhao/Qwen3-ASR-GGUF",
        modelSize: value.asr.modelSize === "1.7B" ? "1.7B" : "0.6B"
      });
      return;
    }
    if (mode === "local-command") {
      patch("asr", { mode, provider: "custom-command" });
      return;
    }
    if (mode === "cloud-endpoint") {
      patch("asr", { mode, provider: "cloud-endpoint" });
      return;
    }
    patch("asr", { mode });
  }

  async function save() {
    setBusy("save");
    try {
      await onSave(value);
      setMessage("已保存到 .workbench/service-settings.json");
    } catch (err) {
      setMessage(readableError(err));
    } finally {
      setBusy(null);
    }
  }

  async function prepareLocalAsr() {
    setBusy("prepare-asr");
    try {
      await onPrepareAsr(value);
      setMessage("本地 ASR 模型准备任务已启动。可以切到任务中心看下载和安装日志。");
    } catch (err) {
      setMessage(readableError(err));
    } finally {
      setBusy(null);
    }
  }

  async function convertFlvNow() {
    setBusy("convert-flv");
    try {
      await onConvertFlv();
      setMessage("FLV 转 MP4 任务已启动。转换后列表会优先显示同名 MP4。");
    } catch (err) {
      setMessage(readableError(err));
    } finally {
      setBusy(null);
    }
  }

  async function refreshRootCandidates() {
    setBusy("refresh-roots");
    try {
      const candidates = await onRefreshRoots();
      setRootCandidates(candidates);
      setMessage(candidates.length ? `找到 ${candidates.length} 个候选录播目录。` : "没有自动找到候选目录，可以直接手填路径。");
    } catch (err) {
      setMessage(readableError(err));
    } finally {
      setBusy(null);
    }
  }

  async function testVisionNow() {
    setBusy("test-vision");
    try {
      const result = await onTestVision(value);
      setMessage(`视频理解接口可用：${JSON.stringify(result).slice(0, 240)}`);
    } catch (err) {
      setMessage(`视频理解接口失败：${readableError(err)}`);
    } finally {
      setBusy(null);
    }
  }

  const asrModeLabel = describeAsrMode(value.asr.mode);
  const usingQwen = value.asr.mode === "qwen3-local" || value.asr.provider === "qwen3-asr-gguf";
  const selectedQwenModel = asrTools?.qwen?.models.find((item) => item.size === value.asr.modelSize);
  const asrRuntimeSummary = asrTools?.torchInstalled
    ? `torch ${asrTools.torchVersion || "已安装"} / ${asrTools.cudaAvailable ? `GPU 可用（CUDA ${asrTools.torchBuild || "已启用"}）` : "当前走 CPU"}`
    : "还没装 torch";

  return (
    <div className="settings-layout">
      <section className="upload-main">
        <div className="section-head">
          <div>
            <span className="eyebrow">本地工具与外部模型</span>
            <h2>ASR、视频理解、封面和批量转码</h2>
          </div>
          <button className="primary" onClick={save} disabled={busy !== null}>
            {busy === "save" ? <Loader2 className="spin" size={16} /> : <Save size={16} />}保存设置
          </button>
        </div>

        <div className="settings-grid">
          <div className="settings-card wide-card">
            <div className="panel-title">
              <FolderOpen size={18} />
              <h3>录播目录</h3>
              <span>{value.recordingsRoot ? "自定义" : "未设置"}</span>
            </div>
            <p className="helper-text">这里填 blrec 保存录播文件的目录。换目录后保存并刷新素材库，房间列表会从新目录读取。</p>
            <label>
              目录路径
              <input value={value.recordingsRoot} onChange={(event) => setValue((prev) => ({ ...prev, recordingsRoot: event.target.value }))} />
            </label>
            <div className="button-row">
              <button onClick={() => void refreshRootCandidates()} disabled={busy !== null}>
                {busy === "refresh-roots" ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}重新识别候选目录
              </button>
            </div>
            {rootCandidates.length ? (
              <div className="root-candidate-list">
                {rootCandidates.map((candidate) => (
                  <button
                    key={candidate.path}
                    className={candidate.path === value.recordingsRoot ? "root-candidate active" : "root-candidate"}
                    onClick={() => setValue((prev) => ({ ...prev, recordingsRoot: candidate.path }))}
                  >
                    <strong>{candidate.label}</strong>
                    <span>{candidate.path}</span>
                    <small>
                      {candidate.exists ? `${candidate.roomCount} 房间 · ${candidate.videoCount} 视频` : "目录不存在"} · {candidate.reason}
                    </small>
                  </button>
                ))}
              </div>
            ) : (
              <p className="helper-text">没有候选目录时直接粘贴路径即可，例如 blrec 的“录播文件”目录。</p>
            )}
          </div>

          <div className="settings-card">
            <div className="panel-title">
              <ListVideo size={18} />
              <h3>本地 ASR</h3>
              <span>{asrModeLabel}</span>
            </div>
            <p className="helper-text">这里控制 ASR 按钮怎么生成可编辑字幕。Fun-ASR 的 GPU 看 Torch CUDA；Qwen3-ASR 主要走 DirectML/Vulkan，和 torch(cpu) 不是一回事。</p>
            <label>
              运行方式
              <select value={value.asr.mode} onChange={(event) => applyAsrMode(event.target.value)}>
                <option value="funasr-local">本地 Fun-ASR-Nano（已接通）</option>
                <option value="qwen3-local">本地 Qwen3-ASR-GGUF</option>
                <option value="extract-audio">只提取音频</option>
                <option value="local-command">运行自定义本地命令</option>
                <option value="cloud-endpoint">调用云端 ASR 接口</option>
              </select>
            </label>
            {value.asr.mode === "cloud-endpoint" || value.asr.mode === "local-command" ? (
              <label>
                模型名
                <input value={value.asr.model} onChange={(event) => patch("asr", { model: event.target.value })} />
              </label>
            ) : null}
            <label>
              模型规格
              <select value={value.asr.modelSize} onChange={(event) => patch("asr", { modelSize: event.target.value })}>
                {usingQwen ? (
                  <>
                    <option value="0.6B">0.6B</option>
                    <option value="1.7B">1.7B</option>
                  </>
                ) : (
                  <option value="nano-2512">Nano-2512</option>
                )}
              </select>
            </label>
            <label>
              运行设备
              <select value={value.asr.device} onChange={(event) => patch("asr", { device: event.target.value })}>
                <option value="auto">自动（优先 GPU）</option>
                <option value="cuda">强制 GPU（CUDA）</option>
                <option value="cpu">只用 CPU</option>
              </select>
            </label>
            <label>
              识别语言
              <input value={value.asr.language} onChange={(event) => patch("asr", { language: event.target.value })} />
            </label>
            <label>
              字幕格式
              <select value={value.asr.outputFormat} onChange={(event) => patch("asr", { outputFormat: event.target.value })}>
                <option value="srt">SRT</option>
                <option value="vtt">VTT</option>
              </select>
            </label>
            <label>
              长音频分块秒数
              <input type="number" min={15} max={300} value={value.asr.chunkSeconds} onChange={(event) => patch("asr", { chunkSeconds: Number(event.target.value) })} />
            </label>
            {usingQwen ? (
              <label>
                Qwen 上下文窗口
                <input type="number" min={1024} max={8192} step={512} value={value.asr.qwenContextTokens} onChange={(event) => patch("asr", { qwenContextTokens: Number(event.target.value) })} />
              </label>
            ) : null}
            <label>
              字幕写回方式
              <select value={value.asr.replaceMode} onChange={(event) => patch("asr", { replaceMode: event.target.value })}>
                <option value="range">替换本次识别范围</option>
                <option value="append">追加到现有字幕</option>
                <option value="all">清空旧字幕后写入</option>
              </select>
            </label>
            <div className="switch-grid tight">
              <Switch checked={value.asr.autoPrepareModel} label="识别前自动补齐模型" onChange={(checked) => patch("asr", { autoPrepareModel: checked })} />
            </div>
            {value.asr.mode === "local-command" ? (
              <label>
                本地命令模板
                <textarea value={value.asr.localCommand} onChange={(event) => patch("asr", { localCommand: event.target.value })} />
              </label>
            ) : null}
            {usingQwen ? (
              <details className="advanced-settings">
                <summary>高级：外部命令模板</summary>
                <label>
                  Qwen3 外部命令模板
                  <textarea value={value.asr.qwenCommand} onChange={(event) => patch("asr", { qwenCommand: event.target.value })} />
                </label>
                <small>正常不用填。工作台会优先使用 .workbench 里已安装并测试通过的 transcribe.exe，{"{nCtx}"} 会替换成上面的上下文窗口。</small>
              </details>
            ) : null}
            {value.asr.mode === "cloud-endpoint" ? (
              <>
                <label>
                  接口地址
                  <input value={value.asr.endpoint} onChange={(event) => patch("asr", { endpoint: event.target.value })} />
                </label>
                <label>
                  API Key
                  <input type="password" value={value.asr.apiKey} onChange={(event) => patch("asr", { apiKey: event.target.value })} />
                </label>
              </>
            ) : null}
            <div className="button-row">
              <button onClick={() => void prepareLocalAsr()} disabled={busy !== null || value.asr.mode === "extract-audio" || value.asr.mode === "cloud-endpoint" || value.asr.mode === "local-command"}>
                {busy === "prepare-asr" ? <Loader2 className="spin" size={15} /> : <Download size={15} />}{usingQwen ? "安装/下载 Qwen3-ASR" : "下载/检查当前模型"}
              </button>
            </div>
            <div className="status-list">
              <span>运行环境：{asrTools?.runtimeReady ? "已就绪" : "未就绪"}</span>
              <span>Fun-ASR：{asrTools?.funAsrInstalled ? "已安装" : "未安装"}</span>
              <span>Fun-ASR Torch：{asrRuntimeSummary}</span>
              {usingQwen ? <span>Qwen 工具：{asrTools?.qwen?.toolReady ? "已安装" : "未安装"}</span> : null}
              {usingQwen ? <span>Qwen {value.asr.modelSize}：{selectedQwenModel?.ready ? "模型已下载" : `缺 ${selectedQwenModel?.missingFiles.length || 0} 个文件`}</span> : null}
              {usingQwen ? <span>Qwen 加速：自动模式会使用 DirectML/Vulkan；只用 CPU 时会禁用它们。</span> : null}
              <span>已下载模型：{asrTools?.downloadedModels.length ? asrTools.downloadedModels.join(" / ") : "暂无"}</span>
            </div>
            <small>当前模型缓存：{asrTools?.cacheRoot || "E:/bil233/.workbench/models"}</small>
            {usingQwen ? <small>Qwen 工具：{asrTools?.qwen?.exePath || "尚未安装"}；模型目录：{selectedQwenModel?.path || asrTools?.qwen?.modelRoot || "尚未下载"}</small> : null}
            {asrTools?.notes?.length ? (
              <ul className="plain-list">
                {asrTools.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            ) : null}
          </div>

          <div className="settings-card">
            <div className="panel-title">
              <Bot size={18} />
              <h3>视频理解 / 标题</h3>
              <span>{value.vision.model || "未设置"}</span>
            </div>
            <p className="helper-text">AI 切片标题、切片理由增强会优先走这里。你给的本地接口默认就是这块。</p>
            <label>
              接口类型
              <select value={value.vision.provider} onChange={(event) => patch("vision", { provider: event.target.value })}>
                <option value="openai-compatible">OpenAI 兼容接口</option>
                <option value="custom-json">自定义 JSON 接口</option>
                <option value="manual">只用本地规则</option>
              </select>
            </label>
            <label>
              接口地址
              <input value={value.vision.endpoint} onChange={(event) => patch("vision", { endpoint: event.target.value })} />
            </label>
            <label>
              API Key
              <input type="password" value={value.vision.apiKey} onChange={(event) => patch("vision", { apiKey: event.target.value })} />
            </label>
            <label>
              模型名
              <input value={value.vision.model} onChange={(event) => patch("vision", { model: event.target.value })} />
            </label>
            <div className="switch-grid tight">
              <Switch checked={value.vision.sendFrames} label="把截图发给模型" onChange={(checked) => patch("vision", { sendFrames: checked })} />
              <Switch checked={value.vision.sendAudio} label="把音频发给模型" onChange={(checked) => patch("vision", { sendAudio: checked })} />
              <Switch checked={value.vision.sendSubtitles} label="把字幕发给模型" onChange={(checked) => patch("vision", { sendSubtitles: checked })} />
              <Switch checked={value.vision.sendDanmaku} label="把弹幕发给模型" onChange={(checked) => patch("vision", { sendDanmaku: checked })} />
            </div>
            <div className="button-row">
              <button onClick={() => void testVisionNow()} disabled={busy !== null}>
                {busy === "test-vision" ? <Loader2 className="spin" size={15} /> : <Bot size={15} />}测试视频理解接口
              </button>
            </div>
          </div>

          <div className="settings-card">
            <div className="panel-title">
              <Sparkles size={18} />
              <h3>封面生成</h3>
              <span>{value.cover.provider}</span>
            </div>
            <p className="helper-text">没配图像接口时，会退回本地模板封面：抽帧 + 标题排版。</p>
            <label>
              生成方式
              <select value={value.cover.provider} onChange={(event) => patch("cover", { provider: event.target.value })}>
                <option value="frame-template">本地模板封面</option>
                <option value="custom-json">外部图像接口</option>
                <option value="openai-compatible">OpenAI 兼容接口</option>
              </select>
            </label>
            <label>
              接口地址
              <input value={value.cover.endpoint} onChange={(event) => patch("cover", { endpoint: event.target.value })} />
            </label>
            <label>
              API Key
              <input type="password" value={value.cover.apiKey} onChange={(event) => patch("cover", { apiKey: event.target.value })} />
            </label>
            <label>
              模型名
              <input value={value.cover.model} onChange={(event) => patch("cover", { model: event.target.value })} />
            </label>
            <label>
              封面风格提示
              <textarea value={value.cover.stylePrompt} onChange={(event) => patch("cover", { stylePrompt: event.target.value })} />
            </label>
          </div>

          <div className="settings-card">
            <div className="panel-title">
              <Wand2 size={18} />
              <h3>批量转码</h3>
              <span>FLV 转 MP4</span>
            </div>
            <p className="helper-text">这个是录播目录批量整理，不是浏览器预览。转换后房间列表会优先展示同名 MP4。</p>
            <label>
              输出位置
              <select value={value.media.flvOutputMode} onChange={(event) => patch("media", { flvOutputMode: event.target.value })}>
                <option value="same-dir">原目录同名 MP4</option>
                <option value="compressed-dir">原目录下 _compressed 子目录</option>
              </select>
            </label>
            <div className="switch-grid tight">
              <Switch checked={value.media.skipIfMp4Exists} label="已有 MP4 就跳过" onChange={(checked) => patch("media", { skipIfMp4Exists: checked })} />
              <Switch checked={value.media.deleteSourceAfterConvert} label="转完删除原 FLV" onChange={(checked) => patch("media", { deleteSourceAfterConvert: checked })} />
            </div>
            <div className="button-row">
              <button onClick={() => void convertFlvNow()} disabled={busy !== null}>
                {busy === "convert-flv" ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}转换录播目录全部 FLV
              </button>
            </div>
          </div>

          <div className="settings-card">
            <div className="panel-title">
              <Upload size={18} />
              <h3>投稿工具</h3>
              <span>{uploadTools?.biliup ? "biliup 可用" : "未安装"}</span>
            </div>
            <div className="capability-list">
              <span>已实测：多文件分 P 上传</span>
              <span>已实测：追加到已有稿件</span>
              <span>已实测：历史稿件 / 已有分 P 读取</span>
              <span>已实测：仅自己可见</span>
            </div>
            <small>当前路径：{uploadTools?.biliupPath || "系统 PATH 里还没找到 biliup"}</small>
          </div>
        </div>
        {message ? <p className="tool-message">{message}</p> : null}
      </section>
    </div>
  );
}

function defaultServiceSettings(): ServiceSettings {
  return {
    recordingsRoot: "",
    asr: {
      mode: "funasr-local",
      provider: "funasr-nano",
      model: "FunAudioLLM/Fun-ASR-Nano-2512",
      modelSize: "nano-2512",
      endpoint: "",
      apiKey: "",
      localCommand: 'faster-whisper "{audio}" --model "{model}" --language "{language}" --output_format srt --output_dir "{outDir}"',
      qwenCommand: '".workbench\\tools\\qwen3-asr-release\\Qwen3-ASR-Transcribe\\transcribe.exe" "{audio}" --model-dir ".workbench\\models\\qwen3-asr-gguf" --n-ctx "{nCtx}" --quiet -y',
      language: "zh",
      outputFormat: "srt",
      device: "auto",
      autoPrepareModel: true,
      chunkSeconds: 60,
      qwenContextTokens: 4096,
      defaultScope: "selection",
      replaceMode: "range"
    },
    vision: {
      provider: "openai-compatible",
      endpoint: "http://localhost:8317/v1",
      apiKey: "your-api-key-1",
      model: "gpt-5.4",
      sendFrames: true,
      sendAudio: false,
      sendSubtitles: true,
      sendDanmaku: true
    },
    cover: {
      provider: "frame-template",
      endpoint: "",
      apiKey: "",
      model: "",
      stylePrompt: "清晰、有标题空间、适合 B 站直播切片封面"
    },
    media: {
      flvOutputMode: "same-dir",
      deleteSourceAfterConvert: false,
      skipIfMp4Exists: true
    }
  };
}

function describeAsrMode(mode: string) {
  if (mode === "funasr-local") return "本地 Fun-ASR";
  if (mode === "qwen3-local") return "本地 Qwen3-ASR-GGUF";
  if (mode === "cloud-endpoint") return "云端 ASR";
  if (mode === "local-command") return "自定义命令";
  if (mode === "extract-audio") return "只提取音频";
  return mode || "未设置";
}

function Timeline({
  bins,
  duration,
  currentTime,
  selection,
  candidates,
  onSeek
}: {
  bins: HistogramBin[];
  duration: number;
  currentTime: number;
  selection: { start: number; end: number };
  candidates: ClipCandidate[];
  onSeek: (time: number) => void;
}) {
  const width = 1100;
  const height = 120;
  const safeDuration = Math.max(1, duration);

  return (
    <svg
      className="timeline"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        onSeek(((event.clientX - rect.left) / rect.width) * safeDuration);
      }}
    >
      <rect className="timeline-bg" x="0" y="0" width={width} height={height} />
      {candidates.map((candidate) => (
        <rect
          key={candidate.id}
          className="candidate-span"
          x={(candidate.start / safeDuration) * width}
          y="0"
          width={Math.max(2, ((candidate.end - candidate.start) / safeDuration) * width)}
          height={height}
        />
      ))}
      <rect
        className="selection-span"
        x={(selection.start / safeDuration) * width}
        y="0"
        width={Math.max(2, ((selection.end - selection.start) / safeDuration) * width)}
        height={height}
      />
      {bins.map((bin) => {
        const x = (bin.start / safeDuration) * width;
        const barWidth = Math.max(1, ((bin.end - bin.start) / safeDuration) * width - 1);
        const barHeight = Math.max(2, (bin.score / 100) * 82);
        return <rect key={bin.index} className="bar" x={x} y={height - barHeight - 20} width={barWidth} height={barHeight} />;
      })}
      <line className="playhead" x1={(currentTime / safeDuration) * width} x2={(currentTime / safeDuration) * width} y1="0" y2={height} />
      <text x="12" y="22">
        {formatTime(currentTime)} / {formatTime(duration)}
      </text>
    </svg>
  );
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return <span className={`status-pill ${ok ? "ok" : "bad"}`}>{label}</span>;
}

function CoverImage({ src, label }: { src: string | null | undefined; label: string }) {
  if (!src) {
    return (
      <span className="cover-fallback" aria-hidden="true">
        {label.slice(0, 2)}
      </span>
    );
  }
  return <img src={src} alt="" />;
}

function Switch({ checked, label, onChange }: { checked: boolean; label: string; onChange: (value: boolean) => void }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function LoadingBlock({ label }: { label: string }) {
  return (
    <div className="loading-block">
      <Loader2 className="spin" size={22} />
      <span>{label}</span>
    </div>
  );
}

function EmptyState({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="empty-state">
      {icon}
      <h2>{title}</h2>
    </div>
  );
}

function EmptyMini({ label }: { label: string }) {
  return <div className="empty-mini">{label}</div>;
}

function shiftAsrCues(cues: SubtitleCue[], offset: number, idPrefix: string) {
  return cues.map((cue, index) => ({
    ...cue,
    id: `${idPrefix}-${index}-${cue.id}`,
    start: roundTime(cue.start + offset),
    end: roundTime(cue.end + offset),
    source: cue.source || "asr"
  }));
}

function toggleValue(values: string[], value: string) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function readableError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return "0:00";
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}` : `${minutes}:${String(secs).padStart(2, "0")}`;
}

function roundTime(seconds: number) {
  return Math.round((seconds || 0) * 10) / 10;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知时间";
  return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}
