# Changelog

## Unreleased

- 后续发布使用 GitHub Actions OIDC，移除 NPM_TOKEN 依赖，并检查 tag 与版本一致。
- 发布文档补充浏览器 Security Key 验证、占位版本状态核对与撤销边界。

## 0.1.0 — 2026-11-13

首个可用版本。

### 核心能力

- 每次运行创建全新 Root Session（`ctx.agents.create`，无 seed / 无 parent / 无历史继承）。
- 只读加固三层：`sandbox/mode=read-only`、`approval/policy=never`、`tools.restrict` allowlist + 收窄后自检。
- 结果判定：`NORMAL` / `ALERT` / `MONITOR_ERROR`，未完成或不可解析永不判正常。
- 正常运行自动 `archiveSession`，异常会话保留；归档可 `unarchive` 恢复。
- 异常回传原始 `source_session_id`：`resolveAgent` + `followup` + `sessions.flush`。
- 异常事件去重（task + type + object key），支持持续计数、严重度升级、可选恢复通知。
- 通知持久化待投递、指数退避、幂等去重、重启不丢；`retry_alerts` / `retry_delivery` 手动重投。
- 调度：once / after / every / daily / weekly / cron / rrule；时区；错过合并；重启恢复；防并发；超时；瞬时错误重试。
- 确定性预检（command / file_exists / file_match），`hybrid` 模式下通过即 0 token。
- token 预算、单模型覆盖、每次运行独立 usage 统计。
- 4 个管理工具 + `/monitor` 命令。
- 归档准入：创建者会话归档时报告/暂停其监控任务，避免无人接收的运行。
- 独立数据目录、原子写、备份恢复、损坏隔离、证据文件。

### 实机验证

- DSH 0.2.2-rc.1 / Windows / Node 24：正常任务 0 token 归档且主对话零消息；异常任务真实调用模型并成功回传；归档集合与 inbox 均验证通过。
