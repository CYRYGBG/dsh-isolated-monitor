# 测试报告

测试时间：2026-11-13
环境：Windows / Node.js v24.15.0 / DSH 0.2.2-rc.1（Desktop profile `desktop`）
原则：不启动真实 GPU 训练，不修改 DSH 环境；单元/集成测试使用 Mock Session 与临时数据目录，另做一次真实 DSH 在线端到端验证。

## 1. 测试命令

```bash
cd dsh-isolated-monitor
node --test test/*.test.mjs
```

最近一次结果：

```text
ℹ tests 37
ℹ pass 37
ℹ fail 0
ℹ duration_ms ≈ 2000ms
```

| 测试文件 | 覆盖 | 数量 |
|---|---|---|
| `test/acceptance.test.mjs` | 验收场景 1–7、确定性检查、重试、管理工具、输入校验、源会话归档 | 15 |
| `test/classify.test.mjs` | JSON 契约解析、findings 归一化、判定优先级 | 9 |
| `test/timing.test.mjs` | once/after/every/daily/weekly/cron/rrule、时区、DST、错过合并 | 8 |
| `test/store.test.mjs` | 原子持久化、损坏回退、重启恢复、定时触发、一次性任务、证据清理 | 5 |

## 2. 测试 1：正常监控

**步骤**：主对话 A（fake `session-A`）创建任务 → 触发一次 → 检查 A/B/Session 列表/归档/history。

**实测断言（全部通过）**：

- 新建 Session B，`session_id != session-A`；
- B 的 `header.parentSession === undefined`，日志第一条为本插件 marker，**没有**来自 A 的任何事件；
- B 的 cwd = 任务 `project_path`；
- 运行状态 `normal`，`session_archived === true`；
- B 已从 live agent 注册表移除（Agent 已结束）；
- B 在 Workspace archive set 中 → 活动侧边栏不再显示；
- A 的 transcript 长度不变，`source.kind === 'isolated-monitor'` 的消息数为 0；
- `state.runs[0]` 保留状态/耗时/usage=120/证据文件路径；
- `monitor_view` 能按 `session_id` 找到这次运行；
- `unarchiveSession(B)` 后 B 回到可见状态（归档可恢复）。

## 3. 测试 2：异常监控

**步骤**：行为模拟 CUDA OOM finding → 触发一次。

**实测断言（全部通过）**：

- 状态 `alert`，B **不在** archive set 中；
- B 被 dispose，但 Session 持久化保留；日志含 assistant 消息与 `plugin:isolated-monitor/run` 记录；
- A 收到 1 条消息，文本包含：任务名、任务 ID、B 的 Session ID、`cuda_oom`、`critical`、`CUDA OOM`、`torch.OutOfMemoryError`、`logs/train.log:42`、项目绝对路径、"建议排查方向"；
- delivery 状态 `delivered`，含 `message_id` 与稳定 `dedupeKey`；
- `source.kind === 'isolated-monitor'`，携带 task/event/delivery/dedupe 元数据。

## 4. 测试 3：执行失败

分别验证：

| 场景 | 结果 | code |
|---|---|---|
| `agents.create` 抛错 | MONITOR_ERROR + 通知 | `session_create_failed` |
| Agent 挂起直到超时 | MONITOR_ERROR + 通知（< 3s 内结束） | `timeout` |
| Agent 内 `agent/error` + turn/end error | MONITOR_ERROR | `turn_error` / `agent_error` |
| 最后一轮没有 `turn/end` | MONITOR_ERROR | `no_turn_end` |
| 最终回复没有 JSON 契约 | MONITOR_ERROR | `result_missing` |
| JSON 非法 | MONITOR_ERROR | `result_invalid` |
| JSON status 非法 | MONITOR_ERROR | `result_invalid` |
| 模型声明 inconclusive | MONITOR_ERROR | `inconclusive` |
| `alert` 但 findings 为空 | MONITOR_ERROR | `result_inconsistent` |
| token 预算超限 | MONITOR_ERROR | `budget_exceeded` |

共同断言：**没有任何一种失败被判为 normal**；A 均收到"监控未完成"通知；对应 B 不归档（保留证据）。

## 5. 测试 4：异常通知失败

**场景 A：目标会话暂时不可达**

