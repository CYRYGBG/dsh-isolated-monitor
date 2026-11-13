# dsh-isolated-monitor 技术调查

调查时间：2026-11-13。所有结论来自本机 DSH 安装的只读源码解包（`D:\02.Software\DSH\resources\app.asar` → 临时目录）与实际运行环境，不依赖其它版本 API 猜测。

## 1. 当前环境

| 项目 | 值 | 依据 |
|---|---|---|
| DSH 版本 | `0.2.2-rc.1` | asar 内 `dsh/node_modules/@deepseek-ai/dsh-schedule/package.json` 等全部为 `0.2.2-rc.1` |
| Node.js | `v24.15.0` | `node --version` |
| 运行形态 | Electron Desktop，Profile `desktop`，Web GUI `http://127.0.0.1:14014` | 环境变量 `DSH_PROFILE=desktop`、`DSH_WEB_URL`、`DSH_SESSION_ID=session-67184a20-…` |
| DSH_HOME | `C:\Users\cyr\.dsh` | `DSH_HOME` |
| Profile 目录 | `C:\Users\cyr\.dsh\profiles\desktop` | `DSH_PROFILE_DIR` |
| 已装插件 | `dsh-cost-meter@1.9.64`、`dsh-meter@0.3.32`、`dsh-pet@0.3.8` | profile `package.json` |
| 插件架构 | Cordis 4.x 插件树 + Loader + bundle patch 分层 | profile `cordis.patch.yml`、`dsh-base`/`dsh-web-app` bundle patch |
| 包管理器 | pnpm，`autoInstallPeers: false`，`nodeLinker: hoisted` | profile `pnpm-workspace.yaml`、`pnpm-lock.yaml` |

## 2. 官方 API（本版本实测/patch 源码确认）

### 2.1 当前 Session ID
- 工具执行上下文 `exec.agent.session.id`（`dsh-tool-schedule` 第 452/483 行、`targetFor()` 第 481 行）。
- Agent 身份与 Session 身份相同：`agent.id === agent.session.id`（`dsh-agent` `enter()` 断言）。
- `ctx.agents.currentInitiator()` 可拿到驱动链上的 Agent（goal 工具用它做权威校验）。
- 结论：创建任务时必须使用 `exec.agent.session.id`，且要求该 Agent 是运行时根 Agent（`ctx.agents.roots()`），不从名称/最近活动推断。

### 2.2 创建全新 Root Session
- `ctx.agents.create({ sessionId, meta: { cwd, agentPreset? }, agentOptions, setup })` → `AgentHandle { agent, dispose() }`（`dsh-agent` README + `AgentRegistry.create`）。
- `setup(agentCtx)` 在 Agent 发布前执行，用于挂载 preset / 工具限制 / 提示段。
- 官方 Web 控制器等价实现：`ApiSessionAgentController.createAgent()`（`dsh-api-session-controller/lib/types/agent.js` 第 456-472 行）：
  ```js
  await this.ctx.agents.create({ sessionId, agentOptions, meta: { cwd, agentPreset }, setup: composition.setup })
  ```
  其中 `composition.setup` = `installModelSelection(agentCtx)` + `presets.mount(agentCtx, resolvedId)`（同文件 `composeAgent()` 第 262-275 行）。
- `dsh-schedule` 的 `new` 投递目标走 `ctx.sessionController.create({ sessionId, cwd, agentPreset })`（`dsh-schedule/lib/index.js` 第 1499-1508 行），但该路径不返回 handle，无法主动 dispose；本插件需要"运行结束立即结束 Agent"，因此采用 `ctx.agents.create` 直接持有 handle（与 headless runner 相同）。
- `handle.dispose()`：停止 loop、注销 Agent、把 Session 从 live store 摘除、关闭持久化写句柄；磁盘 Session 日志保留（`dsh-agent-loop` 第 1530-1546 行 teardown）。
- 新 Session 不继承任何历史：`agents.create` 无 `seed`，`session.header.isSeeded=false`、`parentSession` 为空。

### 2.3 驱动 Agent 并等待完成
- `agent.followup(createUserMessage({ content, source: { kind } }))` 唤醒一轮；`await agent.whenIdle()` 等待整轮静默。
- `agent.cancel(cause, { keepInbox })` 取消活动轮；`agent.status` 为 `idle|running`。
- 驱动器会吞掉异常（`kick()` 的 `catch (_error) {}`），失败通过 `agent/error` 事件与 `turn/end.reason.kind='error'|'aborted'` 体现 → 必须同时监听事件与读日志。
- 官方 headless 的完整模式（`dsh-headless/lib/index.js` 第 336-383 行）：create → whenIdle → 设定权限 → 记录 `firstSeq` → followup → whenIdle（含子 Agent 等待）→ `sessions.flush` → `summarize(session, firstSeq)`（最后一个非空 `assistant/message` 文本 + 最后一个 `turn/end.reason`）。本插件复用该模式。

