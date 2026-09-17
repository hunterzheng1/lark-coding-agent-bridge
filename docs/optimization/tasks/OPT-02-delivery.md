# OPT-02：卡片更新调度与可观测性

状态：已实施（commit `58898f2`），本地验证通过、未压测线上行为。优先级 P1。实施记录见文末。

## 问题

`processAgentStream` 逐事件等待 `safeFlush`，而 `EventFanout` 可以继续读取并缓存事件。网络慢时呈现可能落后。`ResilientCardUpdater` 默认立即尝试两次后换卡，未在该层分类失败原因。以上为源码风险，尚无压测证明实际延迟或内存规模。

当前已存在串行更新、心跳、流式续期和 rollover，必须复用或明确替代，不能再叠一套相互竞争的定时器。

## 目标契约

- 接收/归并事件不必等每次网络更新；待投递的普通快照最多保留最新版本。
- 终态快照优先且必须尝试送达；旧运行态快照不得覆盖终态。
- 收到 done、Agent 进程退出、最终卡片成功送达分别记录，不能合成一个“完成”。
- 保留事件记录与丢弃中间展示快照是两回事。OPT-01 的完整记录不能因快照合并而丢失。
- 同一张卡片的 sequence、续期、关闭和后继卡片切换必须共享有序控制。

## 推荐设计

使用独立的投递调度器管理最新快照和终态屏障。启动时读现有逻辑，选择最小接口，例如 `offer(snapshot)` 与可等待的 `finish(terminalSnapshot)`。刷新间隔先作为可测试参数，通过基线数据决定默认值。

记录 `lastAgentEventAt`、`lastDeliverySuccessAt`、待发送版本/已发送版本和最近错误类别。用户界面分别表达“暂无新事件”和“卡片更新延迟”；不能用“进程仍在运行”证明 Agent 有进展。

| 错误类别 | 推荐处理 |
|---|---|
| 限流 | 遵循可用的服务端等待信息，带上限退避；合并普通快照 |
| 临时网络错误 | 有界重试，恢复后发最新快照 |
| 流式已关闭 | 复用续期/换卡机制，保持终态顺序 |
| payload 无效或超限 | 交给预算/降级路径，不重复提交同一无效内容 |
| 无权限/对象不可用 | 标记可操作错误，不无限换卡 |

具体错误码必须结合实际 SDK 与对应飞书接口文档核验，不从现有注释推导所有接口的限制。

## 入口与依赖

`src/bot/channel.ts`、`src/runtime/run-executor.ts`、`src/card/resilient-updater.ts`、`src/card/streaming-session.ts`、`src/core/logger.ts`。先交付基线观测，再改调度；与 OPT-03 协商预算拒绝接口。

## 验收

- 用假时钟/可控 Promise 模拟高频事件和慢 API，待发送快照数保持有界。
- 慢请求期间到达更多事件，恢复后送最新内容，无需逐条追赶所有旧快照。
- done/stop/timeout 与正在重试、续期同时发生时，终态不被回退覆盖。
- 最终投递失败被记录且可见，不导致无限等待；新运行的状态不被旧运行污染。
- 瞬时错误恢复不重复发送完整最终答复；永久内容错误不触发无限换卡。
- 观测事件到投递延迟、失败率、rollover 次数和缓存峰值；给出实测结果，不凭空写 SLA。

## 边界

本任务不承诺所有历史事件都保存在内存。缓存裁剪若影响订阅者语义，应单独明确游标与生命周期，不能只删数组头部。未测量前不要声称内存泄漏或性能提升比例。

## 实施记录（2026-09-17，基线 d5efacd）

### 所选设计（相对推荐设计的取舍）

- `src/card/snapshot-scheduler.ts` 新增 `SnapshotScheduler<RunState>`，接口即推荐的 `offer(snapshot)` / `finish(terminalSnapshot)`。事件循环每次状态变化 `offer`，不再等待网络；同一时刻至多一个在途发送、至多一个待发送快照（总是最新），慢 API 下中间快照被合并（`coalesced` 计数）。`finish()` 可等待、幂等；设置后新的 `offer` 被忽略（终态屏障），终态在在途发送完成后最后送达，旧运行态快照不可能覆盖终态；终态发送有界重试（默认 3 次，`maxAttempts` 可调）后放弃并记录失败。
- **刷新间隔参数未加入**：合并上限由"一个在途 + 一个待发"结构保证，节奏由实际更新延迟与 SDK `streamThrottleMs`（400ms）决定；再加固定节奏定时器会与续期/心跳形成规格明确反对的多套竞争定时器。如基线数据显示需要节流再作为参数加入。
- `src/card/delivery-errors.ts` 错误分类：`stream_closed`（200850/300309、streaming timeout/closed、本地 "streaming card session closed"，前两者为代码内已验证映射）、`invalid_payload`（230028 审计拒绝为已验证；invalid param/`card.content` 为启发式）、`rate_limited`（9499 与消息启发式）、`forbidden`、`transient_network`、`unknown`。未按文档核验全部错误码，类别名已进入日志便于现场校准。
- `ResilientCardUpdater`：永久类（invalid_payload/forbidden）第一次失败即抛出，不重试、不换卡（同一内容换卡同样失败）；`rate_limited` 在重试间注入有上限退避（`min(250ms×attempt, 1s)`，`sleep` 可注入）；其余类别保持原重试→换卡行为。新增 `rolloverCount`、`lastErrorCategory`。
- 观测：终态时输出 `stream.delivery-stats`（offered/delivered/coalesced/failures/lastErrorCategory/deliveryLagMs）与 `card_delivery_lag_ms`、`card_delivery_failures`、`card_delivery_coalesced` 指标。`deliveryLagMs` = 最后送达成功时间 − 最后 agent 事件时间，负值/缺失表示终态未确认送达。done 接收（`card.final`）、进程退出（run-executor 已有 `run.completed`/`post-done-exit-*`）、最终送达（`lastDeliverySuccessAt`）三者分别可追溯。

### 验证证据

- 新增 `tests/unit/card/snapshot-scheduler.test.ts` 8 项（合并、串行、终态屏障、可等待、有界重试、失败不停泵、幂等 finish、统计）、`tests/unit/card/delivery-errors.test.ts` 7 项分类；`tests/unit/card/resilient-updater.test.ts` 增 4 项分类行为（永久错误不换卡、退避、计数）；`tests/integration/bot/card-stream-integration.test.ts` 增 3 项（慢 API + 事件突发只送 2 次且最后为终态、瞬时失败不停流、终态不被回退）。
- 上述测试在实现前运行失败（模块不存在/断言失败），实现后通过；投递链路 6 文件 46 项连续 3 轮全绿。
- 全量 `pnpm test`：103 文件、709 项中 707 通过；唯一失败 `tests/unit/observability/logger.test.ts` 2 项为 e387662 基线已存在的既有失败（telemetry tags 断言），与本任务无关。`pnpm typecheck` 通过。

### 剩余事项

- 终态重试之间无退避延迟（连续 3 次立即重试）；如现场出现终态瞬断需再加。
- 错误码映射需结合飞书接口文档与现场日志校准（类别已可在 `delivery-stats.lastErrorCategory` 观察）。
- 尚未采集线上基线数据（事件→送达延迟、失败率、rollover 次数分布）；指标已埋点，待部署后采样。
- `EventFanout.buffer` 无界保留事件仍未裁剪（规格已声明不在本任务范围）。