- 模拟 `sessionController.resolveAgent` 返回 `session/not-found`；
- delivery 保持 `pending`，`last_error` 含 "cannot activate"；A 无消息；
- 归档 B 后 pending 仍然存在；
- 恢复目标后 `alerts.retry(deliveryId)` → `delivered`，A 收到消息，`message_id` 落库。

**场景 B：Session flush 未确认**

- `sessions.flush` 返回 false；
- 监控运行判 `MONITOR_ERROR(prompt_flush_failed)`；
- 告警 delivery 保持 pending，`last_error` 含 "did not acknowledge"；
- flush 恢复后重试 → delivered。

## 6. 测试 5：异常去重

- 同一 finding（`type=cuda_oom, key=train-1`）连续 3 次：
  - A 只收到 **1** 条通知；
  - 事件 `occurrence_count = 3`，`notify_count = 1`，`last_seen_at` 更新；
- 新增不同异常（`missing_file, key=disk-1`）：
  - A 收到第 2 条通知，产生第 2 个 open 事件；
- 同一对象严重度从 `high → critical`：
  - A 收到第 3 条通知，事件 `notify_count = 2`、`severity = critical`；
- 一次完全干净（`ok`、无 findings）的运行：
  - 所有 open 事件 → `resolved`，默认不发恢复通知；
- 开启 `notify_on_recovery: true` 后再恢复：
  - 多发 1 条"隔离监控恢复通知"。

## 7. 测试 6：长期运行 / 重启

- 第一次运行后把 `state.json` 损坏：
  - 新实例自动从 `state.json.bak` 恢复，任务与运行历史存在，损坏文件被隔离，日志有提示；
- 构造一个 `running` 的运行记录（模拟进程被杀）：
  - 加载时规范化为 `monitor_error / interrupted`；
  - `recoverInterrupted()` 只通知一次，并写 `recovery_handled=true`；
  - 第二次恢复不再重复通知；
- 重启后：
  - 任务配置、`next_run_at`、运行历史、pending delivery 全部恢复；
  - 调度器触发时 `runs` 数量不增加（不会重复执行已完成 occurrence）；
  - 重启后的 pending 可重投成功；
- 一次性任务（`after`）运行后 `status=ended`、`next_run_at=null`。

## 8. 测试 7：会话隔离

连续 3 次运行同一任务：

- 产生 **3 个不同的 Session ID**；
- 每个 Session `header.parentSession === undefined`，没有 A 的历史事件；
- 每个 Session 的第一条插件 marker 携带各自的 `run_id`；
- 3 次运行都挂载了任务记录的 Agent preset（含 `agent-instructions`，因此项目 `AGENTS.md` 会被加载），cwd 均为项目目录；
- 每次提示词都包含项目路径与 "AGENTS.md" 说明；
- 每次运行 usage 独立（各 120），任务累计 360；三次运行互不共享对话上下文。

## 9. 额外覆盖

- **确定性检查**：
  - 命令检查通过 → `hybrid` 跳过模型、usage=0、Session 仍创建并归档；
  - 命令检查失败 → 升级到 Agent 调查，检查结果进入 finding 与告警；
  - 文件存在/文件内容检查通过 → normal。
- **重试**：第一次瞬时错误、第二次成功 → 2 条运行记录；第一次会话被归档；最终 normal；**不告警**。
- **管理工具**：list / view / pause / resume / update（改名、cron、severity）/ run_now / delete；删除后运行历史保留。
- **输入校验**：缺 prompt、`every_seconds<60`、相对路径、非法时间 → 拒绝创建，状态不变。
- **源会话归档**：运行前发现 A 已归档 → 任务暂停、不创建会话、不运行。
- **调度器**：due 任务只触发一次；触发后 occurrence 推进到未来；正常运行不打扰 A。

## 10. 真实 DSH 在线端到端验证（非 Mock）

在正在运行的 Desktop profile（`http://127.0.0.1:14014`）中安装插件并真实执行：

### 10.1 安装与挂载

`plugin_manager install_bundle` 链接本地目录成功；`mount.json`：

```json
{
  "plugin": "dsh-isolated-monitor",
  "mountedAt": "2026-11-13T10:42:25.927Z",
  "dataDir": "C:\\Users\\cyr\\.dsh\\isolated-monitor",
  "timeZone": "Asia/Shanghai",
  "tools": ["monitor_create", "monitor_list", "monitor_view", "monitor_manage"],
  "tasks": 0
}
```

