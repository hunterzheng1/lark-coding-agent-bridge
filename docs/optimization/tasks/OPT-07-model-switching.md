# OPT-07：会话模型选择

日期：2026-09-18。源码基线：`6573d54`。状态：Slice A（命令闭环）、Slice B（选择卡与目录发现）、Slice C（忙时切换与恢复一致性）均已实施并本地验证通过（各轮 `pnpm ci:local` 全绿）；随后完成一轮独立评审修复（见文末「实施记录：评审修复」），修复后 `pnpm ci:local` 全绿（868 测试）；现场/真机验证仍未执行。以下交互、权限和一致性规则属于设计建议，实施取舍见文末各段「实施记录」。

## 目标与结论

在飞书内查看当前 Agent 的模型候选、点击切换，并通过快捷命令指定模型。保留聊天上下文，不要求用户登录服务器修改 CLI 配置。第一版只切换模型，不切换 Agent 后端，不自动改变权限或推理强度。

技术上可行。主要工作是命令入口、Scope 偏好、运行参数贯通及列表发现。模型列表必须区分「上游返回的候选」「本地候选」「手动输入」，不能宣称所有条目都已验证账号可用。

外部能力与官方来源见 [模型切换调研](../05-model-switching-research.md)。本文的交互、权限和一致性规则属于设计建议。

## 已核实的本地事实

| 位置 | 当前行为 | 实施含义 |
|---|---|---|
| `src/commands/index.ts` 的 handlers、tryHandleCommand | 没有 `/model`；未知命令返回 false | `/model` 继续进入普通消息路径，桥接层不会打开选择界面 |
| `src/bot/channel.ts` 的命令处理分支 | handled 后调用 `pending.cancel(scope)` | 不能只添加 handler；查看列表和切换都不得清空队列 |
| `src/agent/types.ts`、`src/runtime/run-executor.ts` | 已有 `model?: string`，Executor 会转发 | 可复用现有参数，不需要重建执行器 |
| `src/bot/run-flow.ts`、`src/bot/comments.ts`、`/doctor` submit | 当前未传入 model | 必须明确各运行入口的模型来源，避免只覆盖一种消息路径 |
| Claude、CodeBuddy adapter | 已将 opts.model 转为 `--model` | 尚未形成可用的用户入口 |
| Codex adapter、`src/agent/codex/argv.ts` | 未读取或转发 model | 新运行与 resume 都需要补齐并单独验证参数位置 |
| `src/card/config-card.ts`、`src/card/dispatcher.ts` | 已有 select_static、表单值与命令回调 | 复用卡片组件和访问控制链路 |
| `src/session/store.ts` | 没有模型偏好；set、clear、load 显式处理字段 | 不可只增加字段而漏掉会话更新与重启加载行为 |
| `src/agent/types.ts`、`src/card/run-state.ts` | system 事件允许 model；RunState 尚无模型字段 | 应区分选择值和上游报告值，不能用配置值冒充实际模型 |

上述结论不等于上游所有 CLI 都不支持非交互 `/model`。桥接器需要提供统一界面和偏好语义，不能依赖把一段 slash 文本交给不同 CLI 后产生相同行为。

## 推荐交互

### 命令与入口

| 操作 | 建议行为 |
|---|---|
| `/model` | 打开模型选择卡，不启动 Agent，不改变队列 |
| `/model <模型 ID 或后端支持的别名>` | 保存当前 Scope、当前 Agent 的模型选择 |
| `/model reset` | 清除桥接器覆盖，后续运行不传模型参数，跟随后端解析规则 |
| `/model refresh` | 刷新候选列表；失败保留旧列表并显示来源时间 |
| `/status` 的「切换模型」按钮 | 打开同一选择卡 |
| `/help` | 介绍上述命令及作用范围 |

`reset` 与 `refresh` 为保留子命令；自定义输入表单可提交恰好同名的模型 ID，避免解析歧义。可另设 `set <id>` 作为无歧义语法，实施时统一帮助说明。

第一版采用「下拉选择 + 应用」：移动端可用，模型多时卡片仍短，也能在提交前看清作用范围。列表较少时仍使用同一交互，不根据数量频繁换界面。

