# OPT-05：结构化交互与能力声明

状态：能力矩阵分片已实施（commit `1e4a8a3`）；纵向交互闭环未实施（见文末后续步骤）。优先级 P2。

## 目标

将后端实际支持的等待输入、审批、任务步骤等能力通过统一事件表达，并在飞书提供闭环。不能因为 Claude 支持某种交互，就对 Codex/CodeBuddy 显示同样按钮。

当前 `AgentEvent` 主要包含 text、thinking、tool_use、tool_result、usage 和终态；`AgentRun` 主要暴露事件、停止与退出等待。需要核查各后端公开协议，再决定怎样扩展，不能通过 prompt 模拟权限审批。

## 建议能力维度

公开思考、增量正文、输入请求、工具审批、即时补充要求、任务清单、上下文用量、原生历史。每项区分支持、不支持、部分支持；对版本差异建立契约测试。

不要将已有权限模式的映射解释为同等操作系统级隔离，也不要用能力声明抬高 profile 权限上限。

## 交互契约

- 每个请求绑定 runId、requestId、Scope、操作人、类型、过期时间和后端请求身份。
- 状态至少能区分等待、已回复、已取消、已过期；回复必须作用于原请求。
- run 已结束、权限已撤销、旧卡片重放或第二次点击时，不重复批准操作。
- 对多请求同时等待的情况，裸 `1/2/3` 不得歧义匹配。
- 传输失败与后端拒绝分别反馈。只有后端确认收到响应后才能显示已处理。
- 不支持双向交互的后端明确提示限制，不渲染无效按钮。

## 借鉴与限制

[Claude-to-IM](https://github.com/op7418/Claude-to-IM-skill) 的远程审批和 [agents-to-im](https://github.com/francize/agents-to-im) 的会话身份可作产品参考。应复用本项目回调签名、nonce、策略指纹和权限校验，不能用无签名控制替换它们。

运行中补充消息建议明确分为“下一轮”“改变当前要求”“停止后重做”。默认保持当前排队行为；只有实现后端 steer/input 能力后才能开放即时补充。

## 入口与分片

入口：`src/agent/types.ts`、`src/agent/capability.ts`、各 Adapter、`src/runtime/run-executor.ts`、`src/card/dispatcher.ts`、`src/card/callback-auth.ts`。

先交付能力矩阵与协议证据，再挑一个有明确协议支持的后端、一个交互类型完成纵向闭环。不要一次增加所有后端和所有事件。

## 验收

- 支持/不支持后端展示不同且准确的控制。
- 同时两个请求、旧卡片、跨 Scope、过期、终止后回复和重复点击均正确处理。
- 恶意构造请求 ID 或 runId 不能跨权限批准操作。
- 等待用户输入不会被误报为 Agent 卡死；超时策略有独立语义。
- 后端协议变化时可诊断，不能默默丢弃请求并永远显示思考中。

## 边界

本任务不是授权改成自动批准全部工具。权限默认值、审批粒度及后台执行范围是独立产品决策。

## 实施记录（2026-09-17，基线 ee12588）

### 已实施：能力矩阵与协议证据（规格第一分片）

`src/agent/capability.ts` 的 `AgentCapability` 新增 `interactions: InteractionCapabilities`，契约测试锁定取值：

| 维度 | claude | codebuddy | codex | 协议证据 |
|---|---|---|---|---|
| thinkingEvents | ✓ | ✓ | ✗ | claude/codebuddy 走 `src/agent/claude/stream-json.ts`（`block.type==='thinking'` 映射）；codex `src/agent/codex/jsonl.ts` 只映射 agent_message/命令/token_count，无 reasoning item |
| incrementalText | ✓ | ✓ | ✓ | claude stream-json `text` delta；codex `agent_message` 增量与 `final_text` 分流 |
| usageEvents | ✓ | ✓ | ✓ | 两侧 translator 均映射 token usage |
| nativeHistory | ✓ | ✓ | ✗ | 与既有 `supportsNativeHistory` 一致（codex 按 threadId 续聊，无历史 provider） |
| inputRequest | ✗ | ✗ | ✗ | 三个后端在桥接器使用的 `-p`/exec 模式下均无已核验的结构化输入请求通道 |
| toolApproval | ✗ | ✗ | ✗ | 同上；未核验前不得渲染审批按钮，也不得用 prompt 模拟审批 |
| taskList | ✗ | ✗ | ✗ | 无结构化 plan/task 事件映射 |
| steer | ✗ | ✗ | ✗ | 运行中补充消息维持既有"下一轮"排队语义 |

已接线的唯一消费点：`/thinking` 在 `thinkingEvents=false` 的后端上明确答复"该 agent 不产生思考事件"，替代笼统的"暂无记录"。矩阵的契约测试（5 项）防止后续未经声明就开放交互控制。

### 未实施：纵向交互闭环（规格第二分片）

三个后端在当前调用模式下都没有现成的双向交互协议（Claude 的审批通道需要 `--permission-prompt-tool` + MCP server 链路；Codex proto 的审批事件未被本 fork 的 exec 封装暴露）。按规格"先核验协议，不通过 prompt 模拟审批"，本切片不猜测协议。后续步骤（按顺序）：

1. 对 `claude --help` / `codex --help` 与对应版本文档核验审批/输入请求的实际调用方式，并记录到本文件。
2. 选 Claude 一个交互类型（建议 toolApproval）做端到端：MCP prompt-tool → bridge 卡片按钮（复用 `callback-auth` 签名 + 新的终态卡片回调校验语义，见 OPT-01 遗留）→ `control_response` 回写 → 后端确认。
3. 契约测试加入矩阵：该后端该维度翻 true，其他后端保持 false。
4. `requestId`/过期/一次性点击/跨 scope 拒绝按"交互契约"一节逐条验收。
