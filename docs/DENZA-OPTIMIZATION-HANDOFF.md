# Denza-Fork 性能优化与架构改造交接文档（3.2.9-denza.6）

本文档记录按 [`DENZA-PERFORMANCE-AUDIT.md`](DENZA-PERFORMANCE-AUDIT.md) 优先级分阶段实施 P0 / P1 / P2 优化后的完整改动、兼容迁移机制、实测数据对比、验证矩阵及后续接手注意事项。所有改动均遵守 [`AGENTS.md`](../AGENTS.md) 与 [`DENZA-ARCHITECTURE.md`](DENZA-ARCHITECTURE.md) 分层红线。

---

## a) 本轮起止 Commit、涉及文件与关键符号改动详表

- **基线起点（`custom` 分支）**：`0a4eb4b57a242432b5b3c96b013f8129d33fb0e1`（Merge PR #8, `3.2.9-denza.5`）
- **基线文档锁定 Commit**：`8789cb6`（`docs: record performance audit baseline and handoff policy`，提交既有 `AGENTS.md` 与 `DENZA-PERFORMANCE-AUDIT.md`）
- **优化开发与合并 Commit**：功能提交 `67b3112`（分支 `feat/perf-arch-optimization`，版本号 `3.2.9-denza.6`），已合并至 `custom` 节点 `f15fc03bb69da2b90e4b7275b7b050045c444305`（已通过 CI Run `43893899000` 全量打包与冒烟验证）

