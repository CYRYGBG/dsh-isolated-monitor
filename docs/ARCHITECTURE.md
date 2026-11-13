# 架构设计

## 1. 设计目标与约束

目标：**每个定时监控任务在完全独立的新会话中执行；正常结束自动归档；只有异常才回传创建它的原始主对话。**

硬约束：

- 不修改 DSH 核心源码；
- 不破坏已装插件；
- 不直接操作 DSH 数据库或未公开私有接口；
- 不删除现有 Session；
- 不在主对话里执行监控本身；
- 正常结果不发给主对话；
- 异常必须发到**正确的** Session；
- 所有投递有可靠状态记录；
- 归档可恢复查看；
- 数据放在独立插件目录。

## 2. 模块图

```text
src/index.js                 组合根：适配器注入、工具/命令注册、归档准入、生命周期
├─ src/config.js             部署配置默认值与规范化
├─ src/clock.js              时区/日历/时长纯函数
├─ src/timing.js             schedule 校验 + occurrence 计算（复用官方 Cron/RRule）
├─ src/state.js              任务/运行/异常事件/待投递记录 + 纯规范化
├─ src/store.js              $DSH_HOME/isolated-monitor 原子持久化与证据文件
├─ src/scheduler.js          单定时器、并发预算、occurrence 触发、立即执行
├─ src/sessions.js           新建 Root Session、只读加固、命名/分组、归档/恢复、目标 Agent 解析
├─ src/checks.js             确定性预检（工具管线执行命令 + 文件读取）
├─ src/prompt.js             监控提示词与输出契约
├─ src/runner.js             一次运行：尝试/超时/预算/重试/归档/路由
├─ src/classify.js           turn 终止原因 + JSON 契约 → NORMAL/ALERT/MONITOR_ERROR
├─ src/alerts.js             去重事件、通知渲染、持久化投递与重试
└─ src/tools.js              4 个模型工具 + /monitor 命令
```

运行时对象关系：

```text
ctx.schedule / ctx.storage…         （不直接使用，避免与官方调度语义冲突）
ctx.agents                          创建/持有 AgentHandle，dispose
ctx.sessions                        读取事件日志、flush 持久化
ctx.sessionController.resolveAgent  按需激活目标会话（冷启动恢复 preset）
ctx.workspaceRegistry               archiveSession / unarchiveSession / 归档准入
ctx.agentPresets                    resolve/mount 监控会话的 preset
ctx.agentDefaultModel               默认模型选择
ctx.sessionTitle                    给监控会话命名
ctx.tools / ctx.commands            工具与命令注册
ctx.sessionQuery                    可选：不激活读取历史（当前实现未依赖）
```

## 3. 一次运行的时序

```text
Scheduler (setTimeout, unref)
  │  due?
  ▼
runner.execute(task, occurrence)
  │
  ├─ 0. source_session_id 已归档？ → pause(task) 结束
  │
  ├─ 1. 事务：task.in_flight_run_id = runId, state.runs += run(running)
  │       ↑ 先落盘再执行：重启不会重复跑同一 occurrence
  │
  ├─ 2. sessions.createRunSession(task, run)
  │       ├─ agentPresets.resolve(task.agent_preset) / mount
  │       ├─ agents.create({ sessionId: session-<uuid>, meta:{cwd, agentPreset} })
  │       │     └─ setup(agentCtx, agent):
  │       │           installModelSelection()
  │       │           preset.mount()
  │       │           sandbox/mode = read-only
  │       │           approval/policy = never
  │       │           tools.restrict({allow: read-only set})
  │       │           可见工具自检（危险工具 → 抛错）
  │       │           systemPrompt.section(monitor policy)
  │       ├─ appendPluginRecord(plugin:isolated-monitor/session)
  │       ├─ flush
  │       ├─ sessionTitle.rename("[监控] <task> · <time>")
  │       └─ workspaceRegistry.resolveByPath(cwd)?.attachSession()
  │
  ├─ 3. checks.run()（可选，0 token）
  │
  ├─ 4. drive():
  │       followup(createUserMessage({source:{kind:'isolated-monitor-run'}}))
  │       flush → whenIdle
  │       [timeout] setTimeout → agent.cancel(timeout)
  │       [budget]  session/event 累计 usage → agent.cancel(budget)
  │       [agent/error] 记录；后续 turn/end 到达则清除
  │       summarize(session, firstSeq):
  │         last assistant/message text
  │         last turn/end reason
  │         usage sum
  │
  ├─ 5. classify():
  │       超时/预算 > agent 错误 > turn 未完成 > JSON 缺失/非法
  │       > inconclusive > findings 非空 → ALERT > 否则 NORMAL
  │
  ├─ 6. NORMAL:
  │       appendPluginRecord(plugin:isolated-monitor/run)
  │       flush → dispose(handle) → archiveSession(sessionId)
  │       归档失败 → 改判 MONITOR_ERROR(archive_failed) 并告警
  │
  ├─ 7. ALERT / MONITOR_ERROR:
  │       appendPluginRecord → flush → dispose(handle)
  │       不归档；去重 → 生成/更新事件 → 生成待投递
  │
  ├─ 8. 写证据文件 runs/<runId>.json
  │
  ├─ 9. 事务：更新 run、task 统计、last_result、next_run_at
  │       once/after → ended；其它 → next occurrence（错过的合并）
  │
  └─ 10. 瞬时错误且还有重试额度？
          → 归档本次尝试会话 → 退避 → 新 Session 重试（同一 occurrence）
          否则 → alerts.raise() → deliverDue()
```

