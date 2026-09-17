# 验证矩阵与完成标准

## 已有证据

调查基线 `003f01e`：相关卡片、状态、续期和 updater 测试 4 个文件、41 项通过；独立思考超限检查失败。前者说明原有用例未覆盖这个用户场景，不证明缺陷不存在。

仓库本地 `.harness/research/repro-thinking.cjs` 是调查时的辅助脚本，受 gitignore 管理，不是交接必需文件。接手 Agent 应根据下方测试逻辑在正式测试目录建立回归用例。

## OPT-01 最小红灯样例

```typescript
// 放入现有 Vitest 测试后，按项目路径补充真实模块 import。
const before = reduce(initialState, {
  type: 'thinking', delta: 'A'.repeat(1600),
});
const after = reduce(before, {
  type: 'thinking', delta: '\nLATEST_PROGRESS_MARKER',
});
const first = JSON.stringify(renderCard(windowState(before, { maxTextChars: 4000 })));
const latest = JSON.stringify(renderCard(windowState(after, { maxTextChars: 4000 })));
expect(latest).not.toBe(first);
expect(latest).toContain('LATEST_PROGRESS_MARKER');
```

以上断言在调查基线上失败。实现者应确认在当前代码仍然失败；若已被修复，记录事实并检查剩余记录入口任务，不为了制造红灯破坏正确行为。

## 矩阵

| 任务 | 单元测试 | 集成/进程测试 | 人工或现场检查 |
|---|---|---|---|
| OPT-01 | 边界长度、Unicode、窗口不修改源数据 | CodeBuddy 事件→记录→分页；重启、Scope 拒绝、旧入口身份 | 两种思考面板持续显示最新内容 |
| OPT-02 | 快照合并、终态顺序、重试分类 | 慢 API、限流、续期、停止并发；缓存界限 | 展示延迟文案准确 |
| OPT-03 | UTF-8/JSON 预算、Markdown 分段 | create/update/send 超限与中途失败；完整重建 | 长中文/代码在手机端可读 |
| OPT-04 | 状态转移、事件去重、认领竞争 | 各崩溃窗口重启；未知副作用不自动重跑 | 恢复卡含义清楚 |
| OPT-05 | 能力矩阵、请求身份/过期 | 多请求、跨 Scope、重复按钮、后端错误 | 输入或审批真正抵达后端 |
| OPT-06 | 状态来源、汇总真实性 | 进程成功但检查失败、无检查、部分完成 | 默认卡片简洁，重要失败可见 |

## 推荐现有测试入口

- `tests/unit/card/run-renderer.snapshot.test.ts`
- `tests/unit/card/run-state-schema.test.ts`
- `tests/unit/card/streaming-session.test.ts`
- `tests/unit/card/resilient-updater.test.ts`
- `tests/unit/session/last-run-output.test.ts`
- `tests/integration/bot/run-output-fragmentation.test.ts`
- `tests/integration/commands/claude-commands.test.ts`
- `tests/static/contracts.test.ts`

文件名和内容以执行时实际仓库为准。复用 bridge-env、fake-agent、fake-channel 和临时 Profile，不访问用户真实聊天或配置来替代自动测试。

## 检查命令

局部迭代运行受影响测试；准备交付代码时执行仓库规定的检查，例如：

```text
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

`pnpm ci:local` 已包含对应检查，可用它避免重复执行。依赖已齐全时不必无理由重新安装。

## 完成报告必须包含

1. 完成了哪个任务/切片，哪些仍未完成。
2. 实际行为变化、兼容性与配置默认值。
3. 回归测试失败原因和实现后的结果；不能只提供快照更新。
4. 验证命令、退出状态，以及受影响路径的证据。
5. 存储/权限/恢复的实际语义和限制。
6. Git 提交、部署和发布状态分别说明。

没有用户现场权限时，可以交付“本地验证通过，现场未验证”；不得声称已经修复正在运行的服务。本文档交付本身不需要运行全部产品测试。
