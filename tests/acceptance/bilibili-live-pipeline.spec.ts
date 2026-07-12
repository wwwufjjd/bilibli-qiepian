import { expect, test } from "@playwright/test";

const roomId = "22889";

test.beforeEach(async ({ page }) => {
  let roomStatus: Record<string, unknown> = {
    roomId,
    inputRoomId: roomId,
    name: "Public live room",
    title: "Public live room",
    anchorName: "Public Anchor",
    coverUrl: "https://example.test/cover.jpg",
    parentAreaName: "网游",
    areaName: "英雄联盟",
    biliLiveStatus: "live",
    enabled: true,
    taskStatus: "idle",
    liveStatus: "unknown",
    message: "Ready",
    nextAction: "start"
  };
  let monitorStatus: Record<string, unknown> = {
    enabled: true,
    running: false,
    scheduled: true,
    nextRunAt: "2026-06-17T12:10:00.000Z",
    lastResult: null,
    intervalSeconds: 600,
    enabledRooms: 1,
    activeRecordings: 0,
    waitingRooms: 0,
    updatedAt: "2026-06-17T12:00:00.000Z"
  };
  let recordingEvents: Record<string, unknown>[] = [
    {
      id: "event-live-began",
      type: "LiveBeganEvent",
      date: "2026-06-17T12:00:00.000Z",
      roomId,
      path: null,
      data: { room_id: Number(roomId) }
    }
  ];

  await page.route("**/api/recording/config", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        json: {
          limits: { maxConfiguredRooms: 10, maxConcurrentRecordings: 3, stabilityHours: 24 }
        }
      });
      return;
    }
    await route.fulfill({ json: { ok: true } });
  });

  await page.route(/\/api\/recording\/rooms(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      json: {
        rooms: [roomStatus]
      }
    });
  });

  await page.route("**/api/recording/monitor/status", async (route) => {
    await route.fulfill({ json: monitorStatus });
  });

  await page.route("**/api/recording/events**", async (route) => {
    await route.fulfill({ json: { events: recordingEvents } });
  });

  await page.route("**/api/recording/monitor/sweep", async (route) => {
    roomStatus = {
      ...roomStatus,
      biliLiveStatus: "offline",
      taskStatus: "waiting",
      liveStatus: "offline",
      message: "等待开播",
      monitorCheckedAt: "2026-06-17T12:00:05.000Z",
      nextMonitorAt: "2026-06-17T12:10:05.000Z"
    };
    recordingEvents = [
      {
        id: "event-live-ended",
        type: "LiveEndedEvent",
        date: "2026-06-17T12:00:05.000Z",
        roomId,
        path: null,
        data: { room_id: Number(roomId) }
      }
    ];
    monitorStatus = {
      ...monitorStatus,
      lastResult: {
        status: "ok",
        checked: 1,
        started: 0,
        waiting: 1,
        skipped: 0,
        errors: 0,
        updatedAt: "2026-06-17T12:00:05.000Z"
      },
      waitingRooms: 1,
      nextRunAt: "2026-06-17T12:10:05.000Z"
    };
    await route.fulfill({ json: { ok: true, ...(monitorStatus.lastResult as Record<string, unknown>) } });
  });

  await page.route(`**/api/recording/rooms/${roomId}`, async (route) => {
    if (route.request().method() === "DELETE") {
      roomStatus = {};
      await route.fulfill({ json: { ok: true, rooms: [] } });
      return;
    }
    if (route.request().method() !== "PATCH") {
      await route.fallback();
      return;
    }
    const patch = route.request().postDataJSON() as Record<string, unknown>;
    roomStatus = { ...roomStatus, ...patch };
    await route.fulfill({ json: { ok: true, room: roomStatus, rooms: [roomStatus] } });
  });

  await page.route(`**/api/recording/rooms/${roomId}/start`, async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({ oneShot: true });
    roomStatus = {
      ...roomStatus,
      taskStatus: "recording",
      liveStatus: "live",
      recordingPath: "D:/Recordings/22889/blive_22889.flv",
      danmakuPath: "D:/Recordings/22889/blive_22889.xml",
      videoSize: 1024 * 1024,
      bytesWritten: 1024 * 1024,
      speedBytesPerSecond: 512 * 1024,
      averageSpeedBytesPerSecond: 384 * 1024,
      elapsedSeconds: 42,
      staleSeconds: 0,
      stalled: false,
      danmakuSize: 4096,
      danmakuCount: 128,
      message: "recording",
      nextAction: "stop"
    };
    await route.fulfill({
      json: {
        roomId,
        taskStatus: "recording",
        message: "recording",
        nextAction: "stop"
      }
    });
  });

  await page.route(`**/api/recording/rooms/${roomId}/stop`, async (route) => {
    roomStatus = {
      ...roomStatus,
      taskStatus: "completed",
      recordingPath: "D:/Recordings/22889/blive_22889.flv",
      danmakuPath: "D:/Recordings/22889/blive_22889.xml",
      videoSize: 2 * 1024 * 1024,
      bytesWritten: 2 * 1024 * 1024,
      danmakuSize: 8192,
      danmakuCount: 256,
      refreshed: true,
      message: "completed",
      nextAction: "open"
    };
    await route.fulfill({
      json: roomStatus
    });
  });
});

test("room recording switch only disables automatic waiting", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("recording-dashboard")).toBeVisible();
  await expect(page.getByTestId(`room-bili-meta-${roomId}`)).toContainText("主播 Public Anchor");
  await expect(page.getByTestId(`room-bili-meta-${roomId}`)).toContainText("直播中");
  await expect(page.getByTestId(`start-room-${roomId}`)).toBeEnabled();
  await page.getByTestId(`room-recording-toggle-${roomId}`).click();
  await expect(page.getByTestId(`start-room-${roomId}`)).toBeEnabled();
  await expect(page.getByTestId(`start-room-${roomId}`)).toContainText("立即录制");
  await expect(page.getByTestId(`room-status-${roomId}`)).toContainText("已关闭");
  await expect(page.getByTestId(`room-flow-${roomId}`)).toContainText("手动立即录制");
});

