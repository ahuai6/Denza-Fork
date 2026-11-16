# Denza-Fork 性能与架构优化审查清单（交接基线）

> 本文档整理自对 `ahuai6/Denza-Fork` 的深度代码审查，面向后续新建 Project 接手改造的 Agent。开始改代码前请先阅读 `AGENTS.md`、`CLAUDE.md`、`.claude/skills/cadenza/SKILL.md` 与 `docs/DENZA-ARCHITECTURE.md`。

## 0. 审查基线与架构红线

### 0.1 代码与产物基线

| 维度 | 实测基线 |
| --- | --- |
| Fork HEAD（`custom` 分支） | `0a4eb4b57a242432b5b3c96b013f8129d33fb0e1`（Release `v3.2.9-denza.5`） |
| 上游共同祖先（`ahuai6/Cadenza`） | `41963b9c68c57bc977c46b7fe001d89e71e97026`（`v3.2.9`，已完整同步） |
| 相对上游代码规模 | 非 `vendor/` 部分共 **108 个文件（+14,541 / -515 行）**；另含 `vendor/kugou`（**284 文件 / 1.1 MB / 2 个 `.wasm`**） |
| 上游 `Cadenza v3.2.9` 安装包体积 | `Cadenza-Setup-3.2.9.exe`：**361.97 MB**；`Cadenza-3.2.9-portable.exe`：**345.34 MB** |
| `Denza-Fork v3.2.9-denza.5` 安装包体积 | `Cadenza-Setup-3.2.9-denza.5.exe`：**505.51 MB**（**+143.54 MB**）；`Cadenza-3.2.9-denza.5-portable.exe`：**466.59 MB**（**+121.25 MB**） |
| 现有 Windows CI 验证门禁 | `.github/workflows/denza-build.yml`：`npm run typecheck` + `npm test` + `npm run build:app` + `node scripts/models.mjs` + `cargo build` + `electron-builder` + `scripts/packaged-smoke.cjs` |

### 0.2 不可违反的 Fork 约束（摘自 `AGENTS.md` / `CLAUDE.md` / `docs/DENZA.md`）

1. **边界隔离不破坏**：第三方 SDK 只能留在 `electron/platform-worker.cjs` -> `electron/online/sdk-loaders.cjs`；平台能力以 `shared/online-providers.json` 为准，经典界面与空间界面共用同一业务逻辑。
2. **核心文件最小侵入**：对 `electron/library.cjs` 与界面层的扩展尽量维持挂载适配器模式（如 `electron/online/library-links.cjs`），避免日后同步 `Cadenza` 上游时产生大面积合并冲突。
3. **安全与合规不降级**：
   - 明文 Cookie / API Key / OAuth 凭证禁止离开主进程（`electron/online-store.cjs` 使用 Electron `safeStorage`）。
   - 保持 `apple-music.cjs` 的 `METADATA_LANGUAGE = 'zh-Hans-CN'`、AM 浏览器的隔离 session 与独立下载帮助提示。
   - 新增弹窗必须接入 `src/app/actions/dialogs.ts` 与 `src/app/ui/DialogOwner.tsx`，不得绕过窗口栈。
   - 保留 `docs/online-dependencies.json` 与 `scripts/online-deps.mjs` 校验及 `NOTICE.md` / `licenses/` 合规文件。
4. **验证诚实原则**：不得把未实际跑过的真实平台账号、真机音频输出或完整图形回归宣称为通过（参考 `docs/DENZA-VALIDATION.md`）。

---

## 1. P0 优先级：`Denza-Fork` 扩展层核心瓶颈

### P0-1. 第三方 SDK 每次调用都冷启/销毁 `Worker` + 每次重复 DPAPI 解密 + 歌单串行同步

- **涉及文件**：
  - `electron/online/sdk-transport.cjs`（L3–L30：`sdk()`）
  - `electron/platform-worker.cjs`（L1–L18）
  - `electron/online/sdk-loaders.cjs`（L1–L12）
  - `electron/platforms.cjs`（L36–L41：`call()`）
  - `electron/online-store.cjs`（L61–L64：`credential()`）
  - `electron/online.cjs`（L156–L172：`sync()`）
  - `electron/apple-music.cjs`（L141–L165：`developerTokens()`）