### 2.4 读取执行结果
- `session.eventAt(seq)` / `session.snapshotEvents()` / `session.log` / `session.seq`（`dsh-session`）。
- `assistant/message` 事件：`{ turn, step, message, usage?, stream, interrupted? }`；`usage` 字段为 `inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens/reasoningTokens`（cost-meter 回放代码确认）。
- `turn/end` 事件：`{ turn, reason }`，`reason.kind ∈ completed|aborted|error|max-tokens`。
- `ctx.sessionQuery.readSession(id)` 可在不激活 Agent 的情况下读取完整事件日志（用于重启恢复、通知去重校验）。
- `appendPluginRecord(session, 'plugin:<name>/<record>', data)`（`dsh-session`）是插件写入自定义会话记录的官方方式，带 `ignorable` 标记，不影响旧版本读取。

### 2.5 归档 / 恢复 Session
- `ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity? })`：全局 archive set，归档后从所有分组/侧边栏隐藏；Session 与历史完整保留；`unarchiveSession(sessionId)` 恢复原位置（`dsh-workspace` `src/index.ts` 第 265-330 行、`dsh-client-ui-workspace` README「Archive…」）。
- 归档前 `workspace/session-activity` waterfall 会询问"还有什么在运行"；`stopActivity: true` 时跳过检查并派发 `workspace/session-stop`。Schedule / AgentRegistry / jobs / subagent 都注册了 provider。
- 归档不删除；侧边栏默认 `Hide archived`，可切到 `All conversations` 或搜索后 Unarchive。
- 结论：满足"正常会话自动归档且不出现在活动侧边栏""归档可恢复查看"。

### 2.6 向指定 Session 发送消息
- 官方做法（`dsh-schedule/lib/index.js` 第 1381-1403 行）：
  ```js
  const message = createUserMessage({ content:[{type:'text',text}], source:{kind:'schedule'} })
  agent.followup(message)              // 进入持久 inbox 并唤醒
  await ctx.sessions.flush(agent.session)  // 等待持久化确认
  ```
- Agent 解析：`ctx.sessionController.resolveAgent(sessionId)` → `{ agent }` 或 `{ error }`（冷 Session 会 resume；拒绝 subagent 归属 Session）。
- 邮件式消息以 `user/message` 事件落盘，模型可见；`source.kind` 非 `user`，不授予人类权威（goal 工具只认 `source.kind==='user'`）。
- 归档 Session 有 `ArchivedSessionGate`：`agent/pre-step` 拒绝归档 Session 的模型步，因此不能向已归档的 A 投递。
- 结论：使用 `resolveAgent + followup + sessions.flush`，消息落盘成功才算投递成功。

### 2.7 权限收敛（只读）
- `setSandboxMode(session, 'read-only')`（`@deepseek-ai/dsh-sandbox-policy` 导出）与 `setApprovalPolicy(session, 'never')`（`@deepseek-ai/dsh-user-approval` 导出）是官方唯一写路径（追加 `sandbox/mode`、`approval/policy` 事件）。
- `ctx.permissionPresets.set(session, name)` 需要配置存在的 preset；本机 profile 有 `read-only (sandbox=read-only, approval=ask)`，但没有 read-only+never 组合，因此直接调用两个 canonical setter。
- `agent.ctx.tools.restrict({ allow|deny })` 可在 Agent scope 收窄继承的工具（`dsh-tools` 第 92-115 行）；未知工具名会抛错，需要先与可见工具名求交。
- 归档闸门 `ArchivedSessionGate` 防止归档后再次运行。

### 2.8 定时任务系统
- 官方 `ctx.schedule`（`dsh-schedule`）支持 `after/at/every/daily/weekly/cron/rrule`、`target: session|new_once|new`、持久化于 `$DSH_HOME/storages/schedule.json`、重启恢复、投递回执。
- **不足**：投递只是一条 `schedule` 消息进入目标 Session inbox，官方不暴露模��完成后的结果、不归档 Session、不做条件告警；`new` 目标会复用 `pendingDelivery` 且在 `newSessionIntervalSeconds`（默认 60s）内限流。
- 结论：无法用官方 Schedule 完成"运行→拿到结果→按结果归档/通知"，因此本插件自建轻量调度（复用官方 `Cron`/`RRule` 纯解析 + `ctx.timeout` fiber 定时器），但**不重复实现** Cron/RRULE 解析、权限、Session、归档、消息投递等底层能力。