test("room overview presents automatic live state without manual sweep", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("recording-monitor-strip")).toContainText("开播/下播状态");
  await expect(page.getByTestId("recording-monitor-strip")).toContainText("下播后自动入库");
  await expect(page.getByTestId("recording-monitor-strip")).not.toContainText("检查中");
  await expect(page.getByTestId("recording-monitor-strip")).not.toContainText("巡检");
  await expect(page.getByTestId("recording-monitor-strip")).not.toContainText("下次检查");
  await expect(page.getByTestId("recording-monitor-strip")).not.toContainText("准备中");
  await expect(page.getByTestId("recording-dashboard")).not.toContainText("房间状态");
  await expect(page.getByTestId("recording-dashboard")).not.toContainText("内置录制");
  await expect(page.getByTestId("recording-dashboard")).not.toContainText("监控开");
  await expect(page.getByTestId("recording-dashboard")).not.toContainText("后台兜底");
  await expect(page.locator(".library-room-tools").getByRole("button", { name: /刷新/ })).toHaveCount(0);
  await expect(page.getByTestId("recording-recent-events")).toContainText("开播");
  await expect(page.getByTestId("check-live-rooms")).toHaveCount(0);
  await expect(page.getByTestId(`start-room-${roomId}`)).toContainText("立即录制");
});

test("settings completion strip reflects verified workflow gates", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "设置" }).click();
  await expect(page.getByTestId("feature-completion-strip")).toContainText("AI 切片");
  await expect(page.getByTestId("feature-completion-strip")).toContainText("已验证");
  await expect(page.getByTestId("feature-completion-strip")).toContainText("字幕对齐");
  await expect(page.getByTestId("feature-completion-strip")).toContainText("投稿门禁");
  await expect(page.getByTestId("feature-completion-strip")).not.toContainText("需实测");
  await expect(page.getByTestId("feature-completion-strip")).not.toContainText("自动投稿");
  await expect(page.locator("body")).not.toContainText("全自动投稿");
});

test("room delete removes recording config without deleting material card", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("recording-dashboard")).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByTestId(`delete-room-${roomId}`).click();
  await expect(page.getByTestId(`delete-room-${roomId}`)).toHaveCount(0);
  await expect(page.getByTestId(`start-room-${roomId}`)).toHaveCount(0);
});

test("material-only rooms can be hidden from the library", async ({ page }) => {
  let rooms = [
    {
      key: "local-room-key",
      path: "D:/Recordings/667788 - Local Room",
      folderName: "667788 - Local Room",
      roomId: "667788",
      name: "Local Room",
      videoCount: 3,
      xmlCount: 3,
      latestVideo: {
        key: "local-video-key",
        name: "clip.flv",
        mtime: "2026-06-14T12:00:00.000Z",
        size: 2048
      },
      coverUrl: ""
    }
  ];

  await page.route(/\/api\/recording\/rooms(?:\?.*)?$/, (route) => route.fulfill({ json: { rooms: [] } }));
  await page.route("**/api/rooms**", async (route) => {
    if (route.request().method() === "DELETE") {
      rooms = [];
      await route.fulfill({ json: { ok: true, rooms } });
      return;
    }
    await route.fulfill({ json: { root: "D:/Recordings", rooms } });
  });

  await page.goto("/");
  await expect(page.getByTestId("library-room-card-667788")).toContainText("Local Room");
  await expect(page.getByTestId("library-room-card-667788")).toContainText("未加入录制");
  await expect(page.getByTestId("room-flow-local-room-key")).toContainText("生成 MP4 预览");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByTestId("delete-material-room-local-room-key").click();
  await expect(page.getByTestId("library-room-card-667788")).toHaveCount(0);
});

test("fixed live room without local material still opens its workspace", async ({ page }) => {
  await page.route("**/api/rooms", (route) =>
    route.fulfill({
      json: {
        root: "D:/Recordings",
        rooms: []
      }
    })
  );

  await page.goto("/");
  await expect(page.getByTestId("recording-dashboard")).toBeVisible();
  await expect(page.getByTestId(`library-room-card-${roomId}`)).toContainText("Public live room");
  await page.getByTestId(`open-fixed-room-${roomId}`).click();
  await expect(page.getByTestId("workspace-room-materials")).toContainText("Public live room");
  await expect(page.getByTestId("workspace-empty-room")).toBeVisible();
});

test("fixed room start shows real recording outputs", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("recording-dashboard")).toBeVisible();
  await page.getByTestId(`start-room-${roomId}`).click();
  await expect(page.getByTestId(`room-status-${roomId}`)).toContainText("录制中");
  await expect(page.getByTestId(`room-recording-assets-${roomId}`)).toContainText("已写 1.0 MB");
  await expect(page.getByTestId(`room-recording-assets-${roomId}`)).toContainText("速度 512 KB/s");
  await expect(page.getByTestId(`room-recording-assets-${roomId}`)).toContainText("时长 0:42");
  await expect(page.getByTestId(`room-recording-assets-${roomId}`)).toContainText("128 条弹幕");
  await expect(page.getByTestId(`repair-room-${roomId}`)).toHaveCount(0);
  await expect(page.getByTestId(`room-flow-${roomId}`)).toContainText("需要成片时点");
});

test("stop finalizes files and refreshes media library", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId(`start-room-${roomId}`).click();
  await page.getByTestId(`stop-room-${roomId}`).click();
  await expect(page.getByTestId(`room-status-${roomId}`)).toContainText("已完成");
  await expect(page.getByTestId(`room-recording-assets-${roomId}`)).toContainText("256 条弹幕");
  await expect(page.getByTestId(`room-recording-assets-${roomId}`)).toContainText("均速 384 KB/s");
  await expect(page.getByTestId("open-recorded-media")).toBeEnabled();
});