```text
模型设置 · CodeBuddy
作用范围：当前话题（同话题成员共享）
后续消息：跟随 CLI 设置
上次运行实际模型：<上游报告值，或“未报告”>

选择模型  [ 搜索/选择候选 ▼ ]
候选来源：<CLI / 本地候选> · <更新时间>
未经过本账号实际调用验证

[应用模型]  [跟随 CLI 设置]  [刷新列表]
[手动输入模型 ID]

切换成功后的新消息使用新设置。
已接收的任务保留原设置；不会中断当前任务。
```

“搜索”仅在当前卡片组件和客户端验证支持后启用；否则分页或限制首屏数量，并保留手动输入。示意内容不是已经存在的产品界面。

应用成功后的文案为「已保存：<模型>，此后收到的消息使用该设置」。只有上游运行事件明确报告后，才显示「本次实际模型：<模型>」。保持选择卡可再次打开；旧卡片提交要检查版本，防止覆盖更新后的选择。

### 为什么不建议第一版自动选模型

任务分类、成本和速度都依赖账号、提供商及实际测量。自动替用户选模型会引入结果波动，也可能改变费用。先做明确选择和最近使用，后续可提供用户自行绑定的「快速处理」「复杂任务」预设；预设展示准确模型 ID，不自行宣称某模型必然便宜或更强。

## 作用范围、队列与持久化

1. 偏好按 Profile + Scope + Agent 隔离。普通群共享聊天偏好，话题群按话题隔离；不改 CLI 的全局配置。
2. 建议私聊授权用户可修改自己的 Scope；群和话题中所有授权成员可查看，修改默认仅 bot owner／管理员允许，避免互相改变后续任务模型。群内是否开放给全部授权成员属于可调整产品策略。
3. `/new` 清除对话上下文但保留模型偏好；`/resume` 不覆盖 Scope 的显式模型选择。切换 Agent 时不复用另一后端的模型 ID。
4. 「跟随 CLI 设置」的精确定义是不传 `--model`，不承诺恢复到某个固定模型。CLI 可能根据环境、配置或恢复会话决定实际模型。
5. 模型选择在普通消息被持久化接收时形成不可变快照。切换完成前已接收的消息，包括排队中的消息，继续使用原快照；正在运行的任务不重启。
6. 合批只合并相同模型快照的消息；不同选择版本不合成一个 prompt。保存模型版本和来源，避免晚读取全局可变状态。
7. 入站日志保存上述快照。崩溃恢复沿用原快照；老日志缺字段时遵循旧行为，即不传模型覆盖。恢复卡若提供「用当前模型重做」，必须作为明确的独立动作，不静默替换。
8. 列表、刷新、切换命令均不清空 PendingQueue。建议命令返回明确的队列处理策略，保留其他命令原有语义，避免用一个 handled 布尔值承载不同副作用。
9. 偏好更新必须等持久化成功后才回执成功。并发提交使用 revision 检查；落盘失败保留原值。复用项目锁和原子写入约束，不把写入失败隐藏在异步任务里。

接收快照规则会涉及队列和恢复模块，不能当作一个仅改卡片的小功能。如果希望更快交付，允许第一阶段在 Scope 有运行或排队任务时拒绝修改并解释原因；查看列表始终允许。该简化必须明确交付边界，不能宣称已经支持忙时切换。

## 模型目录和兼容策略

- 后端模块负责候选发现与模型参数规则，公共 card/bot 只消费统一描述，不导入 Codex 内部实现。
- 候选记录至少有 ID、展示名、来源、获取时间；账号可用性可为 unknown，不以一个 available=true 代替多个不同概念。
- 优先使用已验证版本支持的结构化目录。CodeBuddy 的 help 文本可作兼容候选源，但解析失败不能让整个 `/model` 失效；不把交互式 `/model list` 直接视为已验证的机器接口。
- Codex 已有目录能力，应检测实际 binary 版本和命令支持；不为此强制将现有 exec 架构迁移到 app-server。
- 列表查询采用与实际运行一致的 binary、Profile、认证环境、提供商和必要工作目录。缓存按这些维度隔离，不能把 A 账号候选当成 B 账号目录。
- 查询有超时和缓存；失败时保留当前选择、最近使用与手动输入。非结构化候选需明确「尚未验证可用」。不要靠实际生成请求探测所有模型。
- 只读取所需模型元数据，不在日志或文档输出凭证、完整用户配置。模型 ID 作为独立 argv 参数传递，不拼接 shell 命令。
- 语法校验与账号权限校验分开：本地通过不代表远端支持。运行拒绝模型时保留用户任务和上下文，给出重新选择入口；不自动换模型重跑可能产生副作用的任务。
- 续接时显式模型参数是否生效，需逐后端、逐目标 CLI 版本验证；不兼容时保留会话，解释限制并让用户决定是否新开会话。