- **现状问题**：
  1. `sdk(platform, method, query, signal)` 每次请求都 `new Worker(platform-worker.cjs)`，在新 V8 线程内冷加载 NetEase API / QQ ESM / Kugou API（含 2 个 WASM 文件）并只执行一次调用后立刻 `worker.terminate()`。全平台搜索一次冷启 3 个 Worker；扫码轮询每次启动 1 个；`sync()` 遍历歌单与分页可连续冷启销毁数十上百次 Worker。
  2. `OnlineStore.credential(platform)` 每次在 `platforms.call()` 时实时调用 `safeStorage.decryptString(...)` 解密 Cookie，未在主进程内存中缓存已解密凭证。
  3. `online.cjs:163-166` 对 `lists` 做严格串行 `for (const list of lists) await collectPages(...)`，且未对比历史同步结果做局部/增量优化。
  4. `apple-music.cjs:141-165` 的 `developerTokens()` 仅内存缓存从 Apple Web Player 大型 JS Bundle（`/assets/index~*.js`）正提取的 `ES256` JWT，每次重启应用首轮 AM 调用都会重新抓 HTML 并下载整份 Web Player JS。
- **改造建议**：
  1. 将 `sdk-transport.cjs` + `platform-worker.cjs` 改为**长生命周期按平台复用 Worker（或空闲超时自动退出的 Worker 池）**，通过 `requestId` 在同一 Worker 内多路复用并发请求与 `AbortSignal` 取消。注意保持原有“错误脱敏（不泄露含鉴权 URL）”和单请求超时清理。
  2. `OnlineStore` 在 `load()` / `setAccount()` 后于内存维护解密凭证缓存，并在 `logout` / 退出时清除（不落明文盘）。
  3. `online.cjs` 的 `sync()` 将歌单歌曲列表拉取改为**受控并发（如并发数 3–4）**，保证任一页失败或账号切换时仍遵守“完整快照成功后才覆盖已保存歌单”的不变性。
  4. 将 Apple `tokens`（含 `exp`）持久化到 `OnlineStore`，未接近过期且未遇到 401/403 时直接复用。

---

### P0-2. 同步歌单全量耦合进 `db.json` 与 `lib:changed`，且单曲下载每次触发整库 `scan()`

- **涉及文件**：
  - `electron/online/library-links.cjs`（L20–L152：`linkSyncedPlaylists`, `importDownload`, `syncPlaylists`, `cachePlaylistCover`, `remoteSong`）
  - `electron/library.cjs`（L103–L180：`save`, `changed`, `view`；L479–L485；L1253–L1260：`lib:played`）
  - `src/app/space/bind.ts`（L143–L154）
  - `src/app/space/data.ts`（L48–L103）
- **现状问题**：
  1. `syncPlaylists()` 将每个同步歌单的完整 `remote.songs` 元数据数组直接挂在 `db.playlists[i].remote.songs` 并写入主库 `db.json`；`library.cjs:178` 的 `view()` 每次将全部 `playlists`（连同全部 `remote.songs`）通过 `lib:changed` 广播给渲染端。因此**哪怕只是本地播完一首歌（`lib:played` -> `changed()`）或缓存 1 张歌单封面（`cachePlaylistCover` -> `changed()`）**，都会触发数 MB JSON 全量重写、全量 IPC 克隆、以及 `Space` 的 `fromLibrary()` / 经典视图的联动重算。
  2. `importDownload(file, source)`（`library-links.cjs:73-92`）每下载完 1 首歌就触发**整库 `await scan()`**，并在 `while (!(track = Object.values(db.tracks).find(...)))` 中每 100ms 轮询等待（最长 60s），连续下载会持续引起整库重扫与同步 `existsSync`。
  3. `linkSyncedPlaylists()`（`library-links.cjs:20-72`）在每次 `scan()` / `importDownload()` / `syncPlaylists()` 时都全量扫描所有 `db.tracks`，对每首本地歌曲重复做两次 `normalizeSong()`（Unicode NFKC + `/[\s\p{P}]+/gu`），重建整张 Map 后重新匹配全部歌单。
  4. `remoteSong(key)`（`library-links.cjs:147-150`）每次调用都会 `playlists.flatMap(...).find(...)`，在 `online.cjs:175` 批量入队 100 首未命中 `candidates` 的歌曲时退化为百次全表数组分配与扫描。