test("workspace sidebar is scoped to the opened live room materials", async ({ page }) => {
  const firstVideo = {
    key: "video-a-1",
    path: "D:/Recordings/22889/a.flv",
    name: "A room highlight",
    extension: "flv",
    size: 2048,
    mtime: "2026-06-13T00:00:00.000Z",
    duration: 90,
    width: 1920,
    height: 1080,
    playable: true,
    xml: null,
    subtitles: [],
    thumbnailUrl: ""
  };
  const secondVideo = { ...firstVideo, key: "video-a-2", path: "D:/Recordings/22889/b.flv", name: "A room second clip" };

  await page.route("**/api/rooms", (route) =>
    route.fulfill({
      json: {
        root: "D:/Recordings",
        rooms: [
          {
            key: "room-a",
            path: "D:/Recordings/22889",
            folderName: "22889 - Public live room",
            roomId,
            name: "Public live room",
            videoCount: 2,
            xmlCount: 1,
            latestVideo: { key: firstVideo.key, name: firstVideo.name, mtime: firstVideo.mtime, size: firstVideo.size },
            coverUrl: ""
          },
          {
            key: "room-b",
            path: "D:/Recordings/7788",
            folderName: "7788 - Other live room",
            roomId: "7788",
            name: "Other live room",
            videoCount: 1,
            xmlCount: 0,
            latestVideo: null,
            coverUrl: ""
          }
        ]
      }
    })
  );
  await page.route("**/api/rooms/room-a", (route) =>
    route.fulfill({
      json: {
        key: "room-a",
        path: "D:/Recordings/22889",
        folderName: "22889 - Public live room",
        roomId,
        name: "Public live room",
        videos: [firstVideo, secondVideo],
        xmlFiles: 1,
        subtitleFiles: 0
      }
    })
  );
  await page.route("**/api/videos/video-a-1/context", (route) =>
    route.fulfill({
      json: {
        key: firstVideo.key,
        path: firstVideo.path,
        name: firstVideo.name,
        extension: firstVideo.extension,
        room: { roomId, name: "Public live room" },
        media: { duration: 90, width: 1920, height: 1080 },
        playable: true,
        mediaUrl: "",
        thumbnailUrl: "",
        preview: { status: "idle", progress: 0, path: null, mediaUrl: null, message: "", updatedAt: null },
        xml: null,
        danmaku: [],
        danmakuTotal: 0,
        danmakuMetadata: {},
        subtitles: [],
        histogram: [],
        duration: 90
      }
    })
  );
  await page.route("**/api/projects/video-a-1", (route) => route.fulfill({ json: { clips: [], danmakuEdits: {}, subtitles: null, updatedAt: null } }));

  await page.goto("/");
  await expect(page.locator(".room-sidebar")).toHaveCount(0);
  await expect(page.getByTestId("library-room-card-22889")).toContainText("Public live room");
  await page.getByTestId("library-room-card-22889").getByRole("button", { name: /进入房间/ }).click();
  await expect(page.getByTestId("workspace-room-materials")).toContainText("Public live room");
  await expect(page.getByTestId("workspace-room-materials")).toContainText("A room highlight");
  await expect(page.getByTestId("workspace-room-materials")).toContainText("A room second clip");
  await expect(page.getByTestId("workspace-room-materials")).not.toContainText("Other live room");
});

test("workspace marks the actively recording material and keeps finished material editable", async ({ page }) => {
  const activeVideo = {
    key: "video-active-recording",
    path: "D:/Recordings/22889/live-writing.flv",
    name: "Live writing file",
    extension: "flv",
    size: 2048,
    mtime: "2026-06-13T00:00:00.000Z",
    duration: 90,
    width: 1920,
    height: 1080,
    playable: true,
    xml: null,
    subtitles: [],
    thumbnailUrl: ""
  };
  const stableVideo = { ...activeVideo, key: "video-stable-recording", path: "D:/Recordings/22889/stable.mp4", name: "Finished clip", extension: "mp4" };
  const contextFor = (video: typeof activeVideo) => ({
    key: video.key,
    path: video.path,
    name: video.name,
    extension: video.extension,
    room: { roomId, name: "Public live room" },
    media: { duration: 90, width: 1920, height: 1080 },
    playable: true,
    mediaUrl: "",
    thumbnailUrl: "",
    preview: { status: "idle", progress: 0, path: null, mediaUrl: null, message: "", updatedAt: null },
    xml: null,
    danmaku: [],
    danmakuTotal: 0,
    danmakuMetadata: {},
    subtitles: [],
    histogram: [],
    duration: 90
  });

  await page.route(/\/api\/recording\/rooms(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        rooms: [
          {
            roomId,
            inputRoomId: roomId,
            name: "Public live room",
            title: "Public live room",
            anchorName: "Public Anchor",
            enabled: true,
            taskStatus: "recording",
            liveStatus: "live",
            recordingPath: activeVideo.path,
            danmakuPath: "D:/Recordings/22889/live-writing.xml",
            videoSize: 2048,
            bytesWritten: 2048,
            speedBytesPerSecond: 1024,
            danmakuCount: 3,
            message: "recording",
            nextAction: "stop"
          }
        ]
      }
    })
  );
  await page.route("**/api/rooms", (route) =>
    route.fulfill({
      json: {
        root: "D:/Recordings",
        rooms: [
          {
            key: "room-active",
            path: "D:/Recordings/22889",
            folderName: "22889 - Public live room",
            roomId,
            name: "Public live room",
            videoCount: 2,
            xmlCount: 1,
            latestVideo: { key: activeVideo.key, name: activeVideo.name, mtime: activeVideo.mtime, size: activeVideo.size },
            coverUrl: ""
          }
        ]
      }
    })
  );
  await page.route("**/api/rooms/room-active", (route) =>
    route.fulfill({
      json: {
        key: "room-active",
        path: "D:/Recordings/22889",
        folderName: "22889 - Public live room",
        roomId,
        name: "Public live room",
        videos: [activeVideo, stableVideo],
        xmlFiles: 1,
        subtitleFiles: 0
      }
    })
  );
  await page.route("**/api/videos/video-active-recording/context", (route) => route.fulfill({ json: contextFor(activeVideo) }));
  await page.route("**/api/videos/video-stable-recording/context", (route) => route.fulfill({ json: contextFor(stableVideo) }));
  await page.route("**/api/projects/video-active-recording", (route) =>
    route.fulfill({
      json: {
        clips: [{ id: "draft-active", title: "Active draft", start: 0, end: 20, score: 0, reason: "manual", evidence: [], status: "draft" }],
        danmakuEdits: {},
        subtitles: null,
        updatedAt: null
      }
    })
  );
  await page.route("**/api/projects/video-stable-recording", (route) =>
    route.fulfill({
      json: {
        clips: [{ id: "draft-stable", title: "Stable draft", start: 0, end: 20, score: 0, reason: "manual", evidence: [], status: "draft" }],
        danmakuEdits: {},
        subtitles: null,
        updatedAt: null
      }
    })
  );

  await page.goto("/");
  await page.getByTestId("library-room-card-22889").getByRole("button", { name: /进入房间/ }).click();
  await expect(page.getByTestId("workspace-video-video-active-recording")).toContainText("录制中");
  await expect(page.getByTestId("workspace-video-video-stable-recording")).not.toContainText("录制中");
  await page.getByTestId("workspace-video-video-active-recording").click();
  await expect(page.getByTestId("active-recording-notice")).toContainText("还在录制中");
  await expect(page.getByTestId("run-ai-slices")).toBeDisabled();
  await expect(page.getByRole("button", { name: /当前区间 ASR/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: /导出/ })).toBeDisabled();

  await page.getByTestId("workspace-video-video-stable-recording").click();
  await expect(page.getByTestId("active-recording-notice")).toHaveCount(0);
  await expect(page.getByTestId("run-ai-slices")).toBeEnabled();
  await expect(page.getByRole("button", { name: /导出/ })).toBeEnabled();
});