## 实施切片

### A：可用的命令闭环

- 注册命令；调整命令的队列副作用策略。
- 保存 Scope 模型偏好；支持查看、直接指定、reset。
- 贯通 RunExecutor 与三种 adapter；Codex 覆盖 exec 和 resume。
- `/status` 展示选择值和来源；忙时修改若暂不支持，明确拒绝。
- 文档评论使用其独立 Scope 偏好，第一版没有设置入口则保持 CLI 默认；`/doctor` 使用独立诊断 Scope 默认，不继承聊天自定义模型，保证模型错误时仍能诊断。为这两个入口写明规则和测试。

### B：选择卡与目录

- 统一目录接口、各后端能力检测、超时与缓存。
- 卡片选择、手动输入、刷新、默认入口；文本回复模式仍可通过命令完成全流程。
- 回调绑定 Profile、Scope、Agent、操作者权限及偏好 revision；过期、重复、跨话题回调不能误改其他范围。
- 严格限制模型 ID 和展示内容长度，遵守现有卡片预算。

### C：忙时切换与恢复一致性

- 入站模型快照、分组合批、日志兼容和恢复一致性。
- 明确反馈当前运行模型与后续消息设置，避免把旧运行标成新模型。
- 加入最近使用；推理强度、个人预设、跨 Agent 选择作为后续独立能力评估。

## 验收矩阵

| 场景 | 通过条件 |
|---|---|
| `/model`、刷新列表 | 不调用生成、不清队列、不改变会话 |
| 新运行、续接 | 三个后端的实际 argv 都携带期望 ID，CodeBuddy 保持多行 system prompt 位于末尾 |
| Scope 隔离 | 普通群、不同话题、不同 Profile、不同 Agent 互不串用 |
| `/new`、重启、`/resume`、reset | 偏好按本文规则保持；reset 后不再传参数 |
| 活动任务、队列、合批 | A 切 B 不改变已接收任务；不同快照不合批；或 A 阶段明确拒绝忙时修改 |
| 崩溃恢复 | 恢复原选择；旧日志无快照时仍可处理 |
| 权限与回调 | 未授权、跨 Scope、过期卡、旧 revision 被拒绝；文本和卡片规则相同 |
| 无网络、旧版本、列表解析失败 | 仍能看到当前设置并手动输入；不展示虚假的已验证状态 |
| 落盘失败、重复提交 | 不误报成功，不丢旧偏好；重复回调不产生重复副作用 |
| 无效模型或无权限 | 不自动改用其他模型重试；用户能重新选择，原上下文保留 |
| 实际模型展示 | 未报告时明确未知；上游报告值与请求值不一致时如实显示 |

实施时使用 fake-agent、fake-channel、fake-executable 做参数和队列测试；模型实际可用性、续接上下文和飞书移动端交互需要单独现场验证。本文只做源码与 CLI help 检查，没有运行真实模型请求、飞书点击测试或产品测试套件。

## 实施记录：Slice A（2026-09-18，基线 `361808e` 之后）

本轮只交付 Slice A「可用的命令闭环」，`pnpm ci:local` 全绿（typecheck、817 测试、build）。Slice B/C 明确未做，边界如下。

### 已实现

