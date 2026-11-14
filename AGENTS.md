# Denza-Fork 维护约定

这是独立维护的 Cadenza 定制仓库。先阅读 `CLAUDE.md`、`.claude/skills/cadenza/SKILL.md` 和 `docs/DENZA-ARCHITECTURE.md`，遵守现有分层、两种界面共用逻辑及原有歌词保存链路。用户要求使用简体中文回复。

- Cadenza 是主程序上游，仅在用户要求时评估并合并更新，保留定制提交，不重置覆盖。功能修改尽量集中在扩展模块；对音乐库、播放、歌词保存接口的适配集中在接入边界。
- 下载、账号歌单、在线翻译、歌词匹配均由 Denza-Fork 自行开发和维护。Sonora、SyncC、LyricsFlow 参考应用只作为最初的功能/源码参考，不作为后续功能同步或发布依赖，不自动合并它们的提交。同名的公开 HTTP 文件服务作为独立协议依赖维护，区别于参考应用。
- 底层平台 SDK 直接跟踪其各自来源，见 `docs/online-dependencies.json`。每次显式固定版本并审阅锁文件/许可证，通过对应适配器的契约测试；不把 SDK 响应格式或登录细节扩散到界面、下载队列或 Cadenza 核心。
- 平台能力以 `shared/online-providers.json` 为准。新增平台先实现独立适配器和契约用例，再接入统一入口；经典和空间界面共用同一业务逻辑。
- 未发布的功能继续在功能分支和草稿 PR 上迭代。不得把未验证的真实账号、Windows 音频或完整图形回归宣称为通过，验证记录见 `docs/DENZA-VALIDATION.md`。
