# Qoder for Codex

在 Codex 中调用本机已经安装并登录的 Qoder CLI，让 Qoder 作为一个可持续运行的外部 Agent，负责代码审查、问题调查、实现任务和会话迁移。

版本更新见 [CHANGELOG.md](CHANGELOG.md)。

本插件参考了 [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) 的交互思路，但运行方向相反：`codex-plugin-cc` 是在 Claude Code 中调用 Codex，本插件是在 Codex 中调用 Qoder。

插件完全基于 Codex Skills 实现，不启动 MCP Server。

本插件尚未适配 Claude Code，请在 Codex 中使用。

## 你能获得什么

| Skill             | 能力                                                                 |
| ----------------- | -------------------------------------------------------------------- |
| `$qoder:review`   | 让 Qoder 审查当前改动或当前分支，支持普通审查和对抗式审查            |
| `$qoder:task`     | 把调查、修复或实现任务交给 Qoder，支持只读、写入、后台执行和续接会话 |
| `$qoder:jobs`     | 查看、等待、获取结果或取消后台任务                                   |
| `$qoder:transfer` | 把已有 Qoder 会话迁移为可继续使用的 Codex 会话                       |
| `$qoder:setup`    | 检查 Node.js、Qoder CLI、Qoder 登录状态和 Codex App Server           |

这些能力以 Codex Skill 的形式提供，不会注册 `/qoder:review` 这类斜杠命令。你可以直接用自然语言提出要求，也可以显式写出 `$qoder:review` 等 Skill 名称。

## 环境要求

- Node.js 18.18 或更高版本
- `qodercli` 1.1.31 或更高版本，并已完成登录
- `codex` 0.150.1 或更高版本；会话迁移依赖 Codex App Server

Windows 目前存在已知限制：通过 npm 安装的 `qodercli.cmd` 无法由插件直接启动，评审还可能遗漏未跟踪文件。

Qoder 执行任务会消耗你的 Qoder 用量，Codex 负责理解请求、调用 Skill 和整理结果。

## 安装

添加 GitHub 仓库中的插件市场并安装：

```bash
codex plugin marketplace add jasonchio-cn/qoder-plugin-for-codex
codex plugin add qoder@qoder-plugin-for-codex
```

安装后重新启动一个 Codex 会话，执行 `$qoder:setup`。当所有检查项均为 `PASS` 时，插件即可使用。

## 快速上手

最简单的使用方式是在 Codex 中直接描述任务：

```text
请用 $qoder:review 审查当前改动。

请用 $qoder:task 在后台调查这个测试为什么失败，不要修改代码。

请用 $qoder:jobs 查看刚才任务的进度。
```

## 代码审查

`$qoder:review` 会把当前仓库的变更上下文交给 Qoder。审查始终是只读的，不会自动修改代码。

普通审查：

```text
请用 $qoder:review 审查当前未提交的改动。
```

审查当前分支相对 `main` 的变化：

```text
请用 $qoder:review 审查当前分支相对 main 的改动。
```

对抗式审查用于挑战实现方向、隐含假设和风险：

```text
请用 $qoder:review 做一次对抗式审查，重点检查并发、数据丢失和回滚风险。
```

审查默认在后台执行。Codex 会返回 Job ID，之后可以用 `$qoder:jobs` 查询进度或获取结果。

## 委派任务

`$qoder:task` 可以让 Qoder 调查问题、编写方案或实现修改。

默认任务是只读并在后台运行：

```text
请用 $qoder:task 调查这个接口偶发超时的原因，不要修改代码。
```

如果希望 Qoder 修改代码，需要明确授权：

```text
请用 $qoder:task 修复这个测试，并允许它修改当前工作区。
```

需要隔离修改时，可以要求使用独立 worktree：

```text
请用 $qoder:task 在独立 worktree 中修复这个问题。
```

还可以继续最近一次 Qoder 任务，或指定 Qoder Session ID 续接已有任务：

```text
请用 $qoder:task 继续上一次任务，验证刚才的修复。

请用 $qoder:task 继续 Qoder 会话 <session-id>。
```

## 管理后台任务

使用 `$qoder:jobs` 管理由本插件启动的任务和审查：

```text
请用 $qoder:jobs 列出当前仓库的任务。

请用 $qoder:jobs 等待 <job-id> 完成。

请用 $qoder:jobs 获取 <job-id> 的最终结果。

请用 $qoder:jobs 取消 <job-id>。
```

任务结果会保留 Job ID、状态、Qoder Session ID、错误信息和最终输出，便于后续追踪或续接。

## 将 Qoder 会话迁移到 Codex

`$qoder:transfer` 可以读取本机 Qoder 会话记录，创建一个持久化 Codex Thread：

```text
请用 $qoder:transfer 把 Qoder 会话 <session-id> 迁移到 Codex。
```

迁移完成后会返回 Codex Thread ID，以及继续会话的命令：

```bash
codex resume <thread-id>
```

也可以明确要求迁移最近一次 Qoder 会话：

```text
请用 $qoder:transfer 迁移最近一次 Qoder 会话。
```

会话迁移会转换 Qoder 顶层、模型可见的对话历史，但不会承诺无损迁移 Qoder 私有事件、附件或所有内部状态，也不会在两端自动同步后续上下文。

## 工作原理

```text
Codex Skill -> 本地 Node.js 脚本 -> qodercli stream-json
```

- 使用本机已有的 `qodercli` 安装、登录状态和模型访问权限
- 任务可以前台执行，也可以作为本地后台进程持续运行
- 后台任务状态保存在当前 Git 仓库的元数据目录中；无法使用时回退到 Codex 用户状态目录
- 会话迁移通过 Codex App Server 创建持久化 Thread 并注入转换后的历史记录
- 插件不启动常驻服务，也不引入 MCP

## 能力边界

- 不能让 Qoder 和 Codex 自动、实时共享完整上下文
- 不能保证 Qoder 会话中的私有事件、附件和内部状态无损迁移
- 不会在未明确授权时让 Qoder 修改代码
- 代码审查只返回发现，不会自动修复
- 当前版本不提供自动 review gate

## 本地开发

```bash
npm test
npm run validate
npm run build
```

修改插件后重新构建并安装，然后新开一个 Codex 会话验证最新版本。

## 许可证

项目修改采用 [MIT 许可证](LICENSE)。包含的 OpenAI 改编内容仍适用 [Apache License 2.0](LICENSE-APACHE)，归属信息见 [NOTICE](NOTICE)。