test("same Bilibili room material folders merge into one card and one workspace", async ({ page }) => {
  const firstVideo = {
    key: "video-merged-a",
    path: "D:/Recordings/22889 - Old title/a.flv",
    name: "Old title clip",
    extension: "flv",
    size: 2048,
    mtime: "2026-06-15T00:00:00.000Z",
    duration: 90,
    width: 1920,
    height: 1080,
    playable: true,
    xml: null,
    subtitles: [],
    thumbnailUrl: ""
  };
  const secondVideo = {
    ...firstVideo,
    key: "video-merged-b",
    path: "D:/Recordings/22889 - New title/b.flv",
    name: "New title clip",
    mtime: "2026-06-14T00:00:00.000Z"
  };
  const thirdVideo = {
    ...firstVideo,
    key: "video-merged-c",
    path: "D:/Recordings/22889 - New title/c.flv",
    name: "New title second clip",
    mtime: "2026-06-13T00:00:00.000Z"
  };

  await page.route("**/api/rooms", (route) =>
    route.fulfill({
      json: {
        root: "D:/Recordings",
        rooms: [
          {
            key: "room-old-title",
            path: "D:/Recordings/22889 - Old title",
            folderName: "22889 - Old title",
            roomId,
            name: "Old title",
            videoCount: 1,
            xmlCount: 1,
            latestVideo: { key: firstVideo.key, name: firstVideo.name, mtime: firstVideo.mtime, size: firstVideo.size },
            coverUrl: ""
          },
          {
            key: "room-new-title",
            path: "D:/Recordings/22889 - New title",
            folderName: "22889 - New title",
            roomId,
            name: "New title",
            videoCount: 2,
            xmlCount: 1,
            latestVideo: { key: secondVideo.key, name: secondVideo.name, mtime: secondVideo.mtime, size: secondVideo.size },
            coverUrl: ""
          },
          {
            key: "room-other",
            path: "D:/Recordings/7788",
            folderName: "7788 - Other",
            roomId: "7788",
            name: "Other live room",
            videoCount: 1,
            xmlCount: 1,
            latestVideo: null,
            coverUrl: ""
          }
        ]
      }
    })
  );
  await page.route("**/api/rooms/room-old-title", (route) =>
    route.fulfill({
      json: {
        key: "room-old-title",
        path: "D:/Recordings/22889 - Old title",
        folderName: "22889 - Old title",
        roomId,
        name: "Old title",
        videos: [firstVideo],
        xmlFiles: 1,
        subtitleFiles: 0
      }
    })
  );
  await page.route("**/api/rooms/room-new-title", (route) =>
    route.fulfill({
      json: {
        key: "room-new-title",
        path: "D:/Recordings/22889 - New title",
        folderName: "22889 - New title",
        roomId,
        name: "New title",
        videos: [secondVideo, thirdVideo],
        xmlFiles: 1,
        subtitleFiles: 0
      }
    })
  );
  await page.route("**/api/videos/video-merged-a/context", (route) =>
    route.fulfill({
      json: {
        key: firstVideo.key,
        path: firstVideo.path,
        name: firstVideo.name,
        extension: firstVideo.extension,
        room: { roomId, name: "Public live room" },
        media: { duration: 90, width: 1920, height: 1080 },
        playable: true,
        mediaUrl: "",
        thumbnailUrl: "",
        preview: { status: "idle", progress: 0, path: null, mediaUrl: null, message: "", updatedAt: null },
        xml: null,
        danmaku: [],
        danmakuTotal: 0,
        danmakuMetadata: {},
        subtitles: [],
        histogram: [],
        duration: 90
      }
    })
  );
  await page.route("**/api/projects/video-merged-a", (route) => route.fulfill({ json: { clips: [], danmakuEdits: {}, subtitles: null, updatedAt: null } }));

  await page.goto("/");
  await expect(page.getByTestId(`library-room-card-${roomId}`)).toHaveCount(1);
  await expect(page.getByTestId(`library-room-card-${roomId}`)).toContainText("3 视频");
  await expect(page.getByTestId(`library-room-card-${roomId}`)).toContainText("2 弹幕");
  await page.getByTestId(`library-room-card-${roomId}`).getByRole("button", { name: /进入房间/ }).click();
  await expect(page.getByTestId("workspace-room-materials")).toContainText("3 个素材");
  await expect(page.getByTestId("workspace-room-materials")).toContainText("Old title clip");
  await expect(page.getByTestId("workspace-room-materials")).toContainText("New title clip");
  await expect(page.getByTestId("workspace-room-materials")).toContainText("New title second clip");
});

