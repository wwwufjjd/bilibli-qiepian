import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  BadgeCheck,
  Bot,
  Clapperboard,
  Clock3,
  Trash2,
  Download,
  Film,
  FolderOpen,
  ImageIcon,
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
  Square,
  Wand2,
  X
} from "lucide-react";
import {
  addFixedRoom,
  convertAllFlv,
  deleteFixedRoom,
  deleteMaterialRoom,
  extractCover,
  generateClipTitle,
  generateCover,
  generateUploadCommand,
  getAsrJob,
  getUploadJob,
  getJson,
  installBiliup,
  loadFixedRooms,
  loadAutomationJobs,
  loadArchiveDetail,
  loadPreviewStatus,
  loadRecordingEvents,
  loadRecordingMonitorStatus,
  loadRecordingRootCandidates,
  loadSettings,
  loadTasks,
  loadUploadHistory,
  packageModelAssets,
  preflightUpload,
  postJson,
  postRecordingRoomAction,
  prepareAsrModel,
  requestSliceCandidates,
  saveServiceSettings,
  saveUploadDraft,
  runBiliupUpload,
  startBiliupLogin,
  startAsr,
  startPreview,
  testVisionSettings,
  updateFixedRoom
} from "./api";
import type {
  AiSliceDiagnostics,
  AutomationJob,
  ClipCandidate,
  ClipDraft,
  DanmakuItem,
  FixedRoom,
  HistogramBin,
  LocalAsrStatus,
  PreviewStatus,
  RecordingEvent,
  RecordingMonitorStatus,
  RecordingRoomStatus,
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

type AsrAvailability = {
  canTranscribe: boolean;
  label: string;
  message: string;
};

type RemoteArchiveDetail = {
  archive: RemoteArchiveInfo;
  videos: RemoteArchivePart[];
};

type AutomationSummary = {
  total: number;
  running: number;
  ready: number;
  accepted: number;
  exported: number;
  filtered: number;
  blocked: number;
  lastStage: string;
  lastMessage: string;
  latestJob: AutomationJob | null;
};

type View = "library" | "workspace" | "upload" | "tasks" | "settings";

const emptyProject: ProjectState = {
  clips: [],
  danmakuEdits: {},
  subtitles: null,
  updatedAt: null
};

const hiddenMaterialRoomsStorageKey = "bilive.hiddenMaterialRooms.v1";

function readLocalHiddenMaterialRooms() {
  try {
    return new Set(JSON.parse(localStorage.getItem(hiddenMaterialRoomsStorageKey) || "[]").map((item: unknown) => String(item)));
  } catch {
    return new Set<string>();
  }
}

function rememberLocalHiddenMaterialRoom(roomKey: string) {
  const hidden = readLocalHiddenMaterialRooms();
  hidden.add(roomKey);
  localStorage.setItem(hiddenMaterialRoomsStorageKey, JSON.stringify([...hidden]));
}

function filterVisibleMaterialRooms(rooms: Room[]) {
  const hidden = readLocalHiddenMaterialRooms();
  return rooms.filter((room) => !hidden.has(room.key));
}

function materialRoomMembers(room: Room): Room[] {
  return room.materialRooms?.length ? room.materialRooms : [room];
}

function compareLatestMaterial(a: Room, b: Room) {
  const at = a.latestVideo ? Date.parse(a.latestVideo.mtime) : 0;
  const bt = b.latestVideo ? Date.parse(b.latestVideo.mtime) : 0;
  return bt - at;
}

function groupMaterialRooms(rooms: Room[]): Room[] {
  const grouped = new Map<string, Room[]>();
  const loose: Room[] = [];
  for (const room of rooms) {
    if (!room.roomId) {
      loose.push(room);
      continue;
    }
    const list = grouped.get(room.roomId) || [];
    list.push(room);
    grouped.set(room.roomId, list);
  }
  const merged = [...grouped.values()].map((list) => {
    const sorted = [...list].sort(compareLatestMaterial);
    const primary = sorted[0];
    if (sorted.length === 1) return primary;
    const latestVideo = sorted.find((room) => room.latestVideo)?.latestVideo || null;
    return {
      ...primary,
      key: `group-${primary.roomId}`,
      path: primary.path,
      folderName: `${sorted.length} 个素材目录`,
      name: primary.name || sorted.find((room) => room.name)?.name || `房间 ${primary.roomId}`,
      videoCount: sorted.reduce((count, room) => count + (room.videoCount || 0), 0),
      xmlCount: sorted.reduce((count, room) => count + (room.xmlCount || 0), 0),
      latestVideo,
      coverUrl: primary.coverUrl || sorted.find((room) => room.coverUrl)?.coverUrl || null,
      materialRooms: sorted
    };
  });
  return [...merged, ...loose].sort(compareLatestMaterial);
}

function materialGroupForRoomId(rooms: Room[], roomId: string) {
  return groupMaterialRooms(rooms).find((room) => room.roomId && room.roomId === roomId) || null;
}

function mergeRoomDetails(group: Room, details: RoomDetail[]): RoomDetail {
  const seen = new Set<string>();
  const videos = details
    .flatMap((detail) => detail.videos)
    .filter((video) => {
      if (seen.has(video.key)) return false;
      seen.add(video.key);
      return true;
    })
    .sort((a, b) => Date.parse(b.mtime || "0") - Date.parse(a.mtime || "0"));
  return {
    key: group.key,
    path: group.path,
    folderName: group.folderName,
    roomId: group.roomId,
    name: group.name,
    videos,
    xmlFiles: details.reduce((count, detail) => count + (detail.xmlFiles || 0), 0),
    subtitleFiles: details.reduce((count, detail) => count + (detail.subtitleFiles || 0), 0)
  };
}

export function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const monitorRequestSeq = useRef(0);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [fixedRooms, setFixedRooms] = useState<FixedRoom[]>([]);
  const [automationJobs, setAutomationJobs] = useState<AutomationJob[]>([]);
  const [recordingMonitor, setRecordingMonitor] = useState<RecordingMonitorStatus | null>(null);
  const [recordingMonitorError, setRecordingMonitorError] = useState<string | null>(null);
  const [recordingEvents, setRecordingEvents] = useState<RecordingEvent[]>([]);
  const [recordingSummary, setRecordingSummary] = useState<(RecordingRoomStatus & { roomId: string }) | null>(null);
  const [roomDetail, setRoomDetail] = useState<RoomDetail | null>(null);
  const [selectedVideo, setSelectedVideo] = useState<VideoAsset | null>(null);
  const [context, setContext] = useState<VideoContext | null>(null);
  const [project, setProject] = useState<ProjectState>(emptyProject);
  const [previewStatus, setPreviewStatus] = useState<PreviewStatus | null>(null);
  const [activeView, setActiveView] = useState<View>("library");
  const [query, setQuery] = useState("");
  const [roomMediaQuery, setRoomMediaQuery] = useState("");
  const [danmakuQuery, setDanmakuQuery] = useState("");
  const [currentTime, setCurrentTime] = useState(0);
  const [selectionStart, setSelectionStart] = useState(0);
  const [selectionEnd, setSelectionEnd] = useState(90);
  const [sources, setSources] = useState<string[]>(["danmaku"]);
  const [clipDuration, setClipDuration] = useState(90);
  const [clipCount, setClipCount] = useState(5);
  const [candidates, setCandidates] = useState<ClipCandidate[]>([]);
  const [sliceDiagnostics, setSliceDiagnostics] = useState<AiSliceDiagnostics | null>(null);
  const [selectedMaterialVideoKeys, setSelectedMaterialVideoKeys] = useState<string[]>([]);
  const [asrComparison, setAsrComparison] = useState<AsrComparison | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeRecordingKey = useMemo(
    () =>
      fixedRooms
        .filter((room) => ["starting", "waiting", "recording", "finalizing"].includes(String(room.taskStatus || "")))
        .map((room) => `${room.roomId}:${room.taskStatus}`)
        .join("|"),
    [fixedRooms]
  );
  const activeRecordingPaths = useMemo(
    () =>
      fixedRooms
        .filter((room) => ["recording", "finalizing"].includes(String(room.taskStatus || "")) && room.recordingPath)
        .map((room) => normalizeComparePath(room.recordingPath)),
    [fixedRooms]
  );
  const selectedVideoIsActiveRecording = isActiveRecordingVideo(selectedVideo, activeRecordingPaths);

  async function loadRecordingMonitorStatusSafe() {
    try {
      const payload = await loadRecordingMonitorStatus();
      setRecordingMonitorError(null);
      return payload;
    } catch (err) {
      setRecordingMonitorError(readableError(err));
      setRecordingMonitor(null);
      return null;
    }
  }

  useEffect(() => {
    void bootstrap();
  }, []);

  useEffect(() => {
    const automation = settings?.serviceSettings.automation;
    if (!automation) return;
    setSources(automation.sources?.length ? automation.sources : ["danmaku"]);
    setClipDuration(automation.clipDuration || 90);
    setClipCount(automation.clipCount || 3);
  }, [
    settings?.serviceSettings.automation.sources,
    settings?.serviceSettings.automation.clipDuration,
    settings?.serviceSettings.automation.clipCount
  ]);

  useEffect(() => {
    const id = window.setInterval(() => {
      void refreshAutomationJobs();
    }, 7000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!activeRecordingKey) return;
    let cancelled = false;
    async function refreshRunningRooms() {
      try {
        const [fixedRoomPayload, eventPayload] = await Promise.all([
          loadFixedRooms({ enrich: false }),
          loadRecordingEvents(8).catch(() => ({ events: recordingEvents }))
        ]);
        if (cancelled) return;
        setFixedRooms(fixedRoomPayload.rooms);
        setRecordingEvents(eventPayload.events || []);
        setRecordingSummary((prev) => {
          if (!prev) return prev;
          return fixedRoomPayload.rooms.find((room) => room.roomId === prev.roomId) || prev;
        });
      } catch {
        // Keep the current recording card visible; the next poll can recover.
      }
    }
    void refreshRunningRooms();
    const id = window.setInterval(() => void refreshRunningRooms(), 1800);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [activeRecordingKey]);

  useEffect(() => {
    const recordingSettings = settings?.serviceSettings.recording;
    if (!recordingSettings || recordingSettings.autoMonitorEnabled === false) return;
    let cancelled = false;
    async function refreshMonitorState() {
      const requestId = ++monitorRequestSeq.current;
      try {
        const [monitorPayload, fixedRoomPayload, eventPayload] = await Promise.all([
          loadRecordingMonitorStatusSafe(),
          loadFixedRooms({ enrich: false }),
          loadRecordingEvents(8).catch(() => ({ events: recordingEvents }))
        ]);
        if (cancelled || requestId !== monitorRequestSeq.current) return;
        if (monitorPayload) setRecordingMonitor(monitorPayload);
        setFixedRooms(fixedRoomPayload.rooms);
        setRecordingEvents(eventPayload.events || []);
        setRecordingSummary((prev) => {
          if (!prev) return prev;
          return fixedRoomPayload.rooms.find((room) => room.roomId === prev.roomId) || prev;
        });
      } catch {
        // The next status refresh can recover; keep the room cards usable meanwhile.
      }
    }
    void refreshMonitorState();
    const id = window.setInterval(() => void refreshMonitorState(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [
    settings?.serviceSettings.recording.autoMonitorEnabled
  ]);

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
      const [loadedSettings, roomPayload, fixedRoomPayload, automationPayload, monitorPayload, eventPayload] = await Promise.all([
        loadSettings(),
        getJson<{ root: string; rooms: Room[] }>("/api/rooms"),
        loadFixedRooms(),
        loadAutomationJobs().catch(() => ({ jobs: [] })),
        loadRecordingMonitorStatusSafe(),
        loadRecordingEvents(8).catch(() => ({ events: [] }))
      ]);
      setSettings(loadedSettings);
      setRooms(filterVisibleMaterialRooms(roomPayload.rooms));
      setFixedRooms(fixedRoomPayload.rooms);
      setAutomationJobs(automationPayload.jobs);
      setRecordingMonitor(monitorPayload);
      setRecordingEvents(eventPayload.events || []);
    } catch (err) {
      setError(readableError(err));
    } finally {
      setBusy(null);
    }
  }

  async function refreshAutomationJobs() {
    try {
      const payload = await loadAutomationJobs();
      setAutomationJobs(payload.jobs);
    } catch {
      // Automation jobs are an enhancement layer; keep the main workbench usable if the file is absent.
    }
  }

  function applyRecordingStatus(status: RecordingRoomStatus & { roomId: string }) {
    setRecordingSummary(status);
    setFixedRooms((prev) => prev.map((room) => (room.roomId === status.roomId ? { ...room, ...status } : room)));
  }

  async function refreshRecordingRooms() {
    const [fixedRoomPayload, monitorPayload, eventPayload] = await Promise.all([
      loadFixedRooms(),
      loadRecordingMonitorStatusSafe(),
      loadRecordingEvents(8).catch(() => ({ events: recordingEvents }))
    ]);
    setFixedRooms(fixedRoomPayload.rooms);
    if (monitorPayload) setRecordingMonitor(monitorPayload);
    setRecordingEvents(eventPayload.events || []);
  }

  async function createFixedRoom(roomId: string) {
    const clean = roomId.trim();
    if (!clean) return;
    setBusy("recording-add-room");
    setError(null);
    try {
      const result = await addFixedRoom({ roomId: clean });
      setFixedRooms(result.rooms);
      setMessage(`固定房间 ${clean} 已保存。`);
    } catch (err) {
      setError(readableError(err));
    } finally {
      setBusy(null);
    }
  }

  async function toggleFixedRoomEnabled(roomId: string, enabled: boolean) {
    setBusy(`recording-toggle-${roomId}`);
    setError(null);
    try {
      const result = await updateFixedRoom(roomId, { enabled });
      setFixedRooms(result.rooms);
      setRecordingSummary((prev) => {
        if (!prev?.roomId) return prev;
        return result.rooms.find((room) => room.roomId === prev.roomId) || prev;
      });
      setMessage(`${enabled ? "已开启" : "已关闭"}房间 ${roomId} 的自动录制。`);
    } catch (err) {
      setError(readableError(err));
    } finally {
      setBusy(null);
    }
  }

  async function removeFixedRoom(roomId: string) {
    const confirmed = window.confirm(`移除房间 ${roomId} 的录制配置？已录制的视频和弹幕文件不会删除。`);
    if (!confirmed) return;
    setBusy(`recording-delete-${roomId}`);
    setError(null);
    try {
      const result = await deleteFixedRoom(roomId);
      setFixedRooms(result.rooms);
      setRecordingSummary((prev) => (prev?.roomId === roomId ? null : prev));
      setMessage(`已移除房间 ${roomId} 的录制配置，素材文件保留。`);
    } catch (err) {
      setError(readableError(err));
    } finally {
      setBusy(null);
    }
  }

  async function removeMaterialRoom(room: Room) {
    const members = materialRoomMembers(room);
    const memberKeys = new Set(members.map((item) => item.key));
    const title = room.name || room.folderName || room.roomId || "这个素材房间";
    const scope = members.length > 1 ? `「${title}」的 ${members.length} 个素材目录` : `「${title}」`;
    const confirmed = window.confirm(`从素材库隐藏${scope}？硬盘里的视频和弹幕文件不会删除。`);
    if (!confirmed) return;
    setBusy(`material-delete-${room.key}`);
    setError(null);
    members.forEach((item) => rememberLocalHiddenMaterialRoom(item.key));
    setRooms((prev) => prev.filter((item) => !memberKeys.has(item.key)));
    try {
      let latestRooms: Room[] | null = null;
      for (const item of members) {
        const result = await deleteMaterialRoom(item.key);
        latestRooms = result.rooms;
      }
      if (latestRooms) setRooms(filterVisibleMaterialRooms(latestRooms));
      setMessage(`已从素材库隐藏${scope}，本地文件已保留。`);
    } catch (err) {
      const reason = readableError(err);
      const waitingForRestart = /404|Cannot DELETE|Not Found/i.test(reason);
      setMessage(waitingForRestart
        ? `已先从当前素材库隐藏${scope}。服务重启后会写入持久隐藏列表，本地文件已保留。`
        : `已从当前素材库隐藏${scope}，但持久保存失败：${reason}`);
    } finally {
      if (roomDetail && (roomDetail.key === room.key || memberKeys.has(roomDetail.key))) {
        setRoomDetail(null);
        resetEmptyWorkspaceState();
        setActiveView("library");
      }
      setBusy(null);
    }
  }

  async function runRecordingAction(roomId: string, action: "start" | "stop" | "retry") {
    setBusy(`recording-${action}-${roomId}`);
    setError(null);
    try {
      const status = await postRecordingRoomAction(roomId, action);
      applyRecordingStatus(status);
      if (action === "stop" && status.refreshed) {
        const roomPayload = await getJson<{ root: string; rooms: Room[] }>("/api/rooms");
        setRooms(filterVisibleMaterialRooms(roomPayload.rooms));
      }
    } catch (err) {
      const payload = (err as Error & { payload?: RecordingRoomStatus & { roomId?: string; error?: string } }).payload;
      const translatedError = recordingMessageLabel(payload?.message || payload?.error || readableError(err));
      if (payload?.roomId) {
        applyRecordingStatus({
          ...payload,
          roomId: payload.roomId,
          taskStatus: payload.taskStatus || "error",
          liveStatus: payload.liveStatus || "unknown",
          recordingPath: payload.recordingPath || null,
          danmakuPath: payload.danmakuPath || null,
          videoSize: payload.videoSize || 0,
          danmakuSize: payload.danmakuSize || 0,
          danmakuCount: payload.danmakuCount || 0,
          refreshed: Boolean(payload.refreshed),
          message: payload.message || payload.error || readableError(err),
          nextAction: payload.nextAction || "retry",
          log: payload.log || payload.error || readableError(err)
        });
      }
      setError(translatedError);
    } finally {
      setBusy(null);
    }
  }

  async function openRoom(room: Room) {
    setBusy("room");
    setError(null);
    setActiveView("workspace");
    try {
      const members = materialRoomMembers(room);
      const details = await Promise.all(
        members.map((item) => getJson<RoomDetail>(`/api/rooms/${encodeURIComponent(item.key)}`))
      );
      const detail = details.length > 1 ? mergeRoomDetails(room, details) : details[0];
      setRoomDetail(detail);
      setSelectedMaterialVideoKeys([]);
      const firstReadable = detail.videos.find((video) => Number(video.duration) > 0) || detail.videos[0];
      if (firstReadable) {
        await openVideo(firstReadable);
      } else {
        resetEmptyWorkspaceState();
      }
    } catch (err) {
      setError(readableError(err));
    } finally {
      setBusy(null);
    }
  }

  async function openFixedRoom(room: FixedRoom) {
    setBusy("room");
    setError(null);
    setActiveView("workspace");
    try {
      let materialRoom = materialGroupForRoomId(rooms, room.roomId);
      if (!materialRoom) {
        const roomPayload = await getJson<{ root: string; rooms: Room[] }>("/api/rooms");
        const visibleRooms = filterVisibleMaterialRooms(roomPayload.rooms);
        setRooms(visibleRooms);
        materialRoom = materialGroupForRoomId(visibleRooms, room.roomId);
      }
      if (materialRoom) {
        await openRoom(materialRoom);
        return;
      }
      setRoomDetail(emptyFixedRoomDetail(room));
      setSelectedMaterialVideoKeys([]);
      resetEmptyWorkspaceState();
    } catch (err) {
      setError(readableError(err));
    } finally {
      setBusy(null);
    }
  }

  function resetEmptyWorkspaceState() {
    setSelectedVideo(null);
    setContext(null);
    setPreviewStatus(null);
    setProject(emptyProject);
    setCandidates([]);
    setSliceDiagnostics(null);
    setSelectedMaterialVideoKeys([]);
    setAsrComparison(null);
    setCurrentTime(0);
    setSelectionStart(0);
    setSelectionEnd(0);
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
      setSliceDiagnostics(null);
      setAsrComparison(null);
      setCurrentTime(0);
      setSelectionStart(0);
      const configuredDuration = settings?.serviceSettings.automation.clipDuration || clipDuration || 90;
      const safeDuration = loadedContext.duration || configuredDuration;
      const initialDuration = Math.min(configuredDuration, safeDuration);
      setClipDuration(Math.max(20, Math.round(initialDuration)));
      setSelectionEnd(initialDuration);
    } catch (err) {
      setError(readableError(err));
    } finally {
      setBusy(null);
    }
  }

  async function convertSelectedRoomFlv(videoKeys: string[]) {
    if (!roomDetail || !videoKeys.length) return;
    setBusy("convert-selected-flv");
    setError(null);
    try {
      await convertAllFlv({ videoKeys });
      setSelectedMaterialVideoKeys([]);
      setMessage(`已启动 ${videoKeys.length} 个已选 FLV 转 MP4，进度去任务中心看。`);
    } catch (err) {
      setError(readableError(err));
    } finally {
      setBusy(null);
    }
  }

  function guardActiveRecordingAction(actionLabel: string) {
    if (!selectedVideoIsActiveRecording) return false;
    setError(`这段还在录制中，${actionLabel}建议等停止并收尾后再做。现在可以先查看画面、弹幕和写入进度。`);
    return true;
  }

  function seekTo(seconds: number) {
    const safe = Math.max(0, Math.min(seconds, context?.duration || seconds));
    setCurrentTime(safe);
    if (videoRef.current) {
      try {
        videoRef.current.currentTime = safe;
      } catch {
        // Some browser states reject seeking before a local preview source exists.
      }
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
    if (guardActiveRecordingAction("AI 切片")) return;
    setBusy("ai");
    setError(null);
    try {
      const requestBody = {
        videoKey: context.key,
        sources,
        clipCount,
        subtitles: editedSubtitles,
        danmakuEdits: project.danmakuEdits
      };
      const result = await requestSliceCandidates({ ...requestBody, precisionMode: "high" });
      setSliceDiagnostics(result.diagnostics);
      if (result.candidates.length) {
        setCandidates(result.candidates);
        previewClip(result.candidates[0]);
        setMessage(`已生成 ${result.candidates.length} 个高置信候选${sliceModelNotice(result.diagnostics)}`);
        return;
      }
      if (["error", "not-configured"].includes(String(result.diagnostics?.modelStatus || ""))) {
        setCandidates([]);
        setMessage(`模型没有生成候选${sliceModelNotice(result.diagnostics)}。`);
        return;
      }
      const reviewResult = await requestSliceCandidates({ ...requestBody, precisionMode: "review" });
      setSliceDiagnostics(reviewResult.diagnostics);
      setCandidates(reviewResult.candidates);
      if (reviewResult.candidates[0]) {
        previewClip(reviewResult.candidates[0]);
        setMessage(`没有命中高置信片段，已显示待复核候选${sliceModelNotice(reviewResult.diagnostics)}。`);
      } else {
        setMessage(`没有找到可用切片候选；当前素材的弹幕和字幕信号偏弱${sliceModelNotice(reviewResult.diagnostics)}。`);
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
    if (guardActiveRecordingAction("导出成片")) return;
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
    if (guardActiveRecordingAction("打包素材")) return;
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
    if (guardActiveRecordingAction("抽封面")) return;
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
    if (guardActiveRecordingAction("生成标题")) return;
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
    if (guardActiveRecordingAction("生成封面")) return;
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
    if (guardActiveRecordingAction("生成字幕")) return;
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
      if (isAsrCompletedStatus(finished.status) && finished.subtitles.length && options.writeBack !== false) {
        const shifted = shiftAsrCues(finished.subtitles, start, `asr-${job.id}`);
        writeSubtitlesToRange(shifted, { start, end });
        setMessage(`${options.label} ASR 完成，已写入 ${shifted.length} 条可编辑字幕。`);
      } else if (isAsrCompletedStatus(finished.status) && finished.subtitles.length) {
        setMessage(`${options.label} ASR 完成，识别到 ${finished.subtitles.length} 条字幕：${finished.outDir}`);
      } else if (isAsrCompletedStatus(finished.status)) {
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

  const showSidebar = activeView === "workspace" && Boolean(roomDetail);
  const shellClass = showSidebar ? "shell" : "shell library-mode";

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Clapperboard size={22} />
          <div>
            <strong>Bilive Workbench</strong>
            <span>{settings?.recordingsRoot || "未设置录制素材目录"}</span>
          </div>
        </div>
        <nav className="view-tabs">
          <button className={activeView === "library" ? "active" : ""} onClick={() => setActiveView("library")}>
            <FolderOpen size={16} />素材库
          </button>
          <button className={activeView === "workspace" ? "active" : ""} onClick={() => setActiveView("workspace")} disabled={!roomDetail}>
            <Scissors size={16} />编辑台
          </button>
          <button data-testid="nav-upload" className={activeView === "upload" ? "active" : ""} onClick={() => setActiveView("upload")}>
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
          <StatusPill ok={Boolean(settings?.rootExists)} label="录制素材" />
          <StatusPill ok={Boolean(settings?.ffmpeg && settings.ffprobe)} label="ffmpeg" />
          <button className="icon-button" onClick={() => void bootstrap()} aria-label="刷新">
            <RefreshCw size={17} />
          </button>
        </div>
      </header>

      {error ? <div className="toast error">{error}</div> : null}
      {message ? <div className="toast" onAnimationEnd={() => setMessage(null)}>{message}</div> : null}

      <main className={shellClass}>
        {showSidebar && roomDetail ? (
          <aside className="room-sidebar">
            <RoomMaterialSidebar
              roomDetail={roomDetail}
              selectedVideo={selectedVideo}
              selectedVideoKeys={selectedMaterialVideoKeys}
              activeRecordingPaths={activeRecordingPaths}
              query={roomMediaQuery}
              busy={busy}
              onQuery={setRoomMediaQuery}
              onSelectedVideoKeys={setSelectedMaterialVideoKeys}
              onConvertSelected={(keys) => void convertSelectedRoomFlv(keys)}
              onVideoSelect={(video) => void openVideo(video)}
              onBackToLibrary={() => setActiveView("library")}
            />
          </aside>
        ) : null}

        <section className="main-panel">
          {activeView === "library" ? (
            <LibraryView
              rooms={filteredRooms}
              fixedRooms={fixedRooms}
              busy={busy}
              recordingMonitor={recordingMonitor}
              recordingMonitorError={recordingMonitorError}
              recordingEvents={recordingEvents}
              recordingSummary={recordingSummary}
              settings={settings}
              query={query}
              onQuery={setQuery}
              onOpenRoom={(room) => void openRoom(room)}
              onOpenFixedRoom={(room) => void openFixedRoom(room)}
              onAddRoom={(roomId) => void createFixedRoom(roomId)}
              onDeleteRoom={(roomId) => void removeFixedRoom(roomId)}
              onDeleteMaterialRoom={(room) => void removeMaterialRoom(room)}
              onToggleRoomEnabled={(roomId, enabled) => void toggleFixedRoomEnabled(roomId, enabled)}
              onStartRecording={(roomId) => void runRecordingAction(roomId, "start")}
              onStopRecording={(roomId) => void runRecordingAction(roomId, "stop")}
              onRetryRecording={(roomId) => void runRecordingAction(roomId, "retry")}
            />
          ) : null}

          {activeView === "workspace" ? (
            <WorkspaceView
              busy={busy}
              context={context}
              roomDetail={roomDetail}
              selectedVideo={selectedVideo}
              isActiveRecording={selectedVideoIsActiveRecording}
              videoRef={videoRef}
              currentTime={currentTime}
              selectionStart={selectionStart}
              selectionEnd={selectionEnd}
              sources={sources}
              clipCount={clipCount}
              candidates={candidates}
              sliceDiagnostics={sliceDiagnostics}
              project={project}
              editedDanmaku={editedDanmaku}
              editedSubtitles={editedSubtitles}
              activeDanmaku={activeDanmaku}
              activeSubtitle={activeSubtitle}
              previewStatus={previewStatus}
              asrAvailability={getAsrAvailability(settings)}
              danmakuQuery={danmakuQuery}
              onVideoSelect={(video) => void openVideo(video)}
              onTimeUpdate={setCurrentTime}
              onSeek={seekTo}
              onSelectionStart={setSelectionStart}
              onSelectionEnd={setSelectionEnd}
              onSourceToggle={(source) => setSources((prev) => toggleValue(prev, source))}
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

          {activeView === "tasks" ? <TaskCenterView automationJobs={automationJobs} /> : null}

          {activeView === "settings" ? (
            <SettingsView
              initial={settings?.serviceSettings || null}
              asrTools={settings?.asrTools || null}
              uploadTools={settings?.uploadTools || null}
              recordingRootCandidates={settings?.recordingRootCandidates || []}
              onSave={async (value) => {
                await saveServiceSettings(value);
                const [latest, roomPayload, monitorPayload] = await Promise.all([
                  loadSettings(),
                  getJson<{ root: string; rooms: Room[] }>("/api/rooms"),
                  loadRecordingMonitorStatusSafe()
                ]);
                setSettings(latest);
                setRooms(filterVisibleMaterialRooms(roomPayload.rooms));
                if (monitorPayload) setRecordingMonitor(monitorPayload);
                setRoomDetail(null);
                setSelectedVideo(null);
                setContext(null);
                setProject(emptyProject);
                setMessage("服务设置已保存，录制素材已重新扫描。");
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

function recordingStatusLabel(status?: string | null) {
  const labels: Record<string, string> = {
    idle: "待命",
    running: "运行中",
    ready: "完成",
    starting: "启动中",
    waiting: "等待开播",
    recording: "录制中",
    finalizing: "收尾中",
    completed: "已完成",
    error: "异常"
  };
  return labels[String(status || "idle")] || String(status || "未知");
}

function taskTypeLabel(task: WorkbenchTask) {
  const labels: Record<string, string> = {
    "recording-room": "直播录制",
    recording: "录制工具",
    asr: "ASR 字幕",
    preview: "本地预览",
    transcode: "转 MP4",
    upload: "投稿",
    model: "AI 生成"
  };
  return labels[task.type] || labels[task.source] || task.type || "任务";
}

function taskDisplayLabel(task: WorkbenchTask) {
  const label = String(task.label || "").trim();
  const roomId = label.match(/^Room\s+(\d+)$/i)?.[1] || task.id.match(/^recording-room-(\d+)$/)?.[1] || "";
  if (roomId && task.outputPath) {
    const normalizedPath = task.outputPath.replace(/\\/g, "/");
    const match = normalizedPath.match(new RegExp(`(?:^|/)${roomId}\\s+-\\s+([^/]+)(?:/|$)`));
    const roomName = match?.[1]?.trim();
    if (roomName) return `${roomName}（${roomId}）`;
  }
  return label || taskTypeLabel(task);
}

function recordingRoomStatusLabel(room?: FixedRoom | null, running = false) {
  if (!room) return "素材";
  if (room.enabled === false && !running) return "已关闭";
  const message = String(room.message || "");
  if (room.enabled !== false && room.biliLiveStatus === "live" && room.taskStatus === "waiting" && room.liveStatus !== "live") {
    return "等待开录";
  }
  if (room.taskStatus === "waiting" && room.liveStatus === "live" && /自动重连|重连|取流中断|直播流中断|卡住/.test(message)) {
    return "重连中";
  }
  if (room.enabled !== false && room.taskStatus === "error" && isOfflineLiveRoom(room)) {
    return "等待开播";
  }
  if (room.enabled !== false && room.taskStatus === "error" && isRecoverableStreamRoom(room)) {
    return "重连中";
  }
  if (room.taskStatus === "error" && isOfflineLiveRoom(room)) {
    return "已下播";
  }
  return recordingStatusLabel(room.taskStatus);
}

function recordingMessageLabel(message?: string | null) {
  const value = String(message || "").trim();
  const labels: Record<string, string> = {
    Ready: "就绪",
    recording: "录制中",
    completed: "已完成",
    "未开播，自动巡检中": "等待开播",
    "等待开播，监控中": "等待开播",
    "已加入自动巡检，开播后会自动录制": "自动录制已开启",
    "已加入监控，开播后会自动录制": "自动录制已开启",
    "自动巡检已开启，开播后会自动录制": "自动录制已开启",
    "自动监控已开启，开播后会自动录制": "自动录制已开启",
    "未开播，内置录制会继续监听": "等待开播",
    "监控中，已开播，正在自动复查并准备录制": "开播，准备录制",
    "监控中，已开播，等待自动启动录制": "开播，准备录制",
    "取流中断，自动复查中": "取流重连中",
    "取流重连中": "取流重连中",
    "已开播，等待录制空位": "已开播，等待录制空位",
    "Waiting for live stream or first file": "等待开播或首个录制文件",
    "No finalized video was found after stop.": "停止后没有找到已完成的视频文件。",
    "Bilibili room was not found": "没有找到这个 B 站直播间"
  };
  if (labels[value]) return labels[value];
  const issue = classifyRecordingIssue(value);
  if (issue.kind !== "generic") return issue.title;
  return value || "就绪";
}

function isOfflineLiveRoom(room?: Pick<FixedRoom, "biliLiveStatus" | "liveStatus" | "message"> | null) {
  if (room?.biliLiveStatus === "live") return false;
  const statuses = [room?.biliLiveStatus, room?.liveStatus]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
  const message = String(room?.message || "");
  return statuses.some((status) => ["offline", "0", "ended", "not_live", "not-live"].includes(status))
    || /Bili stream request failed:\s*404|404 Not Found|未开播|下播|live ended|主播已下播/i.test(message);
}

function isRecoverableStreamRoom(room?: Pick<FixedRoom, "message" | "log"> | null) {
  const text = `${room?.message || ""}\n${room?.log || ""}`;
  return /Bili stream request failed:\s*(403|404|408|409|425|429|5\d\d)|fetch failed|network|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|AbortError|terminated|socket|当前没有可用/i.test(text);
}

function classifyRecordingIssue(message?: string | null, log?: string | null, room?: FixedRoom | null) {
  const text = `${message || ""}\n${log || ""}`;
  if (/Bilibili room was not found|room was not found|invalid room/i.test(text)) {
    return {
      kind: "not-found",
      title: "没有找到这个 B 站直播间",
      description: "房间号、完整链接或房间访问状态不对，当前不会继续录制。",
      action: "检查房间链接后重新保存，或者移除这个录制配置。"
    };
  }
  if (isOfflineLiveRoom(room) || /Bili stream request failed:\s*404|404 Not Found|live ended|主播已下播|未开播/i.test(text)) {
    return {
      kind: "live-ended",
      title: "等待开播",
      description: "主播当前未开播或刚下播；自动录制开着时会继续等待开播，已录到的视频文件会保留。",
      action: "可以先进入房间剪已有素材；主播重新开播后会自动录制。"
    };
  }
  if (/Bili stream request failed:\s*(403|408|409|425|429|5\d\d)/i.test(text)) {
    return {
      kind: "stream-expired",
      title: "直播流暂时不可用",
      description: "B 站返回的 CDN 流链接暂时不可用，已录到的视频文件会保留。",
      action: "点“重试”重新取流；如果主播已下播，保持等待或稍后再试。"
    };
  }
  if (/fetch failed|network|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(text)) {
    return {
      kind: "network",
      title: "网络取流失败",
      description: "请求直播流时网络或 B 站 CDN 中断，已录到的视频文件会保留。",
      action: "网络恢复后点“重试”，通常会重新连接并继续生成新片段。"
    };
  }
  if (/No finalized video was found/i.test(text)) {
    return {
      kind: "no-output",
      title: "没有找到完成的视频",
      description: "录制任务停止了，但还没有生成可剪辑的视频文件。",
      action: "确认主播是否开播，或稍后重新录制。"
    };
  }
  return {
    kind: "generic",
    title: recordingMessageLabelBase(message),
    description: "录制任务中断，已有素材文件会保留。",
    action: "可以先进入房间查看已有素材，或点“重试”重新启动录制。"
  };
}

function recordingMessageLabelBase(message?: string | null) {
  const value = String(message || "").trim();
  const labels: Record<string, string> = {
    Ready: "就绪",
    recording: "录制中",
    completed: "已完成",
    "未开播，自动巡检中": "等待开播",
    "等待开播，监控中": "等待开播",
    "已加入自动巡检，开播后会自动录制": "自动录制已开启",
    "已加入监控，开播后会自动录制": "自动录制已开启",
    "自动巡检已开启，开播后会自动录制": "自动录制已开启",
    "自动监控已开启，开播后会自动录制": "自动录制已开启",
    "未开播，内置录制会继续监听": "等待开播",
    "监控中，已开播，正在自动复查并准备录制": "开播，准备录制",
    "监控中，已开播，等待自动启动录制": "开播，准备录制",
    "取流中断，自动复查中": "取流重连中",
    "取流重连中": "取流重连中",
    "已开播，等待录制空位": "已开播，等待录制空位",
    "Waiting for live stream or first file": "等待开播或首个录制文件",
    "No finalized video was found after stop.": "停止后没有找到已完成的视频文件。",
    "Bilibili room was not found": "没有找到这个 B 站直播间"
  };
  return labels[value] || value || "就绪";
}

function RecordingIssueCard({ room }: { room: FixedRoom }) {
  const issue = classifyRecordingIssue(room.message, room.log, room);
  const log = room.log || room.message || "暂无日志。";
  return (
    <div data-testid={`room-error-${room.roomId}`} className="recording-issue">
      <strong>{issue.title}</strong>
      <span>{issue.description}</span>
      <em>{issue.action}</em>
      <details data-testid={`room-log-${room.roomId}`} className="recording-log-details">
        <summary>查看原始日志</summary>
        <pre className="recording-log">{log}</pre>
      </details>
    </div>
  );
}

function TaskRecordingIssue({ task }: { task: WorkbenchTask }) {
  const issue = classifyRecordingIssue(task.message, task.log);
  const log = task.log || task.message || "暂无日志。";
  return (
    <div data-testid={`task-issue-${task.id}`} className="task-issue">
      <strong>{issue.title}</strong>
      <span>{issue.description}</span>
      <em>{issue.action}</em>
      <details className="recording-log-details">
        <summary>查看原始日志</summary>
        <pre className="command-box task-log">{log}</pre>
      </details>
    </div>
  );
}

function roomFlowHint({
  fixed,
  material,
  recordingEnabled,
  running
}: {
  fixed?: FixedRoom | null;
  material?: Room | null;
  recordingEnabled?: boolean;
  running?: boolean;
}) {
  const latestName = material?.latestVideo?.name || "";
  const needsPreview = /\.(flv|mkv|ts)$/i.test(latestName);
  if (!fixed) {
    return needsPreview ? "下一步：进入房间后先生成 MP4 预览再剪。" : "下一步：加入录制，或进入房间剪已有素材。";
  }
  const status = String(fixed.taskStatus || "idle");
  if (!recordingEnabled && !running) return "下一步：可手动立即录制；打开自动录制后才会等待下次开播。";
  if (status === "error" && isOfflineLiveRoom(fixed)) return "下一步：自动录制会继续等待开播，也可以先进入房间剪已有素材。";
  if (status === "error" && isRecoverableStreamRoom(fixed)) return "下一步：自动录制会继续等待开播；也可以先进入房间剪已有素材。";
  if (status === "error") return "下一步：重试取流，或进入房间剪已有素材。";
  if (status === "recording") return "下一步：需要成片时点“停止”，素材会自动入库。";
  if (status === "starting" || status === "finalizing") return "下一步：等待当前录制步骤完成。";
  if (status === "waiting" && fixed.liveStatus === "offline") return "下一步：保持自动录制，主播开播后自动录；也可以先剪已有素材。";
  if (status === "waiting" && fixed.liveStatus === "live") return "下一步：等待录制空位或自动重连。";
  if (status === "waiting") return "下一步：保持自动录制，不要重复启动。";
  if (status === "completed") {
    return needsPreview ? "下一步：进入房间生成预览、切片。" : "下一步：进入房间切片。";
  }
  if (material) return needsPreview ? "下一步：进入房间生成预览、切片。" : "下一步：进入房间剪已有素材。";
  return "下一步：打开自动录制，主播开播后会自动录制。";
}

function fixedRoomDisplayName(room: FixedRoom) {
  if (!room.name || room.name === `Room ${room.roomId}` || room.name === "New room" || room.name === `房间 ${room.roomId}` || room.name === "新房间") {
    return `房间 ${room.roomId}`;
  }
  return room.name;
}

function emptyFixedRoomDetail(room: FixedRoom): RoomDetail {
  const title = fixedRoomDisplayName(room);
  const folderName = `${room.roomId} - ${title}`;
  return {
    key: `fixed-${room.roomId}`,
    path: pathParent(room.recordingPath || room.danmakuPath || ""),
    folderName,
    roomId: room.roomId,
    name: title,
    videos: [],
    xmlFiles: 0,
    subtitleFiles: 0
  };
}

function pathParent(value: string) {
  return String(value || "").replace(/[\\/][^\\/]*$/, "");
}

function fixedRoomCover(room: FixedRoom, material?: Room | null) {
  return room.coverUrl || room.keyframeUrl || material?.coverUrl || room.avatarUrl || null;
}

function effectiveRoomLiveStatus(room: FixedRoom) {
  const taskStatus = String(room.taskStatus || "");
  if (["starting", "recording", "finalizing"].includes(taskStatus) || room.liveStatus === "live") return "live";
  if (room.liveStatus === "offline" && ["waiting", "completed"].includes(taskStatus)) return "offline";
  return room.biliLiveStatus;
}

function fixedRoomMetaLine(room: FixedRoom) {
  const liveStatus = effectiveRoomLiveStatus(room);
  const live = liveStatus === "live" ? "直播中" : liveStatus === "replay" ? "轮播中" : liveStatus === "offline" ? "未开播" : "";
  const area = room.areaName && room.parentAreaName ? `${room.parentAreaName} · ${room.areaName}` : room.areaName || "";
  const realRoom = room.realRoomId && room.realRoomId !== room.roomId ? `真实房间 ${room.realRoomId}` : "";
  return [room.anchorName ? `主播 ${room.anchorName}` : "", live, area, realRoom].filter(Boolean).join(" · ");
}

function recordingEventLabel(event: RecordingEvent) {
  const room = event.roomId ? `房间 ${event.roomId}` : "直播间";
  if (/InternalRecorderStartedEvent/.test(event.type)) return `${room} 自动录制已接管`;
  if (/LiveBeganEvent/.test(event.type)) return `${room} 开播，准备录制`;
  if (/RecordingStartedEvent|VideoFileCreatedEvent/.test(event.type)) return `${room} 录制中`;
  if (/RoomMonitorLiveEndedEvent/.test(event.type)) return `${room} 下播，等待开播`;
  if (/LiveEndedEvent/.test(event.type)) return `${room} 下播，正在收尾`;
  if (/RecordingFinishedEvent|PostprocessingCompletedEvent|VideoPostprocessingCompletedEvent/.test(event.type)) return `${room} 录制完成，可剪辑`;
  if (/VideoFileCompletedEvent/.test(event.type)) return `${room} 片段已入库`;
  if (/DanmakuFileCreatedEvent/.test(event.type)) return `${room} 弹幕已开始采集`;
  if (/DanmakuFileCompletedEvent|RawDanmakuFileCompletedEvent/.test(event.type)) return `${room} 弹幕已保存`;
  if (/ReconnectEvent/.test(event.type)) return `${room} 取流重连中`;
  if (/Error|Cancelled/.test(event.type)) return `${room} 录制异常`;
  return `${room} ${event.type}`;
}

function recordingEngineLabel(value?: string | null) {
  return "内置 B 站录制";
}

function monitorServiceErrorMessage(error?: string | null) {
  const value = String(error || "").trim();
  if (!value) return "";
  if (/Unexpected token\s*'<|DOCTYPE|not valid JSON|JSON/i.test(value)) {
    return "自动录制服务未加载，重启开发服务后才会生效。";
  }
  return `自动录制状态读取失败：${value}`;
}

function danmakuHealthLabel(status: Partial<RecordingRoomStatus>) {
  const danmaku = status.danmakuStatus;
  if (!danmaku) return status.danmakuPath ? "弹幕已同步" : "无弹幕文件";
  const auth = danmaku.authenticated ? "已鉴权" : danmaku.connected ? "已连接" : "未连接";
  const cookie = danmaku.cookieLoaded
    ? danmaku.uidPresent || danmaku.buvidPresent ? "cookie 已加载" : "cookie 缺 uid/buvid"
    : "未加载 cookie";
  const close = danmaku.lastCloseCode ? `断开 ${danmaku.lastCloseCode}` : "";
  return ["弹幕", auth, cookie, close].filter(Boolean).join(" · ");
}

function recordingMetricItems(status: Partial<RecordingRoomStatus>) {
  const bytes = Number(status.bytesWritten || status.videoSize || 0);
  const speed = Number(status.speedBytesPerSecond || 0);
  const average = Number(status.averageSpeedBytesPerSecond || 0);
  const elapsed = Number(status.elapsedSeconds || 0);
  const stale = Number(status.staleSeconds || 0);
  const isLiveSpeed = status.taskStatus === "recording" && !status.stalled;
  const speedItem = isLiveSpeed && speed > 0
    ? `速度 ${formatSpeed(speed)}`
    : average > 0
      ? `均速 ${formatSpeed(average)}`
      : speed > 0
        ? `均速 ${formatSpeed(speed)}`
        : "";
  const items = [
    bytes > 0 ? `已写 ${formatSize(bytes)}` : "",
    speedItem,
    elapsed > 0 ? `时长 ${formatTime(elapsed)}` : "",
    `${Number(status.danmakuCount || 0)} 条弹幕`,
    status.stalled ? "疑似卡住" : stale > 3 ? `${stale}s 未进数据` : "",
    danmakuHealthLabel(status)
  ];
  return items.filter(Boolean);
}

function RecordingMetricStrip({ task }: { task: WorkbenchTask }) {
  const items = recordingMetricItems({
    taskStatus: task.status === "running" ? "recording" : task.status,
    videoSize: task.bytesWritten || 0,
    bytesWritten: task.bytesWritten || 0,
    speedBytesPerSecond: task.speedBytesPerSecond || 0,
    averageSpeedBytesPerSecond: task.averageSpeedBytesPerSecond || 0,
    elapsedSeconds: task.elapsedSeconds || 0,
    staleSeconds: task.staleSeconds || 0,
    stalled: task.stalled,
    danmakuCount: task.danmakuCount || 0,
    danmakuPath: task.danmakuCount ? "task" : null
  });
  if (!items.length) return null;
  return (
    <div className="recording-metric-strip" data-testid={`task-recording-metrics-${task.id}`}>
      {items.map((item) => <span key={item}>{item}</span>)}
    </div>
  );
}

function RoomMaterialSidebar({
  roomDetail,
  selectedVideo,
  selectedVideoKeys,
  activeRecordingPaths,
  query,
  busy,
  onQuery,
  onSelectedVideoKeys,
  onConvertSelected,
  onVideoSelect,
  onBackToLibrary
}: {
  roomDetail: RoomDetail;
  selectedVideo: VideoAsset | null;
  selectedVideoKeys: string[];
  activeRecordingPaths: string[];
  query: string;
  busy: string | null;
  onQuery: (value: string) => void;
  onSelectedVideoKeys: (keys: string[]) => void;
  onConvertSelected: (keys: string[]) => void;
  onVideoSelect: (video: VideoAsset) => void;
  onBackToLibrary: () => void;
}) {
  const needle = query.trim().toLowerCase();
  const videos = needle
    ? roomDetail.videos.filter((video) => `${video.name} ${video.extension} ${video.path}`.toLowerCase().includes(needle))
    : roomDetail.videos;
  const convertibleVideos = videos.filter((video) => video.extension === "flv" && !isActiveRecordingVideo(video, activeRecordingPaths));
  const selectedVisibleKeys = selectedVideoKeys.filter((key) => convertibleVideos.some((video) => video.key === key));
  const allVisibleSelected = Boolean(convertibleVideos.length) && selectedVisibleKeys.length === convertibleVideos.length;

  function toggleVideo(key: string, checked: boolean) {
    onSelectedVideoKeys(checked
      ? [...new Set([...selectedVideoKeys, key])]
      : selectedVideoKeys.filter((item) => item !== key)
    );
  }

  function toggleAll(checked: boolean) {
    const visible = new Set(convertibleVideos.map((video) => video.key));
    if (checked) {
      onSelectedVideoKeys([...new Set([...selectedVideoKeys, ...visible])]);
      return;
    }
    onSelectedVideoKeys(selectedVideoKeys.filter((key) => !visible.has(key)));
  }

  return (
    <div className="room-material-sidebar" data-testid="workspace-room-materials">
      <div className="workspace-room-head">
        <div>
          <span className="eyebrow">当前直播间</span>
          <strong>{roomDetail.name}</strong>
          <small>{roomDetail.roomId || "本地"} · {roomDetail.videos.length} 个素材</small>
        </div>
        <button className="icon-button" onClick={onBackToLibrary} title="回到素材库" aria-label="回到素材库">
          <FolderOpen size={17} />
        </button>
      </div>
      <div className="searchbox">
        <Search size={16} />
        <input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="搜本房间素材" />
      </div>
      <div className="material-bulk-tools" data-testid="material-bulk-tools">
        <label className={convertibleVideos.length ? "" : "disabled"}>
          <input
            type="checkbox"
            checked={allVisibleSelected}
            disabled={!convertibleVideos.length || busy === "convert-selected-flv"}
            onChange={(event) => toggleAll(event.target.checked)}
          />
          全选 FLV
        </label>
        <button
          onClick={() => onConvertSelected(selectedVisibleKeys)}
          disabled={!selectedVisibleKeys.length || busy === "convert-selected-flv"}
          data-testid="convert-selected-flv"
        >
          {busy === "convert-selected-flv" ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
          转 MP4
        </button>
      </div>
      <div className="room-list room-video-list">
        {busy === "room" ? <LoadingBlock label="读取房间素材" /> : null}
        {videos.map((video) => {
          const isActiveRecording = isActiveRecordingVideo(video, activeRecordingPaths);
          const canSelect = video.extension === "flv" && !isActiveRecording;
          const selected = selectedVideoKeys.includes(video.key);
          const remuxReady = Boolean(video.remuxTarget?.exists);
          return (
            <div
              key={video.key}
              className={`room-video-item ${selected ? "selected" : ""}`}
            >
              <label className={`video-select ${canSelect ? "" : "disabled"}`} title={canSelect ? "选择这个 FLV 转 MP4" : "只有 FLV 素材需要转换"}>
                <input
                  type="checkbox"
                  checked={selected}
                  disabled={!canSelect || busy === "convert-selected-flv"}
                  onChange={(event) => toggleVideo(video.key, event.target.checked)}
                />
              </label>
              <button
                data-testid={`workspace-video-${video.key}`}
                className={`room-card room-video-card ${selectedVideo?.key === video.key ? "active" : ""} ${isActiveRecording ? "is-recording" : ""}`}
                onClick={() => onVideoSelect(video)}
              >
                <CoverImage src={video.thumbnailUrl} label={video.name} />
                <span className="room-title">{video.name}</span>
                <span className="room-meta">
                  {formatTime(video.duration)} · {video.extension.toUpperCase()} · {Number(video.danmakuCount || 0)} 弹幕
                </span>
                <span className="room-meta secondary">
                  {video.playable ? "网页可播" : remuxReady ? `MP4 已生成 ${formatSize(video.remuxTarget?.size || 0)}` : "需转 MP4"}
                  {video.subtitles.length ? ` · ${video.subtitles.length} 字幕` : ""}
                </span>
                {isActiveRecording ? <span className="room-chip recording">录制中</span> : null}
              </button>
            </div>
          );
        })}
        {!videos.length ? <EmptyMini label="这个直播间还没有匹配的素材。" /> : null}
      </div>
    </div>
  );
}


function AutomationSummaryStrip({ summary, compact = false }: { summary: AutomationSummary; compact?: boolean }) {
  if (!summary.total) {
    return (
      <div className={`automation-strip ${compact ? "compact" : ""}`}>
        <span className="automation-pill muted">暂无自动切片</span>
      </div>
    );
  }
  return (
    <div className={`automation-strip ${compact ? "compact" : ""}`}>
      <span className={`automation-pill ${summary.running ? "running" : summary.ready ? "ready" : "muted"}`}>
        {summary.running ? "运行中" : summary.ready ? "切片就绪" : summary.lastStage || "等待分析"}
      </span>
      <span className="automation-pill">任务 {summary.total}</span>
      <span className="automation-pill">采纳 {summary.accepted}</span>
      {summary.exported ? <span className="automation-pill ready">导出 {summary.exported}</span> : null}
      {summary.filtered ? <span className="automation-pill muted">已过滤 {summary.filtered}</span> : null}
      {summary.blocked ? <span className="automation-pill blocked">需处理 {summary.blocked}</span> : null}
      {!compact && summary.lastMessage ? <span className="automation-note">{summary.lastMessage}</span> : null}
    </div>
  );
}

function ClipAutomationDetails({ item }: { item: Pick<ClipCandidate, "automation" | "signal" | "score"> }) {
  const automation = item.automation;
  if (!automation && !item.signal) return null;
  const signal = item.signal;
  return (
    <details className="automation-details">
      <summary>指标明细</summary>
      <div className="automation-detail-grid">
        <span>分数 {automation?.score ?? item.score ?? "-"}</span>
        <span>{automation?.eligibleForAutoUpload ? "可直接发" : "需要复核"}</span>
        {automation?.signalFamilies?.length ? <span>{automation.signalFamilies.join(", ")}</span> : null}
        {signal ? <span>弹幕 {signal.danmakuCount} / 字幕 {signal.subtitleCount}</span> : null}
        {signal ? <span>关键词 {signal.funnyHits + signal.reactionHits + signal.questionHits}</span> : null}
      </div>
      {automation?.policyReason ? <p>{automation.policyReason}</p> : null}
    </details>
  );
}

function summarizeAutomationJobs(jobs: AutomationJob[]): AutomationSummary {
  const sorted = sortAutomationJobsForDisplay(jobs);
  const latestJob = sorted[0] || null;
  const latestStage = String(latestJob?.stage || "");
  return {
    total: jobs.length,
    running: jobs.filter((job) => job.status === "running" || job.status === "queued").length,
    ready: jobs.filter((job) => job.status === "ready").length,
    accepted: jobs.reduce((count, job) => count + (job.acceptedClips?.length || 0), 0),
    exported: jobs.reduce((count, job) => count + (job.acceptedClips || []).filter((clip) => clip.status === "exported" || clip.exportPath).length, 0),
    filtered: jobs.filter((job) => String(job.stage || "").includes("no-high-confidence")).length,
    blocked: jobs.filter((job) => job.status === "error" || String(job.stage || "").includes("blocked")).length,
    lastStage: latestJob?.stage || "",
    lastMessage: latestStage.includes("no-high-confidence") ? "" : (latestJob?.message || ""),
    latestJob
  };
}

function automationStageLabel(job: AutomationJob) {
  const stage = String(job.stage || "");
  if (job.status === "queued") return "等待分析";
  if (job.status === "running" && stage.includes("export")) return "正在导出";
  if (job.status === "running") return "正在分析";
  if (job.status === "error") return "异常";
  if (stage === "upload-draft-ready") return "投稿草稿已生成";
  if (stage === "upload-preflight-blocked") return "投稿预检未通过";
  if (stage === "upload-started") return "投稿任务已启动";
  if (stage === "exported") return "切片已导出";
  if (stage === "clips-ready") return "高置信片段已生成";
  if (stage.includes("no-high-confidence")) return "没有高置信片段";
  return stage || "自动切片";
}

function automationStatusClass(job: AutomationJob) {
  if (job.status === "error" || String(job.stage || "").includes("blocked") || String(job.stage || "").includes("no-high-confidence")) return "error";
  if (job.status === "running" || job.status === "queued") return "running";
  return "ready";
}

function automationProgress(job: AutomationJob) {
  if (job.status === "error") return 0;
  if (job.status === "queued") return 8;
  if (job.status === "running" && String(job.stage || "").includes("export")) return 72;
  if (job.status === "running") return 42;
  if (job.uploadDraftPath || job.uploadJobId) return 100;
  if (job.exportedClips?.length) return 90;
  if (job.acceptedClips?.length) return 70;
  return 35;
}

function automationVideoName(job: AutomationJob) {
  const normalized = String(job.videoPath || "").replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() || job.videoPath || "录制视频";
}

function AutomationJobCard({ job }: { job: AutomationJob }) {
  const exported = job.exportedClips?.length || 0;
  const accepted = job.acceptedClips?.length || 0;
  const progress = automationProgress(job);
  const className = automationStatusClass(job);
  const highScore = Math.max(...(job.acceptedClips || []).map((clip) => Number(clip.automation?.score ?? clip.score ?? 0)), 0);
  return (
    <article className={`task-card automation-task ${className}`} data-testid={`automation-task-${job.id}`}>
      <div className="task-head">
        <div>
          <strong>{automationVideoName(job)}</strong>
          <span>自动切片 · {automationStageLabel(job)} · {progress}%</span>
        </div>
        <em>{job.updatedAt ? formatDate(job.updatedAt) : ""}</em>
      </div>
      <p>{job.message || automationStageLabel(job)}</p>
      <div className="automation-strip compact">
        <span className="automation-pill">候选 {job.candidates?.length || 0}</span>
        <span className="automation-pill ready">采纳 {accepted}</span>
        <span className={`automation-pill ${exported ? "ready" : "muted"}`}>导出 {exported}</span>
        {highScore ? <span className="automation-pill">最高分 {highScore}</span> : null}
        <span className="automation-pill">{uploadPolicyLabel(job.uploadPolicy)}</span>
      </div>
      <div className="task-progress">
        <span style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
      </div>
      {job.uploadDraftPath ? <code data-testid={`automation-draft-${job.id}`}>{job.uploadDraftPath}</code> : null}
      {job.uploadJobId ? <code>投稿任务：{job.uploadJobId}</code> : null}
      {job.error ? <div className="preflight-box bad">{job.error}</div> : null}
    </article>
  );
}


function isActiveRecordingVideo(video: VideoAsset | null, activeRecordingPaths: string[]) {
  if (!video) return false;
  const videoPath = normalizeComparePath(video.path);
  return activeRecordingPaths.some((path) => path === videoPath);
}

function normalizeComparePath(value: string | null | undefined) {
  return String(value || "").replace(/\\/g, "/").toLowerCase();
}

function LibraryView({
  rooms,
  fixedRooms,
  busy,
  recordingMonitor,
  recordingMonitorError,
  recordingEvents,
  recordingSummary,
  settings,
  query,
  onOpenRoom,
  onOpenFixedRoom,
  onQuery,
  onAddRoom,
  onDeleteRoom,
  onDeleteMaterialRoom,
  onToggleRoomEnabled,
  onStartRecording,
  onStopRecording,
  onRetryRecording
}: {
  rooms: Room[];
  fixedRooms: FixedRoom[];
  busy: string | null;
  recordingMonitor: RecordingMonitorStatus | null;
  recordingMonitorError: string | null;
  recordingEvents: RecordingEvent[];
  recordingSummary: (RecordingRoomStatus & { roomId: string }) | null;
  settings: Settings | null;
  query: string;
  onQuery: (value: string) => void;
  onOpenRoom: (room: Room) => void;
  onOpenFixedRoom: (room: FixedRoom) => void;
  onAddRoom: (roomId: string) => void;
  onDeleteRoom: (roomId: string) => void;
  onDeleteMaterialRoom: (room: Room) => void;
  onToggleRoomEnabled: (roomId: string, enabled: boolean) => void;
  onStartRecording: (roomId: string) => void;
  onStopRecording: (roomId: string) => void;
  onRetryRecording: (roomId: string) => void;
}) {
  const [roomId, setRoomId] = useState("");
  const isRecordingBusy = Boolean(busy?.startsWith("recording"));
  const fixedByRoomId = new Map(fixedRooms.filter((room) => room.roomId).map((room) => [room.roomId, room]));
  const materialGroups = groupMaterialRooms(rooms);
  const roomCards = [
    ...materialGroups.map((room) => ({
      key: `material-${room.key}`,
      roomId: room.roomId,
      fixed: room.roomId ? fixedByRoomId.get(room.roomId) || null : null,
      material: room
    })),
    ...fixedRooms
      .filter((room) => room.roomId && !materialGroups.some((material) => material.roomId === room.roomId))
      .map((room) => ({
        key: `fixed-${room.roomId}`,
        roomId: room.roomId,
        fixed: room,
        material: null
      }))
  ];
  const current = recordingSummary
    || fixedRooms.find((room) => ["recording", "completed", "error", "waiting", "starting"].includes(String(room.taskStatus)))
    || fixedRooms[0]
    || null;
  const monitoredRooms = fixedRooms.filter((room) => room.enabled !== false).length;
  const runningRooms = fixedRooms.filter((room) => ["starting", "recording", "finalizing"].includes(String(room.taskStatus || ""))).length;
  const totalVideos = rooms.reduce((count, room) => count + (room.videoCount || 0), 0);
  const totalDanmaku = rooms.reduce((count, room) => count + (room.xmlCount || 0), 0);
  const autoMonitorEnabled = recordingMonitor?.enabled ?? settings?.serviceSettings.recording.autoMonitorEnabled !== false;
  const monitorIssue = autoMonitorEnabled ? monitorServiceErrorMessage(recordingMonitorError) : "";
  const waitingRooms = recordingMonitor?.waitingRooms ?? Math.max(0, monitoredRooms - runningRooms);
  const monitorSummary = monitorIssue
    || (autoMonitorEnabled
      ? `${recordingMonitor?.enabledRooms ?? monitoredRooms} 个房间自动录制 · ${recordingMonitor?.activeRecordings ?? runningRooms} 个录制中 · ${waitingRooms} 个等待开播 · 下播后自动入库`
      : "自动录制关闭后不会等待开播；仍可在房间卡片手动立即录制。");
  const recentEvents = recordingEvents.slice(0, 4);

  function saveRoom() {
    const clean = roomId.trim();
    if (!clean) return;
    onAddRoom(clean);
    setRoomId("");
  }

  return (
    <div className="library-grid" data-testid="recording-dashboard">
      <section className="hero-band library-overview">
        <div>
          <span className="eyebrow">直播间素材</span>
          <h1>房间总览</h1>
        </div>
        <div className="stat-row">
          <Metric label="房间" value={roomCards.length} />
          <Metric label="素材视频" value={totalVideos} />
          <Metric label="弹幕文件" value={totalDanmaku} />
          <Metric label="自动录制" value={recordingMonitor?.enabledRooms ?? monitoredRooms} />
          <Metric label="录制中" value={recordingMonitor?.activeRecordings ?? runningRooms} />
          <Metric label="等待开播" value={waitingRooms} />
        </div>
      </section>

      <section className="library-room-tools">
        <div className="searchbox library-search">
          <Search size={16} />
          <input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="搜索房间、ID、文件夹" />
        </div>
        <input
          data-testid="fixed-room-input"
          value={roomId}
          onChange={(event) => setRoomId(event.target.value)}
          placeholder="B 站直播间 ID 或完整链接"
        />
        <button data-testid="save-fixed-room" className="primary" onClick={saveRoom} disabled={!roomId.trim() || isRecordingBusy}>
          <Save size={15} />保存房间
        </button>
      </section>

      <section className={`recording-monitor-strip ${monitorIssue ? "monitor-error" : ""}`} data-testid="recording-monitor-strip">
        <div>
          <strong>{monitorIssue ? "自动录制异常" : "开播/下播状态"}</strong>
          <span>{monitorSummary}</span>
        </div>
        <div className="recent-recording-events" data-testid="recording-recent-events">
          <small>开播/下播事件</small>
          {recentEvents.length ? (
            recentEvents.map((event) => (
              <b key={event.id}>{recordingEventLabel(event)}</b>
            ))
          ) : (
            <b>暂无开播/下播事件</b>
          )}
        </div>
      </section>

      <section className="room-grid" data-testid="library-room-grid">
        {roomCards.map(({ key, fixed, material, roomId: cardRoomId }) => {
          const rawStatus = fixed?.taskStatus || "idle";
          const recordingEnabled = fixed?.enabled !== false;
          const monitoredOfflineError = Boolean(fixed && recordingEnabled && rawStatus === "error" && isOfflineLiveRoom(fixed));
          const monitoredRecoverableError = Boolean(fixed && recordingEnabled && rawStatus === "error" && isRecoverableStreamRoom(fixed));
          const status = monitoredOfflineError || monitoredRecoverableError ? "waiting" : rawStatus;
          const activeRecording = Boolean(
            fixed && (
              status === "recording"
              || status === "starting"
              || status === "finalizing"
              || (status === "waiting" && fixed.liveStatus === "live" && Boolean(fixed.recordingPath || fixed.bytesWritten))
            )
          );
          const monitorServiceMissing = Boolean(fixed && recordingEnabled && monitorIssue && !activeRecording);
          const running = activeRecording;
          const statusClass = fixed && rawStatus === "error" && isOfflineLiveRoom(fixed) && !monitoredOfflineError ? "live-ended" : status;
          const title = fixed ? fixedRoomDisplayName(fixed) : material?.name || `房间 ${cardRoomId || "本地"}`;
          const coverUrl = fixed ? fixedRoomCover(fixed, material) : material?.coverUrl || null;
          const biliMeta = fixed ? fixedRoomMetaLine(fixed) : "";
          const isCurrentRecordingRoom = Boolean(fixed && current?.roomId === fixed.roomId);
          const hasRecordedMedia = Boolean(fixed && (fixed.recordingPath || fixed.danmakuPath || material?.latestVideo));
          const recordedMediaButtonTestId = fixed && (
            (isCurrentRecordingRoom && hasRecordedMedia)
            || (rawStatus === "completed" && hasRecordedMedia)
            || (fixed.nextAction === "open" && hasRecordedMedia)
          ) ? "open-recorded-media" : undefined;
          const fixedOpenRoomTestId = fixed ? `open-fixed-room-${fixed.roomId}` : undefined;
          const statusText = fixed ? recordingRoomStatusLabel(fixed, running) : "素材";
          const recordingMetrics = fixed ? recordingMetricItems(fixed) : [];
          const flowHint = roomFlowHint({ fixed, material, recordingEnabled, running });
          const flowTestId = fixed ? `room-flow-${fixed.roomId}` : material ? `room-flow-${material.key}` : undefined;
          return (
            <article
              className={`room-tile recording-room-tile ${fixed ? "managed" : "material-only"} ${statusClass} ${fixed && !recordingEnabled ? "recording-disabled" : ""}`}
              data-testid={`library-room-card-${cardRoomId || material?.key || key}`}
              key={key}
            >
              <div className="room-card-top">
                <div className="room-card-cover">
                  <CoverImage src={coverUrl} label={title} />
                </div>
                <div className="room-card-copy">
                  <div className="room-card-titleline">
                    <span className="room-card-title">{title}</span>
                    <em data-testid={fixed ? `room-status-${fixed.roomId}` : undefined} className={`room-state-pill ${fixed ? statusClass : "material"}`}>
                      {statusText}
                    </em>
                  </div>
                  <small>
                    {cardRoomId || "本地"} · {material ? `${material.videoCount} 视频 · ${material.xmlCount} 弹幕` : "暂无素材"}
                  </small>
                  {biliMeta ? <small data-testid={`room-bili-meta-${fixed?.roomId}`} className="room-card-bili-meta">{biliMeta}</small> : null}
                  {fixed ? (
                    <Switch
                      checked={recordingEnabled}
                      dataTestId={`room-recording-toggle-${fixed.roomId}`}
                      disabled={isRecordingBusy || activeRecording}
                      label={recordingEnabled ? "自动录制" : "已关闭"}
                      onChange={(enabled) => onToggleRoomEnabled(fixed.roomId, enabled)}
                    />
                  ) : null}
                </div>
              </div>
              {fixed && rawStatus === "error" && !monitoredOfflineError && !monitoredRecoverableError ? (
                <RecordingIssueCard room={fixed} />
              ) : fixed && !recordingEnabled && !running ? (
                <p className="recording-summary muted">自动录制已关闭；不会等待开播，仍可手动立即录制。</p>
              ) : fixed && monitorServiceMissing ? (
                <p className="recording-summary warning">
                  <span>自动录制服务未就绪，重启后端后会继续等待开播。</span>
                </p>
              ) : fixed ? (
                <p className="recording-summary">
                  <span>{monitoredOfflineError ? "等待开播" : monitoredRecoverableError && fixed.biliLiveStatus === "live" ? "直播中，准备录制" : monitoredRecoverableError ? "取流重连中" : recordingMessageLabel(fixed.message)}</span>
                </p>
              ) : (
                <p className="recording-summary muted">未加入录制。</p>
              )}
              <p data-testid={flowTestId} className="room-flow-hint">{flowHint}</p>
              {material ? (
                <div className="room-material-meta">
                  <span>{material.videoCount} 视频</span>
                  <span>{material.xmlCount} 弹幕</span>
                  <span>{material.latestVideo ? formatDate(material.latestVideo.mtime) : "无最新视频"}</span>
                </div>
              ) : null}
              {fixed && recordingMetrics.length ? (
                <div className="room-material-meta recording-footprint" data-testid={`room-recording-assets-${fixed.roomId}`}>
                  {recordingMetrics.map((item) => <span key={item}>{item}</span>)}
                </div>
              ) : null}
              <div className="button-row">
                {fixed ? (
                  <>
                    <button data-testid={`start-room-${fixed.roomId}`} className={!material ? "primary" : ""} onClick={() => onStartRecording(fixed.roomId)} disabled={isRecordingBusy || activeRecording}>
                      <Play size={15} />立即录制
                    </button>
                    <button data-testid={`stop-room-${fixed.roomId}`} onClick={() => onStopRecording(fixed.roomId)} disabled={isRecordingBusy || !activeRecording}>
                      <Square size={15} />停止
                    </button>
                    {rawStatus === "error" && !monitoredOfflineError && !monitoredRecoverableError ? (
                      <button data-testid={`repair-room-${fixed.roomId}`} onClick={() => onRetryRecording(fixed.roomId)} disabled={isRecordingBusy || activeRecording}>
                        <RefreshCw size={15} />重试
                      </button>
                    ) : null}
                    <button data-testid={`delete-room-${fixed.roomId}`} onClick={() => onDeleteRoom(fixed.roomId)} disabled={isRecordingBusy || activeRecording}>
                      <Trash2 size={15} />移除录制
                    </button>
                  </>
                ) : (
                  <>
                    {cardRoomId ? (
                      <button onClick={() => onAddRoom(cardRoomId)} disabled={isRecordingBusy}>
                        <Plus size={15} />加入录制
                      </button>
                    ) : null}
                    {material ? (
                      <button data-testid={`delete-material-room-${material.key}`} onClick={() => onDeleteMaterialRoom(material)} disabled={isRecordingBusy || busy === `material-delete-${material.key}`}>
                        <Trash2 size={15} />隐藏素材
                      </button>
                    ) : null}
                  </>
                )}
                {material ? (
                  <button data-testid={recordedMediaButtonTestId} className="primary" onClick={() => onOpenRoom(material)}>
                    <Scissors size={15} />进入房间
                  </button>
                ) : fixed ? (
                  <button data-testid={recordedMediaButtonTestId || fixedOpenRoomTestId} className="primary" onClick={() => onOpenFixedRoom(fixed)}>
                    <Scissors size={15} />进入房间
                  </button>
                ) : null}
              </div>
            </article>
          );
        })}
        {!roomCards.length ? <EmptyMini label="还没有房间素材；添加直播间后可以直接录制。" /> : null}
      </section>
    </div>
  );
}

function WorkspaceView(props: {
  busy: string | null;
  context: VideoContext | null;
  roomDetail: RoomDetail | null;
  selectedVideo: VideoAsset | null;
  isActiveRecording: boolean;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  currentTime: number;
  selectionStart: number;
  selectionEnd: number;
  sources: string[];
  clipCount: number;
  candidates: ClipCandidate[];
  sliceDiagnostics: AiSliceDiagnostics | null;
  project: ProjectState;
  editedDanmaku: DanmakuItem[];
  editedSubtitles: SubtitleCue[];
  activeDanmaku: DanmakuItem[];
  activeSubtitle: SubtitleCue | null;
  previewStatus: PreviewStatus | null;
  asrAvailability: AsrAvailability;
  danmakuQuery: string;
  onVideoSelect: (video: VideoAsset) => void;
  onTimeUpdate: (time: number) => void;
  onSeek: (time: number) => void;
  onSelectionStart: (time: number) => void;
  onSelectionEnd: (time: number) => void;
  onSourceToggle: (source: string) => void;
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
    isActiveRecording,
    videoRef,
    currentTime,
    selectionStart,
    selectionEnd,
    sources,
    clipCount,
    candidates,
    sliceDiagnostics,
    project,
    editedDanmaku,
    editedSubtitles,
    activeDanmaku,
    activeSubtitle,
    previewStatus,
    asrAvailability,
    danmakuQuery,
    onVideoSelect,
    onTimeUpdate,
    onSeek,
    onSelectionStart,
    onSelectionEnd,
    onSourceToggle,
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
    if (busy !== "room" && !roomDetail.videos.length) {
      return (
        <div className="workspace-empty" data-testid="workspace-empty-room">
          <div className="section-head">
            <div>
              <span className="eyebrow">{roomDetail.roomId || "本地房间"}</span>
              <h2>{roomDetail.name}</h2>
            </div>
          </div>
          <EmptyState icon={<FolderOpen />} title="暂无可剪素材" />
        </div>
      );
    }
    return <LoadingBlock label={busy === "room" ? "读取房间素材" : "读取视频上下文"} />;
  }

  const playbackUrl = context.playable ? context.mediaUrl : previewStatus?.mediaUrl || undefined;
  const needsPreview = !context.playable && previewStatus?.status !== "ready";
  const selectionLabel = `${formatTime(selectionStart)} - ${formatTime(selectionEnd)}`;

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
        <div className="workbench-strip">
          <span>{selectedVideo.name}</span>
          <span>当前 {formatTime(currentTime)}</span>
          <span>区间 {selectionLabel}</span>
          <span>{candidates.length} 候选</span>
          <span>{project.clips.length} 草稿</span>
        </div>

        {isActiveRecording ? (
          <div className="active-recording-notice" data-testid="active-recording-notice">
            <strong>这段还在录制中</strong>
            <span>可以查看画面、弹幕和写入进度；AI 切片、字幕和导出建议等停止并收尾后再做。</span>
          </div>
        ) : null}

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
          <button className="primary" onClick={onRunAsr} disabled={isActiveRecording || busy === "asr" || !asrAvailability.canTranscribe}>
            {busy === "asr" ? <Loader2 className="spin" size={16} /> : <ListVideo size={16} />}
            当前区间 ASR
          </button>
          <button onClick={onRunFullAsr} disabled={isActiveRecording || busy === "asr-full" || !asrAvailability.canTranscribe}>
            {busy === "asr-full" ? <Loader2 className="spin" size={16} /> : <ListVideo size={16} />}
            整片 ASR
          </button>
          <button onClick={onCompareAsr} disabled={isActiveRecording || busy === "asr-compare" || !asrAvailability.canTranscribe}>
            {busy === "asr-compare" ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />}
            ASR 对比
          </button>
        </div>
        {!asrAvailability.canTranscribe ? (
          <p className="asr-availability" data-testid="asr-availability">
            <strong>{asrAvailability.label}</strong>
            <span>{asrAvailability.message}</span>
          </p>
        ) : null}
        <AsrComparisonPanel comparison={asrComparison} onSeek={onSeek} onApply={onApplyAsrComparison} />
      </section>

      <section className="inspector-column">
        <AiPanel
          busy={busy}
          disabled={isActiveRecording}
          sources={sources}
          clipCount={clipCount}
          candidates={candidates}
          diagnostics={sliceDiagnostics}
          currentTime={currentTime}
          onSourceToggle={onSourceToggle}
          onClipCount={onClipCount}
          onRunAi={onRunAi}
          onSeek={onSeek}
          onPreviewClip={onPreviewClip}
          onAddClip={onAddClip}
        />

        <ClipPanel
          clips={project.clips}
          busy={busy}
          disabled={isActiveRecording}
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

const AI_CLIP_COUNT_PRESETS = [
  { label: "少而准", detail: "3个候选", value: 3 },
  { label: "均衡", detail: "5个候选", value: 5 },
  { label: "多找点", detail: "8个候选", value: 8 },
  { label: "扫全片", detail: "12个候选", value: 12 }
];

function AiPanel(props: {
  busy: string | null;
  disabled: boolean;
  sources: string[];
  clipCount: number;
  candidates: ClipCandidate[];
  diagnostics: AiSliceDiagnostics | null;
  currentTime: number;
  onSourceToggle: (source: string) => void;
  onClipCount: (value: number) => void;
  onRunAi: () => void;
  onSeek: (time: number) => void;
  onPreviewClip: (clip: ClipCandidate) => void;
  onAddClip: (clip: ClipCandidate) => void;
}) {
  const highConfidence = props.candidates.filter((candidate) => candidate.score >= 72).length;
  const selectedCountPreset = AI_CLIP_COUNT_PRESETS.find((preset) => preset.value === props.clipCount);
  const clipCountLabel = selectedCountPreset ? selectedCountPreset.label : `${props.clipCount}个候选`;
  const clipSummary = `模型定时长 · ${clipCountLabel}`;
  return (
    <div className="panel">
      <div className="panel-title">
        <Bot size={18} />
        <h3>AI 切片</h3>
        <span>{highConfidence ? `${highConfidence} 个高置信` : clipSummary}</span>
      </div>
      <div className="toggle-row">
        <button className={props.sources.includes("danmaku") ? "selected" : ""} onClick={() => props.onSourceToggle("danmaku")}>
          <MessageSquareText size={15} />弹幕
        </button>
        <button className={props.sources.includes("subtitle") ? "selected" : ""} onClick={() => props.onSourceToggle("subtitle")}>
          <ListVideo size={15} />字幕
        </button>
        <button className={props.sources.includes("visual") ? "selected" : ""} onClick={() => props.onSourceToggle("visual")}>
          <ImageIcon size={15} />画面
        </button>
        <button className={props.sources.includes("audio") ? "selected" : ""} onClick={() => props.onSourceToggle("audio")}>
          <Activity size={15} />频谱
        </button>
      </div>
      <div className="ai-choice-stack">
        <div className="ai-choice-group" data-testid="ai-count-presets">
          <div className="ai-choice-head">
            <span>候选策略</span>
            <strong>模型定时长 · {clipCountLabel}</strong>
          </div>
          <div className="preset-grid">
            {AI_CLIP_COUNT_PRESETS.map((preset) => (
              <button
                key={preset.value}
                type="button"
                className={`preset-button ${props.clipCount === preset.value ? "selected" : ""}`}
                data-testid={`ai-count-preset-${preset.value}`}
                aria-pressed={props.clipCount === preset.value}
                onClick={() => props.onClipCount(preset.value)}
              >
                <Scissors size={14} />
                <span>
                  <strong>{preset.label}</strong>
                  <em>{preset.detail}</em>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
      <button data-testid="run-ai-slices" className="primary wide" onClick={props.onRunAi} disabled={props.disabled || props.busy === "ai"}>
        {props.busy === "ai" ? <Loader2 className="spin" size={16} /> : <Wand2 size={16} />}
        生成候选
      </button>
      {props.diagnostics ? (
        <p className={`slice-diagnostics ${props.diagnostics.modelStatus === "ok" ? "ok" : "warn"}`} data-testid="slice-diagnostics">
          <strong>{sliceDiagnosticsLabel(props.diagnostics)}</strong>
          <span>{props.diagnostics.message}</span>
          {props.diagnostics.warnings?.length ? <small>{props.diagnostics.warnings.join(" / ")}</small> : null}
        </p>
      ) : null}
      <div className="candidate-list">
        {!props.candidates.length ? <EmptyMini label="暂无候选；先生成少量高置信片段。" /> : null}
        {props.candidates.map((candidate) => {
          const evidence = Array.isArray(candidate.evidence) ? candidate.evidence.slice(0, 5) : [];
          const isActive = props.currentTime >= candidate.start && props.currentTime <= candidate.end;
          return (
            <article key={candidate.id} className={`candidate-card ${isActive ? "active" : ""}`} data-testid={`candidate-card-${candidate.id}`}>
              <div className="candidate-card-head">
                <div>
                  <strong>{candidate.title}</strong>
                  <span>
                    {formatTime(candidate.start)} - {formatTime(candidate.end)} · {candidate.score}
                  </span>
                </div>
                <span className={`score-badge ${candidate.score >= 72 ? "strong" : ""}`}>{candidate.score}</span>
                <button className="icon-button" title="跳到片段起点" onClick={() => props.onSeek(candidate.start)}>
                  <Clock3 size={15} />
                </button>
              </div>
              <p className="candidate-reason">
                <b>AI 理由：</b>
                {candidate.reason}
              </p>
              {evidence.length ? (
                <div className="evidence-strip" aria-label="切片证据">
                  {evidence.map((item, index) => {
                    const seekTime = parseEvidenceTime(item) ?? candidate.start;
                    return (
                      <button
                        key={`${item}-${index}`}
                        className="evidence-chip"
                        data-testid={`candidate-evidence-${candidate.id}-${index}`}
                        onClick={() => props.onSeek(seekTime)}
                      >
                        <span>{formatTime(seekTime)}</span>
                        <em>{item}</em>
                      </button>
                    );
                  })}
                </div>
              ) : null}
              <ClipAutomationDetails item={candidate} />
              <div className="card-actions">
                <button onClick={() => props.onPreviewClip(candidate)}>
                  <Play size={15} />预览
                </button>
                <button onClick={() => props.onAddClip(candidate)}>
                  <Plus size={15} />加入
                </button>
              </div>
            </article>
          );
        })}
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
  disabled,
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
  disabled: boolean;
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
            <div className="clip-row-head">
              <input value={clip.title} onChange={(event) => onUpdate(clip.id, { title: event.target.value })} />
              <span>{formatTime(clip.start)} - {formatTime(clip.end)}</span>
            </div>
            <div className="time-pair">
              <input type="number" value={roundTime(clip.start)} onChange={(event) => onUpdate(clip.id, { start: Number(event.target.value) })} />
              <input type="number" value={roundTime(clip.end)} onChange={(event) => onUpdate(clip.id, { end: Number(event.target.value) })} />
            </div>
            <p>{clip.reason}</p>
            <ClipAutomationDetails item={clip} />
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
              <button onClick={() => onExport(clip)} disabled={disabled || busy === `export-${clip.id}`}>
                {busy === `export-${clip.id}` ? <Loader2 className="spin" size={15} /> : <Download size={15} />}
                导出
              </button>
              <button onClick={() => onPackage(clip)} disabled={disabled || busy === `assets-${clip.id}`}>
                {busy === `assets-${clip.id}` ? <Loader2 className="spin" size={15} /> : <Sparkles size={15} />}
                素材包
              </button>
              <button onClick={() => onTitle(clip)} disabled={disabled || busy === `title-${clip.id}`}>
                {busy === `title-${clip.id}` ? <Loader2 className="spin" size={15} /> : <Bot size={15} />}
                生成标题
              </button>
              <button onClick={() => onCover(clip)} disabled={disabled || busy === `cover-${clip.id}`}>
                {busy === `cover-${clip.id}` ? <Loader2 className="spin" size={15} /> : <Film size={15} />}
                封面帧
              </button>
              <button onClick={() => onAiCover(clip)} disabled={disabled || busy === `ai-cover-${clip.id}`}>
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
  const nearbyCount = danmaku.filter((item) => Math.abs(item.time - currentTime) <= 8).length;

  return (
    <div className="editor-panel">
      <div className="panel-title">
        <MessageSquareText size={18} />
        <h3>弹幕</h3>
        <span>{visible.length}/{total}</span>
      </div>
      <div className="sync-summary" data-testid="danmaku-sync-summary">
        <span>当前 {formatTime(currentTime)}</span>
        <span>附近 {nearbyCount} 条</span>
      </div>
      <div className="searchbox slim">
        <Search size={15} />
        <input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="过滤弹幕" />
      </div>
      <div className="table-list">
        {visible.map((item) => {
          const distance = Math.abs(item.time - currentTime);
          const stateClass = distance <= 0.8 ? "is-current" : distance <= 5 ? "is-near" : "";
          return (
            <div className={`editable-row timed-row ${stateClass}`} data-testid={`danmaku-row-${item.id}`} key={item.id}>
              <button data-testid={`danmaku-seek-${item.id}`} onClick={() => onSeek(item.time)}>{formatTime(item.time)}</button>
              <input value={item.text} onChange={(event) => onUpdate(item.id, event.target.value)} />
            </div>
          );
        })}
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
  const activeCue = cues.find((cue) => cue.start <= currentTime && cue.end >= currentTime) || null;
  return (
    <div className="editor-panel">
      <div className="panel-title">
        <ListVideo size={18} />
        <h3>字幕</h3>
        <span>{cues.length}</span>
      </div>
      <div className="sync-summary" data-testid="subtitle-sync-summary">
        <span>当前 {formatTime(currentTime)}</span>
        <span>{activeCue ? `命中 ${formatTime(activeCue.start)}` : "未命中字幕"}</span>
      </div>
      <button className="wide" onClick={onAdd}>
        <Plus size={15} />新增字幕行
      </button>
      <div className="table-list">
        {visible.length === 0 ? <EmptyMini label="当前视频没有字幕文件" /> : null}
        {visible.map((cue) => {
          const isCurrent = cue.start <= currentTime && cue.end >= currentTime;
          const isNear = !isCurrent && Math.abs(cue.start - currentTime) <= 5;
          return (
            <div className={`subtitle-row timed-row ${isCurrent ? "is-current" : isNear ? "is-near" : ""}`} data-testid={`subtitle-row-${cue.id}`} key={cue.id}>
              <button data-testid={`subtitle-seek-${cue.id}`} onClick={() => onSeek(cue.start)}>{formatTime(cue.start)}</button>
              <input type="number" value={roundTime(cue.start)} onChange={(event) => onUpdate(cue.id, { start: Number(event.target.value) })} />
              <input type="number" value={roundTime(cue.end)} onChange={(event) => onUpdate(cue.id, { end: Number(event.target.value) })} />
              <textarea value={cue.text} onChange={(event) => onUpdate(cue.id, { text: event.target.value })} />
            </div>
          );
        })}
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

  async function refreshLoginStatus() {
    setBusy(true);
    try {
      await onRefreshTools();
      setLoginMessage("登录状态已刷新；如果刚完成扫码，Cookie 状态会同步到这里。");
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

  async function finalConfirmUpload() {
    setBusy(true);
    try {
      const result = await runBiliupUpload({ ...draft, autoSubmit: true, cookiePath: draft.cookiePath || tools?.cookiePath });
      setJob(result);
      setLoginMessage("已开始执行最终投稿命令。");
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
  const uploadReadinessIssues = getUploadReadinessIssues(tools, draft);
  const canExecuteUpload = uploadReadinessIssues.length === 0;
  const executeLabel = !tools?.biliup
    ? "先安装 biliup"
    : !tools.cookieExists
      ? "扫码登录后执行"
      : !(draft.parts || []).some((part) => String(part.path || "").trim())
        ? "添加分 P 后执行"
        : draft.publishMode === "append" && !String(draft.vid || "").trim()
          ? "填写目标稿件后执行"
          : "执行";

  const uploadTitle = context?.room.name || "投稿草稿";

  return (
    <div className="upload-layout">
      <section className="upload-main">
        <div className="section-head">
          <div>
            <span className="eyebrow">B 站投稿设置</span>
            <h2>{uploadTitle}</h2>
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
            <span>{tools?.cookieExists ? "Cookie 已存在" : tools?.biliup ? "还差扫码登录" : "先安装投稿工具"}</span>
          </div>
          {!tools?.biliup ? (
            <button className="wide" onClick={installLocalBiliup} disabled={busy || job?.status === "running"}>
              {job?.type === "install-biliup" && job.status === "running" ? <Loader2 className="spin" size={16} /> : <Download size={16} />}
              安装本地 biliup
            </button>
          ) : null}
          <button className="primary wide" onClick={login} disabled={busy || !tools?.biliup}>
            {busy ? <Loader2 className="spin" size={16} /> : <Send size={16} />}
            {tools?.cookieExists ? "重新扫码登录" : "打开扫码终端"}
          </button>
          <button className="wide" data-testid="refresh-login-status" onClick={refreshLoginStatus} disabled={busy}>
            <RefreshCw size={16} />刷新登录状态
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
            <button data-testid="upload-command" onClick={previewCommand} disabled={busy}>
              <Download size={15} />生成命令
            </button>
            <button data-testid="upload-preflight" onClick={runPreflight} disabled={busy}>
              <BadgeCheck size={15} />预检
            </button>
            <button data-testid="upload-final-confirm" onClick={finalConfirmUpload} disabled={busy || !canExecuteUpload} title={uploadReadinessIssues[0] || "执行最终投稿命令"}>
              <Send size={15} />{executeLabel}
            </button>
          </div>
          <UploadReadiness issues={uploadReadinessIssues} />
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

function uploadPolicyLabel(value?: string | null) {
  const policy = String(value || "review");
  if (policy === "auto-only-self") return "仅自己可见";
  if (policy === "auto-public") return "自动公开";
  if (policy === "manual-confirm") return "手动确认";
  if (policy === "review") return "人工复核";
  return policy;
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

function UploadReadiness({ issues }: { issues: string[] }) {
  return (
    <div className={`preflight-box ${issues.length ? "bad" : "ok"}`} data-testid="upload-readiness">
      <strong>{issues.length ? "投稿前还差" : "可以执行投稿"}</strong>
      {issues.length ? (
        <ul>
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      ) : (
        <span>工具、Cookie 和分 P 队列都已就绪；点击执行才会真正调用 biliup。</span>
      )}
    </div>
  );
}

function getUploadReadinessIssues(tools: UploadTools | null, draft: UploadDraft) {
  const issues = [];
  if (!tools?.biliup) issues.push("安装本地 biliup。");
  if (tools?.biliup && !tools.cookieExists) issues.push("扫码登录生成 Cookie。");
  if (!(draft.parts || []).some((part) => String(part.path || "").trim())) issues.push("添加至少一个本地视频分 P。");
  if (draft.publishMode === "append" && !String(draft.vid || "").trim()) issues.push("填写要追加的目标 BV 或 av 号。");
  return issues;
}

function isWaitingRecordingTask(task: WorkbenchTask) {
  return task.source === "recording" && task.type === "recording-room" && /等待开播|未开播/.test(recordingMessageLabel(task.message));
}

function isActiveRecordingTask(task: WorkbenchTask) {
  return task.source === "recording" && task.type === "recording-room" && task.status === "running" && !isWaitingRecordingTask(task);
}

function taskStatusText(task: WorkbenchTask) {
  if (task.status === "error") return recordingStatusLabel(task.status);
  if (task.source === "recording") {
    if (isWaitingRecordingTask(task)) return "等待开播";
    const message = recordingMessageLabel(task.message);
    if (/录制中|直播录制中|准备录制|下播/.test(message)) return message;
  }
  return recordingStatusLabel(task.status);
}

function automationDisplayPriority(job: AutomationJob) {
  const stage = String(job.stage || "");
  const hasExport = Boolean(job.uploadDraftPath || job.exportedClips?.length || (job.acceptedClips || []).some((clip) => clip.exportPath));
  const hasAccepted = Boolean(job.acceptedClips?.length);
  if (job.status === "running" || job.status === "queued") return 0;
  if (hasExport) return 1;
  if (hasAccepted) return 2;
  if (job.status === "error" || stage.includes("blocked")) return 3;
  if (stage.includes("no-high-confidence")) return 5;
  return 4;
}

function sortAutomationJobsForDisplay(jobs: AutomationJob[]) {
  return [...jobs].sort((a, b) => {
    const priority = automationDisplayPriority(a) - automationDisplayPriority(b);
    if (priority !== 0) return priority;
    return Date.parse(b.updatedAt || b.createdAt || "") - Date.parse(a.updatedAt || a.createdAt || "");
  });
}

function TaskCenterView({ automationJobs }: { automationJobs: AutomationJob[] }) {
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

  const activeRecording = tasks.filter(isActiveRecordingTask).length;
  const waitingRecording = tasks.filter(isWaitingRecordingTask).length;
  const failed = tasks.filter((task) => task.status === "error").length;
  const automationSummary = summarizeAutomationJobs(automationJobs);
  const visibleAutomationJobs = sortAutomationJobsForDisplay(automationJobs).slice(0, 8);

  return (
    <div className="tasks-layout">
      <section className="upload-main">
        <div className="section-head">
          <div>
            <span className="eyebrow">任务中心</span>
            <h2>ASR、标题、封面、投稿日志</h2>
          </div>
          <div className="stat-row task-stats">
            <Metric dataTestId="task-stat-recording" label="录制中" value={activeRecording} />
            <Metric dataTestId="task-stat-waiting" label="等待开播" value={waitingRecording} />
            <Metric dataTestId="task-stat-failed" label="失败" value={failed} />
            <Metric dataTestId="task-stat-automation" label="自动切片" value={automationSummary.total} />
          </div>
        </div>
        {error ? <div className="preflight-box bad">{error}</div> : null}
        <section className="task-section" data-testid="automation-task-section">
          <div className="panel-title">
            <Scissors size={18} />
            <h3>自动切片</h3>
            <span>{automationSummary.total}</span>
          </div>
          <AutomationSummaryStrip summary={automationSummary} />
          <div className="task-grid automation-task-grid">
            {visibleAutomationJobs.map((job) => <AutomationJobCard key={job.id} job={job} />)}
            {!automationJobs.length ? <EmptyMini label="还没有自动切片任务；录制完成或手动分析后会出现在这里。" /> : null}
          </div>
        </section>
        <div className="task-grid">
          {tasks.map((task) => {
            const hasRecordingIssue = task.source === "recording" && task.status === "error";
            return (
              <article key={`${task.source}-${task.id}`} className={`task-card ${task.status}`}>
                <div className="task-head">
                  <div>
                    <strong>{taskDisplayLabel(task)}</strong>
                    <span>{taskTypeLabel(task)} · {taskStatusText(task)} · {task.progress}%</span>
                  </div>
                  <em>{task.updatedAt ? formatDate(task.updatedAt) : ""}</em>
                </div>
                {hasRecordingIssue ? <TaskRecordingIssue task={task} /> : <p>{task.source === "recording" ? recordingMessageLabel(task.message) : task.message}</p>}
                {task.source === "recording" ? <RecordingMetricStrip task={task} /> : null}
                <div className="task-progress">
                  <span style={{ width: `${Math.max(0, Math.min(100, task.progress))}%` }} />
                </div>
                {task.outputPath ? <code>{task.outputPath}</code> : null}
                {task.command ? <code>{task.command}</code> : null}
                {task.log && !hasRecordingIssue ? (
                  <details className="recording-log-details">
                    <summary>查看原始日志</summary>
                    <pre className="command-box task-log">{task.log}</pre>
                  </details>
                ) : null}
              </article>
            );
          })}
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

  function patch(section: "recording" | "asr" | "vision" | "cover" | "media", patchValue: Record<string, unknown>) {
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

  function setAutomationSource(source: string, enabled: boolean) {
    setValue((prev) => {
      const current = prev.automation.sources || [];
      const sources = enabled
        ? [...new Set([...current, source])]
        : current.filter((item) => item !== source);
      return { ...prev, automation: { ...prev.automation, sources } };
    });
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
      setMessage(candidates.length ? `找到 ${candidates.length} 个候选录制素材目录。` : "没有自动找到候选目录，可以直接手填路径。");
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
  const completionItems = [
    { label: "直播录制", state: "可用", tone: "ready", detail: "房间卡启动/停止，视频、XML 弹幕和直播事件已接通" },
    { label: "弹幕事件", state: "可用", tone: "ready", detail: "普通弹幕、礼物、醒目留言、舰长事件入库" },
    { label: "AI 切片", state: "已验证", tone: "ready", detail: "候选、模型理由、证据展示和证据跳转已接通" },
    { label: "字幕对齐", state: "已验证", tone: "ready", detail: "ASR 结果会写回全局时间线，字幕、弹幕和证据共用同一预览时间" },
    { label: "投稿门禁", state: "需登录", tone: uploadTools?.biliup ? "partial" : "blocked", detail: "草稿、预检和确认门禁已接；真投稿仍需要登录态和最终确认" }
  ];

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
        <div className="completion-strip" data-testid="feature-completion-strip">
          {completionItems.map((item) => (
            <article key={item.label} className={`completion-card ${item.tone}`}>
              <span>{item.state}</span>
              <strong>{item.label}</strong>
              <small>{item.detail}</small>
            </article>
          ))}
        </div>

        <div className="settings-grid">
          <div className="settings-card wide-card">
            <div className="panel-title">
              <FolderOpen size={18} />
              <h3>录制素材目录</h3>
              <span>{value.recordingsRoot ? "自定义" : "未设置"}</span>
            </div>
            <p className="helper-text">这里是录制文件和已有素材的根目录。换目录后保存并刷新，房间列表会按新目录重新读取。</p>
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
              <p className="helper-text">没有候选目录时直接粘贴路径即可。</p>
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
            <p className="helper-text">AI 切片会直接走这里生成候选；模型不可用时不会再用本地规则冒充候选。</p>
            <label>
              接口类型
              <select value={value.vision.provider} onChange={(event) => patch("vision", { provider: event.target.value })}>
                <option value="openai-compatible">OpenAI 兼容接口</option>
                <option value="custom-json">自定义 JSON 接口</option>
                <option value="manual">关闭模型切片</option>
              </select>
            </label>
            <label>
              Wire API
              <select value={value.vision.wireApi || "chat-completions"} onChange={(event) => patch("vision", { wireApi: event.target.value })}>
                <option value="responses">Responses (/v1/responses)</option>
                <option value="chat-completions">Chat Completions (/v1/chat/completions)</option>
              </select>
            </label>
            <label>
              Endpoint
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
            <p className="helper-text">这个是录制素材批量整理，不是浏览器预览。转换后素材库会优先展示同名 MP4。</p>
            <label>
              输出位置
              <select value={value.media.flvOutputMode} onChange={(event) => patch("media", { flvOutputMode: event.target.value })}>
                <option value="same-dir">原目录同名 MP4</option>
                <option value="compressed-dir">原目录下 _compressed 子目录</option>
              </select>
            </label>
            <label>
              视频处理
              <select value={value.media.videoTranscodeMode} onChange={(event) => patch("media", { videoTranscodeMode: event.target.value })}>
                <option value="compress">压缩为 H.264</option>
                <option value="copy">只转封装，不压视频</option>
              </select>
            </label>
            {value.media.videoTranscodeMode !== "copy" ? (
              <div className="form-grid">
                <label>
                  视频 CRF
                  <input type="number" min={0} max={51} value={value.media.videoCrf} onChange={(event) => patch("media", { videoCrf: Number(event.target.value) })} />
                </label>
                <label>
                  压缩速度
                  <select value={value.media.videoPreset} onChange={(event) => patch("media", { videoPreset: event.target.value })}>
                    <option value="ultrafast">ultrafast</option>
                    <option value="veryfast">veryfast</option>
                    <option value="fast">fast</option>
                    <option value="medium">medium</option>
                    <option value="slow">slow</option>
                  </select>
                </label>
              </div>
            ) : null}
            <label>
              音频处理
              <select value={value.media.audioTranscodeMode} onChange={(event) => patch("media", { audioTranscodeMode: event.target.value })}>
                <option value="aac">压缩 AAC</option>
                <option value="lossless">无损 ALAC</option>
                <option value="copy">保留原音频</option>
              </select>
            </label>
            {value.media.audioTranscodeMode === "aac" ? (
              <label>
                音频码率 Kbps
                <input type="number" min={64} max={512} value={value.media.audioBitrateKbps} onChange={(event) => patch("media", { audioBitrateKbps: Number(event.target.value) })} />
              </label>
            ) : null}
            <div className="switch-grid tight">
              <Switch checked={value.media.skipIfMp4Exists} label="已有 MP4 就跳过" onChange={(checked) => patch("media", { skipIfMp4Exists: checked })} />
              <Switch checked={value.media.deleteSourceAfterConvert} label="转完删除原 FLV" onChange={(checked) => patch("media", { deleteSourceAfterConvert: checked })} />
            </div>
            <div className="button-row">
              <button onClick={() => void convertFlvNow()} disabled={busy !== null}>
                {busy === "convert-flv" ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}转换全部 FLV 素材
              </button>
            </div>
          </div>

          <div className="settings-card">
            <div className="panel-title">
              <Sparkles size={18} />
              <h3>自动切片</h3>
              <span>{value.automation.enabled ? "已启用" : "关闭"}</span>
            </div>
            <p className="helper-text">录制完成后按弹幕、字幕和视频理解挑少量高置信片段；投稿仍会走确认门禁。</p>
            <div className="switch-grid tight">
              <Switch checked={value.automation.enabled} label="启用自动切片" onChange={(checked) => setValue((prev) => ({ ...prev, automation: { ...prev.automation, enabled: checked } }))} />
              <Switch checked={value.automation.triggerOnRecordingComplete !== false} label="录制完成自动排队" onChange={(checked) => setValue((prev) => ({ ...prev, automation: { ...prev.automation, triggerOnRecordingComplete: checked } }))} />
              <Switch checked={value.automation.autoAnalyze} label="录制完成后分析" onChange={(checked) => setValue((prev) => ({ ...prev, automation: { ...prev.automation, autoAnalyze: checked } }))} />
              <Switch checked={value.automation.autoExport} label="高置信片段自动导出" onChange={(checked) => setValue((prev) => ({ ...prev, automation: { ...prev.automation, autoExport: checked } }))} />
              <Switch checked={value.automation.autoUpload} label="生成投稿草稿" onChange={(checked) => setValue((prev) => ({ ...prev, automation: { ...prev.automation, autoUpload: checked } }))} />
              <Switch checked={value.automation.requireHighConfidence !== false} label="只收可直接发片段" onChange={(checked) => setValue((prev) => ({ ...prev, automation: { ...prev.automation, requireHighConfidence: checked } }))} />
              <Switch checked={Boolean(value.automation.burnSubtitles)} label="导出时压字幕" onChange={(checked) => setValue((prev) => ({ ...prev, automation: { ...prev.automation, burnSubtitles: checked } }))} />
              <Switch checked={value.automation.sources.includes("danmaku")} label="分析弹幕" onChange={(checked) => setAutomationSource("danmaku", checked)} />
              <Switch checked={value.automation.sources.includes("subtitle")} label="分析字幕" onChange={(checked) => setAutomationSource("subtitle", checked)} />
              <Switch checked={value.automation.sources.includes("visual")} label="分析画面" onChange={(checked) => setAutomationSource("visual", checked)} />
              <Switch checked={value.automation.sources.includes("audio")} label="分析频谱" onChange={(checked) => setAutomationSource("audio", checked)} />
            </div>
            <div className="form-grid">
              <label>
                投稿策略
                <select value={value.automation.uploadPolicy} onChange={(event) => setValue((prev) => ({ ...prev, automation: { ...prev.automation, uploadPolicy: event.target.value } }))}>
                  <option value="review">只生成待审草稿</option>
                  <option value="auto-only-self">自动仅自己可见草稿</option>
                  <option value="auto-public">公开投稿前强门禁</option>
                  <option value="manual-confirm">每次手动确认</option>
                </select>
              </label>
              <label>
                最低分
                <input type="number" min={1} max={100} value={value.automation.minScore} onChange={(event) => setValue((prev) => ({ ...prev, automation: { ...prev.automation, minScore: Number(event.target.value) } }))} />
              </label>
              <label>
                最少证据数
                <input type="number" min={1} max={10} value={value.automation.minEvidenceCount || 2} onChange={(event) => setValue((prev) => ({ ...prev, automation: { ...prev.automation, minEvidenceCount: Number(event.target.value) } }))} />
              </label>
              <label>
                候选数量
                <input type="number" min={1} max={6} value={value.automation.clipCount} onChange={(event) => setValue((prev) => ({ ...prev, automation: { ...prev.automation, clipCount: Number(event.target.value) } }))} />
              </label>
              <label>
                画面抽帧数
                <input type="number" min={1} max={12} value={value.vision.frameSampleCount || 6} onChange={(event) => patch("vision", { frameSampleCount: Number(event.target.value) })} />
              </label>
              <label>
                模型温度
                <input type="number" min={0} max={1.5} step={0.05} value={value.vision.sliceTemperature ?? 0.35} onChange={(event) => patch("vision", { sliceTemperature: Number(event.target.value) })} />
              </label>
            </div>
            <label>
              AI 切片提示词
              <textarea value={value.vision.slicePrompt || ""} onChange={(event) => patch("vision", { slicePrompt: event.target.value })} />
            </label>
          </div>

          <div className="settings-card wide-card">
            <div className="panel-title">
              <Play size={18} />
              <h3>直播录制</h3>
              <span>{recordingEngineLabel(value.recording.backend)}</span>
            </div>
            <p className="helper-text">主流程使用内置 B 站取流和弹幕采集；下面这些设置会直接影响房间卡上的录制按钮。</p>
            <div className="recording-settings-grid">
              <div className="settings-subcard">
                <h4>常用录制</h4>
                <div className="form-grid">
                  <label>
                    录制引擎
                    <input value="B 站直播录制" disabled readOnly />
                  </label>
                  <label>
                    录制模式
                    <select value={value.recording.recordingMode} onChange={(event) => patch("recording", { recordingMode: event.target.value })}>
                      <option value="standard">标准录制</option>
                      <option value="raw">原始流优先</option>
                    </select>
                  </label>
                  <label>
                    录制画质 qn
                    <input type="number" min={80} max={30000} value={value.recording.qualityNumber} onChange={(event) => patch("recording", { qualityNumber: Number(event.target.value) })} />
                  </label>
                  <label>
                    流格式
                    <select value={value.recording.streamFormat} onChange={(event) => patch("recording", { streamFormat: event.target.value })}>
                      <option value="flv">FLV（推荐，稳定录制）</option>
                      <option value="fmp4">fMP4（实验，直接 MP4）</option>
                      <option value="ts">TS</option>
                    </select>
                  </label>
                  {value.recording.streamFormat === "fmp4" ? (
                    <p className="settings-inline-warning span-2">fMP4 会直接写 MP4，但直播流断开或未完整收尾时更容易无法预览。稳定录制建议用 FLV，再生成 MP4 预览或批量转换。</p>
                  ) : null}
                  <label>
                    编码
                    <select value={value.recording.streamCodec} onChange={(event) => patch("recording", { streamCodec: event.target.value })}>
                      <option value="avc">AVC/H.264</option>
                      <option value="hevc">HEVC/H.265</option>
                    </select>
                  </label>
                  <label>
                    最大并发录制
                    <input type="number" min={1} max={12} value={value.recording.maxConcurrentRecordings} onChange={(event) => patch("recording", { maxConcurrentRecordings: Number(event.target.value) })} />
                  </label>
                </div>
                <div className="switch-grid tight">
                  <Switch checked={value.recording.autoMonitorEnabled !== false} label="自动录制" onChange={(checked) => patch("recording", { autoMonitorEnabled: checked })} />
                </div>
              </div>

              <div className="settings-subcard">
                <h4>文件与分段</h4>
                <div className="form-grid">
                  <label className="span-2">
                    录制输出目录
                    <input value={value.recording.outputDir} onChange={(event) => patch("recording", { outputDir: event.target.value })} placeholder="留空则跟随录制素材目录" />
                  </label>
                  <label>
                    房间目录模板
                    <input value={value.recording.roomFolderTemplate} onChange={(event) => patch("recording", { roomFolderTemplate: event.target.value })} />
                  </label>
                  <label>
                    文件名模板
                    <input value={value.recording.filenameTemplate} onChange={(event) => patch("recording", { filenameTemplate: event.target.value })} />
                  </label>
                  <label>
                    按时长分段（秒）
                    <input type="number" min={0} max={86400} value={value.recording.segmentSeconds} onChange={(event) => patch("recording", { segmentSeconds: Number(event.target.value) })} />
                  </label>
                  <label>
                    按大小分段（MB）
                    <input type="number" min={0} max={1048576} value={value.recording.fileSizeLimitMb} onChange={(event) => patch("recording", { fileSizeLimitMb: Number(event.target.value) })} />
                  </label>
                  <label>
                    写入缓冲（KB）
                    <input type="number" min={4} max={524288} value={value.recording.bufferSizeKb} onChange={(event) => patch("recording", { bufferSizeKb: Number(event.target.value) })} />
                  </label>
                  <label>
                    最大固定房间
                    <input type="number" min={1} max={200} value={value.recording.maxConfiguredRooms} onChange={(event) => patch("recording", { maxConfiguredRooms: Number(event.target.value) })} />
                  </label>
                </div>
              </div>

              <div className="settings-subcard">
                <h4>弹幕采集</h4>
                <div className="form-grid">
                  <label className="span-2">
                    弹幕服务器
                    <input value={value.recording.danmakuServer} onChange={(event) => patch("recording", { danmakuServer: event.target.value })} placeholder="auto 或 ws://127.0.0.1:2243" />
                  </label>
                </div>
                <div className="switch-grid tight">
                  <Switch checked={value.recording.enableDanmaku} label="同步 XML 弹幕" onChange={(checked) => patch("recording", { enableDanmaku: checked })} />
                  <Switch checked={value.recording.saveRawDanmaku} label="保存原始 JSONL" onChange={(checked) => patch("recording", { saveRawDanmaku: checked })} />
                  <Switch checked={value.recording.danmuUname} label="记录弹幕用户名" onChange={(checked) => patch("recording", { danmuUname: checked })} />
                  <Switch checked={value.recording.recordGiftSend} label="记录付费礼物" onChange={(checked) => patch("recording", { recordGiftSend: checked })} />
                  <Switch checked={value.recording.recordFreeGifts} label="记录免费礼物" onChange={(checked) => patch("recording", { recordFreeGifts: checked })} />
                  <Switch checked={value.recording.recordGuardBuy} label="记录舰长购买" onChange={(checked) => patch("recording", { recordGuardBuy: checked })} />
                  <Switch checked={value.recording.recordSuperChat} label="记录醒目留言" onChange={(checked) => patch("recording", { recordSuperChat: checked })} />
                </div>
              </div>

              <details className="settings-subcard advanced-settings recording-advanced">
                <summary>高级：重连与存储保护</summary>
                <div className="form-grid">
                  <label>
                    API 地址
                    <input value={value.recording.biliApiBase} onChange={(event) => patch("recording", { biliApiBase: event.target.value })} />
                  </label>
                  <label>
                    Web API 地址
                    <input value={value.recording.biliWebApiBase || ""} onChange={(event) => patch("recording", { biliWebApiBase: event.target.value })} />
                  </label>
                  <label className="span-2">
                    Cookie 文件
                    <input value={value.recording.cookiePath || ""} onChange={(event) => patch("recording", { cookiePath: event.target.value })} placeholder=".workbench/drafts/cookies.json" />
                  </label>
                  <label>
                    接口超时（秒）
                    <input type="number" min={3} max={120} value={value.recording.requestTimeoutSeconds} onChange={(event) => patch("recording", { requestTimeoutSeconds: Number(event.target.value) })} />
                  </label>
                  <label>
                    单段取流超时（秒）
                    <input type="number" min={0} max={86400} value={value.recording.streamTimeoutSeconds} onChange={(event) => patch("recording", { streamTimeoutSeconds: Number(event.target.value) })} />
                  </label>
                  <label>
                    断流容忍（秒）
                    <input type="number" min={0} max={1800} value={value.recording.disconnectionTimeoutSeconds} onChange={(event) => patch("recording", { disconnectionTimeoutSeconds: Number(event.target.value) })} />
                  </label>
                  <label>
                    断线重连（秒）
                    <input type="number" min={1} max={120} value={value.recording.reconnectSeconds} onChange={(event) => patch("recording", { reconnectSeconds: Number(event.target.value) })} />
                  </label>
                  <label>
                    稳定保留小时
                    <input type="number" min={1} max={168} value={value.recording.stabilityHours} onChange={(event) => patch("recording", { stabilityHours: Number(event.target.value) })} />
                  </label>
                  <label>
                    磁盘保护频率（秒）
                    <input type="number" min={0} max={600} value={value.recording.spaceCheckIntervalSeconds} onChange={(event) => patch("recording", { spaceCheckIntervalSeconds: Number(event.target.value) })} />
                  </label>
                  <label>
                    空间阈值（MB）
                    <input type="number" min={0} max={1048576} value={value.recording.spaceThresholdMb} onChange={(event) => patch("recording", { spaceThresholdMb: Number(event.target.value) })} />
                  </label>
                </div>
                <div className="switch-grid tight">
                  <Switch checked={value.recording.enableWbiSigning !== false} label="WBI 签名" onChange={(checked) => patch("recording", { enableWbiSigning: checked })} />
                  <Switch checked={value.recording.recycleRecords} label="空间不足回收旧视频" onChange={(checked) => patch("recording", { recycleRecords: checked })} />
                </div>
              </details>

              <div className="settings-subcard">
                <h4>后处理</h4>
                <div className="form-grid">
                  <label>
                    封面保存策略
                    <select value={value.recording.coverSaveStrategy} onChange={(event) => patch("recording", { coverSaveStrategy: event.target.value })}>
                      <option value="default">默认</option>
                      <option value="room-cover">直播间封面</option>
                      <option value="recording-cover">录制封面</option>
                    </select>
                  </label>
                </div>
                <div className="switch-grid tight">
                  <Switch checked={value.recording.saveCover} label="保存直播封面" onChange={(checked) => patch("recording", { saveCover: checked })} />
                  <Switch checked={value.recording.remuxToMp4} label="录完转封装 MP4" onChange={(checked) => patch("recording", { remuxToMp4: checked })} />
                  <Switch checked={value.recording.deleteSourceAfterRemux !== "never"} label="FLV 转 MP4 后删除 FLV" onChange={(checked) => patch("recording", { deleteSourceAfterRemux: checked ? "always" : "never" })} />
                  <Switch checked={value.recording.injectExtraMetadata} label="写入关键帧/元数据" onChange={(checked) => patch("recording", { injectExtraMetadata: checked })} />
                  <Switch checked={value.recording.enableWebhooks} label="发送兼容 webhook 事件" onChange={(checked) => patch("recording", { enableWebhooks: checked })} />
                </div>
              </div>
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

const DEFAULT_SLICE_PROMPT = [
  "你是一个看直播切片的剪辑师，不是质检员。先判断这个点会不会让人想点开、看完、转发。",
  "不要为了凑数量硬选；宁愿少给，也别把普通聊天包装成高能。",
  "标题要像真实 B 站短切片标题：口语、有钩子、能让人知道笑点或反差在哪；少用“高能来袭”“名场面”这类空泛词。",
  "理由写给剪辑的人看，一两句话就够：说清包袱、反差、节奏变化、观众反应或画面/声音为什么成立。",
  "证据要短而具体，优先引用弹幕原话、字幕台词、画面动作、频谱变化；不要写“多信号综合判断”这种废话。"
].join("\n");

function defaultServiceSettings(): ServiceSettings {
  return {
    recordingsRoot: "",
    recording: {
      backend: "internal",
      outputDir: "",
      host: "127.0.0.1",
      port: 2233,
      apiKey: "",
      maxConfiguredRooms: 10,
      maxConcurrentRecordings: 3,
      autoMonitorEnabled: true,
      stabilityHours: 24,
      enableWebhooks: false,
      webhookUrl: "",
      biliApiBase: "https://api.live.bilibili.com",
      biliWebApiBase: "https://api.bilibili.com",
      cookiePath: "",
      enableWbiSigning: true,
      roomFolderTemplate: "{anchorName}_{roomId}",
      filenameTemplate: "{start}_{title}_{roomId}_{backend}",
      segmentSeconds: 0,
      fileSizeLimitMb: 0,
      qualityNumber: 10000,
      streamFormat: "flv",
      streamCodec: "avc",
      recordingMode: "standard",
      bufferSizeKb: 8,
      requestTimeoutSeconds: 12,
      streamTimeoutSeconds: 0,
      disconnectionTimeoutSeconds: 600,
      pollIntervalSeconds: 600,
      reconnectSeconds: 5,
      enableDanmaku: true,
      saveRawDanmaku: false,
      danmakuServer: "auto",
      danmuUname: false,
      recordGiftSend: true,
      recordFreeGifts: true,
      recordGuardBuy: true,
      recordSuperChat: true,
      saveCover: false,
      coverSaveStrategy: "default",
      remuxToMp4: true,
      injectExtraMetadata: true,
      deleteSourceAfterRemux: "always",
      spaceCheckIntervalSeconds: 60,
      spaceThresholdMb: 1024,
      recycleRecords: false
    },
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
      wireApi: "chat-completions",
      endpoint: "http://localhost:8317/v1",
      apiKey: "your-api-key-1",
      model: "gpt-5.4",
      sendFrames: true,
      sendAudio: false,
      sendSubtitles: true,
      sendDanmaku: true,
      frameSampleCount: 6,
      audioSpectrum: true,
      sliceTemperature: 0.35,
      slicePrompt: DEFAULT_SLICE_PROMPT
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
      skipIfMp4Exists: true,
      videoTranscodeMode: "compress",
      videoCrf: 23,
      videoPreset: "veryfast",
      audioTranscodeMode: "aac",
      audioBitrateKbps: 160
    },
    automation: {
      enabled: false,
      triggerOnRecordingComplete: true,
      autoAnalyze: true,
      autoExport: false,
      autoUpload: false,
      uploadPolicy: "review",
      clipDuration: 90,
      clipCount: 3,
      sources: ["danmaku", "subtitle"],
      minScore: 72,
      minEvidenceCount: 2,
      requireHighConfidence: true,
      burnSubtitles: false
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

function getAsrAvailability(settings: Settings | null): AsrAvailability {
  const asr = settings?.serviceSettings.asr;
  if (!asr) {
    return {
      canTranscribe: false,
      label: "ASR 未加载",
      message: "ASR 设置还没加载完成，稍后再试。"
    };
  }
  if (asr.mode === "extract-audio") {
    return {
      canTranscribe: false,
      label: "仅抽音频",
      message: "当前 ASR 模式只会提取 audio.wav，不会生成字幕；去设置启用 Fun-ASR、Qwen3-ASR、云端 ASR 或自定义识别命令。"
    };
  }
  if (asr.mode === "cloud-endpoint" && !asr.endpoint) {
    return {
      canTranscribe: false,
      label: "云端 ASR 未配置",
      message: "云端 ASR 缺少接口地址，先在设置里填 endpoint 和模型。"
    };
  }
  if (asr.mode === "local-command" && !String(asr.localCommand || "").trim()) {
    return {
      canTranscribe: false,
      label: "命令未配置",
      message: "自定义 ASR 命令为空，先在设置里填识别命令模板。"
    };
  }
  return {
    canTranscribe: true,
    label: describeAsrMode(asr.mode),
    message: ""
  };
}

function sliceModelNotice(diagnostics?: AiSliceDiagnostics | null) {
  if (!diagnostics) return "";
  if (diagnostics.modelStatus === "ok") return "，模型已生成";
  if (diagnostics.modelStatus === "error") return "，模型调用失败";
  if (diagnostics.modelStatus === "not-configured") return "，未配置模型";
  if (diagnostics.modelStatus === "empty-response") return "，模型没有返回候选";
  return "";
}

function sliceDiagnosticsLabel(diagnostics: AiSliceDiagnostics) {
  if (diagnostics.modelStatus === "ok") return "模型切片";
  if (diagnostics.modelStatus === "error") return "模型调用失败";
  if (diagnostics.modelStatus === "not-configured") return "模型未配置";
  if (diagnostics.modelStatus === "empty-response") return "模型空返回";
  if (diagnostics.modelStatus === "no-candidates") return "未命中候选";
  return diagnostics.engine || "切片诊断";
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
      {candidates.map((candidate) => {
        const active = currentTime >= candidate.start && currentTime <= candidate.end;
        return (
          <g
            key={candidate.id}
            className="candidate-marker"
            data-testid={`timeline-candidate-${candidate.id}`}
            onClick={(event) => {
              event.stopPropagation();
              onSeek(candidate.start);
            }}
          >
            <title>{`${candidate.title} ${formatTime(candidate.start)} - ${formatTime(candidate.end)}`}</title>
            <rect
              className={`candidate-span ${active ? "active" : ""}`}
              x={(candidate.start / safeDuration) * width}
              y="0"
              width={Math.max(2, ((candidate.end - candidate.start) / safeDuration) * width)}
              height={height}
            />
          </g>
        );
      })}
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
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!src || failed) {
    return (
      <span className="cover-fallback" aria-hidden="true">
        {label.slice(0, 2)}
      </span>
    );
  }
  return <img src={proxyBiliImage(src)} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

function proxyBiliImage(src: string) {
  if (/^https:\/\/([^/]+\.)?(hdslb|bilibili)\.com\//i.test(src)) {
    return `/api/image-proxy?url=${encodeURIComponent(src)}`;
  }
  return src;
}

function Switch({
  checked,
  label,
  onChange,
  disabled = false,
  dataTestId
}: {
  checked: boolean;
  label: string;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  dataTestId?: string;
}) {
  return (
    <label className={`switch ${disabled ? "disabled" : ""}`} data-testid={dataTestId}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function Metric({ label, value, dataTestId }: { label: string; value: string | number; dataTestId?: string }) {
  return (
    <div className="metric" data-testid={dataTestId}>
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
    start: roundTime(cue.start + (cue.timebase === "global" ? 0 : offset)),
    end: roundTime(cue.end + (cue.timebase === "global" ? 0 : offset)),
    source: cue.source || "asr"
  }));
}

function isAsrCompletedStatus(status: string) {
  return status === "completed" || status === "ready";
}

function toggleValue(values: string[], value: string) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function readableError(error: unknown) {
  const payload = error && typeof error === "object" && "payload" in error
    ? (error as { payload?: unknown }).payload
    : null;
  const diagnosticMessage = diagnosticPayloadMessage(payload);
  if (diagnosticMessage) return diagnosticMessage;
  if (error instanceof Error) {
    const parsed = parseErrorMessagePayload(error.message);
    const parsedDiagnostic = diagnosticPayloadMessage(parsed);
    if (parsedDiagnostic) return parsedDiagnostic;
    return error.message;
  }
  const parsed = parseErrorMessagePayload(String(error));
  const parsedDiagnostic = diagnosticPayloadMessage(parsed);
  if (parsedDiagnostic) return parsedDiagnostic;
  return error instanceof Error ? error.message : String(error);
}

function diagnosticPayloadMessage(payload: unknown) {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as {
    diagnostic?: { message?: unknown };
    error?: unknown;
    message?: unknown;
  };
  if (typeof record.diagnostic?.message === "string") return record.diagnostic.message;
  if (record.error && typeof record.error === "object") {
    const nested = record.error as { message?: unknown };
    if (typeof nested.message === "string") return nested.message;
  }
  if (typeof record.error === "string") return record.error;
  if (typeof record.message === "string") return record.message;
  return "";
}

function parseErrorMessagePayload(message: string) {
  const text = String(message || "").trim();
  if (!text || !/^[\[{]/.test(text)) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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

function parseEvidenceTime(value: string) {
  const text = String(value || "");
  const secondMatch = text.match(/(?:^|[^\d])(\d{1,5}(?:\.\d+)?)\s*(?:s|秒)(?=$|[^\d])/i);
  if (secondMatch) {
    const seconds = Number(secondMatch[1]);
    if (Number.isFinite(seconds)) return seconds;
  }
  const colonMatch = text.match(/(?:^|[^\d])(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?/);
  if (!colonMatch) return null;
  const hours = Number(colonMatch[1] || 0);
  const minutes = Number(colonMatch[2] || 0);
  const seconds = Number(colonMatch[3] || 0);
  const fraction = colonMatch[4] ? Number(`0.${colonMatch[4]}`) : 0;
  const total = hours * 3600 + minutes * 60 + seconds + fraction;
  return Number.isFinite(total) ? total : null;
}

function formatSize(bytes?: number | null) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return "0 MB";
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(value / 1024))} KB`;
}

function formatSpeed(bytesPerSecond?: number | null) {
  return `${formatSize(bytesPerSecond || 0)}/s`;
}

function roundTime(seconds: number) {
  return Math.round((seconds || 0) * 10) / 10;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知时间";
  return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}