| 阶段 | 文件 | 关键符号 / 改动摘要 |
| --- | --- | --- |
| 基线工具 | `scripts/perf-bench.mjs` | 新增可复现基准脚本：SDK Worker 冷热与并发、OnlineStore 解密次数、200 曲目扫盘与 3000 首同步歌单、下载写标签事件循环滞后、`dist-app` 产物体积统计 |
| P0-1 | `electron/platform-worker.cjs` | 支持按 `workerData.platform` 常驻事件循环复用 `getSDK()` / `runOperation()`，兼容旧单次模式；对外清理敏感错误字段后回传 |
| P0-1 | `electron/online/sdk-transport.cjs` | 新增 per-platform 常驻 Worker 池：`pool`、`getSlot()`、`armIdle()`（`WORKER_IDLE_MS = 60000` `.unref()`）、`REQUEST_TIMEOUT_MS = 25000`、`MAX_HUNG_REQUESTS = 4` 超时熔断重建、`AbortSignal` 单请求取消及 `closeSdkWorkers()` |
| P0-1 | `electron/online-store.cjs` | 新增内存 `decrypted` 明文缓存、`credential()` 按 `secret` 校验命中缓存、`load()`/`deleteAccount()`/`close()` 清理明文、`scheduleSave()`/`flush()` 合并盘写 |
| P0-1 | `electron/platforms.cjs` | `logout()` 改用 `deleteAccount()` 同步清理凭证缓存，避免残留明文或空写盘 |
| P0-1 | `electron/apple-music.cjs` | `appleTokens` 持久化至 `OnlineStore`、并发 `tokenFetch` 去重、收到 401/403 时失效持久 token 并单次重试、`deleteAccount('apple')` 登出清理 |
| P0-1 | `electron/online.cjs` | `sync()` 歌单页抓改用有界并发（并发度 4，任一分页失败通过 `AbortController` 中止兄弟请求，防止部分快照覆盖）；新增 `playlistSongs` 惰性读取；`close()` 调用 `closeSdkWorkers()`、`store.close()`、`library.flushRemotePlaylists()`；透传 `onProgress` 至下载管理器 |
| P0-2 | `electron/online/library-links.cjs` | 将 `remote.songs` 从 `db.json` 与 `lib:get`/`lib:changed` 抽离至 `remoteDir/<id>.json`；新增 `migrateLegacyPlaylists()`、`removePlaylistShard()`、`flushRemotePlaylists()`、`remoteSongs()`；预归一键缓存 `normCache` + `O(1)` 曲目映射 `songLookup`；新增 `importFile` 单曲直接入库绕过全盘 `scan()`；保留无 `remoteDir`/`importFile` 时对内存 `remote.songs` 的兼容回退 |
| P0-2 | `electron/library.cjs` | `P.remotePlaylists` 分片目录、`load()` 调用 `migrateLegacyPlaylists()`、`view()` 返回浅快照且 `remote` 仅保留 `songCount` 剥离 inline `songs`；提取共享 `upsertTrack()` 与单文件 `importFile()`；删除歌单时调用 `removePlaylistShard()`；同时完成 P1-3（`walk()` 单遍收集 `sidecars` Set、`sidecar()`/`ttmlSidecar()` 免 `fs.existsSync`、`byAk` Map、`nextJob()` 单遍选曲） |
| P0-2 | `src/app/online/types.ts` / `src/app/space/data.ts` / `src/app/space/SpaceDetail.tsx` | `RemotePlaylist` 调整为 `songCount?: number; songs?: OnlineSong[]`；`fromLibrary()` 与空间歌单详情优先读 `songCount` 并兼容 `songs?.length` |
| P0-2 / P2-1 | `src/app/ui/OnlineMusic.tsx` | 抽离 `OnlineDialog.tsx`（P1-1）；`SyncedPlaylists` 当 `remote.songs` 缺失时请求 `playlistSongs` 懒加载并保留内联回退；`SearchSongs` 勾选改用 `selectedSet`；新增 `SyncedSongRow`/`DownloadJobRow` 记忆化子行与大列表（>80 项）`useVirtualWindow` 窗口化；`accountsByPlatform` Map、`localPosByIdx` 缓存 |
| P0-3 | `electron/online/tag-worker.cjs` | 新增标签写盘独立工作线程：接收 `copyFile` -> `writeDownloadTags` -> `music-metadata` 校验 -> `unlink` -> SHA-256 `digest` 全流程，写标签失败时保留完整的 `tempPath` 供排障或重试 |
| P0-3 | `electron/downloads.cjs` | 集成 `TAG_WORKER_SCRIPT` 单实例复用池（`TAG_WORKER_IDLE_MS = 45000` `.unref()`）；集成 `createArtworkCache()` 封面内存缓存；引入 `publishProgress()` 增量进度回调与 `saveState` 写入合批；`close()` 清理计时器与写标签 Worker |
| P0-3 | `electron/online/artwork.cjs` | `fetchArtwork()` 支持 `outerSignal`；新增 `createArtworkCache({ fetcher, maxEntries = 64, maxBytes = 64MB })` LRU 封面字节缓存 |
| P0-3 | `electron/preload.cjs` / `src/app/online/state.ts` | 新增 `online:progress` IPC 通道与 `OnlineApi.onProgress?`，增量更新 `online.get().jobs` 中对应任务而不必全量克隆 |
| P0-4 | `package.json` / `.github/workflows/denza-build.yml` | 采用**方案 A**：保留 `win32-x64` 版 Codex CLI（`codex.exe` + `codex.js`）以保持开箱即用和 `packaged-smoke.cjs` 全绿；通过 `build.files` 显式剔除非运行期目录与文件（Codex 非目标平台/资源/`codex-code-mode-host.exe`、`netease/public`、`qq-music-api/{docs-dist,public}`、`kugou/{public,docs,.github}`、`node-taglib-sharp/src`、`*.map`、`*.d.ts` 等），磁盘保留 `vendor/kugou` 以确保 `online:deps` 指纹完整；CI 增加 `Report packaged size breakdown` 体积统计步骤；版本升至 `3.2.9-denza.6` |
| P1-1 | `vite.config.ts` / `src/app/ui/OnlineDialog.tsx` | 仅在 `mode === 'web'` 时启用 `viteSingleFile`；`mode === 'app'` 关闭单文件内联、`assetsInlineLimit: 4096`，CSP `script-src` 补 `file:` 并移除 HTML 上 `<script>/<link>` 的 `crossorigin` 属性以适配桌面端 `file://` ESM 分块 |
| P1-1 | `src/app/main.tsx` / `src/app/views/{Shell,Library,Effect}.tsx` / `src/app/views/workshop/Workshop.tsx` / `src/app/space/{SpaceShell,SpaceDetail,SpacePanels}.tsx` | 对 `Shell`、`WebApp`、`PosterWall`、`SettingsView`、`WorkshopPage`、`OnlineMusic`、`SyncedPlaylists`、`SpaceSettings`、`OnlineLyricsSearch`、`TranslationEditor` 改为 `lazy()` / 动态 `import()` 配合 `<Suspense fallback={null}>` |
| P1-2 | `src/rhythm/neural/wgsl/percussive.ts` / `src/rhythm/neural/gpu.worker.ts` / `src/rhythm/neural/index.ts` | 新增 `runPercussiveEnergyCpu()`（与 `PERCUSSIVE_WGSL` 算法一致），使 `nat`（Native ONNX）模式无需调用 `openDevice()` 初始化 WebGPU；新增 `ownBuffer` / `.slice()` / `transferOf` 安全使用 `Transferable` 零拷贝传递音频与分析 TypedArray |
| P1-4 | `src/render/renderer.ts` / `src/director/fit.ts` | 新增 `getShadeCanvas()` 缓存径向渐变压暗离屏画布、新增 `getLayerEffects()` 缓存图层合并与 Z 序过滤结果；`fitPass()` 将逐帧 `.filter()` / `.some()` / `.find()` 收敛为排序队列 `frameQueue` + `sungIdx` 单调游标 |
| P2-1 | `src/app/ui/useVirtualWindow.ts` / `src/app/ui/TranslationEditor.tsx` / `src/app/views/Library.tsx` / `src/app/views/Wall.tsx` | 新增统一自适应窗口化 Hook `useVirtualWindow`（小于阈值 80/100/120 时原样全量挂载，超出阈值按真实滚动容器窗口切片）；`TranslationEditor` 拆出 `TranslationRow` `memo` 子行、`Set`/`Map` 查询、函数式局部更新；`Library.tsx` `TrackList` 拆出 `TrackRow` `memo` 子行并与 `useReorder` 共享容器 ref、保留虚拟化下 `locatePlaying()` 自动滚回激活行；`Wall.tsx` `PosterWall` 改用 `idx.fav.has()` |
| P2-2 | `electron/online/providers/qq.cjs` | `lyrics()` 当 `json` 可用时优先直连 `musicu.fcg`（`PlayLyricInfo`），主歌词存在时跳过冗余 SDK Worker `getLyric` 调用；异常或缺失时无缝回退 SDK |
| 测试与文档 | `tests/unit/{online,apple-music,online-fixes,neural}.test.ts` / `docs/{DENZA-VALIDATION,RELEASE}.md` | 增补 Worker 池复用与中止、凭证缓存、AM 公开 Token 缓存与 401 刷新、分片迁移与删库清理、封面 LRU 复用、进度增量合并、`runPercussiveEnergyCpu`、QQ 歌词直查快路径单测；更新 `online.test.ts` 中同步歌单视图契约断言 |