test("extract-audio mode tells users it will not generate subtitles", async ({ page }) => {
  const video = {
    key: "video-asr-notice",
    path: "D:/Recordings/22889/asr-notice.flv",
    name: "ASR notice clip",
    extension: "flv",
    size: 2048,
    mtime: "2026-06-15T00:00:00.000Z",
    duration: 90,
    width: 1920,
    height: 1080,
    playable: true,
    xml: null,
    subtitles: [],
    thumbnailUrl: ""
  };

  await page.route("**/api/settings", (route) =>
    route.fulfill({
      json: {
        recordingsRoot: "D:/Recordings",
        rootExists: true,
        recordingRootCandidates: [],
        ffmpeg: true,
        ffprobe: true,
        uploadTools: {},
        uploadDefaults: {},
        asrTools: { runtimeReady: false, notes: [] },
        serviceSettings: {
          recordingsRoot: "D:/Recordings",
          recording: {},
          asr: {
            mode: "extract-audio",
            provider: "custom-command",
            model: "",
            modelSize: "",
            endpoint: "",
            apiKey: "",
            localCommand: "",
            qwenCommand: "",
            language: "zh",
            outputFormat: "srt",
            device: "auto",
            autoPrepareModel: true,
            chunkSeconds: 60,
            qwenContextTokens: 4096,
            defaultScope: "selection",
            replaceMode: "range"
          },
          vision: { provider: "", wireApi: "responses", endpoint: "", apiKey: "", model: "", sendFrames: true, sendAudio: false, sendSubtitles: true, sendDanmaku: true },
          cover: { provider: "frame-template", endpoint: "", apiKey: "", model: "", stylePrompt: "" },
          media: { flvOutputMode: "same-dir", deleteSourceAfterConvert: false, skipIfMp4Exists: true },
          automation: { enabled: false, autoAnalyze: false, autoExport: false, autoUpload: false, uploadPolicy: "review", clipDuration: 30, clipCount: 2, sources: ["danmaku"], minScore: 72 }
        }
      }
    })
  );
  await page.route("**/api/rooms", (route) =>
    route.fulfill({
      json: {
        root: "D:/Recordings",
        rooms: [
          {
            key: "room-asr-notice",
            path: "D:/Recordings/22889 - Public live room",
            folderName: "22889 - Public live room",
            roomId,
            name: "Public live room",
            videoCount: 1,
            xmlCount: 0,
            latestVideo: { key: video.key, name: video.name, mtime: video.mtime, size: video.size },
            coverUrl: ""
          }
        ]
      }
    })
  );
  await page.route("**/api/rooms/room-asr-notice", (route) =>
    route.fulfill({
      json: {
        key: "room-asr-notice",
        path: "D:/Recordings/22889 - Public live room",
        folderName: "22889 - Public live room",
        roomId,
        name: "Public live room",
        videos: [video],
        xmlFiles: 0,
        subtitleFiles: 0
      }
    })
  );
  await page.route("**/api/videos/video-asr-notice/context", (route) =>
    route.fulfill({
      json: {
        key: video.key,
        path: video.path,
        name: video.name,
        extension: video.extension,
        room: { roomId, name: "Public live room" },
        media: { duration: 90, width: 1920, height: 1080 },
        playable: true,
        mediaUrl: "",
        thumbnailUrl: "",
        preview: { status: "idle", progress: 0, path: null, mediaUrl: null, message: "", updatedAt: null },
        xml: null,
        danmaku: [],
        danmakuTotal: 0,
        danmakuMetadata: {},
        subtitles: [],
        histogram: [],
        duration: 90
      }
    })
  );
  await page.route("**/api/projects/video-asr-notice", (route) => route.fulfill({ json: { clips: [], danmakuEdits: {}, subtitles: null, updatedAt: null } }));

  await page.goto("/");
  await page.getByTestId(`library-room-card-${roomId}`).getByRole("button", { name: /进入房间/ }).click();
  await expect(page.getByTestId("asr-availability")).toContainText("仅抽音频");
  await expect(page.getByTestId("asr-availability")).toContainText("不会生成字幕");
  await expect(page.getByRole("button", { name: "当前区间 ASR" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "整片 ASR" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "ASR 对比" })).toBeDisabled();
});

