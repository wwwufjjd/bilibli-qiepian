# Bilive Workbench

<div align="center">

**面向 `blrec` 本地录播的可视化剪辑、字幕、封面和投稿工作台**

![Vite](https://img.shields.io/badge/Vite-8-646CFF?logo=vite&logoColor=white)
![React](https://img.shields.io/badge/React-19-149ECA?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-Express-339933?logo=node.js&logoColor=white)

</div>

Bilive Workbench 是一个本地优先的录播整理工具。它不负责直播录制，而是把已经由 `blrec` 保存下来的录播素材扫描出来，集中完成预览、弹幕分析、字幕编辑、AI 切片建议、封面抽帧、素材打包和 `biliup` 投稿前准备。

## 功能亮点

- **素材库扫描**：按房间展示封面、录播数量、弹幕 XML 数量和最近视频。
- **本地预览**：直接播放浏览器支持的 MP4/MOV；FLV/MKV 可生成本地 MP4 预览。
- **弹幕与字幕编辑**：解析 B 站 XML 弹幕，支持弹幕密度时间线、字幕行编辑和手动补字幕。
- **AI 切片建议**：结合弹幕密度、字幕和手动编辑内容，生成高能片段候选。
- **ASR 工作流**：支持 Fun-ASR-Nano、Qwen3-ASR-GGUF、本地命令和云端接口模式。
- **封面与标题**：可抽取切片封面帧，也可接入外部模型生成标题、理由和封面。
- **投稿准备**：管理分 P、读取历史稿件、生成/预检 `biliup` 命令，并保留真实投稿前确认入口。
- **任务中心**：集中查看 ASR、转码、封面、标题和投稿任务日志。

## 快速启动

第一次使用可以直接双击：

```text
setup.bat
start.bat
```

也可以使用命令行：

```powershell
npm install
npm run dev
```

启动后打开浏览器里的本地地址，进入 **设置** 页面，填写你的 `blrec` 录播目录并保存。

## 环境要求

| 依赖 | 用途 |
| --- | --- |
| Node.js | 运行 Vite 前端和 Express 本地服务 |
| ffmpeg / ffprobe | 抽帧、转码、切片导出、预览生成 |
| Python | 可选，用于本地 ASR、`biliup` 工作区安装 |
| biliup | 可选，用于投稿、追加分 P、读取稿件信息 |

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动本地工作台 |
| `npm run build` | 构建前端产物 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run setup` | 安装基础依赖 |
| `npm run setup:qwen` | 安装依赖并准备默认 Qwen3-ASR 0.6B |
| `npm run start:workbench` | 使用 PowerShell 启动脚本运行工作台 |

## 目录说明

```text
.
├─ src/                # React 前端界面
├─ server/             # Express API、本地媒体处理、ASR/投稿任务
├─ scripts/            # Windows 安装和启动脚本
├─ .workbench/         # 本地缓存、模型、草稿、导出文件，默认不上传
├─ dist/               # 构建产物，默认不上传
└─ README.md
```

`.workbench/` 会保存模型、cookie、任务草稿、导出视频、封面和临时素材。该目录已经写入 `.gitignore`，避免把本地隐私数据和大文件上传到 GitHub。

## 推荐工作流

1. 在 **设置** 中填写录播根目录，并确认 `ffmpeg` 状态。
2. 在 **素材库** 选择房间，进入 **编辑台**。
3. 预览视频，查看弹幕密度，手动框选或生成 AI 切片建议。
4. 按需运行 ASR、编辑字幕、生成标题和封面。
5. 在 **投稿** 页面管理分 P、预检命令，确认后再执行真实投稿。

## 注意事项

- 浏览器原生通常只能直接预览 MP4/MOV。FLV/MKV 可扫描和切片，但需要先生成 MP4 预览。
- 真实投稿需要本地 `biliup`、有效 cookie 和明确的投稿确认开关。
- 外部模型接口默认按 OpenAI-compatible JSON 服务设计，也可以在设置页改成本地命令或自定义接口。
- 当前仓库未指定开源协议；公开使用或二次分发前请先补充许可证。
