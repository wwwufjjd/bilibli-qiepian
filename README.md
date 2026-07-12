# Bilive Workbench

<div align="center">

**B 站直播本地工作台：自动录制 · AI 切片 · 字幕 · 投稿预检**

不用在录播软件、剪辑软件、ASR 工具、投稿 CLI 之间来回切。  
一个本地页面走完：**开播入库 → 高能切片 → 字幕封面 → 投稿草稿**。

[![GitHub stars](https://img.shields.io/github/stars/wwwufjjd/bilibli-qiepian?style=social)](https://github.com/wwwufjjd/bilibli-qiepian)
[![Vite](https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white)](https://vitejs.dev/)
[![React](https://img.shields.io/badge/React-19-149ECA?logo=react&logoColor=white)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-Express-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-UNLICENSED-lightgrey)](#许可证)

[功能导览](docs/feature-tour.md) · [验收报告](docs/verification-report.md) · [Issues](https://github.com/wwwufjjd/bilibli-qiepian/issues)

</div>

---

## 你是不是也在踩这些坑

| 痛点 | 常见现状 | Bilive 怎么处理 |
| --- | --- | --- |
| 录完找不到片 | 录播堆在一堆文件夹里 | **按直播间**做素材库，封面 / 视频数 / 弹幕数一眼看到 |
| 剪切片太慢 | 自己拖时间轴猜高能 | **弹幕密度 + 字幕 + 模型** 给少而准的候选和人话理由 |
| 工具链太碎 | 录制 / ASR / 转码 / 投稿各一个软件 | **同一工作台**完成预览、字幕、导出、投稿草稿 |
| 投稿容易翻车 | 命令行一把梭，缺分 P / Cookie / 标题 | **预检门禁 + 二次确认**，真实投稿前先看清楚 |
| 磁盘被 FLV 吃满 | 手动一个个转 MP4 | 录制后自动 remux；批量转换默认 **stream copy**，可选 GPU 压缩 |

> 本地优先：视频、Cookie、模型、草稿都在你自己电脑上的 `.workbench/`，默认不上传仓库。

---

## 30 秒上手

**Windows 双击：**

```text
setup.bat
start.bat
```

**或命令行：**

```powershell
npm install
npm run dev
```

浏览器打开本地地址（默认 `http://127.0.0.1:5173`），然后：

1. **设置** → 确认录制目录、ffmpeg  
2. **素材库** → 添加直播间 ID，打开「监控录制」  
3. 主播下播 → 进房间 → AI 切片 / 字幕 / 导出  
4. **投稿** → 预检通过后再确认执行  

可选增强：

```powershell
# 顺带准备默认 Qwen3-ASR 0.6B
npm run setup:qwen
```

---

## 能力一览

| 能力 | 开箱可用 | 说明 |
| --- | --- | --- |
| 多房间监控录制 | ✅ | 开播自动录 FLV + 弹幕 XML，下播入库 |
| 房间素材库 | ✅ | 按房间聚合，支持隐藏目录（不删硬盘文件） |
| 本地预览 | ✅ | MP4/MOV 直播；FLV 可生成预览或批量转封装 |
| 弹幕时间线 | ✅ | 密度直方图、按时间筛弹幕 |
| 字幕编辑 | ✅ | SRT/VTT/ASS + 手动补行 |
| 区间 / 整片 ASR | ⚙️ | Fun-ASR、Qwen3-ASR-GGUF、自定义命令、云端接口 |
| AI 高置信切片 | ⚙️ | 弹幕/字幕/画面/频谱信号；需配置视觉模型更稳 |
| 自动切片流水线 | ⚙️ | 录完可排队分析、导出、生成投稿草稿；失败可重跑 |
| 封面 / 标题 | ⚙️ | 抽帧；可选外部模型生成 |
| 投稿草稿 + 预检 | ✅ | 分 P、Cookie、biliup 命令预检 |
| 真实投稿 | ⚙️ | 需 biliup + 有效 Cookie + **二次确认** |
| FLV 后处理 | ✅ | 默认 copy 快剪；可选 NVENC/QSV/AMF 归档压缩 |
| 任务中心 | ✅ | 录制 / ASR / 转码 / 自动化 / 投稿统一查看 |

图例：`✅` 装好 Node + ffmpeg 就能用 · `⚙️` 按需接模型 / Cookie / 工具

---

## 推荐工作流

```text
加房间 → 开监控录制
    ↓ 开播自动写 FLV + 弹幕
下播入库 → 进房间工作台
    ↓ 可选：ASR / 预览 MP4
AI 切片（少而准）→ 改标题 · 导出
    ↓
投稿页：分 P + 预检 → 确认后 biliup
```

设置里媒体转换有三档预设：

| 预设 | 适合 | 策略 |
| --- | --- | --- |
| **快剪优先** | 当天剪切片 | 视频/音频 stream copy，可并发 |
| **均衡** | 日常默认 | copy + 并发 2 |
| **归档压缩** | 长期存盘 | H.264 压缩，输出到 `_compressed`，编码器可 `auto`（优先 NVENC） |

录制链路建议：`remuxToMp4` 开着，保证下播后尽快有可剪 MP4；省空间再批量归档压缩。

---

## 截图

完整说明见 [docs/feature-tour.md](docs/feature-tour.md)。

| 素材库 | 工作台 AI 切片 |
| --- | --- |
| ![素材库](docs/screenshots/library-overview.png) | ![AI 切片](docs/screenshots/feature-ai-clipping.png) |

| 弹幕字幕 | 投稿预检 |
| --- | --- |
| ![弹幕字幕](docs/screenshots/feature-danmaku-subtitles.png) | ![投稿](docs/screenshots/feature-upload-preflight.png) |

| 任务中心 | 设置 |
| --- | --- |
| ![任务](docs/screenshots/tasks-center.png) | ![设置](docs/screenshots/feature-settings-overview.png) |

---

## 环境要求

| 依赖 | 是否必须 | 用途 |
| --- | --- | --- |
| **Node.js 18+** | 必须 | 前端 + 本地 Express |
| **ffmpeg / ffprobe** | 必须 | 预览、切片、封面、FLV 处理 |
| Python | 可选 | 本地 ASR、工作区安装 biliup |
| biliup | 可选 | 投稿 / 追加分 P / 读稿件 |
| 视觉 / ASR 模型接口 | 可选 | AI 切片、标题、语音识别 |

服务默认只监听 **`127.0.0.1`**，面向本机使用。

---

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动工作台 |
| `npm run build` | 构建前端 |
| `npm run typecheck` | TypeScript 检查 |
| `npm run test:server` | 服务端测试 |
| `npm run test:workflow` | 工作流回归汇总 |
| `npm run setup` | 安装基础依赖 |
| `npm run setup:qwen` | 依赖 + 默认 Qwen3-ASR |
| `npm run start:workbench` | PowerShell 启动脚本 |

真实直播 smoke（需指定当前开播房间）：

```powershell
$env:REAL_BILI_ROOM_ID="545068"
$env:REAL_BILI_SAMPLE_SECONDS="45"
$env:REAL_BILI_REQUIRE_DANMAKU="1"
npm run test:real-live-api
```

更完整的验收证据见 [docs/verification-report.md](docs/verification-report.md)。

---

## 你可能想知道

**会不会把我的 Cookie / 视频传到别人服务器？**  
默认不会。录制文件、工程草稿、Cookie、模型缓存在本地 `.workbench/`（已 gitignore）。只有你在设置里配置的**云端 ASR / 视觉接口**会按你填写的地址出站请求。

**真实投稿安全吗？**  
投稿有预检 + 策略门禁 + 前端二次确认；`confirm=true` 且用户明确执行才会跑 biliup。自动化默认倾向「生成草稿 / 人工复核」，而不是静默公开投稿。

**和纯录播软件有什么区别？**  
录播软件止于「录下来」。这里把**房间素材、剪切片、字幕、投稿准备**收成一条本地流水线，并尽量用「少而准」的 AI 候选减少人肉拖时间轴。

**FLV 必须重编码吗？**  
不必。批量转换默认 **stream copy**（快、画质不变）。要省盘再切「归档压缩」，有 NVIDIA 时可走 NVENC。

**适合谁？**  
自己录自己的直播、做切片二创、想少装几个工具的人。不是云端 SaaS，也不替代专业 NLE 精剪。

---

## 目录结构

```text
.
├─ src/                 # React 工作台 UI
├─ server/              # Express API、录制、ASR、投稿、媒体处理
├─ scripts/             # Windows 安装 / 启动 / 冒烟脚本
├─ docs/                # 功能导览、截图、验收
├─ tests/               # 服务端与 Playwright 验收
├─ .workbench/          # 本地数据（不入库）：录制缓存、模型、Cookie、草稿
└─ README.md
```

---

## 设计原则

1. **本地优先** — 素材与密钥留在本机  
2. **房间是一等公民** — 不为「一个大文件夹」设计  
3. **少而准** — AI 切片宁缺毋滥，并给出可核对的证据  
4. **危险操作要门禁** — 真投稿、删配置、隐藏素材都要说清楚  
5. **能 copy 就不重编码** — 速度优先，归档另说  

---

## 路线图（欢迎 PR / Issue）

- [ ] `/api/settings` 工具探测缓存（首屏再快一截）  
- [ ] 进房视频列表元数据懒加载  
- [ ] 播放进度状态局部化（长视频更顺）  
- [ ] 设置首次使用向导  
- [ ] 拆分巨型 `App.tsx` / `routes.mjs`  

有 bug 或想法请开 [Issue](https://github.com/wwwufjjd/bilibli-qiepian/issues)。

---

## 参与贡献

```powershell
git clone https://github.com/wwwufjjd/bilibli-qiepian.git
cd bilibli-qiepian
npm install
npm run dev
```

改代码前建议：

```powershell
npm run typecheck
npm run test:server
```

---

## 许可证

当前仓库为 **UNLICENSED**。公开使用或二次分发前请先补充许可证；商用请先联系作者确认。

---

## Star 一下？

如果你也在做 B 站直播切片：录完找不到片、剪得慢、投稿前心里没底——这个项目就是为这种日常准备的。

**点个 Star**，方便后面跟更新；平台接口或录制细节变了，我也会按自己在用的节奏继续修。

[→ github.com/wwwufjjd/bilibli-qiepian](https://github.com/wwwufjjd/bilibli-qiepian)
