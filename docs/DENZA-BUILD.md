# Windows 构建

功能已合并到 `custom`。独立工作流 `.github/workflows/denza-build.yml` 可通过 Actions 的 **Denza Windows build → Run workflow → custom** 手动执行；修改此工作流并合并到 `custom` 时也会运行。它不触发 Cadenza 上游发布规则或创建 Release。

工作流执行依赖安装、类型/单元检查、应用与校验过的节奏模型资源准备、Windows 原生音频构建、安装版/免安装版打包，再从打包后的 Electron 可执行程序检查 SDK 与 Codex 文本运行时。该检查不进行账号登录或实际翻译。

成功后在运行页面下载 `Denza-Fork-Windows-x64` Artifact，包含 `Cadenza-Setup-3.2.9-denza.1.exe`、`Cadenza-3.2.9-denza.1-portable.exe` 和 `SHA256SUMS.txt`（文件名随 package.json 版本变化）。应用原名称保留为 Cadenza，版本中的 `denza` 标识 Fork 版本。Artifact 保留 30 天，通常需登录 GitHub 下载；过期后可重新执行构建。

打包检查通过不代表真人账号、服务音频下载、WASAPI 硬件或完整图形回归已通过，详细范围见 `DENZA-VALIDATION.md`。

## 默认发布约定

用户已授权后续修改通过必要检查后直接合并、构建并发布 Release，无需逐次确认。发布流程使用 `.github/workflows/denza-publish.yml`，在 `custom` 上运行，校验成功的 Windows 构建、版本号、空草稿 Release、构建提交已合并以及运行/构建输入一致，再验证 SHA256 并上传、公开 Release。仅文档、维护约定或发布协调流程变化可复用原构建；应用、依赖、测试或构建输入变化必须重新构建。原生构建工作流本身仍不自动创建 Release，由开发流程完成发布协调。