- 命令入口 `src/commands/index.ts`：新增 `/model`（查看当前 Scope+Agent 的选择与来源）、`/model <模型 ID>`（保存）、`/model reset`（清除覆盖，后续运行不传 `--model`）。`/model refresh` 返回「候选发现尚未支持」的说明，不谎称已具备列表能力。模型 ID 保留原始大小写；`reset`/`refresh` 作为保留子命令按小写匹配。
- 语法校验 `validateModelId`：拒绝空值、超过 120 字符、含空白/控制字符、以 `-` 开头的输入；本地语法通过不代表账号可用（与权限校验分离）。ID 作为独立 argv 元素传递，不拼接 shell 命令。
- 队列策略（rule 8）：`tryHandleCommand` 仍返回布尔（保留其他命令语义与既有测试），新增导出 `commandKeepsPendingQueue(content)`；`src/bot/channel.ts` 在 handled 后据此决定 `pending.cancel` 或 `command-keep-queue` 分支。`/model` 全程不清空 PendingQueue。`PendingQueue.has(scope)` 供忙时判定。
- 持久化（rule 1/2/9）：`src/session/store.ts` 的 `SessionEntry.modelPreferences` 按 Agent 后端 id 分桶，实现 Profile（独立 sessions 文件）× Scope × Agent 隔离。`setModelPreference`/`clearModelPreference` 为 durable：await 落盘成功后才返回，写失败回滚原值并抛出（命令回「保存失败，已保留原设置」）。`set()`/`clear()`/`load()` 均已带该字段；`/new`（clear）保留模型偏好、仅清 sessionId/cwd/lastRunOutput；老日志缺字段按「不传覆盖」处理。
- 运行贯通（rule 4）：`startRunFlow` 新增 `model` 入参并转发到 `RunExecutor.submit`；`runAgentBatch` 以 `capability.agentId` 读取偏好后传入。`/doctor`（`${scope}:doctor`）与云文档评论各自直接 `executor.submit`、不读聊天偏好，天然保持诊断/评论走 CLI 默认。
- Codex 参数（acceptance「新运行、续接」）：`buildCodexArgs` 把 `--model <id>` 作为 global flag 置于 `-C` 之后、`resume` 之前，覆盖 fresh 与 resume 两条路径；Codex adapter 传入 `opts.model` 并在 spawn 日志记录。Claude、CodeBuddy 既有 `--model` 转发保持不变。
- 展示：`/status` 卡片新增 model 行（选择值 + 来源「桥接覆盖／跟随 CLI 设置」），`/help` 增列 `/model` 说明。这是「选择值」，非上游报告的「实际模型」，后者属 Slice C。

### 有意采取的 Slice A 简化（不宣称已支持忙时切换）

- 忙时策略：Scope 有活动运行（`activeRuns.get`）或排队消息（`hasPendingForScope`）时，set/reset 被明确拒绝并解释原因；查看始终允许。因此未引入入站模型快照、分组合批与恢复一致性（Slice C）。运行派发时读取当前偏好即为本批次目标值。
- 权限默认：修改仅 bot owner／管理员（rule 2 的保守档）；查看对所有通过准入的用户开放。群内是否放开给全部授权成员仍为可调整产品策略，本轮未开。
- 无选择卡、无列表发现、无「切换模型」按钮、无最近使用（Slice B/C）。

### 验收矩阵对照（本轮）

- `/model`、查看：不调用生成、不清队列、不改会话 —— 单测 `commandKeepsPendingQueue`、命令测试 view 不改状态覆盖。
- 新运行、续接 argv 携带期望 ID：`codex-argv` 单测 + `codex-adapter` 进程测试（fresh/resume `--model` 位置）覆盖 Codex；Claude/CodeBuddy 沿用既有转发。
- Scope／Profile／Agent 隔离：`model-preference` 单测（分后端互不串用）+ 命令测试覆盖。
- `/new`、reset、重启加载：`model-preference` 单测（clear 保留、reload 保留、reset 清除）覆盖。
- 活动任务、队列：命令测试（运行中/排队中拒绝、忙时仍可查）覆盖。
- 落盘失败：durable 写回滚在 store 层实现；未做真实磁盘故障注入（后续可加 gate 化受控测试）。
- 无效模型：命令测试（`--evil` 被拒且不写）覆盖。
- 崩溃恢复、实际模型展示、权限/回调过期：属 Slice B/C，未覆盖。