---

## b) 架构 / 数据流变化、持久化结构变动及兼容迁移逻辑

1. **SDK 与写标签隔离模型（维持扩展边界不变）**：
   - 第三方平台 SDK 仍严格驻留在 Worker 线程（`electron/platform-worker.cjs`），由 `sdk-transport.cjs` 管理每平台最多 1 个常驻空闲超时回收的复用 Worker。所有跨线程错误经过脱敏清理，超时上限触发后自动重建；主进程退出前通过 `closeSdkWorkers()` 优雅收尾。
   - 下载音轨在 `downloads.cjs` 完成临时文件下载与音频流格式校验后，音频复制、写标签（`writeDownloadTags`）、回读校验与 SHA-256 摘要整体迁移至独立复用 Worker（`electron/online/tag-worker.cjs`），彻底避免大文件写标签阻塞主进程事件循环。若 Worker 内标签写入或校验失败，源文件 `tempPath` 完整保留。
2. **同步歌单冷热分层与平滑迁移**：
   - **持久化结构变化**：`userData/library/db.json` 的 `playlists[i].remote` 不再持久化整张 `songs` 明细数组，改为仅存储轻量元信息（`platform`, `id`, `uid`, `name`, `updated`, `cover`, `artworkUrl`, `songCount`）。完整远端曲目数组冷存至 `userData/library/remote-playlists/<playlistId>.json`（经原子队列写入，歌单被删除时同步清理对应分片文件）。
   - **IPC 与视图契约变化**：`lib:get` / `lib:changed` 下发的播放列表不再携带海量 `remote.songs`，前端仅在用户进入对应同步歌单详情且未内联提供 `remote.songs` 时通过 `online:request('playlistSongs', { id })` 惰性加载。前端组件仍保留 `remote.songs ?? ...` 兜底，兼容外部/单测 mock。
   - **向后兼容与迁移**：`library.cjs` 启动 `load()` 时调用 `libraryLinks.migrateLegacyPlaylists()`：扫描旧版 `db.json` 中内联含 `remote.songs` 的歌单，将曲目数组写盘至 `remote-playlists/<id>.json` 并写回 `songCount`，随后从内存 `remote` 对象移除 `songs` 并标记持久化。若单项迁移写盘失败或存在坏分片 JSON，优雅降级避免整库加载失败；同时提供回滚或清理分片安全性。
