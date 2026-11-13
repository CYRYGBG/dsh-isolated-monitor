# dsh-isolated-monitor

DeepSeek Harness 的**独立会话定时监控**插件：每次巡检都在一个全新的 Root Session 中执行；一切正常时该会话自动归档、主对话完全无打扰；只有发现异常或监控本身失败时，才把结构化报告发回**创建任务的原始主对话**。

> 一个插件完成调度、独立会话、只读加固、结果判定、归档、异常去重、可靠回传、重启恢复与历史管理，不需要再安装其它插件，也不修改 DSH 核心源码。

- 适用 DSH：`>=0.2.2-rc.1 <0.3.0`（本机实测 `0.2.2-rc.1`）
- Node.js：`>=22.18`
- 形态：纯宿主侧 Cordis 插件（无客户端构建、无额外 UI 注入）
- 数据目录：`$DSH_HOME/isolated-monitor/`（默认 `~/.dsh/isolated-monitor/`）

---

## 目录

- [它解决什么问题](#它解决什么问题)
- [安装](#安装)
- [发布给其他人安装](#发布给其他人安装npm--插件索引--github)
- [配置](#配置)
- [创建监控任务](#创建监控任务)
- [管理任务](#管理任务)
- [一次运行发生了什么](#一次运行发生了什么)
- [告警、去重与恢复](#告警去重与恢复)
- [只读与安全边界](#只读与安全边界)
- [数据与持久化](#数据与持久化)
- [升级 / 卸载 / 迁移](#升级--卸载--迁移)
- [已知限制](#已知限制)
- [故障排查](#故障排查)

---

## 它解决什么问题

普通的"定时任务"通常把新指令投递回原对话，于是：

- 每次正常巡检都会污染主开发对话；
- 主对话历史越来越长，token 成本上升；
- 监控会话与主对话混在一起，难以区分"哪次是巡检、哪次是人"；
- 异常通知没有去重，同一个训练中断每 30 分钟刷一次屏；
- 通知失败就静默丢失。

dsh-isolated-monitor 的行为：

| 场景 | 行为 |
|---|---|
| 巡检正常 | 新建独立 Session B → B 执行 → B 自动归档（侧边栏默认隐藏）→ 主对话 A **零消息** |
| 巡检异常 | 新建独立 Session B → B 执行 → 保留 B（侧边栏可见）→ 向 A 发送一条结构化告警（含 Session ID、证据、位置、建议） |
| 监控失败（超时/崩溃/结果不可解析/权限不足…） | 判为 `MONITOR_ERROR` → 向 A 发送"监控未完成"通知，绝不误判为正常 |
| 重复异常 | 同一任务 + 同一异常类型 + 同一异常对象 → 只通知一次，后续更新持续时长/证据 |
| 通知投递失败 | 进入持久化待投递队列，按退避重试；确认投递前不标记完成；重启不丢 |

---

## 安装

### 方式 A：通过插件管理器 / `plugin_manager` 工具（推荐）

1. 确保插件目录在本机（本仓库根目录）。
2. 在 DSH 中安装本地 bundle：

```text
plugin_manager install_bundle target = <插件目录绝对路径>
```

或使用命令行：

```bash
dsh plugin --profile desktop add <插件目录绝对路径>
```

插件声明了 `dsh.bundle.patch`，安装后会自动把 `isolated-monitor` 这一行加入 profile 层栈：

```yaml
# cordis.patch.yml（插件自带，安装后生效）
- insert:
    - id: isolated-monitor
      name: dsh-isolated-monitor
```

3. 若当前 DSH 没有开启配置热重载，重启一次 DSH；开启时安装完成即生效。

### 方式 B：手工链接（开发调试）

```bash
cd ~/.dsh/profiles/desktop
pnpm add link:<插件目录绝对路径>
```

然后在 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 末尾加入 `dsh-isolated-monitor`。

### 安装验证

1. 查看 `$DSH_HOME/isolated-monitor/mount.json`：

```json
{
  "plugin": "dsh-isolated-monitor",
  "mountedAt": "2026-11-13T10:42:25.927Z",
  "dataDir": "C:\\Users\\<you>\\.dsh\\isolated-monitor",
  "timeZone": "Asia/Shanghai",
  "tools": ["monitor_create", "monitor_list", "monitor_view", "monitor_manage"],
  "tasks": 0
}
```

2. 在任意主对话里说"列出监控任务"，模型应调用 `monitor_list`；或输入 `/monitor`。
3. 在 **Plugins** 页面应能看到 `dsh-isolated-monitor` bundle 已启用。

### 发布给其他人安装（npm / 插件索引 / GitHub）

- **精确名字安装**：发布到 npm 后，用户在 **插件 → 添加插件** 输入 `dsh-isolated-monitor` 即可。
  注意该输入框是 **安装标识输入框，不是搜索框**。
- **在“发现”里搜名字**：DSH 0.2.2-rc.1 **没有官方公共索引**；需要发布一个 `market/index.json`（format 1），
  用户在 **插件 → 实验性插件 → 自定义插件索引** 中添加该索引 URL，之后即可在 **发现** 里搜索、分类、安装。
- **不想发 npm**：可以把仓库地址或 `.tgz` 路径直接贴进“添加插件”，或用 Git 源生成索引。

本仓库已准备好：

```text
market/index.json              # 已通过 DSH 官方 parseMarketIndex 校验
market/icon.svg
scripts/make-market-index.mjs  # 发版后重新生成索引
scripts/check-publish-ready.mjs# 发布前检查（测试/图标/包体/索引）
.github/workflows/publish.yml  # 打 v* tag 时自动 npm publish（provenance）
```

完整流程（npm 登录、镜像、GitHub raw/Pages 托管、scoped 包、撤销、CI）见
[docs/PUBLISH.md](docs/PUBLISH.md)。

---

## 配置

配置是 Cordis 插件配置，写在 profile 的 `cordis.patch.yml` 中（按行 id 覆盖），全部字段可选：

```yaml
- id: isolated-monitor
  config:
    timeZone: Asia/Shanghai          # 墙钟调度的默认时区；空 = 宿主时区
    defaultTimeoutSeconds: 900       # 单次运行默认超时
    defaultRetryMaxAttempts: 1       # 默认重试次数（0 = 不重试）
    defaultRetryBaseSeconds: 60      # 重试退避基数
    maxConcurrentRuns: 2             # 同时执行的监控运行数
    historyLimit: 200                # 每个任务保留的运行记录数
    runArtifactRetentionDays: 30     # 每次运行的证据文件保留天数
    alertTextMaxChars: 6000          # 单条告警最大字符数
    maxRunPromptChars: 60000         # 监控提示词最大字符数
    enableCommand: true              # 注册 /monitor 命令
    allowUnenforcedReadOnly: false   # 只读无法强制执行时是否放行（不建议）
    defaultAgentPreset: ''           # 监控会话使用的 Agent preset；空 = 宿主默认
    pollingMaxSeconds: 60            # 调度器单次最长睡眠
    notifyRetryMaxAttempts: 0        # 通知重投次数；0 = 一直重试直到成功
    notifyRetryBaseSeconds: 60       # 通知重投退避基数
    maxAlertsPerDay: 100             # 每任务每日新建通知上限（超出会延后，不丢弃）
    dataDir: ''                      # 自定义数据目录；空 = <DSH_HOME>/isolated-monitor
```

> 本机 profile 的 `cordis.patch.yml` 里已有 `permission`、`llm-pi-ai` 等配置；新增上面的 `isolated-monitor` 行不会影响它们。

---

## 创建监控任务

### 自然语言（模型自动调用 `monitor_create`）

> 每隔 30 分钟检查一次当前项目的训练进程和日志，出现训练中断、CUDA OOM 就通知我。

模型会调用 `monitor_create`，关键参数：

| 参数 | 说明 |
|---|---|
| `name` | 任务名（≤120 字符） |
| `task_prompt` | 每次运行给监控 Agent 的检查说明；与 `checks` 至少给一个 |
| `schedule` | `{kind: once/after/every/daily/weekly/cron/rrule, ...}` |
| `project_path` | 监控项目绝对路径；默认当前会话工作目录 |
| `checks` | 可选确定性预检（不消耗 token），见下 |
| `execution_mode` | `agent`（总是跑模型）或 `hybrid`（先跑确定性检查，通过则跳过模型） |
| `timeout_seconds` | 单次运行超时，默认 900 |
| `retry_policy` | `{max_attempts, backoff_seconds}`，仅对瞬时错误重试 |
| `alert_rules` | 异常判定规则（字符串数组），写进监控提示词 |
| `severity` | 默认异常等级 `low/medium/high/critical` |
| `model` | `{provider, model, reasoning_effort?, max_tokens?}`，覆盖宿主默认模型 |
| `agent_preset` | 监控会话使用的 preset，默认宿主默认 preset |
| `allowed_operations` | `{write:false, extra_tools, allow_network, commands, notes}` |
| `notify_on_recovery` | 异常恢复时是否发恢复通知，默认 `false` |
| `max_tokens_per_run` | 单次运行 token 预算，超出会中止并判 `MONITOR_ERROR` |

`source_session_id` **不需要也不能由模型传入**：插件从 `exec.agent.session.id` 读取调用者真实 Session ID（并校验它是运行时根 Agent），保证异常一定回到创建任务的原始对话。

### 调度写法

| kind | 字段 | 示例 |
|---|---|---|
| `once` | `at` | `{kind: "once", at: "2026-11-14T09:00:00+08:00"}` |
| `after` | `after_seconds` | `{kind: "after", after_seconds: 300}` |
| `every` | `every_seconds`（≥60） | `{kind: "every", every_seconds: 1800}` |
| `daily` | `time`, `time_zone` | `{kind: "daily", time: "09:00", time_zone: "Asia/Shanghai"}` |
| `weekly` | `time`, `weekday`(1=周一), `time_zone` | `{kind: "weekly", time: "18:00", weekday: 5, time_zone: "Asia/Shanghai"}` |
| `cron` | `expression`, `time_zone` | `{kind: "cron", expression: "*/30 * * * *", time_zone: "Asia/Shanghai"}` |
| `rrule` | `rrule` | `{kind: "rrule", rrule: "DTSTART;TZID=Asia/Shanghai:20261114T090000\nRRULE:FREQ=DAILY;COUNT=30"}` |

cron / rrule 的解析与 occurrence 计算直接复用官方 `@deepseek-ai/dsh-util-time`。

### 零 token 的确定性检查（`checks`）

`execution_mode: "hybrid"` 时会先执行 `checks`；全部通过且 `skip_agent_on_pass` 为 true（默认）时**不调用模型**，直接建会话→记录→归档。

```jsonc
{
  "id": "train-process",
  "kind": "command",
  "title": "训练进程存活",
  "command": "Get-Process python -ErrorAction SilentlyContinue | Select-Object -First 1",
  "shell": "pwsh",
  "expect_exit_code": 0,
  "stdout_includes": "python",
  "severity": "critical",
  "finding_type": "process_exit"
}
```

`kind`：

- `command`：通过 **Agent 自己的工具管线**（`ctx.tools.execute`）调用 `pwsh`/`bash`，因此沙箱、审批策略、日志与取消全部生效；可配 `expect_exit_code/stdout_includes/stdout_excludes/stdout_matches/expect_failure/timeout_ms`。
- `file_exists`：`{path, exists, min_bytes}`。
- `file_match`：`{path, pattern, must_match}`。

任何失败都会变成 finding（`object_key = check:<id>`）并触发告警；无法执行（权限/文件读不了）会判为 `MONITOR_ERROR`，不会当作通过。

---

## 管理任务

### 工具

| 工具 | 用途 |
|---|---|
| `monitor_create` | 创建任务 |
| `monitor_list` | 列出任务（状态、下次运行、最近结果、token、未恢复异常、待投递） |
| `monitor_view` | 查看单个任务：配置、运行历史、异常事件、待投递、证据 |
| `monitor_manage` | `update` / `pause` / `resume` / `delete` / `run_now` / `retry_alerts` / `retry_delivery` / `unarchive_session` / `archive_session` |

`delete` 是软删除：任务不再调度，运行历史、告警事件、会话全部保留；不会删除任何 Session。

### `/monitor` 命令

```text
/monitor                     列出任务
/monitor <task-id>           查看任务详情
/monitor run <task-id>       立即执行一次（新会话，异步）
/monitor pause <task-id>     暂停
/monitor resume <task-id>    恢复
/monitor delete <task-id>    删除配置（历史保留）
/monitor alerts              查看未恢复异常
/monitor retry <task-id>     重投失败通知
```

命令直接返回文本，不进入模型上下文、不消耗 token。

---

## 一次运行发生了什么

```text
Scheduler tick
  └─ runner.execute(task)                         ← occurrence 先持久化（防重复）
       ├─ 检查 source_session_id 是否已归档        → 是：暂停任务，不运行
       ├─ 创建全新 Root Session B（agents.create）  ← 无 seed、无 parent、无历史
       ├─ 只读加固（sandbox + approval + 工具 allowlist + 危险工具自检）
       ├─ [checks] 确定性预检（0 token）
       ├─ [hybrid 且全部通过] 直接判定 normal
       └─ [否则] 注入监控提示词 → whenIdle → flush → 读事件日志
            ├─ turn/end.reason.kind === completed 且 JSON 契约有效
            │    ├─ findings 为空 → NORMAL
            │    └─ findings 非空 → ALERT
            └─ 其它 → MONITOR_ERROR（超时/错误/中止/无法解析/预算超限）
  ├─ NORMAL：写运行记录 → dispose Agent → archiveSession(B) → 不通知
  ├─ ALERT ：写运行记录 → dispose Agent → 保留 B → 去重 → 投递给 A
  └─ ERROR ：同 ALERT，但报告"监控未完成"，不据此判断正常
```

**监控提示词**（每次运行单独构造，不含任何历史对话）：

- 任务说明 + 异常规则 + 允许的操作；
- 结构化历史：上次运行时间/结果/摘要、当前未恢复异常的 key 与出现次数；
- 可选：确定性检查的输出；
- **强制 JSON 输出契约**（`status: ok|alert|inconclusive` + findings 证据字段）。

Agent 若忘记 JSON 契约，插件会用一次"补格式"追问（不重新检查），仍失败才判 `MONITOR_ERROR`。

---

## 告警、去重与恢复

- 事件标识：`type + object_key`（同一训练进程、同一日志错误、同一检查项 = 同一事件）。
- 首次出现 → 通知；重复出现 → 只更新 `occurrence_count / last_seen_at / evidence / run_ids`，**不再通知**。
- 严重度升级（如 `high → critical`）→ 视为新信息，再通知一次。
- 出现**新的**异常对象 → 独立事件、独立通知。
- 只有一次"完全干净"（`ok` 且无 findings）的运行才会把未复现的开放事件标记为 `resolved`；带其它 finding 的运行不会误判其它异常已恢复。
- `notify_on_recovery: true` 时，恢复会发送一条恢复通知（默认不发）。
- 监控失败同样去重：相同错误码只通知一次，避免长期故障每 30 分钟刷屏。

通知消息包含：任务名、任务 ID、发生时间、项目路径、异常类型、严重程度、具体信息、证据、位置、建议排查方向、监控 Session ID、运行 ID、是否已归档。

**可靠投递**：

1. 每条通知先落盘为 `pending` delivery；
2. 解析目标 Session → 若目标已归档/不可用 → 记录原因并保留待投递；
3. `followup + sessions.flush`，只有持久化确认成功才算 `delivered`；
4. 失败按指数退避重试；`notifyRetryMaxAttempts=0` 表示无限重试（默认）；
5. 重投前扫描目标 Session 日志中的 `dedupeKey`，避免"已 flush 但未记账"造成重复；
6. 监控 Session 归档不影响待投递（消息在插件队列里，不在 B 的会话里）。

---

## 只读与安全边界

默认（`allowed_operations.write !== true`）会：

1. 向监控 Session 追加官方 `sandbox/mode = read-only`；
2. 追加官方 `approval/policy = never`（无人值守，不会弹审批）；
3. 在 Agent 作用域 `tools.restrict({allow})`，只保留：`read`、`read_image`、`glob`、`grep`、`bash`/`pwsh`、`web_fetch`/`web_search`、`job_list`、`job_output`、`working_directory`；
4. 收窄后自检：仍能看到 `write/edit/subagent/workflow/run_code/monitor_*` 等危险工具则拒绝运行（`MONITOR_ERROR`），而不是放行；
5. 监控 Session 内隐藏 `monitor_*` 管理工具；
6. 归档闸门保证归档会话不会再被模型步唤醒。

要授权写操作必须显式 `allowed_operations.write = true`（仍建议只做最小修改）。监控 Agent 的权限**不继承**主对话的人工审批授权：监运行使用独立的 `approval/policy = never` 与 `sandbox/mode = read-only`。

---

## 数据与持久化

```text
$DSH_HOME/isolated-monitor/
├─ mount.json          # 挂载证明（时间、工具清单、任务数）
├─ state.json          # 任务 / 运行 / 异常事件 / 待投递（原子写）
├─ state.json.bak      # 上一次成功写入的备份
└─ runs/
   └─ <run-id>.json    # 单次运行的完整证据（提示词、最终回复、检查输出、用量）
```

- 写入使用官方 `@deepseek-ai/dsh-atomic-write`（临时文件 + rename），读取失败自动回退 `.bak`，损坏文件会被隔离而非中断插件。
- 运行历史每任务 `historyLimit` 条；证据文件按天清理。
- 不写 DSH 数据库、不写其它插件目录、不修改 DSH 核心源码。
- 归档只写官方 Workspace registry 的 archive set，不删除 Session 日志。

---

## 升级 / 卸载 / 迁移

### 升级

1. 替换插件目录内容（或安装新版本）。
2. 重新加载 bundle（`plugin_manager set_bundle` 关闭再开启，或重启 DSH）。
3. `state.json` 带 `version`；升级只做兼容性补全，不删除任务/运行/待投递。

### 卸载

```bash
dsh plugin --profile desktop remove dsh-isolated-monitor
```

或 `plugin_manager remove_bundle`。卸载后：

- 定时任务停止；
- 已归档/保留的监控 Session 仍然存在，可正常查看；
- 插件数据目录**默认保留**，重新安装后任务恢复。

彻底清理（不可恢复）：

```bash
rm -r ~/.dsh/isolated-monitor
```

### 迁移

- 换机器：复制整个 `$DSH_HOME/isolated-monitor/` 到新机器同一路径（或设置 `dataDir` 指向它）。
- 注意 `source_session_id` 必须存在于新环境的 Session 存储中；否则任务在下次运行时会因目标不可达而暂停/告警，需要重新创建任务。

### 归档会话找回

监控任务历史里的 `session_id` 就是会话 ID。在侧边栏切到 **All conversations** 可看到已归档会话，或搜索后点 **Unarchive**；也可用 `monitor_manage action=unarchive_session`。

---

## 已知限制

- **Host 必须运行**：DSH 关闭期间不执行；重启后错过的 occurrence 只补一次（合并），不会补跑全部历史。
- **无客户端 UI 页**：管理通过工具与 `/monitor` 完成（官方推荐方式，零构建、零额外注入）。
- **PTC 执行器**：监控 Agent 依赖 `tools.restrict` 收窄工具；若部署使用 PTC `run_code` 或强隔离 preset 导致收窄失败，会判 `MONITOR_ERROR` 而不是放行。
- **模型输出契约**：监控 Agent 必须给出约定的 JSON。插件有一次"补格式"兜底；仍失败则按 `MONITOR_ERROR` 处理（这是安全默认）。
- **token 成本**：`agent` 模式每次运行都会加载宿主默认 preset 的系统提示与工具，成本与普通会话同量级；能用确定性检查表达的条件请用 `hybrid`/`checks`（0 token）。
- **子目录项目分组**：监控会话的 cwd 是 `project_path`；只有该路径本身是已注册 Workspace 时才会归到项目下，否则显示在 **Ungrouped**（仍然可见、可归档、可搜索）。
- **归档目标不可通知**：原始会话被归档后，告警会留在待投递队列，Unarchive 后自动/手动重投；期间任务会被 `workspace/session-stop` 暂停，避免产生无人接收的运行。
- **费用预算**：当前只支持 token 预算（`max_tokens_per_run`），不内置价格表/货币预算。

---

## 故障排查

| 现象 | 检查 |
|---|---|
| 没有任何运行 | 看 `mount.json` 是否存在；`/monitor` 列表；任务 `status` 是否 paused/ended；原始会话是否被归档 |
| 每次都 `MONITOR_ERROR: restriction_failed` | 部署的 preset 隔离了工具或使用 PTC；查看运行记录中的 `dangerous` 列表 |
| 告警一直 pending | `monitor_view` 看 `last_error`；目标会话是否已归档；`flush` 是否被持久化后端确认 |
| 归档失败 | 运行记录 `code=archive_failed` 并会告警；通常是 Session 仍在活动（子 Agent/后台任务），确认后重试 `run_now` 或手动归档 |
| 任务重复执行 | occurrence 在运行前持久化；同任务有 in-flight 保护；重启后只补一次 |
| 状态文件损坏 | 自动使用 `state.json.bak`，原文件重命名为 `.corrupt-<ts>`；日志中会提示 |

更多设计细节见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，调查结论见 [docs/INVESTIGATION.md](docs/INVESTIGATION.md)，测试报告见 [docs/TEST-REPORT.md](docs/TEST-REPORT.md)。
