# OPT-04：入站持久化、去重与恢复

状态：分片 1–4 已实施（`1b95117`、`953ca1f`），评审修复已完成（`bedbc7e`：重复投递拦截、spawn 前原子认领、持久化串行化、操作人绑定）。本地验证通过（ci:local 767/767）、现场未验证。优先级 P1。实施记录见文末。

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

### 评审修复（2026-09-18，`bedbc7e`）

评审发现两处会导致任务重复执行的阻断问题，均已修复并补测试：

1. **重复投递拦截**：`recordAccepted` 返回 `duplicate` 时 intake 直接结束（原实现仍无条件 `pending.push`，同一事件可能拼入运行中 Prompt 或启动第二次运行）。新增集成测试：终态后重投递不再执行、合批窗口内双投递恰好一次运行。
2. **spawn 前原子认领**：原实现先 spawn 后认领且吞掉持久化错误，崩溃窗口内磁盘仍为 queued，重启会重放已有副作用的任务。现 `startRunFlow` 新增 `beforeSpawn` 钩子在 `executor.submit` 前认领（临时 runId）；认领无法持久化（含 journal 不可写、记录缺失）时中止启动并向用户提示「取消本次启动」；运行开始后 `bindRun` 绑定真实 runId，绑定失败保守落为 uncertain（不自动重跑）并有失败日志。`markRejected` 扩展为同时落定 queued 与 claimed（executor 拒绝时无副作用，可安全落定）。补充 spawn 边界故障注入测试（journal 不可写 → 无运行 + 用户可见提示）与 `bindRun` 单测。
3. **journal 写入串行化**：`persistScope` 此前未登记 `persistQueue`（并发转换可能旧快照后写覆盖新状态）。现按 scope 串行链写入；channel 断连流程增加 `inboundJournal.flush()` 与 `thinkingHistory.flush()`。新增并发写不丢数据测试。

### 评审二轮修复（2026-09-18，`4840492`）

1. **并发重复投递**：`recordAccepted` 在首个 await 前同步登记 reservation，`Promise.all` 并发同 id 投递只有一个 `recorded`；失败安全回滚（记录可重试）。新增并发投递测试。
2. **停机 flush 时序**：`disconnect` 改两阶段——先断连接 + `stopAll`，再（有界 5s）等待全部在途终态回调（journal 落定、思考保存、完成通知）结束，最后才 flush 各存储。终态回调经 `trackSettle` 登记，正常停机后 journal 不会停留 claimed、思考记录不再缺失。
3. **恢复卡持久化回滚**：`markDismissed`/`redo` 在 `persistScope` 失败时回滚内存变更并返回失败；dispatcher 区分「已处理过」与「⚠️ 暂时无法写入请重试」，不再在磁盘不可写时误报忽略成功。

### 评审三轮修复（2026-09-18，`46c55ce`）

1. **恢复卡失败不再误报成功**：`dispatch()` 返回 `dispatched/settled/retry` 三态；仅成功入队后发送成功提示。「重头重做」改为先持久化并入队、成功后才重置会话——写入失败时旧会话不再丢失（会话重置发生在派发之后的同一个同步 tick，先于 600ms 合批 flush，重置依然有效）。
2. **停机等待整个运行生命周期**：`runAgentBatch` 的三个 `processAgentStream` 调用点（card/markdown/text）都在消费起始处把运行 Promise 登记进 `trackSettle`，不再依赖 onTerminal 触发时才进入追踪集合；`disconnect` 用有界排空循环（3s 上限/100ms 轮询）等待集合清空后才 flush。曾出现 10s 上限在全量并行测试下引发超时级联，收紧为 3s/100ms（本地落盘为毫秒级）。
3. **trackSettle 死区**：`pendingSettles`/`trackSettle` 初始化移至 `PendingQueue` 创建之前——启动后立即到达的消息可能在连接完成前触发合批，原顺序会访问未初始化变量。影子 Promise 追踪不吞原始拒绝。
4. **首写失败回滚去重预约**：`recordAccepted` 持久化失败时删除本次 reservation 并返回 failed——写入失败后的重投递不会被永久误判为 duplicate。新增「写入失败 → 恢复 → 重投」测试。

### 评审四轮修复（2026-09-18）