模型真实可用性、续接上下文是否覆盖上次模型、飞书移动端交互仍需现场验证，本轮未运行真实模型请求。

## 实施记录：Slice B（2026-09-18，基线 `cb73dca` 之后）

交付 Slice B「选择卡与目录」，`pnpm ci:local` 全绿（typecheck、843 测试、build，较 A 增 26 项）。Slice C 仍未做。

### 目录发现（后端各自适配，公共层只消费统一描述）

- 新增公共门面 `src/agent/model-catalog.ts`：`discoverModelCatalog()` 统一返回 `{ agentId, status, candidates[{id,displayName,source}], fetchedAt, note, unverified }`。按「后端 + binary + tenant + appId」维度缓存，TTL 5 分钟；命中缓存不再查上游，查询失败不清缓存（保留上次好值），且任何情况下手动输入都可用。门面只被 commands/bot/card 引用，后端 runner（`agent/codex/models`、`agent/codebuddy/models`、`agent/claude/models`）藏在门面内，静态架构契约（`commands/index.ts` 不含 `agent/codex`/`agent/codebuddy`）保持通过。
- Codex：`codex debug models --bundled`（本机 0.144.6 实测存在），离线读随二进制附带的 JSON 目录，解析 `slug/display_name`、过滤 `visibility=hidden`、按 `priority` 排序。用 `--bundled` 避免网络刷新与账号副作用；标注「离线目录，未经本账号实时验证」（`unverified=true`）。
- CodeBuddy：`codebuddy --help` 的 `--model` 说明里 `Currently supported: (…)` 作为兼容降级源解析（本机 2.154.0）。帮助文本非稳定协议、非账号授权证明；解析失败只让该项回退到手动输入，不拖垮 `/model`。
- Claude：无稳定列表命令，返回固定的常见别名提示（sonnet/opus/haiku）+ `status='static'`，不 spawn 进程；实际以 CLI 解析为准。
- 发现走只读子进程 runner（argv 数组、超时 kill、捕获 stdout），不拼 shell、不打印凭证。

### 选择卡与命令

- `src/card/model-card.ts`：schema 2.0 表单，`select_static`（候选，≤30 项、id≤120、展示名截断）+ 手动输入框 + 「应用模型／跟随 CLI 设置／刷新列表」按钮；顶部如实显示当前选择、候选来源与更新时间、未验证提示；失败态显示获取失败并保留手动输入。非管理员进入「查看模式」，隐藏应用/恢复、保留刷新。
- 命令路由（`handleModel`）：`/model`→选择卡；`/model list`→文本候选（文本回复模式仍能完成全流程）；`/model <id>`→保存；`/model reset`→恢复；`/model refresh`→重新发现并出卡；卡片回调 `model.submit`/`model.reset`/`model.refresh`/`model.open`。`/status` 增「🧠 切换模型」按钮（`model.open`）。
- 变更类操作统一 `guardModelMutation`：管理员校验 → revision 新鲜度校验 → 忙时校验，任一不过即回复原因且不写。手动输入优先于下拉，且可提交恰为保留字的模型 ID（仅做语法校验，账号可用性交运行期）。
- revision：`SessionStore.modelRevision` 每 scope 单调递增、durable、跨 `/new`(clear) 与重启保留。选择卡绑定当时 revision；过期卡提交被拒（「该选择卡已过期，请重新打开」），不误改新值。card 派发器现传入 `hasPendingForScope`，卡片提交/恢复同样受排队消息忙时闸门约束。

### Slice B 仍未覆盖（属 Slice C / 待现场验证）

- 入站模型快照、按快照分组合批、崩溃恢复一致性与「上次运行实际模型」展示（`RunState`/system 报告值）仍未做；忙时依旧拒绝修改而非排队切换。
- 最近使用、跨 Agent 选择、推理强度/预设留作后续。
- 候选是否本账号可调用、续接是否覆盖上次模型、飞书移动端点击/重复回调/过期卡行为：均只做了源码与本机只读命令核对，未运行真实模型请求或飞书点击测试，需现场单独验证。

### 验证

