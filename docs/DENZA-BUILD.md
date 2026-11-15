# Windows 构建

功能已合并到 `custom`。独立工作流 `.github/workflows/denza-build.yml` 可通过 Actions 的 **Denza Windows build → Run workflow → custom** 手动执行；修改此工作流并合并到 `custom` 时也会运行。它不触发 Cadenza 上游发布规则或创建 Release。

工作流执行依赖安装、类型/单元检查、应用与校验过的节奏模型资源准备、Windows 原生音频构建、安装版/免安装版打包，再从打包后的 Electron 可执行程序检查 SDK 与 Codex 文本运行时。该检查不进行账号登录或实际翻译。

成功后在运行页面下载 `Denza-Fork-Windows-x64` Artifact，包含 `Cadenza-Setup-3.2.9-denza.1.exe`、`Cadenza-3.2.9-denza.1-portable.exe` 和 `SHA256SUMS.txt`（文件名随 package.json 版本变化）。应用原名称保留为 Cadenza，版本中的 `denza` 标识 Fork 版本。Artifact 保留 30 天，通常需登录 GitHub 下载；过期后可重新执行构建。

打包检查通过不代表真人账号、服务音频下载、WASAPI 硬件或完整图形回归已通过，详细范围见 `DENZA-VALIDATION.md`。