### 2.9 持久化
- 官方存储域 `ctx.storageDomain`（`defineDomain`）用于 DSH 内部域（schedule/workspace），写入 `$DSH_HOME/storages/*.json`。
- 用户目录规范：`@deepseek-ai/dsh-home-paths` 的 `dshHomePath()`；原子写：`@deepseek-ai/dsh-atomic-write` 的 `writeFileAtomic` / `withFileLock`（tmp + rename，跨进程锁）。
- 结论：插件状态放 `$DSH_HOME/isolated-monitor/`，使用官方原子写与 home path 工具，不碰 DSH 数据库/其它插件数据。

### 2.10 插件注册 / 工具 / 命令
- 插件入口：ESM `export const name/inject/Config/apply`，`Config` 用 schemastery（`dsh-tool-schedule` 尾）。
- Bundle 声明：`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，安装后自动进入 profile 层栈（`dsh-meter`/`dsh-cost-meter` 实证）。
- 工具：`ctx.tools.register(defineTool({ name, description, parameters, output:{ schema, render }, execute(args, exec) }), { when })`；`exec.agent` 为调用 Agent。
- 命令：`ctx.commands.register({ name, description, input:{hint}, handler })`，handler 返回 `{kind:'success'|'error', text}`。
- 事件：`ctx.on('agent/error'|'session/event'|'agent/status'|…)`。
- 定时器：`cordis-plugin-timer` 的 `ctx.timeout(cb, ms)` 返回随 fiber 释放的 disposer。
- 版本约束：主包 `engines.dsh` 优先于 peerDependencies；声明 `>=0.2.2-rc.1 <0.3.0` 即可被 app-boot 接纳。

## 3. 参考插件

本地可读参考（只读解包官方源码 + 已安装第三方插件）：

| 参考 | 可复用的点 | 本插件取舍 |
|---|---|---|
| `@deepseek-ai/dsh-schedule` | 投递/回执、`resolveAgent`、`createUserMessage+followup+flush`、归档准入 provider、`new` 目标建新 Session | 复用投递与 Session 创建原语；不复用其调度，因为它拿不到执行结果 |
| `@deepseek-ai/dsh-headless` | 单轮驱动、`firstSeq`、`summarize()`、`agent/error` 处理、`sessions.flush` | 直接复用该执行范式 |
| `@deepseek-ai/dsh-tool-schedule` | `exec.agent.session.id`、根 Agent 校验、工具 schema 写法 | 复用 |
| `@deepseek-ai/dsh-agent-preset-registry` | `agentPresets.resolve()/mount()` 组成 Agent | 复用（等价于 Web 控制器） |
| `dsh-pet` / `dsh-meter` / `dsh-cost-meter`（本机已装） | bundle patch、peer 依赖、插件数据目录、设置读取 | 复用打包/安装形态 |
| `@aiwayds/dsh-cron`（npm 公开包，只读查看 README/清单） | 独立 tick 引擎、`$DSH_HOME/storages/<plugin>` 原子持久化、session 绑定、missed-occurrence 跳过、归档会话跳过投递、冷 Session 按需 resume、subagent 拒绝 | **只借鉴模式，不安装、不依赖**；其默认交付到会话/子 Agent，不满足本任务的"结果分类+自动归档+异常回传" |
| `@goodandready/dsh-cron`（npm 公开包，只读查看清单） | 隔离运行、成本护栏、心跳 | 其声明兼容 `>=0.2.1-rc.2 <0.2.2-0`，与本机 `0.2.2-rc.1` 不匹配，仅作参考 |

任务点名调查的 `dsh-cron-tasks`、`dsh-timer-agent`、`dsh-automation`、`dsh-sentinel`、`dsh-agent-message`、`chicheng-cron`：npm registry 查询 `dsh-cron-tasks`、`dsh-timer-agent` 均 404，其余未检索到同名公开包；本机也未安装。因此不以其实现为前提，以上述官方源码 + 两个真实存在的社区 cron 插件为参考。

## 4. 当前环境可实现的 / 受限的

可实现：
- 每次运行新建独立 Root Session（`ctx.agents.create` + 自持 handle）。
- 真实读取项目 AGENTS.md（默认 preset 的 `agent-instructions` 插件自动注入）。
- 严格执行只读（sandbox/mode + approval/policy 事件 + 工具 allowlist + 归档闸门）。
- 执行完成结果捕获（`turn/end` + `assistant/message` + usage）。
- 正常归档、异常保留、侧边栏可见性（workspace archive set）。
- 向原始 Session 可靠投递（`resolveAgent → followup → flush` + 持久化待投递队列 + 幂等去重）。
- 重启恢复（自持久化任务/运行/告警/待投递状态 + 官方 Cron/RRule 解析）。
- 插件卸载/重装后数据保留（独立数据目录）。

限制：
- Host 必须运行；关闭期间错过的 occurrence 只补一次（合并），不做补跑历史。
- 监控 Agent 的工具集来自 Host 默认 preset；若部署替换为 PTC executor 或强隔离 preset，`tools.restrict` 可能无法完全收窄 → 插件会做"仍可见危险工具"自检并判为 MONITOR_ERROR，而不是放行。
- 归档 Session 不能被投递；此时告警进入待投递并在 A 恢复归档后重试。
- 无法从插件内主动"打开" GUI 会话；只能返回 Session ID、归档状态并支持 Unarchive。
- 插件无客户端 UI 面；管理通过工具与 `/monitor` 命令完成（官方推荐方式，零额外构建）。
- `agents.create` 的 preset 组合 API（`agentPresets.resolve/mount`）是服务方法而非文档化 Remote；已按 Web 控制器同款调用封装，并在服务缺失时降级。

## 5. 推荐架构

```
dsh-isolated-monitor（单包，宿主侧）
├─ tools/commands  ── 创建/查看/管理（source_session_id 取自 exec.agent.session.id）
├─ scheduler       ── 单一 fiber 定时器；due → runner；occurrence 先持久化后执行
├─ runner          ── checks(可选) → 新建 root Session → 只读加固 → followup → whenIdle → flush → summarize
├─ classifier      ── 解析最后 assistant 文本中的 JSON 契约 + turn/end reason → NORMAL / ALERT / MONITOR_ERROR
├─ archiver        ── 正常 → workspaceRegistry.archiveSession；异常 → 保留
├─ alert router    ── 去重事件 + 待投递队列 + resolveAgent/followup/flush + 幂等 marker + 重试
└─ state           ── $DSH_HOME/isolated-monitor/state.json + runs/<runId>.json（原子写）
```

## 6. 特别注意事项（兼容性）

1. **不修改 DSH 源码/数据库**：只使用 `ctx.*` 服务与官方导出函数。
2. **不 install/依赖六个参考插件**：单包自包含，peer 仅官方包。
3. **版本**：`engines.dsh = ">=0.2.2-rc.1 <0.3.0"`；peer 用宽范围；升级到 0.2.x 后续版本时需回归 `tools.restrict` / `agentPresets.mount` / `archiveSession`。
4. **`whenIdle()` 不抛错**：必须结合 `agent/error` 与 `turn/end` 判定，避免把失败误判为正常。
5. **`sessions.flush` 返回 false** 表示没有持久化监听者：不能视为投递成功（会静默丢失），应进入待投递。
6. **归档时机**：必须在 Agent 空闲/已 dispose 后归档，否则 `WorkspaceActiveSessionError`。
7. **归档副作用**：归档会清除 pin；不删除 Session；`sessionIds` 槽位保留。
8. **重复执行**：occurrence 与 run 记录先落盘再执行；恢复时按 run 状态收敛，避免重启重复跑。
9. **通知幂等**：消息 source 携带 `dedupeKey`，重投前先在目标 Session 日志中查找，避免"已 flush 但未记账"导致重复。
10. **不泄漏工具 token**：监控 Session 内隐藏 `monitor_*` 工具（`when` 条件），避免自我管理/递归。

## 7. 实机验证补充（安装后）

- 插件通过 `plugin_manager install_bundle`（本地路径 link）安装后，`apply()` 正常执行，`mount.json` 记录了 4 个工具；
- `agentPresets.resolve/mount` 在真实 `agents.create` setup 中工作正常；
- 真实模型在监控会话里完成了 `Test-Path`、`Get-Item`、`glob` 等只读检查并输出 JSON 契约，插件正确判为 ALERT 并投递；
- `workspaceRegistry.archiveSession` 对正常运行的监控会话生效，ID 出现在 `~/.dsh/storages/workspace.json` 的 `archivedSessionIds` 中；异常会话不在其中；
- 投递到原始会话后，A 的 projection cache 中可见 `agent/inbox/spliced` 携带 `source.kind='isolated-monitor'` 与 `dedupeKey`；
- **补充发现**：监控会话的 cwd 是 `project_path`，而 Workspace 成员要求 cwd 与注册路径**完全相等**；因此项目是某个 Workspace 的子目录时，监控会话会落在 **Ungrouped**（仍可见、可归档、可搜索），不会被错误挂到父 Workspace 下。这一点已写入 README 与架构文档。
- **补充发现**：`agent.followup` 在目标会话正在跑 turn 时会把通知排到 next-turn，不会打断当前 turn；这正好满足"主对话继续处理当前工作，随后看到告警"的预期。