### 10.2 正常任务（确定性检查，0 token）

| 项 | 值 |
|---|---|
| 任务 | `mon-36f7128c` 开发自检：插件文件存在 |
| 模式 | `hybrid`，`file_exists` 检查 |
| 触发 | 2026-11-13T10:43:36Z（定时器） |
| 结果 | `normal` |
| 耗时 | 24 ms |
| Token | **0**（未调用模型） |
| 监控会话 | `session-50170d38-9486-4d4d-b617-280e6d12a3bf` |
| 归档 | **是**（`Workspace registry` archive set 中包含该 ID） |
| 主对话消息 | **0** |

### 10.3 异常任务（真实模型调用）

| 项 | 值 |
|---|---|
| 任务 | `mon-b6f79548` 开发自检：缺失文件告警 |
| 模式 | `agent`（真实 LLM） |
| 触发 | 2026-11-13T10:44:17Z |
| 结果 | `alert`（`missing_file / high`） |
| 耗时 | 11,559 ms |
| Token | 15,369 |
| 监控会话 | `session-b4450cbd-9fee-4726-8e2d-cef461e10123` |
| 归档 | **否**（保留在活动会话列表） |
| 主对话投递 | `del-c2f27d9d86717200` → `delivered`，目标 `session-67184a20-2957-4b3e-a5cf-537d755eb08e` |

模型实际执行了 `Test-Path`、`Get-Item`、`glob *.txt` 等只读检查，证据被写入告警：

```text
以 Test-Path -LiteralPath 检查绝对路径 ...\DEFINITELY_MISSING.txt，返回 TargetExists: False；
Get-Item 返回错误“找不到路径…因为该路径不存在”。根目录本身存在（RootExists: True），
其中仅含 cordis.patch.yml、package.json 两个文件及 docs/、scripts/、src/、test/ 四个目录，
根目录 *.txt 文件数为 0。glob 以 *.txt 在项目根搜索同样返回 No files found。
```

监控会话的持久化投影确认只读加固实际生效：

```json
"permissions": {
  "val": { "preset": null, "sandbox": "read-only", "approval": "never", "seeded": false }
}
```

### 10.4 归档可见性验证

`~/.dsh/storages/workspace.json` 的 `archivedSessionIds`：

```text
session-a1a28533-...
session-68fcd777-...
session-609b4b90-...
session-50170d38-9486-4d4d-b617-280e6d12a3bf   ← 正常监控会话（已隐藏）
```

异常会话 `session-b4450cbd-...` **不在**其中 → 仍在侧边栏可见。

### 10.5 主对话 inbox 验证

A 的 projection cache 中可看到待处理 inbox 消息：

```json
"source": {
  "kind": "isolated-monitor",
  "taskId": "mon-b6f79548",
  "alertEventId": "alert-39dd6a1d-2",
  "deliveryId": "del-c2f27d9d86717200",
  "dedupeKey": "im:mon-b6f79548:alert-39dd6a1d-2:alert:1"
}
```

消息正文即 10.3 的结构化告警（含 Session ID `session-b4450cbd-...`）。

### 10.6 插件显示元数据（图标 / 本地化标题）

DSH 的 `readPluginMeta`（`@deepseek-ai/dsh-app-boot`）从包内 `locale/*.json` 与 `icon` 字段读取插件卡片信息。用真实 DSH 实现验证本包：

```json
{
  "title": { "en": "Isolated Monitor", "zh": "独立会话监控" },
  "description": {
    "en": "Scheduled monitors in a fresh isolated Session per run: archive when normal, alert the creator conversation only on anomalies.",
    "zh": "每次巡检新建独立会话：正常自动归档，只有异常才回传原始主对话。"
  },
  "icon": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0i…"
}
```

图标被内联为 data URL（约 1.1KB，远低于 DSH 的 256 KiB 上限），中英文标题/描述均来自 `locale/en.json`、`locale/zh.json`，`exports` 的 `./locale/*.json` 可被解析。

### 10.7 清理

两个自检任务验证后已置为 `paused`（`next_run_at=null`），避免继续消耗 token；运行历史、告警事件、监控会话全部保留，可用 `/monitor` 查看。

## 11. 未覆盖/未验证