- 门面解析（Codex/CodeBuddy/Claude）与缓存 TTL/失败/超时/账号隔离：`tests/unit/agent/model-catalog.test.ts`。
- 只读 runner 真实 spawn + 解析、非零退出降级、Claude 不 spawn：`tests/process/model-discovery.test.ts`。
- 卡片结构（revision 绑定、手动优先、选项预算、查看模式、失败态）：`tests/unit/card/model-card.test.ts`。
- revision 递增/保留：`tests/unit/session/model-revision.test.ts`。
- 命令与卡片回调（出卡、文本列表、submit 应用/过期/越权/忙时拒绝、手动保留字、按后端隔离、不清队列）：`tests/integration/commands/model-command.test.ts`。

模型真实可用性、续接覆盖与飞书移动端交互仍需现场验证，本轮未触发付费模型调用。

## 实施记录：Slice C（2026-09-18，基线 `1de794a` 之后）

交付 Slice C「忙时切换与恢复一致性」，`pnpm ci:local` 全绿（typecheck、853 测试、build，较 B 增 10 项）。OPT-07 三个切片至此全部实现；现场/真机验证仍未执行。

### 入站模型快照与合批（rule 5/6/7）

- `InboundRecord.model`：普通消息被 `recordAccepted` 持久化接收时，冻结其 scope+agent 的当前模型覆盖为不可变快照（缺省=无覆盖/跟随 CLI）。之后 `/model` 改动不回写已接收（含排队中）消息的目标模型。
- `onFlush` 按每条消息落盘的快照，将一次 flush 拆成「连续同快照」的分组，逐组 `await runAgentBatch`（ActiveRuns 每 scope 单运行，故串行）。不同快照永不合入一个 prompt；非相邻同快照也不跨序合并。`runAgentBatch` 改用分组的显式 `model`，不再于派发时读全局可变偏好。
- 崩溃恢复：`recoverOnStartup` requeue 的记录按其原快照派发；`redo()` 保留原始快照（普通重做不静默改目标模型；「用当前模型重做」若要做须作为独立动作，本轮未加）。老日志无 `model` 字段→无覆盖，沿用旧行为。两组间若停机，未运行记录的 journal 仍为 `queued`，下次启动重放。

### 允许忙时切换（替换 A/B 的忙时拒绝）

- `guardModelMutation` 去掉忙时闸门，仅保留管理员校验 + revision 新鲜度校验。因为运行中任务与排队消息各自持快照，切换只影响其后接收的消息，不重启、不改写进行中任务。
- 移除随之失效的 `hasPendingForScope` 接线（CommandContext 字段、intake/dispatcher 注入）与 `PendingQueue.has`；`commandKeepsPendingQueue`（A）保留，`/model` 仍不清空队列。

### 实际模型展示（acceptance「实际模型展示」）

- `RunState.reportedModel`：仅当上游 `system` 事件报告 model 时记录（Codex/CodeBuddy 未报告则不填），绝不猜测。
- `formatModelNoticeSegment`（纯函数）：完成通知里如实呈现——报告了就显示「本次模型：<reported>」（与请求值不一致也照报）；只请求未获确认则「请求模型：<req>（未收到实际模型确认）」；没请求则不加噪声。

### 仍未做

- 最近使用、跨 Agent 选择、推理强度/个人预设；恢复卡「用当前模型重做」的独立入口。
- 候选是否账号可调用、续接是否覆盖上次模型、飞书移动端点击/重复回调/过期卡、真机快照/合批行为：均只源码级与本机只读核对，未跑真实模型请求或飞书点击，需现场验证。

### 验证（新增）

- 快照合批/顺序、停机 requeue 沿用原快照、老日志无字段不覆盖：`tests/integration/bot/inbound-recovery.test.ts`（复用 OPT-04 e2e 栈）。
- 分组纯函数、通知片段纯函数、journal 快照持久化与 redo 保留：`tests/unit/bot/model-snapshot.test.ts`。
- 命令层忙时切换现为允许：`tests/integration/commands/model-command.test.ts`。

OPT-04 的 claim/terminal/uncertain/停机跟踪等既有用例在本轮全量回归中保持全绿。

