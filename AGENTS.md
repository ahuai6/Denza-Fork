# Denza-Fork 维护约定

这是独立维护的 Cadenza 定制仓库。先阅读 `CLAUDE.md`、`.claude/skills/cadenza/SKILL.md` 和 `docs/DENZA-ARCHITECTURE.md`，遵守现有分层、两种界面共用逻辑及原有歌词保存链路。用户要求使用简体中文回复。

- Cadenza 是主程序上游，仅在用户要求时评估并合并更新，保留定制提交，不重置覆盖。功能修改尽量集中在扩展模块；对音乐库、播放、歌词保存接口的适配集中在接入边界。
- 下载、账号歌单、在线翻译、歌词匹配均由 Denza-Fork 自行开发和维护。Sonora、SyncC、LyricsFlow 参考应用只作为最初的功能/源码参考，不作为后续功能同步或发布依赖，不自动合并它们的提交。同名的公开 HTTP 文件服务作为独立协议依赖维护，区别于参考应用。
- 底层平台 SDK 直接跟踪其各自来源，见 `docs/online-dependencies.json`。每次显式固定版本并审阅锁文件/许可证，通过对应适配器的契约测试；不把 SDK 响应格式或登录细节扩散到界面、下载队列或 Cadenza 核心。
- 平台能力以 `shared/online-providers.json` 为准。新增平台先实现独立适配器和契约用例，再接入统一入口；经典和空间界面共用同一业务逻辑。
- 用户已授权：以后每次完成修改并通过必要检查后，直接合并到 `custom`、构建并发布 GitHub Release，无需再次询问。开发期间可用功能分支/草稿 PR；完成后主动转为可合并并发布。不得覆盖既有 Release 资产或跳过失败检查；仅文档等不影响产物的变更可复用已验证且已合并的相同运行代码构建。
- 不得把未验证的真实账号、Windows 音频或完整图形回归宣称为通过，验证记录见 `docs/DENZA-VALIDATION.md`。
- 空间“在线”入口按用户要求仅显示这两个字，目前独立放在左上角；将来用户要求同步上游左上角控制栏时，把它作为控制项右侧的独立按钮接入，不提前同步上游。位置由 `SpaceShell.module.css` 的 `.onlineControl` 及预留 CSS 变量控制。

- 新增窗口须通过 `actions/dialogs.ts` / `ui/DialogOwner.tsx` 接入原生层级、互斥、输入与草稿恢复逻辑；不得仅以独立 portal 开关叠在原面板上。空间主面板通过 `SpaceShell` 的 `SpaceView` 选择。
- AM 元数据语言按用户要求固定简体中文（`apple-music.cjs` 的 `METADATA_LANGUAGE`），不因界面语言改变，也不因此更换账号 storefront；公开链接和账号歌单使用相同语言策略。
- 若进行性能、架构、内存或安装包体积优化，先阅读 `docs/DENZA-PERFORMANCE-AUDIT.md` 获取基线与优先级清单；如已有前序改造交付，一并阅读 `docs/DENZA-OPTIMIZATION-HANDOFF.md`。每轮优化完成并验证后，必须新增或更新 `docs/DENZA-OPTIMIZATION-HANDOFF.md` 记录详细改动、数据结构变更、实测对比数据、真实检查范围与后续接手注意项。