- 真实 GPU 训练进程的异常检测（按要求未启动训练）；用模型 finding 与确定性检查模拟。
- cron/RRULE 的真实边界值在单元测试中用可预测的替身验证"是否调用官方解析器 + 是否推进 occurrence"；官方 `Cron/RRule` 自身由 DSH 测试覆盖。
- 通知在 GUI 中的最终渲染样式（依赖 DSH 对 `source.kind='isolated-monitor'` 的通用用户消息渲染）。
- 多进程并发写同一 `state.json`（插件设计为单 Host 进程；原子写 + 备份已覆盖崩溃场景）。

## 12. 结论

- 37/37 自动化测试通过；
- 真实 DSH 环境中完成"正常 0 token 归档、异常保留并回传、归档集合正确、inbox 可验证"；
- 所有失败分支均不会误判为正常；
- 已知限制见 README「已知限制」。

## 13. npm 0.1.0 发布验收（2026-11-13）

- npm 正式版本：0.1.0，发布时间 2026-11-13T13:18:59.712Z（北京时间 21:18:59），索引 Unix 秒 1794547139。
- registry tarball SHA-512 与 dist.integrity 一致，27 文件，无 test/market/scripts，engines.dsh 为 >=0.2.2-rc.1 <0.3.0。
- Node 24.15.0 与 Node 22.23.5 均 37/37；strict 检查通过。索引通过安装内官方 parseMarketIndex，远端 HTTPS 直链返回 200。
- 干净环境 A：临时 DSH_HOME `dsh-publish-validation-20261113`，实际在 UI 输入包名，选择 npm 官方源安装 0.1.0 并启用；mount.json 四工具、0 任务，UI 可见 /monitor 候选。
- 干净环境 B：临时 DSH_HOME `dsh-publish-discover-20261113`，添加真实 raw 索引，isolated/monitor/监控均匹配；从发现页安装指定 0.1.0 并启用，mount.json 四工具、0 任务。
- B 初次直连读取索引失败，使用本机现有 127.0.0.1:7897 代理，仅对临时进程设置 HTTP(S)_PROXY 与 NODE_USE_ENV_PROXY=1 后成功；未改变系统网络设置或 desktop profile。

根据用户追加指示“直接在我本地 dsh 验收”，任务运行链路改在已登录的 desktop DSH 验证，没有复制凭据到临时环境。新建验收会话 `session-b6241842-7a93-4f2f-873e-07d1ff1bc566`。

| 场景 | 任务 | 运行 | 结果 |
|---|---|---|---|
| README file_exists / hybrid | mon-5afc307f | run-mwf0r88n-c1sqdid3 | normal，session_archived=true，未调用模型 |
| 模拟异常 / agent | mon-3f0c84d9 | run-mwf0r892-i2eq7k63 | alert，session_archived=false，回传 delivered |

正常 Session：session-e9e5a3cd-8b09-4616-8e6d-0c13ef4b278b。异常 Session：session-5a76e9d2-6abe-4cb1-9ba2-6377f52c384f。
投递 del-0753006fb2a2c1cc，delivered_at=2026-11-13T13:35:22.037Z；消息 84afb381-ab63-4f2a-9605-9887f92c2796，pending_alerts=0。本地 UI 可见模拟异常消息。

验收指令误用了 info 严重级别，插件契约实际为 low/medium/high/critical，结果归一化为 low；这是验收输入偏差，未修改业务源码。告警明确标记“npm 发布验收模拟异常，无真实故障”。两个新增任务最终 paused，原有 mon-36f7128c、mon-b6f79548 仍 paused 且各保留原先一次运行。所有任务和历史均保留。

npm 网页已显示 Successfully added new Trusted Publisher connection；绑定 CYRYGBG/dsh-isolated-monitor、publish.yml、允许 npm publish。工作流已移除 NPM_TOKEN、使用 Node 24/npm 11.12.1，并检查 tag 与包版本一致。0.1.0 由本地浏览器 Security Key 验证发布，本次未通过 OIDC 重复发布同版本。新连接须在 npm 要求的 2 天内完成首次成功发布；下一次发版前需核对连接是否过期，过期则由账户本人重新创建。当前不能将“保存绑定”声称为“O​​IDC 实际发布已验证”。

首发中 npm 曾返回成功但仅公开 0.0.0-stage 占位版本；约 5 分钟后正式 0.1.0 才公开。当时账户 Staged Packages 为空，未再次提交、未人工审批、未删除占位版本。最终 latest=0.1.0。