## 4. 关键问题与实现答案

### 4.1 如何获取原始主对话 Session ID

- 工具执行上下文 `exec.agent` 是调用者 Agent；
- `agent.session.id` 与 `agent.id` 相同，是**官方 Session 身份**；
- 插件在 `monitor_create` 中强制读取 `exec.agent.session.id`，并校验：
  - `ctx.agents.get(agent.id) === agent`（live）；
  - `ctx.agents.roots().includes(agent)`（不是 delegated subagent）；
  - 该 Agent 的会话不是监控会话。
- 因此 `source_session_id` 精确指向"谁调用了 monitor_create"，**不通过会话名、最近活动、cwd 猜测**。
- 如果未来 DSH 改变工具上下文形状，插件会在 `monitor_create` 直接报错，而不是悄悄写错目标。

### 4.2 如何创建完全独立的新 Session

- `ctx.agents.create({ sessionId, meta: { cwd, agentPreset }, agentOptions, setup })`：
  - `sessionId` 每次 `session-<uuid>` 全新生成；
  - 不传 `seed`、不传 `parentAgent` → 新 Session 无继承历史、无父会话；
  - `meta.cwd = task.project_path`，因此项目 `AGENTS.md` 由默认 preset 的 `dsh-agent-instructions` 自动加载；
  - `setup` 在 Agent 发布前完成 preset 挂载、只读加固、提示段；
- 为什么不用官方 `ctx.schedule` 的 `new` 目标：它只负责把一条消息投递到新会话 inbox，**拿不到执行完成后的结果、无法按结果归档、无法条件告警**；因此本插件复用同一套底层原语（`agents.create` / `presets.mount` / `followup` / `flush` / `archiveSession`），但由自己驱动一次完整运行。
- 为什么不用 `subagent`：子 Agent 会话属于 delegated 路由，不能在侧边栏作为独立调查会话查看，也不能按普通会话归档；本插件要的是**Root Session**。

### 4.3 如何保证正常 Session 自动归档

- 运行结束后先 `handle.dispose()`（停止 loop、注销 Agent、摘除 live session、关闭持久化写句柄），再调用 `ctx.workspaceRegistry.archiveSession(sessionId)`；
- 此时没有活动轮次/子 Agent/后台任务，归档准入通过；
- 如果仍报 `WorkspaceActiveSessionError`，插件以 `{stopActivity:true}` 重试一次并记录告警；
- 归档失败会被改判 `MONITOR_ERROR(archive_failed)` 并通知主对话，而不是假装成功。

### 4.4 如何确保归档后不出现在活动侧边栏

- `archiveSession` 写入 Workspace registry 的**全局 archive set**；
- DSH 侧边栏默认 `Hide archived`，归档会话从所有分组 surface 消失；
- 插件不改 UI、不删除会话，完全依赖官方归档语义。

### 4.5 如何保留归档会话的历史记录

- 归档只写 archive set；Session 日志、header、Workspace 位置全部保留；
- 插件的 `runs/<runId>.json` 与 `state.runs` 记录 `session_id`、状态、耗时、token、摘要、证据；
- 用户可通过 `monitor_view` 拿到 Session ID，在侧边栏切 **All conversations** 搜索后 **Unarchive**，或用 `monitor_manage action=unarchive_session`；
- 插件提供 `archive_session` 动作，可手动把已处理完的异常会话归档。