test("workbench evidence, danmaku, and subtitle rows seek the same timeline", async ({ page }) => {
  const video = {
    key: "video-sync-1",
    path: "D:/Recordings/22889/sync.flv",
    name: "Sync highlight",
    extension: "flv",
    size: 4096,
    mtime: "2026-06-13T00:00:00.000Z",
    duration: 90,
    width: 1920,
    height: 1080,
    playable: true,
    xml: null,
    subtitles: [],
    thumbnailUrl: ""
  };
  const danmaku = [
    { id: "d-early", time: 8, text: "前情铺垫", user: "u1", uid: "1", mode: 1, size: 25, color: 16777215, date: 0 },
    { id: "d-hot", time: 22.4, text: "这波太强了", user: "u2", uid: "2", mode: 1, size: 25, color: 16777215, date: 0 }
  ];
  const subtitles = [
    { id: "s-hot", start: 24, end: 27, text: "这里就是关键反转", source: "fixture" }
  ];
  const candidate = {
    id: "ai-1",
    title: "这波太强了｜Public live room",
    start: 18,
    end: 48,
    score: 88,
    reason: "弹幕和字幕同时指向这段，适合直接剪成高置信名场面。",
    evidence: ["弹幕 0:22：这波太强了", "字幕 0:24：这里就是关键反转"],
    signal: { funnyHits: 1, reactionHits: 2, questionHits: 0, danmakuCount: 22, subtitleCount: 1, peakCount: 18, hotText: "这波太强了" },
    automation: { eligibleForAutoUpload: true, confidence: "high", score: 88, signalFamilies: ["danmaku-burst", "quotable-line"], policyReason: "High precision candidate." }
  };

  await page.route("**/api/rooms", (route) =>
    route.fulfill({
      json: {
        root: "D:/Recordings",
        rooms: [
          {
            key: "room-a",
            path: "D:/Recordings/22889",
            folderName: "22889 - Public live room",
            roomId,
            name: "Public live room",
            videoCount: 1,
            xmlCount: 1,
            latestVideo: { key: video.key, name: video.name, mtime: video.mtime, size: video.size },
            coverUrl: ""
          }
        ]
      }
    })
  );
  await page.route("**/api/rooms/room-a", (route) =>
    route.fulfill({
      json: {
        key: "room-a",
        path: "D:/Recordings/22889",
        folderName: "22889 - Public live room",
        roomId,
        name: "Public live room",
        videos: [video],
        xmlFiles: 1,
        subtitleFiles: 1
      }
    })
  );
  await page.route("**/api/videos/video-sync-1/context", (route) =>
    route.fulfill({
      json: {
        key: video.key,
        path: video.path,
        name: video.name,
        extension: video.extension,
        room: { roomId, name: "Public live room" },
        media: { duration: 90, width: 1920, height: 1080 },
        playable: true,
        mediaUrl: "",
        thumbnailUrl: "",
        preview: { status: "idle", progress: 0, path: null, mediaUrl: null, message: "", updatedAt: null },
        xml: null,
        danmaku,
        danmakuTotal: danmaku.length,
        danmakuMetadata: {},
        subtitles,
        histogram: [
          { index: 0, start: 0, end: 30, count: 20, score: 80 },
          { index: 1, start: 30, end: 60, count: 8, score: 30 }
        ],
        duration: 90
      }
    })
  );
  const aiSliceRequests: Record<string, unknown>[] = [];
  await page.route("**/api/projects/video-sync-1", (route) => route.fulfill({ json: { clips: [], danmakuEdits: {}, subtitles: null, updatedAt: null } }));
  await page.route("**/api/ai/slices", (route) => {
    aiSliceRequests.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ json: { candidates: [candidate] } });
  });

  await page.goto("/");
  await page.getByTestId("library-room-card-22889").locator("button.primary").click();
  await expect(page.getByTestId("workspace-room-materials")).toContainText("Sync highlight");

  await expect(page.getByTestId("ai-duration-presets")).toHaveCount(0);
  await page.getByTestId("ai-count-preset-8").click();
  await page.getByTestId("run-ai-slices").click();
  expect(aiSliceRequests[aiSliceRequests.length - 1]).toMatchObject({ clipCount: 8 });
  expect(aiSliceRequests[aiSliceRequests.length - 1]).not.toHaveProperty("clipDuration");
  await expect(page.getByTestId("candidate-card-ai-1")).toContainText("AI 理由");

  await page.getByTestId("candidate-evidence-ai-1-0").click();
  await expect(page.getByTestId("danmaku-sync-summary")).toContainText("0:22");
  await expect(page.getByTestId("danmaku-row-d-hot")).toHaveClass(/is-current/);

  await page.getByTestId("subtitle-seek-s-hot").click();
  await expect(page.getByTestId("subtitle-sync-summary")).toContainText("0:24");
  await expect(page.getByTestId("subtitle-row-s-hot")).toHaveClass(/is-current/);

  await page.getByTestId("timeline-candidate-ai-1").click();
  await expect(page.getByTestId("danmaku-sync-summary")).toContainText("0:18");
  await expect(page.getByTestId("candidate-card-ai-1")).toHaveClass(/active/);
});

test("upload does not publish before final confirmation", async ({ page }) => {
  let uploadRunCalls = 0;
  await page.route("**/api/settings", (route) =>
    route.fulfill({
      json: {
        recordingsRoot: "D:/Recordings",
        rootExists: true,
        recordingRootCandidates: [],
        ffmpeg: true,
        ffprobe: true,
        uploadTools: {
          biliup: true,
          biliupPath: "C:/tools/biliup.exe",
          biliupSource: "workspace",
          biliupVersion: "biliup-cli 1.1.29",
          testedBiliupVersion: "1.1.29",
          cookiePath: "D:/Recordings/cookies.json",
          cookieExists: true,
          workspaceInstallPath: "C:/tools/biliup-venv",
          capabilities: { uploadMultiPart: true, appendParts: true, listArchives: true, showArchive: true, onlySelfVisible: true, unsupportedOrUnverified: [] }
        },
        uploadDefaults: {},
        asrTools: { runtimeReady: false, notes: [] },
        serviceSettings: { recordingsRoot: "D:/Recordings", recording: {}, asr: { mode: "extract-audio" }, vision: {}, cover: {}, media: {}, automation: {} }
      }
    })
  );
  await page.route("**/api/upload/preflight", (route) => route.fulfill({ json: { ok: true, issues: [], warnings: [], command: "biliup upload ...", tools: {} } }));
  await page.route("**/api/upload/command", (route) => route.fulfill({ json: { ok: true, command: "biliup upload ...", args: [], mode: "upload", executablePath: "biliup", notes: [] } }));
  await page.route("**/api/upload/run", (route) => {
    uploadRunCalls += 1;
    return route.fulfill({ json: { id: "upload-1", status: "running", type: "biliup-run", message: "publishing" } });
  });

  await page.goto("/");
  await page.getByTestId("nav-upload").click();
  await expect(page.locator("body")).not.toContainText("全自动投稿");
  await page.getByRole("button", { name: "添加分 P", exact: true }).click();
  await page.getByLabel("P1 本地视频路径").fill("D:/Recordings/exported-clip.mp4");
  await page.getByTestId("upload-preflight").click();
  await page.getByTestId("upload-command").click();
  expect(uploadRunCalls).toBe(0);
  await page.getByTestId("upload-final-confirm").click();
  await expect.poll(() => uploadRunCalls).toBe(1);
});

test("upload execution stays disabled until cookie exists", async ({ page }) => {
  await page.route("**/api/settings", (route) =>
    route.fulfill({
      json: {
        recordingsRoot: "D:/Recordings",
        rootExists: true,
        recordingRootCandidates: [],
        ffmpeg: true,
        ffprobe: true,
        uploadTools: {
          biliup: true,
          biliupPath: "C:/tools/biliup.exe",
          biliupSource: "workspace",
          biliupVersion: "biliup-cli 1.1.29",
          testedBiliupVersion: "1.1.29",
          cookiePath: "D:/Recordings/cookies.json",
          cookieExists: false,
          workspaceInstallPath: "C:/tools/biliup-venv",
          capabilities: { uploadMultiPart: true, appendParts: true, listArchives: true, showArchive: true, onlySelfVisible: true, unsupportedOrUnverified: [] }
        },
        uploadDefaults: {},
        asrTools: { runtimeReady: false, notes: [] },
        serviceSettings: { recordingsRoot: "D:/Recordings", recording: {}, asr: { mode: "extract-audio" }, vision: {}, cover: {}, media: {}, automation: {} }
      }
    })
  );

  await page.goto("/");
  await page.getByTestId("nav-upload").click();
  await page.getByRole("button", { name: "添加分 P", exact: true }).click();
  await page.getByLabel("P1 本地视频路径").fill("D:/Recordings/exported-clip.mp4");
  await expect(page.getByTestId("refresh-login-status")).toBeVisible();
  await expect(page.getByTestId("upload-readiness")).toContainText("扫码登录生成 Cookie");
  await expect(page.getByTestId("upload-final-confirm")).toBeDisabled();
});

