/// <reference types="node" />

import { expect, test, type Page } from "@playwright/test";
import { stat, readFile } from "node:fs/promises";

const roomId = process.env.REAL_BILI_ROOM_ID || "";
const roomInput = process.env.REAL_BILI_ROOM_INPUT || (roomId ? `https://live.bilibili.com/${roomId}` : "");
const sampleSeconds = Math.max(15, Math.min(180, Number(process.env.REAL_BILI_SAMPLE_SECONDS || 45)));
const runRealLiveUi = ["1", "true", "yes"].includes(String(process.env.REAL_BILI_UI || "").toLowerCase());

async function getRecordingRoomStatus(page: Page) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await page.request.get(`/api/recording/rooms/${roomId}`);
      if (response.ok()) return await response.json();
      lastError = new Error(`GET room status failed: ${response.status()} ${await response.text()}`);
    } catch (error) {
      lastError = error;
    }
    await page.waitForTimeout(1000);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || "GET room status failed"));
}

test.afterEach(async ({ page }, testInfo) => {
  if (!roomId || !runRealLiveUi || testInfo.project.name !== "chromium") return;
  await page.request.patch(`/api/recording/rooms/${roomId}`, { data: { enabled: false } }).catch(() => null);
  const status = await getRecordingRoomStatus(page).catch(() => null);
  if (status && ["starting", "recording", "finalizing"].includes(String(status.taskStatus || ""))) {
    await page.request.post(`/api/recording/rooms/${roomId}/stop`, { data: {} }).catch(() => null);
  }
});

test("real live-room verification records video, danmaku, and visible metrics", async ({ page }, testInfo) => {
  test.skip(!roomId, "Set REAL_BILI_ROOM_ID to run real Bilibili live-room verification.");
  test.skip(!runRealLiveUi, "Set REAL_BILI_UI=1 to run the real live-room UI recording flow.");
  test.skip(testInfo.project.name !== "chromium", "Real live-room recording mutates external room state, so it runs once in Chromium only.");
  test.setTimeout((sampleSeconds + 90) * 1000);

  await page.request.delete(`/api/recording/rooms/${roomId}`).catch(() => null);

  await page.goto("/");
  await expect(page.getByTestId("recording-dashboard")).toBeVisible();

  await page.getByTestId("fixed-room-input").fill(roomInput);
  await page.getByTestId("save-fixed-room").click();
  await expect(page.getByTestId(`library-room-card-${roomId}`)).toBeVisible({ timeout: 15_000 });

  let initialStatus = await getRecordingRoomStatus(page).catch(async () => {
    await page.request.post("/api/recording/rooms", { data: { roomId: roomInput } });
    await expect(page.getByTestId(`library-room-card-${roomId}`)).toBeVisible({ timeout: 15_000 });
    return getRecordingRoomStatus(page);
  });
  const alreadyRecording = ["starting", "recording", "finalizing"].includes(String(initialStatus.taskStatus || ""));
  if (!alreadyRecording) {
    await page.request.patch(`/api/recording/rooms/${roomId}`, { data: { enabled: true } }).catch(() => null);
    await page.getByTestId(`start-room-${roomId}`).click();
  }
  await expect(page.getByTestId(`room-status-${roomId}`)).toContainText(/录制中|等待|启动/, { timeout: 45_000 });
  await expect(page.getByTestId(`room-recording-assets-${roomId}`)).toContainText(/已写|速度|均速/, { timeout: 60_000 });

  await page.waitForTimeout(sampleSeconds * 1000);

  const runningStatus = await getRecordingRoomStatus(page);
  expect(Number(runningStatus.bytesWritten || runningStatus.videoSize || 0)).toBeGreaterThan(0);
  expect(Number(runningStatus.speedBytesPerSecond || runningStatus.averageSpeedBytesPerSecond || 0)).toBeGreaterThan(0);

  await page.getByTestId(`stop-room-${roomId}`).click();
  await expect(page.getByTestId(`room-status-${roomId}`)).toContainText(/已完成|录制中|正在/, { timeout: 60_000 });

  const stoppedStatus = await getRecordingRoomStatus(page);
  expect(String(stoppedStatus.recordingPath || "")).toMatch(/\.(flv|mp4|mkv)$/i);
  expect(String(stoppedStatus.danmakuPath || "")).toMatch(/\.xml$/i);

  const videoStat = await stat(stoppedStatus.recordingPath);
  const xmlStat = await stat(stoppedStatus.danmakuPath);
  expect(videoStat.size).toBeGreaterThan(128 * 1024);
  expect(xmlStat.size).toBeGreaterThan(8);

  const xmlHead = await readFile(stoppedStatus.danmakuPath, "utf8");
  expect(xmlHead).toContain("<i>");
});
