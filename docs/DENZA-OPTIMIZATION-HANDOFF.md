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

---

## 本轮接手交接：3.2.9-denza.7 / 3.2.9-denza.8（UX 修复 / 优雅动效 / 空间光影与马赛克叠层 / 聆听室 5.1 / 2D-3D 管线优化）

- **基线与提交链路**：基于 `custom`（`9289eb5`），首轮合并提交 `aa77a6a`（`3.2.9-denza.7`），复查空间下拉框马赛克与色调映射后提交 `133b61233bb9c0198d7e1e3af9b1b69f038870fe`（`3.2.9-denza.8`）。
- **Windows CI 构建**：[工作流 43930367681](https://github.com/ahuai6/Denza-Fork/actions/runs/43930367681)（产物 [14259716923](https://github.com/ahuai6/Denza-Fork/actions/runs/43930367681/artifacts/14259716923)）：43 文件 / 447 项单元测试全绿，安装版 `Cadenza-Setup-3.2.9-denza.8.exe` `455.95 MB`、便携版 `Cadenza-3.2.9-denza.8-portable.exe` `425.00 MB`，`app.asar` `175.18 MB`、`app.asar.unpacked` `430.46 MB`，`packaged-smoke.cjs` 通过（9 models; no account sign-in）。

### 涉及文件与关键改动详表

| 模块 | 关键改动 |
| --- | --- |
| 在线文案与对话框（`src/app/main.tsx`、`src/app/ui/OnlineDialog.tsx`、`src/app/ui/OnlineSurface.module.css`、`src/app/ui/OnlineMusic.module.css`） | 主入口静态预注册 `./online/words` 消除启动 `on.short` / `on.close`；`OnlineDialog` 接入 `usePresence` 退场动画（退场期加 `inert`/`aria-hidden`）并拦截下级弹层打开时的误触 `Escape`；空间 `[role="listbox"]` / `[role="menu"]` / `.spacePopup` 保持 `.card` 接入 WebGL `GlassPass` 马赛克特效并辅以 `rgba(26, 20, 15, 0.28)` 轻度暗釉，同时保持 `[role="dialog"].card` 透明底契约。 |
| 经典设置与折叠动画（`src/app/views/Shell.tsx`、`src/app/views/Settings.tsx`、`src/app/views/Settings.module.css`） | 直接导入零体积碎片化的 `PosterWall` 与 `SettingsView`（根因：`Effect.tsx` 已静态导入 `MvLook` 使旧 `Settings` 分块为 `0 KB`），保留 `WorkshopPage` 懒加载并预加载；高级设置采用 `.advWrap`/`.advInner` CSS Grid 展开动画配合 `inert` 与 `aria-hidden` 联动。 |
| 统一优雅动效令牌与面板过渡（`src/app/styles/tokens.css`、`src/app/styles/base.css`、`src/app/ui/kit.tsx`、`src/app/ui/kit.module.css`、`src/app/space/SpaceSettings.*`、`src/app/space/SpaceDetail.tsx`、`src/app/space/SpacePanels.*`、`src/app/space/SpaceShell.*`、`src/app/space/space.css`） | 在 `tokens.css` 收敛柔和缓出曲线 `--ease: cubic-bezier(0.22, 1, 0.36, 1)`、`--ease-soft`、`--ease-in` 与退场/抬头时长（严格满足 `arch.test.ts` 对 `.css` 禁止硬编码 `ms` 的约束）；`MenuList` 二级子菜单与所有空间面板（设置、详情、添加歌单、歌词/队列、`Ask` 确认）补齐 `usePresence` 退场；`base.css` 关闭 `[role='dialog']:focus-visible` 外框以防在空间中与 `GlassPass` 构成双层边框。 |
| 空间光影、马赛克与 3D 渲染管线（`src/app/space/render/passes.ts`、`src/app/space/world.ts`） | 移除 `InkPass` 线性颗粒底噪与 `DreamPass` `+0.02` 黑位抬高去灰雾，并增强直射光、环境暗部、壁灯与太阳光柱（`gain=0.25`）对比度；`InkPass` 天空像素早期跳过 + `38m` 外省去次环；`ShaftsPass` 增加视锥裁剪 + `0.55x HalfFloatType beamRt` + 无可见光束时经 `hasBeam=0` 直通；`GlassPass` 扩展上限至 `GLASS_MAX=24`、按卡片层级排序并修复 `k >= inside` 叠层覆盖与 `ring *= 1. - k` 底层白边遮罩、用平滑肩部压缩 `m / (1 + m * k)` 替代硬截断以保留亮墙马赛克网格、同步卡片 `opacity` 实现马赛克渐隐渐显，并对与浮出下拉框/菜单重叠的底层容器自动施加 `mask-composite: exclude` 局部镂空以彻底消除底层 DOM 文字串透；`world.ts` 实施高分屏 MSAA 降倍（`dpr>=1.5 -> 2`）、`optimized` 阴影贴图上限 `2048`、`freeBand` 400ms 缓存、静止态 ~30fps 空闲帧节流与完整 `dispose()` 资源回收。 |
| 聆听室 5.1 声场与入室判定（`src/app/space/plan.ts`、`src/app/space/systems/audio.ts`、`src/app/space/world.ts`） | `plan.ts` 保留廊道重叠行走区间同时仅在 `along < ROOM_IN + 0.25` 标 `door: true`，避免走进聆听室 1.5m 内仍停留在 `'gallery'` 不亮灯；`RoomAudio` 确保全局仅创建 1 个共用 `ChannelSplitterNode(2)`，扩展 `FIELD` `L/R` 摆角至 `±38°`，重构立体声上混矩阵（前后左右交叉抑制 `0.95/-0.18` 与延时环绕 `0.84/-0.62` + `14/18ms` + `5200Hz LP`）防止居中音频全塌陷进中置。 |
| 2D 特效歌词与背景管线（`src/render/effects/backdrops.ts`、`src/render/effects/ambient.ts`、`src/engine/engine.ts`、`src/render/renderer.ts`、`src/render/effects/cover.ts`） | 实时视频背景降频采样（`~6 Hz` + 平滑滤波 `VID_LUMA` 缓存）替代每帧同步 `getImageData` GPU 回读；`ambientField` 键量化至 ~30Hz 并复用 `rgb(...)` 字符串；`Engine` 在页面隐藏或暂停态节流至 ~25fps 且暂停时不再无效清画；`getLayerEffects` 缓存 `deep/flat` 列表；`cover` 模糊临时画布默认档上限 `768px`。 |

### Before / After 实测数据对比

| 指标 | denza.6（Before） | denza.7（After） |
| --- | --- | --- |
| 空间左上角启动文案 | `"on.short"`（点击后恢复 `"在线"`） | 首次挂载即 `"在线"`，弹层内 `"关闭"` |
| 经典设置打开耗时 | 前 1–6 帧均未挂载设置标题（白屏延迟） | 第 1 帧即显示 `<h1>设置</h1>` |
| 空间静止空闲渲染频率 | 未限频随屏幕刷新率空转（实测 ~`240 FPS` / `4.17ms`） | 空闲降至 ~`690 clears/s`（~`28.8 FPS`）；操作/播放立即恢复 ~`210 FPS` |
| 经典暂停态无操作背景绘制 | `engine.dirty: true` 持续调度 | 暂停且无需重绘时 `0 fills/s` |
| 聆听室 5.1 声场实测（4 秒四段 WAV） | 原逻辑 `door: true` 延后 `ROOM_IN + 1.5m`，且窄立体声偏中置 | 6 只音箱全 `lit: true`、共用 1 个分路器；`L-only` 段 `L=0.131/0.0918` 远超 `R=0.0173/0.0252`（`R-only` 对称翻转，`Surround` 段 `C=0, LFE=0`、环绕约为前置 2x） |

### 后续接手与上游合并注意点

- **未覆盖范围**：本地未安装 `playwright` 与 `cargo`，原版完整图形端到端测试、Windows 实体音频与真机 GPU 表现、真实账号与线上服务可用性未在本机执行；若后续同步 Cadenza 上游，请注意合并冲突集中点：`base.css` `[role='dialog']:focus-visible`、`Shell.tsx` 非懒加载 `PosterWall`/`SettingsView`、`space/passes.ts`、`space/world.ts` 帧节流与光影参数、`space/plan.ts` 侧房门口判断、`space/systems/audio.ts` 声场矩阵、`engine.ts`/`backdrops.ts`/`ambient.ts`/`cover.ts` 缓存策略。

---

## 本轮接手交接：3.2.9-denza.9（播放页逐字歌词闪烁修复 / TTML-LRC 结束时间与切句与多字同时间戳优化 / 空格保留 / 下载自动清理空行）

- **基线与改动范围**：基于 `custom`（`6814970`，`3.2.9-denza.8`），围绕播放页逐字歌词渲染与在线歌词清洗链路完成改造（运行代码提交 `a7022cb`）。
- **Windows CI 构建**：[工作流 44338734459](https://github.com/ahuai6/Denza-Fork/actions/runs/44338734459)（产物 [14443258095](https://github.com/ahuai6/Denza-Fork/actions/runs/44338734459/artifacts/14443258095)）：43 文件 / 450 项单元测试全绿，安装版 `Cadenza-Setup-3.2.9-denza.9.exe` `455.95 MB`、便携版 `Cadenza-3.2.9-denza.9-portable.exe` `425.09 MB`，`app.asar` `175.19 MB`、`app.asar.unpacked` `430.46 MB`，`packaged-smoke.cjs` 通过（9 models; no account sign-in）。
- **涉及文件与关键符号改动**：
  - `src/app/ui/NpLyrics.module.css`：移除 `.line` 的群组 `opacity: var(--o)` 与 `.line .w` 的 `--un: calc(var(--bu) / var(--o))` 除法，直接用 `rgba(255, 255, 255, var(--o))` / `rgba(255, 255, 255, var(--bu))` 绘制逐字渐变，根除 `data-on="true"` 激活瞬间未唱字闪白至 `1.0` 的问题；将 `.w` 的 `white-space: pre-wrap` 改为 `white-space: break-spaces` 防止 `inline-block` 尾随空格悬挂塌缩。
  - `src/lyrics/np-plan.ts`（新增，经 `src/engine/index.ts` 导出供 `src/app/ui/NpLyrics.tsx` 使用）：实现 `buildNpLinePlans(lines, beatLen)`，统一计算播放页每行激活起点 `start`、实际唱完时间 `sungEnd`、词与字符级显示单元 `units`（保留 `w.disp` 内部空格与词间 `w.gap`，将单时间戳多字符与连续相同时间戳按字符权重顺序拆分为独立子区间，未闭合词平滑延音至下一词或句尾，切句起点 `start >= pHoldEnd` 不再提前截断上一句尾字动画）。
  - `src/lyrics/model.ts`、`src/lyrics/parse.ts`、`src/lyrics/ttml.ts`、`src/lyrics/spacing.ts`：`Unit` 保留 `e?: number`、`Line` 保留 `close?: number`（不改动 2D 导演 `camera.ts` 依赖的 `W.end` 启发值）；`parse.ts` 修复空时间戳带空格 `<mm:ss.xx> ` 与和声右括号后空格丢失 `gap = true` 及 `shiftAll` 未偏移 `u.e` 的问题，并忽略独立 `//` 占位空行；`ttml.ts` 修复纯空白计时 `<span>` 丢失 `gap = true` 并扩展 `PLACEHOLDER` 覆盖 `//`；`spacing.ts` `regroup` 保留单个计时单元内部的空格至 `w.disp` 与 `u.c`。
  - `src/lyrics/translation.ts`、`src/lyrics/download.ts`、`electron/platforms.cjs`、`src/app/views/Effect.tsx`、`src/app/space/SpacePanels.tsx`：`cleanBlankLyricRows` 扩展清理零宽字符与 `//` 占位空行，`platforms.lyrics`、`downloadLyricFormats`、`translationLrc` 与双界面歌词编辑框统一自动剥离空白行。
- **实测对比数据（真实 Electron 渲染探测 + 43 文件 / 450 项单元测试）**：
  - 唱到前一刻（`t = 3.10s`，`L1.t = 3.20s`）：修改前 `.line[data-on='true']` 使整行未唱字闪至 `alpha = 1.0`；修改后未唱字 `--p = 0.000`，渐变为 `rgba(255, 255, 255, 0.325)`（`--bu` 从 `0.31` 平滑过渡至 `0.42`）。
  - 切句前夕（`t = 2.90s`，上一句 `2.95s` 结束，下一句 `3.20s` 开始）：修改前 `starts[1]` 在 `lastW.end <= L.t` 时回退 `L.t - 0.15` 导致紧邻句提前切句并强行置 `--p = 1`；修改后 `t = 2.90s` 时上一句保持 `data-on="true"`、尾字 `--p = 0.947` 自然推进至 `2.95s`。
  - 单时间戳多字符与同时间戳（`<00:03.20>我们的<00:04.40>故<00:04.40>事<00:05.20>`）：5 个字符在 `3.40s..5.00s` 依次推进 `[0.5,0,0,0,0] -> [1,0.5,0,0,0] -> [1,1,0.5,0,0] -> [1,1,1,0.5,0] -> [1,1,1,1,0.5]`。
  - 空格宽度（`"清晨 的 光"`）：DOM 完整输出 `"清晨 的 光"`，带尾随空格的 `'晨 '` 实测宽度 `40.5px`（无空格单字 `'清'` 为 `34.3px`）。

---

## 本轮接手交接：3.2.9-denza.10（全场景逐字多字符顺序点亮统一化 / 播放页与经典 UI 性能优化 / 边界修复）

- **架构统一化（`src/lyrics/model.ts`、`src/lyrics/np-plan.ts`、`src/app/space/bind.ts`）**：
  - 将单时间戳包含多个非拉丁字符（如 `<00:01.00>我们的<00:02.20>`、TTML `<span begin="2.0" end="2.5">清晨</span>`）及连续相同时间戳的单元拆分直接下沉至 `src/lyrics/model.ts`（`buildLyrics`），同时保持拉丁音节（如 `['hel', 'lo']`）原有单元粒度以兼容 `spread` 退场测试。
  - 2D 特效歌词（`src/director/layout.ts` + `src/director/words.ts` `unitPose`）、空间 3D 场景悬浮歌词（`src/app/space/bind.ts` 读取 `buildNpLinePlans` 的 `charTimes` 与 `text` 注入 `AirLine`）及播放页/空间歌词面板（`NpLyrics.tsx`）统一消费同一歌词模型，无需各自维护一套启发式。
- **播放页歌词与经典模式 UI 性能优化（`src/app/ui/NpLyrics.tsx`、`src/app/ui/NpLyrics.module.css`、`src/app/ui/LiveEq.tsx`、`src/app/views/Player.tsx`、`src/app/views/NowPlaying.tsx`、`src/app/views/Shell.tsx`）**：
  - `NpLyrics`：`measure()` 预缓存每行 DOM 引用（零每帧 `querySelectorAll`）；非激活行关闭 `-webkit-background-clip: text` 渐变遮罩与 `text-shadow`；已唱完字符在 `0.22s` 余辉后 `--gl` 归零并锁定常量样式，使每帧仅当前正在演唱的 1–2 个字符写 DOM；`|d| > 10` 的远端离屏行设置 `data-far="true"` 关闭高斯模糊与弹簧逐帧位移。
  - 经典 UI：`LiveEq` 在暂停静止或页面隐藏时自动停用 `rAF` 循环并去重 `scaleY` 写入；`Progress` 对 `--k` 与秒级 `fmtTime` 实施脏检查；`NowPlaying` 与 `PlayerCard` 收敛 `lib` 订阅至 `trackOf(id)`；`Activity` 计数改为 `useMemo`。
- **边界情况修复（`src/lyrics/parse.ts`、`src/lyrics/ttml.ts`、`src/app/ui/NpLyrics.tsx`）**：
  - 修复逐字 LRC 首 `<tag>` 前文本保留、TTML `<p>` 内跨 `<span>` 标点拼接、乱序/递减时间戳单调归一化、向前跳进（Forward Seek）跨行 `data-completed="true"` 补齐及播放页滚轮手动滚动上下界钳制。