test("failure states expose cause log and next action", async ({ page }) => {
  await page.route(`**/api/recording/rooms/${roomId}/start`, (route) => {
    expect(route.request().postDataJSON()).toMatchObject({ oneShot: true });
    return route.fulfill({
      status: 409,
      json: {
        error: "invalid room",
        roomId,
        taskStatus: "error",
        message: "Bilibili room was not found",
        nextAction: "edit"
      }
    });
  });

  await page.goto("/");
  await page.getByTestId(`start-room-${roomId}`).click();
  await expect(page.getByTestId(`room-error-${roomId}`)).toContainText("没有找到这个 B 站直播间");
  await expect(page.getByTestId(`room-log-${roomId}`)).toBeVisible();
  await expect(page.getByTestId(`repair-room-${roomId}`)).toBeEnabled();
});

test("recording errors explain cause and recovery without dumping logs", async ({ page }) => {
  await page.route(/\/api\/recording\/rooms(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        rooms: [
          {
            roomId,
            inputRoomId: roomId,
            name: "Public live room",
            enabled: true,
            taskStatus: "error",
            liveStatus: "unknown",
            message: "Bili stream request failed: 404 Not Found",
            log: "取流 10000 https://cdn.example/expired.flv\nBili stream request failed: 404 Not Found",
            nextAction: "retry",
            videoSize: 1024,
            bytesWritten: 1024,
            danmakuCount: 0,
            refreshed: true
          },
          {
            roomId: "7788",
            inputRoomId: "7788",
            name: "Network room",
            enabled: true,
            taskStatus: "error",
            liveStatus: "unknown",
            message: "fetch failed",
            log: "取流 10000 https://cdn.example/live.flv\nfetch failed",
            nextAction: "retry",
            videoSize: 2048,
            bytesWritten: 2048,
            danmakuCount: 0,
            refreshed: true
          }
        ]
      }
    })
  );

  await page.goto("/");
  await expect(page.getByTestId(`room-status-${roomId}`)).toContainText("等待开播");
  await expect(page.getByTestId(`library-room-card-${roomId}`)).toContainText("等待开播");
  await expect(page.getByTestId(`room-error-${roomId}`)).toHaveCount(0);
  await expect(page.getByTestId("room-status-7788")).toContainText("重连中");
  await expect(page.getByTestId("library-room-card-7788")).toContainText("取流重连中");
  await expect(page.getByTestId("room-flow-7788")).toContainText("自动录制会继续等待开播");
  await expect(page.getByTestId("room-error-7788")).toHaveCount(0);
  await expect(page.getByTestId("repair-room-7788")).toHaveCount(0);
});

test("task center explains ended live recordings without dumping technical errors", async ({ page }) => {
  await page.route("**/api/tasks", (route) =>
    route.fulfill({
      json: {
        tasks: [
          {
            id: `recording-room-${roomId}`,
            source: "recording",
            type: "recording-room",
            label: `Room ${roomId}`,
            status: "error",
            progress: 0,
            message: "Bili stream request failed: 404 Not Found",
            log: "取流 10000 https://cdn.example/expired.flv\nBili stream request failed: 404 Not Found",
            outputPath: "D:/Recordings/22889 - Public live room/blive_22889.flv",
            bytesWritten: 2048,
            speedBytesPerSecond: 0,
            averageSpeedBytesPerSecond: 256,
            elapsedSeconds: 180,
            staleSeconds: 5,
            stalled: false,
            danmakuCount: 0,
            updatedAt: "2026-06-15T12:00:00.000Z"
          }
        ]
      }
    })
  );

  await page.goto("/");
  await page.getByRole("button", { name: /任务/ }).click();
  await expect(page.getByText(`Public live room（${roomId}）`)).toBeVisible();
  await expect(page.getByText("直播录制 · 异常 · 0%")).toBeVisible();
  await expect(page.getByTestId(`task-issue-recording-room-${roomId}`)).toContainText("等待开播");
  await expect(page.getByTestId(`task-issue-recording-room-${roomId}`)).toContainText("已录到的视频文件会保留");
  await expect(page.getByTestId(`task-issue-recording-room-${roomId}`).locator("pre")).toBeHidden();
  await expect(page.getByText("Bili stream request failed: 404 Not Found")).toBeHidden();
});

test("task center separates active recordings from rooms waiting to go live", async ({ page }) => {
  await page.route("**/api/tasks", (route) =>
    route.fulfill({
      json: {
        tasks: [
          {
            id: `recording-room-${roomId}`,
            source: "recording",
            type: "recording-room",
            label: `Room ${roomId}`,
            status: "running",
            progress: 52,
            message: "直播录制中：320 KB/s，已写入 102.0 MB",
            log: "",
            outputPath: "D:/Recordings/22889 - Public live room/live.flv",
            bytesWritten: 1024 * 1024 * 102,
            speedBytesPerSecond: 320 * 1024,
            averageSpeedBytesPerSecond: 300 * 1024,
            elapsedSeconds: 120,
            danmakuCount: 12,
            updatedAt: "2026-06-15T12:00:00.000Z"
          },
          {
            id: "recording-room-7788",
            source: "recording",
            type: "recording-room",
            label: "Room 7788",
            status: "running",
            progress: 40,
            message: "等待开播",
            log: "",
            outputPath: "",
            bytesWritten: 0,
            speedBytesPerSecond: 0,
            averageSpeedBytesPerSecond: 0,
            elapsedSeconds: 0,
            danmakuCount: 0,
            updatedAt: "2026-06-15T12:00:00.000Z"
          }
        ]
      }
    })
  );

  await page.goto("/");
  await page.getByRole("button", { name: /任务/ }).click();
  await expect(page.getByTestId("task-stat-recording")).toContainText("1");
  await expect(page.getByTestId("task-stat-recording")).toContainText("录制中");
  await expect(page.getByTestId("task-stat-waiting")).toContainText("1");
  await expect(page.getByTestId("task-stat-waiting")).toContainText("等待开播");
  await expect(page.getByText("直播录制 · 等待开播 · 40%")).toBeVisible();
  await expect(page.getByText("直播录制 · 直播录制中：320 KB/s，已写入 102.0 MB · 52%")).toBeVisible();
});