### 4.6 如何向指定原始 Session 发送消息

```js
const agent = await ctx.sessionController.resolveAgent(sourceSessionId) // {agent} | {error}
// 目标已归档 → 不投递，保持 pending
const message = createUserMessage({
  content: [{ type: 'text', text: alertText }],
  source: { kind: 'isolated-monitor', taskId, alertEventId, deliveryId, dedupeKey },
})
agent.followup(message)                 // 进入持久 inbox 并唤醒
const ok = await ctx.sessions.flush(agent.session) // 持久化确认
if (!ok) throw new Error('persistence did not acknowledge')
```

- 这是 DSH 官方 `dsh-schedule` 使用的同一条投递路径；
- `source.kind` 不是 `user`，因此不会获得"人类输入"的权威（goal 等工具只认 `kind: 'user'`）；
- 消息落盘后，主对话 Agent 会在下一个 turn boundary 处理它，表现为一条用户消息；
- 不复制整段监控对话，只发结构化摘要与证据。

### 4.7 如何保证异常通知不会丢失

1. **先落盘**：`alerts.raise` 在事务中创建 `delivery(pending)`，包含完整文本与去重键；
2. **再投递**：解析目标 → 归档检查 → 幂等扫描 → `followup + flush`；
3. **成功才记账**：`flush === true` 才把 delivery 标为 `delivered` 并写 `message_id`；
4. **失败有原因**：`last_error / blocked_reason / next_attempt_at` 持久化，指数退避重试；
5. **幂等**：重投前扫描目标 Session 日志中相同 `dedupeKey`/`deliveryId`，命中则直接记成功，避免"已 flush 但未记账"的重复；
6. **归档不影响**：待投递属于插件状态，不在监控 Session 里；监控 Session 归档后照样重投；
7. **重启恢复**：`state.json` 中 pending 全部保留，启动后重试循环继续；
8. **不静默失败**：`notifyRetryMaxAttempts=0` 时无限重试；即使配置了上限，超过上限也只停止自动重试并保留 pending，`monitor_view` 可见，可手动 `retry_alerts`。

## 5. 结果判定

`classifyOutcome` 的优先级（从高到低）：

| 条件 | 结果 | code |
|---|---|---|
| 超时 | MONITOR_ERROR | `timeout` |
| 超出 token 预算 | MONITOR_ERROR | `budget_exceeded` |
| 未消解的 `agent/error` | MONITOR_ERROR | `agent_error` |
| 没有任何 turn | MONITOR_ERROR | `no_turn` |
| 最后一轮无 `turn/end` | MONITOR_ERROR | `no_turn_end` |
| `turn/end` 非 completed | MONITOR_ERROR | `turn_<kind>` |
| 最终消息无 JSON 契约块 | MONITOR_ERROR | `result_missing` |
| JSON 非法/字段非法 | MONITOR_ERROR | `result_invalid` |
| 模型声明 inconclusive | MONITOR_ERROR | `inconclusive` |
| findings 非空（含失败的 checks） | ALERT | — |
| `status=alert` 但无 findings | MONITOR_ERROR | `result_inconsistent` |
| 其余（`status=ok` 且 findings 空） | NORMAL | — |

> 未完成/不可判断永远不是 NORMAL —— 这是插件的核心安全默认。

## 6. 去重模型

事件身份：`event_key = type \0 object_key`。
`object_key` 优先取模型给出的稳定 key（同一次运行内同一对象只报一条），否则用 `type + 标题 + 证据前缀` 的短哈希。

| 运行结果 | 处理 |
|---|---|
| 新事件 | 创建 `open` 事件 + 通知 |
| 已有 `open` 事件 | 更新次数/时间/证据；仅当严重度升级或尚未成功通知过才再通知 |
| 完全干净的运行 | 未复现的 `open` 事件 → `resolved`；`notify_on_recovery` 时发恢复通知 |
| 有 findings 的运行 | 不 resolve 其它事件（无法证明其它异常已恢复） |
| MONITOR_ERROR | 用 `monitor_error:<code>` 作为事件，同码只通知一次 |

## 7. 调度与持久化