- **改造建议**：
  1. **冷热分离**：将 `remote.songs` 从 `db.json` 与日常 `lib:changed` 中剥离，改为独立分片文件（如 `remote-playlists/<id>.json`）存储，仅在打开某歌单详情或执行匹配时按需读取/订阅；`db.playlists` 与 `lib:changed` 仅保留轻量的歌单摘要与匹配出的 `tracks` ID 列表。
  2. **单文件增量入库**：为 `library.cjs` 提供精准导入单个已知文件路径的内部方法（解析该文件标签/封面/sidecar 并写入 `db.tracks`），供 `importDownload()` 直接调用，彻底拿掉 `await scan()` 与 100ms 轮询。
  3. **增量/预计算索引**：为本地曲目维护预归一化索引键及 `onlineKey` / `remoteSong` 查找 Map，单曲导入时优先 O(1)/局部更新受影响歌单条目。

---

### P0-3. 下载落盘与写标签流程冗余读写、阻塞主进程且无封面缓存

- **涉及文件**：
  - `electron/downloads.cjs`（L53–L122；L182–L327）
  - `electron/online/tags.cjs`（L30–L63：`writeDownloadTags()`）
  - `electron/online/artwork.cjs`（L1–L28：`fetchArtwork()`）
  - `electron/online-store.cjs`（L29–L44：`save()`）
  - `electron/online.cjs`（L62–L71：`publish()`）
- **现状问题**：
  1. **多倍大文件磁盘 I/O 与主进程卡顿**：单曲下载完成 `.part` 并 `mm.parseFile(temp)`（L213）后，先 `fs.promises.copyFile(temp, staged)` 完整复制一遍音频（L303，Hi-Res FLAC 损耗尤大），再在 Electron 主进程中**同步调用** `taglib.File.createFromPath(staged)` + `file.save()` 写入标签和最大 8 MB 封面（`tags.cjs:37-62`），然后再执行一次 `mm.parseFile(staged)` 校验（L305）、删原件、再读盘算一次 `sha256`（L318），且单任务各阶段最多调用 4–5 次 `OnlineStore.save()` 全量重写 `online.json`。
  2. **封面无复用且校验旁路**：`downloads.cjs:283-300` 每首歌独立 HTTP 请求最高 8 MB 封面（同专辑下多首歌曲重复拉取同一 URL），且直接走 `this.artworkFetcher`，未复用 `artwork.cjs` 的 CDN 域名校验与重定向限制。
  3. **全量进度广播**：下载中每 ~350ms（L199）通过 `publish()` 发送完整 `accounts + folder + preferences + jobs`（最多 1000 条包含完整 `OnlineSong` 的记录）。
- **改造建议**：
  1. 将 `node-taglib-sharp` 写标签、`music-metadata` 二次校验与 SHA-256 哈希下沉到后台 Worker，保持主进程事件循环响应；结合临时文件策略消除整份大文件多余复制。
  2. 统一由带 CDN 安全校验的内存/磁盘短期 LRU 缓存接管封面抓取（下载队列与歌单封面复用同一缓存，同专辑只下一次）。
  3. 拆分轻量增量进度 IPC 事件（如仅推送变更 job 的 `{ id, status, received, total }`），降低 `online:changed` 序列化开销；对非关键状态的 `OnlineStore.save()` 做合并/节流（关停前 `close()` 确保落盘）。

---

### P0-4. 安装包体膨胀至 505.51 MB（+143.54 MB）的精准瘦身

- **涉及文件**：
  - `package.json`（L40–L53：`build.files`, `build.asarUnpack`；L86–L98：`extraResources`；L114–L123：`dependencies`）
  - `package-lock.json`
  - `.github/workflows/denza-build.yml`（L30–L52）
  - `scripts/packaged-smoke.cjs`
- **现状依据**：
  - 上游 `Cadenza v3.2.9` 本身携带 WebGPU WGSL 权重 `models/*.bin`（约 `132.94 MB`，见 `src/rhythm/neural/models.json`）+ `onnxruntime-node` + Electron，Setup 体积为 `361.97 MB`。
  - `Denza-Fork` 额外增加了 **`+143.54 MB` Setup / `+121.25 MB` Portable**，主要来自 `@openai/codex`（且 `package.json:51` 设置了 `asarUnpack: ["node_modules/@openai/codex*/**"]`，`package.json` 未像 `onnxruntime-node` 那样对 `files` 显式排除非目标架构/平台文件）以及第三方音乐 SDK 的完整依赖树（例如 `@neteasecloudmusicapienhanced/api` 附带嵌套的 `music-metadata` 与 `unblockmusic-utils` 下的 `express`/`body-parser`/`dotenv`/`yargs` 等服务端框架；`vendor/kugou/**` 284 个文件也整树进入 `app.asar`）。