test("task center shows automation clips, exports, and upload draft path", async ({ page }) => {
  await page.route("**/api/automation/jobs", (route) =>
    route.fulfill({
      json: {
        jobs: [
          ...Array.from({ length: 9 }, (_, index) => ({
            id: `auto-noise-${index}`,
            roomId,
            videoPath: `D:/Recordings/22889/noise-${index}.flv`,
            trigger: "recording-file-reconcile",
            triggerEventId: `noise-${index}`,
            uploadPolicy: "auto-only-self",
            status: "ready",
            stage: "no-high-confidence-clips",
            message: "No high-confidence clip passed the current precision threshold.",
            candidates: [],
            acceptedClips: [],
            exportedClips: [],
            uploadDraftPath: null,
            uploadPreflight: null,
            uploadJobId: null,
            projectPath: null,
            error: "",
            createdAt: `2026-06-17T12:1${index}:00.000Z`,
            updatedAt: `2026-06-17T12:1${index}:00.000Z`
          })),
          {
            id: "auto-task-ready-1",
            roomId,
            videoPath: "D:/Recordings/22889/clip.mp4",
            trigger: "recording-complete",
            triggerEventId: "event-auto-ready-1",
            uploadPolicy: "auto-only-self",
            status: "ready",
            stage: "upload-draft-ready",
            message: "Prepared upload draft for 1 exported high-confidence clip(s).",
            candidates: [{ id: "candidate-1", title: "名场面", start: 10, end: 40, score: 92, reason: "弹幕爆发", evidence: ["弹幕峰值"] }],
            acceptedClips: [
              {
                id: "candidate-1",
                title: "名场面",
                start: 10,
                end: 40,
                score: 92,
                reason: "弹幕爆发",
                evidence: ["弹幕峰值"],
                status: "exported",
                exportPath: "D:/Recordings/exports/clip-famous.mp4",
                automation: { eligibleForAutoUpload: true, confidence: "high", score: 92, signalFamilies: ["danmaku-burst"], policyReason: "高置信" }
              }
            ],
            exportedClips: [
              {
                id: "candidate-1",
                title: "名场面",
                start: 10,
                end: 40,
                score: 92,
                reason: "弹幕爆发",
                evidence: ["弹幕峰值"],
                status: "exported",
                exportPath: "D:/Recordings/exports/clip-famous.mp4"
              }
            ],
            uploadDraftPath: "D:/Recordings/drafts/automation-auto-task-ready-1.json",
            uploadPreflight: null,
            uploadJobId: null,
            projectPath: "D:/Recordings/projects/clip.json",
            error: "",
            createdAt: "2026-06-17T12:00:00.000Z",
            updatedAt: "2026-06-17T12:01:00.000Z"
          }
        ]
      }
    })
  );

  await page.goto("/");
  await page.getByRole("button", { name: /任务/ }).click();
  await expect(page.getByTestId("automation-task-section")).toContainText("自动切片");
  await expect(page.getByTestId("automation-task-section")).toContainText("无高置信 9");
  await expect(page.getByTestId("automation-task-section").locator(".automation-strip").first()).not.toContainText("No high-confidence");
  await expect(page.locator(".automation-task").first()).toContainText("clip.mp4");
  await expect(page.getByTestId("automation-task-auto-task-ready-1")).toContainText("投稿草稿已生成");
  await expect(page.getByTestId("automation-task-auto-task-ready-1")).toContainText("切片草稿 1");
  await expect(page.getByTestId("automation-task-auto-task-ready-1")).toContainText("投稿草稿");
  await expect(page.getByTestId("automation-task-auto-task-ready-1")).toContainText("导出 1");
  await expect(page.getByTestId("automation-project-auto-task-ready-1")).toContainText("projects/clip.json");
  await expect(page.getByTestId("automation-draft-auto-task-ready-1")).toContainText("automation-auto-task-ready-1.json");
});

test("offline stream errors explain that the live ended instead of blaming network", async ({ page }) => {
  await page.route(/\/api\/recording\/rooms(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        rooms: [
          {
            roomId,
            inputRoomId: roomId,
            name: "Ended live room",
            enabled: true,
            taskStatus: "error",
            liveStatus: "offline",
            biliLiveStatus: "unknown",
            message: "网络取流失败",
            log: "取流 10000 https://cdn.example/live.flv\nfetch failed",
            nextAction: "retry",
            videoSize: 2048,
            bytesWritten: 2048,
            danmakuCount: 0,
            refreshed: true
          }
        ]
      }
    })
  );

  await page.goto("/");
  await expect(page.getByTestId(`room-status-${roomId}`)).toContainText("等待开播");
  await expect(page.getByTestId(`library-room-card-${roomId}`)).toContainText("等待开播");
  await expect(page.getByTestId(`room-error-${roomId}`)).toHaveCount(0);
  await expect(page.getByTestId(`room-flow-${roomId}`)).toContainText("继续等待开播");
});

test("recording reconnect states use a reconnecting room badge", async ({ page }) => {
  await page.route(/\/api\/recording\/rooms(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        rooms: [
          {
            roomId,
            inputRoomId: roomId,
            name: "Public live room",
            enabled: true,
            taskStatus: "waiting",
            liveStatus: "live",
            message: "取流重连中",
            nextAction: "stop",
            videoSize: 1024,
            bytesWritten: 1024,
            speedBytesPerSecond: 0,
            danmakuCount: 0,
            refreshed: true
          }
        ]
      }
    })
  );

  await page.goto("/");
  await expect(page.getByTestId(`room-status-${roomId}`)).toContainText("重连中");
  await expect(page.getByTestId(`room-error-${roomId}`)).toHaveCount(0);
  await expect(page.getByTestId(`room-recording-assets-${roomId}`)).toContainText("已写");
});