3. **Apple Music Token 持久化**：
   - `AppleMusic`（`electron/apple-music.cjs`）将抓取到的匿名公开 `appleTokens`（bundle/dev token 对）缓存在 `OnlineStore` 数据结构中。冷启动优先复用未失效 Token 避免重复解析官网 JS Bundle；遇到 HTTP `401/403` 时清除缓存并发起带 `tokenFetch` 并发去重的刷新重试。
4. **桌面端异步分块（不影响 Web 单文件与沙盒预加载边界）**：
   - Vite 在 `mode === 'app'` 时生成多 ES Chunk，`vite.config.ts` 中 `script-src` 补齐 `file:` 并清除 `<script>/<link>` 的 `crossorigin`，确保 Electron 打包后的 `file://` 协议顺利加载异步模块；`mode === 'web'` 保持原 `vite-plugin-singlefile` 逻辑不变。

---

## c) Before / After 实测性能与安装包体积对比

基准环境：Windows 11, Node `v24.22.1`，基于 [`scripts/perf-bench.mjs`](../scripts/perf-bench.mjs) 与本地 `electron-builder --win --x64 --dir` 解包及 `vite build` 实测数据：

| 维度 / 指标 | 优化前（Before） | 优化后（After） | 变化幅度 |
| --- | --- | --- | --- |
| Netease SDK Worker 复用平均耗时 | `885.62 ms` | `0.27 ms` | **-99.97%** |
| QQ SDK Worker 复用平均耗时 | `164.64 ms` | `0.35 ms` | **-99.79%** |
| Kugou SDK Worker 复用平均耗时 | `359.48 ms` | `0.07 ms` | **-99.98%** |
| 三平台并发调用（预热后） | `892.88 ms` | `0.12 ms` | **-99.99%** |
| `OnlineStore.credential()` 1000 次 `decryptString` 次数 | `1000 次`（`2.426 ms`） | `0 次`（`0.597 ms`，重载仅 1 次） | **消除重复同步解密** |
| 本地 200 曲扫盘（冷扫 / 温扫） | `104.25 ms` / `31.77 ms` | `56.44 ms` / `6.91 ms` | **-45.9% / -78.2%** |
| 扫盘侧车 `fs.existsSync` 调用次数（冷 / 温） | `1000 次` / `1000 次` | `0 次` / `0 次` | **-100%** |
| 3 歌单 3000 曲目下 `db.json` 体积 | `484,313 B`（~473 KB） | `70,057 B`（~68 KB） | **-85.5%** |
| `lib:changed` 广播负载（`3000` 同步曲） | `539,295 B`（~527 KB） | `125,076 B`（~122 KB） | **-76.8%** |
| 歌单变更后 `remoteSong100Ms` 索引查找 | `53.852 ms` | `0.155 ms` | **-99.71%** |
| 单首下载完成入库（`importDownloadMs`） | `36.81 ms` | `6.30 ms` | **-82.9%** |
| 4 首同封面下载封面请求数 & 主线程最大滞后 | `未缓存` / `71.28 ms`（3 首） | `1 次（复用 3 次）` / `5.84 ms` | **事件循环滞后 -91.8%** |
| `dist-app/index.html` 入口 HTML 体积 | `9,338,664 B`（9.34 MB） | `829 B`（异步资产 8.36 MB） | **入口 HTML -99.99%** |
| 打包 `resources/app.asar` 体积 | `201.64 MB` | `175.17 MB` | **-26.47 MB（-13.1%）** |
| 打包 `resources/app.asar.unpacked` 体积 | `556.96 MB` | `430.46 MB` | **-126.50 MB（-22.7%）** |
| 解包核心资源合计（`app.asar + unpacked`） | `758.60 MB` | `605.63 MB` | **-152.97 MB（-20.2%）** |
| Windows 安装包（`Cadenza-Setup-*.exe`） | `505.51 MB`（`denza.5`, 530,070,800 B） | `455.95 MB`（`denza.6`, CI Run `43893899000`） | **-49.56 MB（-9.8%）** |
| Windows 便携版（`Cadenza-*-portable.exe`） | `466.59 MB`（`denza.5`, 489,256,644 B） | `425.01 MB`（`denza.6`, CI Run `43893899000`） | **-41.58 MB（-8.9%）** |