- **改造建议**：
  1. **先测量再动刀**：在 `denza-build.yml` 的打包步骤后增加体积分解输出（统计 `release/win-unpacked/resources/app.asar` 解包前后各子目录、`app.asar.unpacked/` 及 `models/` 的大小排序），精确定位 `+143 MB` 的每项来源。
  2. 若多数用户仅需 HTTP/OpenAI 兼容接口而非本地捆绑 Codex CLI，评估把 `@openai/codex` 运行时改为**可选按需下载 / 系统现有 CLI 探测 / 独立插件包**，或至少严格限定仅打包 `win32-x64` 二进制并剔除非运行时文件。
  3. 审计并裁剪 `vendor/kugou/**` 中的 HTML 测试页/无用文件，以及与客户端运行无关的嵌套服务端依赖（前提是完整通过 `scripts/packaged-smoke.cjs` 与所有在线适配器测试）。

---

## 2. P1 优先级：继承自 `Cadenza` v3.2.9 底座的性能问题

经 `git diff 41963b9c..HEAD` 验证，以下问题原样存在于 `Denza-Fork` 当前代码中：

### P1-1. `viteSingleFile` 单包打包 + 首屏同步引入重型界面/工坊
- **涉及文件**：`vite.config.ts`（L20–L56）、`src/app/actions/boot.ts`（L17–L18）、`src/app/views/Library.tsx`（L16）、`src/app/space/SpaceShell.tsx`（L22）、`src/app/views/workshop/Workshop.tsx`（L35–L36）、`src/app/views/Effect.tsx`
- **问题与方向**：
  - 桌面端 `mode === 'app'` 启用 `viteSingleFile()`（`vite.config.ts:33`）与高内联阈值，把全部 JS/CSS 压入单个巨大 HTML，使 V8 难以有效代码缓存且阻塞首屏解析；同时 `boot.ts` 同步引入 `workshop/project`，且 `Library.tsx` / `SpaceShell.tsx` / `Workshop.tsx` / `Effect.tsx` 同步引入了 `OnlineMusic`（907 行）、`TranslationEditor`（461 行）、`words.ts`（391 行）。
  - 建议保留 `mode === 'web'` 单文件构建特性，将桌面端 `mode === 'app'` 改为标准 ES chunk 懒加载拆分（同步调整 CSP 确认兼容 `cadenza:`/`file:`/`self` 加载与打包单测/桌面启动），并对工坊、在线音乐弹窗与翻译编辑器使用 `React.lazy` 按需加载。

### P1-2. 神经节拍分析管道 4 跳无零拷贝克隆 + Native 模式空开 WebGPU Device
- **涉及文件**：`electron/inferHost.cjs`（L123）、`electron/infer.cjs`（L78–L89）、`src/rhythm/neural/index.ts`（L89–L135）、`src/rhythm/neural/gpu.worker.ts`（L84–L150）
- **问题与方向**：
  - 每段 HTDemucs 音频（`Float32Array(343980)` × 双声道输入 + 双路双声道输出）跨 Worker / IPC 历经多跳未带 `Transferable` 的拷贝（即便下游立即混为单声道或计算 50fps 能量）；Native ONNX 模式下 `gpu.worker.ts:89` 仍打开 WebGPU device 仅为了跑 `runPercussiveEnergy`。
  - 建议：在 Worker ↔ 渲染页链路启用 `Transferable`（传递底层的独立 `ArrayBuffer` 切片，避免误转移视图共享 buffer），并优化 Native 分支返回或直接输出下游所需能量/降采样特征；无必要时延迟/按需初始化 WebGPU。