- 解析：官方 `Cron` / `RRule` + 自实现的 once/after/every/daily/weekly（墙钟用 `Intl` + `resolveLocalInstant`，正确处理 DST gap/overlap 交给官方实现）。
- 单定时器：只睡到"最早 due 的任务"，最长 `pollingMaxSeconds`，不会为每个任务建 interval。
- 触发前先持久化 `in_flight_run_id` 与 run(running)；完成后更新 `next_run_at`。
- 重启：
  - 加载 tasks/runs/events/deliveries；
  - `running` 记录规范化为 `MONITOR_ERROR(interrupted)`，`recoverInterrupted()` 只通知一次并写 `recovery_handled`；
  - active 任务若 `next_run_at` 已过期，只补跑一次（occurrence 合并），然后推进到未来；
  - 同一任务有 `in_flight_run_id`/内存 running 集合，重复触发被跳过。
- 并发：`maxConcurrentRuns` 限制同时执行的运行数。

## 8. 数据格式

`state.json`（version 1）：

```jsonc
{
  "version": 1,
  "createdAt": "...", "updatedAt": "...",
  "tasks": { "<task_id>": { /* 任务配置 + 统计 + next_run_at + in_flight_run_id */ } },
  "runs": [ { "run_id", "task_id", "status", "code", "session_id", "session_archived", "usage", "attempt", "retry_scheduled", ... } ],
  "events": [ { "event_id", "task_id", "event_key", "status", "occurrence_count", "notify_count", ... } ],
  "deliveries": [ { "delivery_id", "alert_event_id", "status", "dedupe_key", "attempts", "next_attempt_at", "message_id", ... } ],
  "stats": { "runs": 0, "normal": 0, "alert": 0, "monitor_error": 0 }
}
```

`runs/<run_id>.json`：该次运行的完整提示词、最终回复、检查输出、findings、usage、错误。

写入：`writeFileAtomic`（临时文件 + rename）；提交前把旧 `state.json` 复制为 `state.json.bak`；读取失败自动回退并隔离损坏文件。

## 9. 只读加固的三层

1. **执行层**：`sandbox/mode=read-only`（官方 policy，bash/fs 工具共同遵守）；
2. **审批层**：`approval/policy=never`（无人值守不会等待人工审批）；
3. **工具层**：`agent.ctx.tools.restrict({allow})` + 收窄后自检。

任何一层无法建立时：

- 若 `allowUnenforcedReadOnly=false`（默认）→ `MONITOR_ERROR(read_only_unenforceable / restriction_failed)`；
- 不会以"只读"为名放行可写工具。

## 10. 与官方能力的边界

| 能力 | 使用 | 未使用/未重复实现 |
|---|---|---|
| Session 创建/恢复 | `ctx.agents.create`、`ctx.sessionController.resolveAgent` | 不自建 Session 存储 |
| Agent 驱动 | `followup`、`whenIdle`、`cancel`、`agent/*` 事件 | 不自建 loop |
| 归档 | `workspaceRegistry.archiveSession` | 不改数据库/不删文件 |
| 消息投递 | `createUserMessage` + `followup` + `sessions.flush` | 不写私有 inbox 表 |
| 调度解析 | `Cron` / `RRule` / `resolveLocalInstant` | 不自写 cron 解析器 |
| 持久化 | `writeFileAtomic` + 独立目录 | 不用未公开 storage 内部接口 |
| 权限 | `setSandboxMode` / `setApprovalPolicy` / `tools.restrict` | 不伪造审批 |

## 11. 兼容性

- `engines.dsh = ">=0.2.2-rc.1 <0.3.0"`；`dsh.compatibility.dshReleases` 标出实测版本。
- 依赖的均为 0.2.2-rc.1 已存在的服务与导出（见 `docs/INVESTIGATION.md`）。
- 升级到 0.2.x 新版本时重点回归：
  - `agents.create` 的 options/meta/setup；
  - `agentPresets.resolve/mount`；
  - `tools.restrict` 语义与 `scopeOf`；
  - `workspaceRegistry.archiveSession`；
  - `sessionController.resolveAgent`；
  - `turn/end` reason 与 `assistant/message` usage 字段；
  - `Cron/RRule.parse` 返回的 discriminated union。
- 若加载失败，app-boot 会将插件行标记为 failed，不影响其它插件；卸载后可完全恢复。

## 12. 可测试性

- 所有依赖 DSH 运行时的地方通过 `src/index.js` 的 `adapters` 注入，业务模块只依赖 Node 内置模块；
- `test/harness.mjs` 用内存 fake 模拟 agents/sessions/tools/workspace/controller/presets，配合真实临时目录的 store 与真实定时/取消行为；
- 因此 37 个测试无需 GPU、无需网络、无需启动 DSH 即可覆盖全部生命周期与故障分支。
