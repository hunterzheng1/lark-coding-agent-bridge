# OPT-04：入站持久化、去重与恢复

状态：分片 1–3 已实施（commit `1b95117`），分片 4 已实施（commit `953ca1f`：结构化恢复卡 + 重做/忽略动作）。本地验证通过、现场未验证。优先级 P1。实施记录见文末。

## 问题

`PendingQueue` 是内存合批队列，`ActiveRuns` 管理活动运行。已有会话持久化不能证明运行中消息或任务在崩溃后恢复。是否会丢失用户消息应通过受控重启测试确认，不能仅根据竞品功能判断。

参考 [OpenClaw 的入站持久性](https://docs.openclaw.ai/channels/feishu/setup)：认证后的事件先落盘、以事件 ID 去重，再分发；借鉴这种交付语义，不直接照搬其整体架构。

## 必须明确的状态

建议区分 `accepted`、`queued`、`claimed`、`running`、`terminal`、`delivery_pending` 和 `uncertain`。具体枚举可调整，但消息收到、任务启动、任务执行结束、结果送达不能混淆。

- 稳定身份至少包含 Profile 与平台事件/消息 ID。
- 同一 Scope 保持顺序，合批后仍保留输入消息与运行的映射。
- 重复事件不能重复创建已存在的队列记录；并发认领必须有锁或原子状态转移。
- 去重保留窗口、失败重试预算、清理策略应显式配置或文档化。
- 用户看到“已接收”的时间点应与实际持久化保证一致。

## 恢复原则

重启时先核查原进程和运行记录；不能把“缺少完成事件”直接解释为“从没执行”。已修改文件或已发送外部请求而终态未知时进入 `uncertain`，提供检查与恢复选择。

不要承诺副作用 exactly-once。消息记录可以去重，不代表 Agent 发出的任意外部操作可重放。恢复通知应说明最后确认的阶段与未知部分。

用户 `/stop`、`/new`、工作目录切换、权限变化发生后，旧队列记录的去向必须定义。重新启动前重新验证当前权限和工作目录，不能复用过期授权。

## 入口

`src/bot/pending-queue.ts`、`src/bot/active-runs.ts`、`src/bot/channel.ts`、`src/bot/run-flow.ts`、`src/runtime/run-executor.ts`、现有 runtime 锁与原子写入模块。先检查 SDK 当前入站确认/重连行为，再决定落盘边界。

## 实施分片

1. 故障注入调查：确认接收、合批、spawn、done、投递之间的崩溃窗口。
2. 持久消息队列和去重；保持现有 Scope 顺序。
3. 运行认领与重启状态分类；以保守的 uncertain 处理未知副作用。
4. 用户恢复卡与诊断；明确”继续会话”和”重做任务”的差别。

## 实施记录（2026-09-17，基线 c24a7c0）

### 故障窗口调查结论（分片 1）

- 源码确认：`startChannel` 的 `disconnect()` 调用 `pending.cancelAll()`——600ms 合批窗口内的消息在优雅停机时被主动丢弃，硬崩溃时随内存丢失；这是主要的丢单窗口。
- run 派发后崩溃：会话/catalog 已持久化，但该次运行终态未知；旧卡片永远停在”运行中”。原行为没有任何恢复通知。
- done 之后、通知送达之前崩溃：终态通知与 `/last` 文本随进程丢失（`lastRunOutput` 为调度式持久化）。

### 所选设计（分片 2–3）

- `src/bot/inbound-journal.ts` 新增 `InboundJournal`：消息通过准入检查、确认不是命令后，在进入内存 `PendingQueue` 前落盘（`<profileDir>/inbound/`，按 scope 一 JSON 文件，原子写 0600）。`messageId` 幂等去重，重复投递返回 `duplicate`，不产生双记录、不误报失败；落盘失败记 `accept-not-durable` 告警（可用性优先，消息仍按原流程处理）。
- 状态机：`queued`（已接收未派发）→ `claimed`（batch 派发进 run 时绑定 runId）→ `terminal`（run 到达已知终态，含 interrupted/timeout；策略拒绝走 `markRejected` 落定，避免重启后重放进同一次拒绝）。
- 启动恢复（`recoverOnStartup`）：窗口内（默认 10 分钟）的 `queued` 记录经**正常 pending 流重放**——派发时重新执行权限、工作目录与策略校验，不复用旧授权；`claimed` 无终态 → `uncertain`，只向该 scope 发送 markdown 恢复通知（”执行结果未知，未自动重跑”），绝不自动重跑；滞留过久的 `queued` → `expired`，通知用户重发。重放/通知延迟 1.5s 等 WS 握手。保留期默认 7 天，惰性清理。
- `/new` 清除本 scope 的 `queued` 记录（新会话语义）；`/stop` 产生的 interrupted 终态正常落定，无需特殊处理。
- 测试为进程内模拟（seed journal + 重建 startChannel），未真实 kill 进程；丢消息窗口以源码分析 + journal 覆盖后的重放 e2e 佐证。

### 验证证据

- 红灯：`tests/unit/bot/inbound-journal.test.ts` 10 项（去重/claim/terminal/rejected/隔离/恢复分类/重载/损坏容忍/落盘失败//new 清理/保留期）在实现前失败，实现后通过。
- 新增 `tests/integration/bot/inbound-recovery.test.ts` 4 项端到端：完整生命周期落定（恢复集为空）、崩溃窗口内已落盘消息重启后经 pending 流重放执行且重新落定、uncertain 通知且不产生新运行、重复投递不双记。
- 全量 `pnpm test` 107 文件 736 项：仅既有 `logger.test.ts` 2 项失败（基线已存在）。`pnpm typecheck` 通过。thinking-history e2e 的 waitFor 上限由 3s 放宽到 10s 消除并行抖动（曾出现一次全量下的超时抖动）。

### 剩余事项

- ~~分片 4：恢复通知目前是 markdown 文本，没有结构化恢复卡~~ 已实施（`953ca1f`），并按用户确认显式拆分两种语义（`d6ee860`）：uncertain 卡三动作——「💬 继续对话」保留会话、派发【恢复】引导文案由 agent 检查进度后接着做；「♻️ 重头重做」重置会话（归档 catalog active 条目 + 清 session store，等价 /new）后按原文完整重跑；「忽略」。「重头重做」的重置只影响该 scope 的会话绑定，权限默认值与工作目录不变，派发时仍走完整策略校验。expired（从未派发）卡两动作——「▶️ 现在执行」（原文派发，不重置会话）与忽略。全部幂等。
- 真实进程 kill 级故障注入未做（测试以进程内模拟替代）；`delivery_pending` 未作为独立状态（终态即落定，最终卡片投递失败不影响 journal 状态）。
- 云文档评论入口（comment scope）未接 journal（该入口不经过 im intake 路径）。
- 优雅停机时 `pending.cancelAll` 丢弃的消息依赖下次启动的重放兜底；若用户在停机期间已在别处重做同一任务，重启重放会执行一次重复任务（去重仅按 messageId，无法识别语义重复）。

## 验收

- 接收落盘后、合批后、spawn 前后、done 后、送达前各点强制结束进程并恢复。
- 重复投递不重复启动已认领任务；存储失败不能报告持久接收成功。
- 已知终态不重跑；未知执行结果不自动重放可能有副作用的任务。
- Scope 顺序和不同 Scope 并发符合既有约束。
- 权限撤销、记录损坏、磁盘不可写有明确失败状态。
- 使用临时测试目录、假 Agent 和假 Channel，不通过杀用户服务进行测试。