1. **「重头重做」改为 journal 意图驱动**：三轮方案「先入队、成功后在 dispatcher 里重置」仍有两个窗口——identity 解析超过 600ms 合批窗时新任务先启动并续接旧会话；入队后、重置前崩溃则重启重放同样续接旧会话（`beforeSpawn` 位于 resume 解析之后，钩子内重置无效）。现由 `journal.redo(..., { resetSession: true })` 把重置意图随重派记录持久化，`runAgentBatch` 在 `startRunFlow` 解析 resume 与认领之前执行归档 + `sessions.clear` 并清旗；崩溃重放同一路径天然覆盖，旗标未清则重放幂等再执行。新增 e2e：门控认领证明重置严格先于 claim/spawn。
2. **「继续对话」成功文案按原始状态判断**：`journal.redo()` 原地把 `record.status` 改为 terminal，回调返回后再读状态使 uncertain 误报「该记录未曾执行」。改为点击时同步捕获 `wasUncertain`。新增断言：uncertain 继续对话回复「已在原会话」。
3. **停机生命周期跟踪再前置**：批次 Promise（模式解析→媒体/引用→策略→spawn→流→终态）此前只在 `processAgentStream` 创建处登记，disconnect 落在该死区时排空集合为空、flush 提前。现 PendingQueue 回调创建完整批次 Promise 即 `trackSettle`。新增 e2e：批次停在 spawn 前认领时断连，`disconnect` 返回即记录已落 terminal/rejected。
4. **reservation 回滚加对象同一性守卫**：`recordAccepted` 首写失败的无条件 `records.delete(k)` 可能删除写入期间被 `/new` 清空后以同 id 重建的新记录。现仅在 `records.get(k) === 本次 reservation` 时删除。新增替换场景单测。

### 评审五轮修复（2026-09-18）

1. **停机改为「显式取消 + 等真正落定」，废除固定 3s 排空上限**：四轮方案的 `disconnect` 有界排空（3s/100ms 轮询）只是把风险窗口挪了位置——媒体解析、引用获取、话题上下文等 spawn 前网络等待完全可能超 3s，超时后仍会 flush 并返回，进程退出即丢失该批次的后续状态写入。现 `startChannel` 持有 `shutdown: AbortController`，`disconnect` 在 `cancelAll` 后立即 `abort()`；新增 `raceShutdown(signal, label, promise)` 竞态辅助，包装全部 **spawn 前** 上游等待（chat 模式解析、`media.resolve`、`fetchQuotedContext` 循环、prompt 内 `fetchTopicContext`），并在 `startRunFlow` 前加同步 abort 守卫。被取消的批次从未 spawn，其 journal 记录保持 queued（本地认领/终态写入不参与竞态、必被等待），下次启动按「从未派发」语义安全重放。排空截止改为 `agentStopGraceMs + 10s`，仅作病态兜底（如卡死的本地写入），触发时 `log.warn('disconnect','drain-timeout')` 显式告警而非静默提前 flush。新增受控测试：门控认领停 4.2s（超旧 3s 上限）→ `disconnect` 实际等待至记录落 terminal/rejected 才返回；`fetchRawMessage` 无限挂起 → abort 后 `disconnect` 立即返回、记录保持 queued 且无运行。

### 评审六轮修复（2026-09-18）

1. **排空超时不再提前 flush/返回（P1）**：五轮的 `grace+10s` 截止超时后仍会告警并继续 flush 返回——若卡住的恰是 journal/terminal writer，仍是「flush 后继续写入 → 进程退出 → 状态丢失」的窗口。现排空**无提前返回截止**：`disconnect` 在 `pendingSettles` 清空前绝不 flush/返回；原阈值降级为纯观测项（新 `drain-stuck` 按周期重复告警，`shutdownDrainWarnMs` 可注入，默认 grace+10s）。真卡死时停机阻塞交由外部强杀，落回 journal 既有崩溃恢复语义（claimed→uncertain 不自动重跑、queued→重放）。新增测试：300ms 告警阈值 + 1.5s 门控认领 → 断言 `drain-stuck` 触发且 `disconnect` 仍等到记录落 terminal/rejected 才返回。
2. **被放弃的底层任务纳入生命周期跟踪（P2）**：SDK 的 REST/下载接口不接受 AbortSignal，`raceShutdown` 只能让调用方跳出、底层 Promise 仍会执行（媒体下载重命名、缓存清理等副作用）。现 `raceShutdown` 增加 `trackAbandoned`（传入 `trackSettle`）：abort 时把底层任务登记进排空集合，停机等到其副作用真正结束才 flush/返回，杜绝进程内重启后旧实例继续改共享媒体缓存。对应测试改为 `fetchRawMessage` 700ms 后落定 → `disconnect` 等待该任务结束（耗时 ≥500ms）才返回、记录保持 queued。
3. **正常停机取消不再进错误遥测（P2）**：`bridge-shutdown:*` 以普通 Error 抛出会被 flush 的 `log.fail` 记成 `✗ [flush.fail]`（error 级、入 telemetry）。现引入专门类型 `BridgeShutdownCancelled`（含 label，pre-spawn 守卫同用它），flush catch 命中时按 `log.info('flush','cancelled-by-shutdown')` 记录；测试断言取消路径零 `log.fail`、出现 info 级取消事件。

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
