# 快速切换模型：官方能力调研

调研日期：2026-09-18。本文记录上游能力与证据边界，不代表桥接项目已经支持这些能力。官方在线文档和主分支可能领先于本机 CLI，实施前须检查安装版本。

## 结论

可以增加桥接层的 `/model` 命令和飞书选择卡片。三个后端均提供显式指定模型的入口；模型目录的获取方式并不统一，必须分别适配。应区分「用户选择的模型」「后端实际使用的模型」与「目录候选模型」，不能仅凭目录存在就承诺当前账号调用成功。

## 已证实的上游能力

| 后端 | 选择模型 | 恢复会话时切换 | 获取模型列表 |
| --- | --- | --- | --- |
| Claude Code | `--model <alias\|name>`；交互 `/model` 打开选择器 | 官方明确 `--model` 优先于恢复会话中保存的模型 | 原生交互选择器；本轮未核实独立、稳定的 CLI JSON 列表命令 |
| CodeBuddy Code | `--model <model>`；交互 `/model <name>` | 官方分别支持 `--resume` 与 `--model`；组合后的优先级须在目标版本验证 | 交互 `/model list` 已记录；未证实其在 `-p` 下的结构化输出契约 |
| Codex CLI | `--model` / `-m` | 官方源码把 exec 的 model 参数设为 global，可用于 exec resume | 实验性 `codex debug models` JSON；app-server 的 `model/list` 提供结构化目录 |

### Claude Code

`--model` 只影响启动的会话，优先于恢复的模型。模型别名的解析随供应商和版本变化。`availableModels` 等组织限制可能使启动参数被替换为默认模型。非交互 `/model` 自 v2.1.205 起支持，因此不能笼统声称 print 模式不支持它；但其行为不等于飞书卡片交互。[官方模型配置](https://code.claude.com/docs/en/model-config)

Claude API 另有 `GET /v1/models`，官方说明它列出 API 可用模型。它不是所有 Claude Code 登录方式的通用目录；不能未经验证就把 API key 目录等同于订阅登录、Bedrock 或自定义网关可用列表。[Models API](https://platform.claude.com/docs/en/api/models/list)

官方 Python Agent SDK 还提供流式连接上的 `set_model()`。这是后续常驻会话架构的可选能力，不是当前 spawn CLI 架构实现快速切换的前提。[官方 SDK 源码](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/client.py)

### CodeBuddy Code

官方 CLI 参考记录 `--model`、`--resume` 和非交互 `-p`；另一份参考页提醒部分命令可能尚未实现，应以实际 `--help` 为准。文档中的示例模型名称不能直接当成所有账号的可用清单。[CLI 参数](https://www.codebuddy.ai/docs/cli/cli-reference)、[版本兼容提示](https://www.codebuddy.ai/docs/cli/reference)

官方 slash 命令表明确列出 `/model [list | model-name]`：无参数打开交互界面，`list` 列模型，名称参数直接切换主模型。另有 `/model:lite`、`/model:reasoning` 管理场景模型；它们应与主模型区分，首期无需同时暴露。[Slash 命令](https://www.codebuddy.ai/docs/cli/slash-commands)

本轮没有找到可据此承诺兼容的独立 JSON 模型目录命令，也没有实测 `-p "/model list"`。不能将「交互模式有 list」扩写成「无副作用、可稳定解析的 headless API」。

### Codex CLI

官方命令文档提供实验性 `codex debug models`，返回原始 JSON 目录；`--bundled` 跳过刷新，只读取随二进制附带的目录。因其标为实验性，接入应检测能力并允许降级；bundled 目录尤其不能宣称是账号实时授权结果。[官方命令参考](https://developers.openai.com/codex/cli/reference)

app-server 的 `model/list` 提供分页、显示名称、默认标记、隐藏标记、支持的推理强度和输入模态。官方建议在渲染模型选择器前调用它。该目录接口适合后续升级，不必为了一个选择卡片立即重写整个运行适配器。[官方 app-server 模型接口](https://developers.openai.com/codex/app-server#models)

官方 exec 参数源码将 `model` 标为 global，并包含 Resume 子命令，支持将显式模型参数传入恢复路径。本轮验证的是当前上游源码；本地支持范围仍须用目标版本的帮助及测试确认。[exec 参数源码](https://github.com/openai/codex/blob/main/codex-rs/exec/src/cli.rs)

## 飞书卡片

飞书开放平台提供卡片 JSON 2.0 的单选下拉菜单、表单容器与按钮组件文档。可以采用「下拉选择模型 → 应用」交互。网页正文依赖客户端加载，本轮浏览工具只取得页面标题，未独立核实选项数量、回调时限等具体平台限制；实施时需结合仓库既有组件与当前官方字段说明验证，本文不填入未经核实的数字。

- [单选下拉菜单](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/interactive-components/single-select-dropdown-menu)
- [表单容器](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/containers/form-container)
- [按钮](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/interactive-components/button)

## 对实施方案的约束

以下是基于调研的设计建议，不是上游保证：

1. 桥接层拦截 `/model`，自行响应；不依赖把文本转发给 CLI 来打开终端选择器。
2. 每个后端独立发现模型目录，并记录来源、抓取时间及是否为离线候选。失败时保留最近使用和管理员配置的候选，明确标注列表状态。
3. 第一版可用显式 `--model` 在下一次运行生效，避免为模型选择引入常驻交互进程。
4. 卡片确认仅表示偏好已保存；实际生效需读取后端事件或结果验证。后端不报告时显示「实际模型未确认」。
5. 保留自定义模型 ID 输入，适配企业部署及网关；输入按参数数组传递，不能拼接 shell 命令。
6. 模型不可用时明确报告原因，允许重新选择；不要悄悄换成另一个模型并显示切换成功。

## 本机只读版本核对

同轮主审通过本机 CLI 帮助输出核对了以下信息；帮助中出现的本机自定义模型清单未写入研究文档：

| CLI | 本机版本 | 帮助输出证据 |
| --- | --- | --- |
| Claude Code | 2.1.261 | 版本高于官方记录的非交互 `/model` 引入版本；仅版本符合不代替行为测试 |
| CodeBuddy Code | 2.154.0 | `--help` 的 `--model` 说明附有 `Currently supported` 候选列表，含本地自定义 ID |
| Codex CLI | 0.144.6 | `debug models --help` 存在 JSON catalog 与 `--bundled`；`exec resume --help` 明确列出 `-m` / `--model` |

CodeBuddy 帮助文本可以作为候选发现的兼容降级来源，但它不是稳定 JSON 协议，也不是账号授权证明。解析失败必须有回退，日志和研究文档不应公开本机自定义模型标识。

## 实施前尚需验证

- CodeBuddy 目标版本的 `--resume` 与 `--model` 组合是否确实覆盖上次模型，同时保留会话上下文。
- CodeBuddy `/model list` 能否在 headless 模式返回稳定、无模型调用的目录；若不能，使用配置候选与自定义 ID。
- Claude 当前安装版本是否有适合桥接的官方结构化模型发现接口；本轮未完成该项验证。
- 其他部署机器的 Codex 安装版本是否支持 `debug models`；模型目录和真正账号权限之间的差异。
- 三个后端恢复会话、切换到较小上下文模型、权限限制及不可用模型错误的具体表现。
- 飞书移动端与桌面端的卡片选择、重复回调和过期卡片行为。

没有向真实 Agent 提交任务，也没有触发付费模型调用。本次交付仅为来源调研与实施约束。