## 实施记录：评审修复（2026-09-18，基线 `b2b5793` 之后）

独立双轴评审（Standards/Spec 子代理 + 本机 `pnpm ci:local` 复验）指出若干缺口，本轮全部修复；修复后 `pnpm ci:local` 全绿（115 个测试文件、868 测试，较 Slice C 净增 15 项）。现场/真机验证仍未执行。

### Spec 轴修复

- 「失败保留旧列表并显示来源时间」（推荐交互表）真实落地：`discoverModelCatalog` 失败（抛错或 failed 结果）时若存在上次成功结果，改以新增 `status='stale'` 返回旧列表，保留原 `fetchedAt`（来源时间由展示层渲染），不触碰缓存条目（后续成功仍正常替换）。选择卡对 stale 显示「⚠️ note · 上次更新 <时间>」且旧候选仍可选；`/model list` 文本补「上次更新」行。Slice B 记录中「查询失败不清缓存（保留上次好值）」的声明自本轮起与实际行为一致（此前过期条目保留但永不服务，属夸大）。无历史列表时仍返回空候选 failed 态，不虚构。
- 命令/文档评论入口规则测试补齐（Slice A 遗留）：`/doctor` 在 scope 已设聊天模型覆盖时探测仍不携带 model（doctor-status 测试）；文档评论运行不继承聊天偏好（comment-run-flow 测试）。
- revision 提交时校验（TOCTOU 修复）：`setModelPreference`/`clearModelPreference` 新增 `expectedRevision` 乐观参数，提交时（而非仅 guard 读取时）核对 revision，不匹配抛 `ModelRevisionConflictError` 且不产生任何写入；命令层 guard 透传卡片绑定 revision，冲突回复与 guard 一致的「已过期」文案。并发双卡同 revision 提交现在恰好一胜一拒（集成测试）。
- Scope 隔离测试补齐：Profile（独立 sessions 文件互不可见）与普通群/话题 scope 的模型层直接测试。
- 无 journal 回退路径的快照语义：intake 现将接受时冻结的模型快照同步写入按消息对象的 WeakMap sidecar，flush 分组在无 journal 时按消息各自的 intake 快照取值（原实现整批读一次 flush 时实时偏好）。生产始终创建 journal，此修复面向未来调用方的语义一致性。

### Standards 轴修复（判断性建议）

- `escapeMd` 三份私有拷贝收敛为 `src/card/markdown.ts` 单一实现（templates/model-card 引用）。
- `{ value?, source: 'override'|'cli' }` 数据团具名为 `ModelSelection`（model-card 导出），`modelSelection(pref)` 工厂统一 `/status` 卡与选择卡的构造。
- `LARK_CHANNEL_CODEBUDDY_BIN` 重复读取收敛为单一 `codebuddyBinary()`；`agentBinary` 的 claude 分支不再读取从未使用的 `LARK_CHANNEL_CLAUDE_BIN`（Claude 发现为静态、不 spawn）。
- 移除 `child.stdout as Readable` unsound cast（`defaultReadOnlyRunner` 显式判空）。
- 模型 ID 上限统一为 `model-catalog.ts` 导出的 `MODEL_ID_MAX_LEN`（命令层与卡片共用）；文本列表上限具名 `MAX_TEXT_CANDIDATES = 40` 并注明与卡片预算（30）属不同约束。
- 偏好写入按 store 串行化（`prefWrites` 链）：失败回滚发生在后续写入读取 prev 之前，消除「回滚覆盖并发成功写入」竞态；受控故障注入测试（mock atomic-write）覆盖回滚不吞噬后续成功写、冲突零写入、落盘成功才回执。

### 未改动项（有意保留）

- `tryHandleCommand` 布尔返回值 + `commandKeepsPendingQueue` 侧通道（Slice A 已声明的边界）。
- revision 为 per-scope 而非 per scope+agent：跨 agent 卡片互失效属保守方向，保留。
- Slice C 记录中「最近使用、跨 Agent 选择、推理强度/预设、恢复卡『用当前模型重做』」仍为后续能力；候选账号可用性、续接覆盖、飞书移动端交互仍需现场验证。