> CI Run [43893899000](https://github.com/ahuai6/Denza-Fork/actions/runs/43893899000)（Artifact ID：`14237804350`）另打包固定模型目录 `resources/models`（`126.78 MB`），并执行 `scripts/packaged-smoke.cjs` 通过（`Packaged modules and text runtime passed (9 models; no account sign-in)`）。

---

## d) 实际运行的检查命令、全部结果及跳过 / 未覆盖范围

### 已实际运行并通过的检查
1. `npm run typecheck`：退出码 0（TypeScript 零报错，全项目含新增虚拟窗口与分块类型）。
2. `npm run online:deps`：退出码 0（全部 4 个固定版本 NPM/本地依赖及外部协议快照均核验一致）。
3. `npm test`（`vitest run`）：退出码 0，**42 个测试文件、444 项单元测试全部通过**（含新增的 Worker 池复用与中止、凭证缓存、AM Token 复用与 401 重试、同步歌单迁移/删库清分片、封面 LRU/增量进度、`runPercussiveEnergyCpu` 与 QQ 歌词直查快路径用例）。
4. `npm run build:app` 与 `npx vite build --mode web`：均退出码 0（`dist-app/index.html` 0.82 kB，异步 Chunk 与 `dist-app/fonts` 124.7 MB 正常输出；`dist-web/web.html` 9,355.67 kB 单文件保留完整）。
5. Electron 分块启动检查（本地临时脚本 `check-electron-chunks.cjs` 加载 `dist-app/index.html`）：经典与空间两种模式均成功初始化视图，`errors: []`、`failedLoads: []`。
6. `electron-builder --win --x64 --dir` + `Cadenza.exe`（`ELECTRON_RUN_AS_NODE=1`）本地解包与 Codex 文本运行时检查：`app.asar` + `app.asar.unpacked` 共缩减 152.97 MB，`loadSDK('netease'/'qq'/'kugou')` 与 `CodexText.models()`（9 个模型）均通过。
7. 增量 Prettier 检查（`npx prettier --write --end-of-line crlf` 仅作用于本次改动中提示格式不一致的 11 个文件，因 Windows `core.autocrlf=true` 会对仓库未改动文件报 CRLF 差异故未执行全局 `--write`）。

### 未覆盖 / 跳过说明（绝不虚报）
- **GitHub Actions Windows CI（已补全打包构建与冒烟）**：[工作流 43893899000](https://github.com/ahuai6/Denza-Fork/actions/runs/43893899000) 已于合并提交 `f15fc03bb69da2b90e4b7275b7b050045c444305` 通过 `tsc` + `vitest`（42 文件 / 444 测试）+ `build:app` + `scripts/models.mjs` + `cargo build`（`cadenza-audio.exe`）+ `electron-builder` 安装版/便携版打包 + `scripts/packaged-smoke.cjs`（9 个模型）。本机因未装 `cargo` 未在本地编原生 Rust 二进制。
- **完整图形 E2E 回归**：本机无 `playwright` 依赖与完整端到端缓存（`tests/desktop.cjs`、`tests/space.cjs`、`tests/online-desktop.cjs`、`tests/desktop-hifi.cjs`、`tests/render.cjs`、`tests/neural.cjs`），CI 流水线也未包含图形 E2E，均未运行。
- **真实在线账号与实体音频硬件**：未执行真实网易云/QQ/酷狗/Apple Music 账号登录、真实网络拉歌与实体 WASAPI/Hi-Fi 声卡播放实测。

---

## e) 仍待后续完成的优化项、已知风险及合并上游注意点

1. **后续可继续推进的优化空间**：
   - **入口与公共 chunk 体积进一步切分**：当前 `build:app` 时 `src/app/views/Effect.tsx` 静态导入了 `MvLook`（来自 `Settings.tsx`），导致 Rollup 提示 `Settings.tsx` 无法被 `Shell.tsx` 独立拆块；若后续将 `MvLook` 移出 `Settings.tsx` 为轻量工具模块，设置页体积可进一步脱离主路径。另外 `DialogOwner` / `SpaceShell` 中 Three.js 相关模块也可视实际首屏交互继续细拆。
   - **Codex CLI 本体体积（~240+ MB `codex.exe`）**：方案 A 在保留开箱即用 Codex 文本模型的前提下保留了 `win32-x64` 的 `codex.exe`；若未来改为按需下载或剥离进可选扩展包，安装包可再降约 200+ MB（注意届时需同步更新 `scripts/packaged-smoke.cjs` 的静态断言）。
   - **本地前端长列表与多账号缓存实测**：在拥有 1000+ 曲目和真实 Windows 设备下，可结合 Chromium Performance 面板复核 `useVirtualWindow` 在滚动高频翻页及不同缩放（DPI）下的行高偏移（当前按固定近似高度 72 / 96 / 132px 估算；`DownloadList` 出现多行报错提示时可能略高，但因超阈值才开启且有 `overscan = 6` 缓冲，不影响可用性，如有极端高度漂移可升级为动态高度测量）。
2. **已知风险提示**：
   - `library-links.cjs` 采用冷热分片后，`userData/library/remote-playlists/*.json` 属于运行期衍生文件；若用户回退至 `3.2.9-denza.5` 旧版本，旧版本仅读 `db.json` 内空 `songs`，需要重新触发一次同步才会重新拉回，但不会破坏 `db.json` 中的本地曲目与本地歌单。
   - `electron/library.cjs`、`electron/online/library-links.cjs` 和 `src/app/ui/OnlineMusic.tsx` 修改较大；后续测试如 mock 了 IPC 或直接读 `playlist.remote.songs`，注意保留向后回退分支或传 `songs` mock 字段。
3. **未来合并 Cadenza 主程序上游时的冲突注意点**：
   - **底座与架构高冲突文件**：`vite.config.ts`、`package.json`、`electron/library.cjs`、`src/app/main.tsx`、`src/app/views/Shell.tsx`、`src/app/views/Library.tsx`、`src/app/views/Wall.tsx`、`src/app/views/Effect.tsx`、`src/app/views/workshop/Workshop.tsx`、`src/app/space/SpaceShell.tsx`、`src/app/space/SpaceDetail.tsx`、`src/app/space/SpacePanels.tsx`、`src/render/renderer.ts`、`src/director/fit.ts`、`src/rhythm/neural/index.ts`、`src/rhythm/neural/gpu.worker.ts`、`src/rhythm/neural/wgsl/percussive.ts`。
   - **合并准则**：合并上游 Cadenza 时**必须保留** `SpaceShell` 的 `.onlineControl` 独立扩展入口定位、`online/library-links.cjs` 挂载钩子、`library.cjs` 中 `P.remotePlaylists` / `importFile` / `view()` 分片逻辑、以及 `vite.config.ts` 中桌面端多 Chunk + `file:` CSP 规则。如上游重构了 `Shell` / `Library` / `TrackList` 导入或重排逻辑，优先以“保留本轮懒加载包装、共享 ref 及扩展点”的方式手动解决冲突，避免直接 `ours`/`theirs` 覆盖。