### P1-3. `library.cjs` 目录扫描丢弃副车歌词导致同步 `fs.existsSync` 风暴与 O(N²) 调度
- **涉及文件**：`electron/library.cjs`（L292–L300：`ttmlSidecar`/`sidecar`；L329–L345：`walk`；L404–L450：`scan`；L593：`nextJob`）
- **问题与方向**：
  - `walk()` 只收集音频文件路径而丢弃了同目录下的 `.lrc`/`.ttml` 文件名，导致 `scan()` 中每首歌曲都要同步调 `sidecar()`/`ttmlSidecar()`（每首最多 5 次同步 `fs.existsSync`）；文件移动检测对 `Object.values(db.tracks)` 做线性 `.find(...)`；`nextJob()` 做多轮过滤与排序。
  - 建议：`walk()` 遍历 `readdir` 时同步建一张小写路径 `Set` 传入扫描判断，将每首歌的 `fs.existsSync` 降为 **0 次**；移动检测改用 `byAk` Map；`nextJob()` 改为单遍扫描选中最高优先级任务。

### P1-4. 渲染帧循环与歌词编排器每帧分配
- **涉及文件**：`src/director/fit.ts`（L71）、`src/render/renderer.ts`（L149, L235, L295）、`src/render/lyrics.ts`（L50）
- **问题与方向**：`fitPass` 多遍扫描全帧、`renderer.ts` 每帧 5 次 `effects().filter().sort()` 与 `createRadialGradient` 重建、`lyrics.ts` `visibleWords` 全表遍历。建议将特效表按层与 Z 序预分组缓存，只在开关变化时失效；缓存背景径向渐变到离屏画布或按尺寸复用；使用时间游标收缩 `visibleWords` 遍历区间。

---

## 3. P2 优先级：高负载 UI 体验、局部去重与验证完善

1. **长列表虚拟化与状态收敛**：
   - `src/app/ui/OnlineMusic.tsx`：`SyncedPlaylists`（L608–L654）的千首级歌曲列表、`DownloadList`（L801–L886）的最多千条队列，以及 `SearchSongs`（L356）中改为 `Set` 查找。
   - `src/app/ui/TranslationEditor.tsx`（L335–L433）：最多 1200 行歌词全量同时挂载 `<textarea>`、渲染期内线性查 `locked.includes` 和两次 `matches.find`，且单字输入触发整页刷新。建议切分 `MemoLineRow`、建立 `lockedSet` / `matchMap`、按视口虚拟化或分页，并与粘贴匹配区联动优化。
   - `src/app/views/Library.tsx` & `src/app/views/Wall.tsx`（L107 `favorites.includes`）：局部抽 `Set` 查找并考虑对 `TrackList` / 墙图引入虚拟列表。
2. **QQ 歌词双重请求优化**（`electron/online/providers/qq.cjs` L68–L125）：改为轻量 `musicu.fcg` 优先或在字段缺漏时再调 SDK（避免每次拉词同时触发冷 Worker + HTTP POST）。
3. **测试与基准补全**（对照 `docs/DENZA-VALIDATION.md`）：
   - 为“SDK Worker 池吞吐 / 库扫描耗时 / 歌单同步内存与 `db.json` 大小 / 打包体积分布”建立可复现的非 GUI 基准测试脚本。
   - 诊断或分层隔离 `tests/desktop.cjs` 与 `tests/space.cjs` 的超时瓶颈，同时保持对真实账号、Windows 音频设备等受限环境的如实标注。

---

## 4. 给本轮实施 Agent 的交付约定（务必在完成后生成交接文档）

**当你在新 Project 中完成一轮改造并验证后，必须在仓库内新增或更新 `docs/DENZA-OPTIMIZATION-HANDOFF.md`（以及在提交日志与回复中引用它）**，确保后续第三位或第 N 位 Agent 可以不靠猜地二次接手。该交接文档至少须包含：

1. **基线对照与修改范围**：改造起止 Commit SHA、涉及模块清单、未触及的遗留问题。
2. **改动明细（按架构域分节）**：每个优化点的具体实现方案、变更文件与关键符号、是否改变持久化文件格式（如 `db.json` 分片、缓存键、兼容/自动迁移与回退策略）。
3. **打包与体积前后对比**：列出 Before/After 的 `Setup.exe` / `portable.exe` / `app.asar` / `app.asar.unpacked` 体积对照表（若本轮跑了 Windows 构建）。
4. **实测性能指标与检查结果**：逐条列出实际执行的命令、环境与结果（`tsc`、`vitest`、`online:deps`、`packaged-smoke.cjs`、自定义 benchmark），严禁虚构或放大测试范围，明确写出跳过/未测项及原因。
5. **已知风险与后续接手指南**：剩余未做的 P1/P2 项、对未来合并 `Cadenza` 上游更新的影响点及解决冲突提示。
