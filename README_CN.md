# Agent Mux

Agent Mux 是一个**基于 tmux 的多 Agent 动态池**，并提供一个小型的 **MCP (Model Context Protocol) Server**。
它将“项目（project）”映射为 tmux session，将每个交互式 Agent 映射为 tmux window，从而可以：

- 创建/列出/切换/关闭项目（tmux session）
- 创建/列出/切换到/中断/关闭 Agent（tmux window）
- 向 Agent 发送文本（输入文本 + 回车）
- 读取 Agent 输出（通过 `tmux capture-pane`）

本仓库将 agent-mux 实现放在 `lib/agent-mux/`，并通过 `servers/agent-mux-server.mjs` 将其暴露为 MCP 工具。

## 为什么用 tmux？

tmux 提供可持久化的会话（便于人工随时 attach 查看），同时也能方便地抓取渲染后的终端输出，因此非常适合作为交互式 CLI Agent 的编排底座。

## 功能特性

- **独立 tmux socket**：使用 `tmux -L ccx ...`，不影响你系统默认的 tmux
- **一个项目 = 一个 session**，**一个 Agent = 一个 window**（单 pane）
- **注册表持久化**：`.ccx/projects/<project>/agents.json`
- **按 Agent 输出日志落盘**：`pipe-pane` 写入 `.ccx/projects/<project>/logs/<agent>.log`
- **保守的命名校验**：避免 tmux target/文件名解析问题

## 环境要求

- Node.js 18+（ESM）
- `tmux` 在 `PATH` 中可用
- 可选 Agent CLI（仅当使用默认命令时需要）：
  - `claude`（默认参数：`--dangerously-skip-permissions`）
  - `codex`（默认参数：`--yolo`）
  - `gemini`（默认参数：`--yolo`）

## 安装

在仓库根目录执行：

```bash
npm install
```

## 快速开始（手动 tmux）

当你创建了项目并生成了一些 Agent 后，可以手动进入 tmux 查看：

```bash
tmux -L ccx attach -t <project>
# 退出查看（不关闭）：Ctrl-b d
# 切换窗口：Ctrl-b 0/1/2/...
```

## 快速开始（MCP Server）

启动 MCP server（stdio）：

```bash
node servers/agent-mux-server.mjs
```

然后在你的 MCP 客户端中把它注册为 stdio server。示例（不同客户端格式可能不同）：

```json
{
  "mcpServers": {
    "agent-mux": {
      "command": "node",
      "args": ["servers/agent-mux-server.mjs"]
    }
  }
}
```

## 使用示例

### 通过 MCP 工具调用

典型流程：

1）创建/切换项目

- `create_project({ "name": "my-project", "cwd": "/path/to/workdir" })`
- `switch_project({ "name": "my-project" })`

2）创建 Agent

- `spawn_agent({ "type": "codex", "name": "codex-1" })`

3）交互

- `send_to_agent({ "name": "codex-1", "text": "hello" })`

4）读取输出

- `read_agent_output({ "name": "codex-1", "lines": 50 })`

### 作为库使用（Node.js）

```js
import { AgentMux } from "./lib/agent-mux/index.mjs";

const mux = new AgentMux({ projectRoot: process.cwd(), tmuxSocketName: "ccx" });

mux.create_project("my-project", process.cwd());
mux.spawn_agent("codex", "codex-1");
mux.send_to_agent("codex-1", "hello");

const { output } = mux.read_agent_output("codex-1", 50);
console.log(output);
```

## MCP 工具列表

MCP server 暴露的工具名与 `AgentMux` 方法一致：

### 项目管理

- `create_project({ name, cwd? })`
- `list_projects({})`
- `switch_project({ name })`
- `close_project({ name })`

### Agent 管理

- `spawn_agent({ type, name, options? })`
- `list_agents({ project? })`
- `attach_agent({ name })`
- `interrupt_agent({ name })`
- `kill_agent({ name })`

### Agent I/O

- `send_to_agent({ name, text })`
- `read_agent_output({ name, lines? })`
- `send_to_window({ window, text })`

## API（库）

### 命名规则

项目名与 Agent 名必须满足：

- `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$`

### `new AgentMux(options?)`

- `options.projectRoot`（string）：注册表/日志的根目录；默认 `process.cwd()`
- `options.tmuxSocketName`（string）：`tmux -L` 的 socket 名；默认 `ccx`
- `options.tmuxBinary`（string）：tmux 命令；默认 `tmux`

### 项目管理

- `create_project(name, cwd?)` → `{ project, cwd, created, storageDir }`
- `list_projects()` → `Array<{ project, cwd, sessionExists, hasRegistry, current }>`
- `switch_project(name)` → `{ project, switched, clients }`
- `close_project(name)` → `{ project, killed, clearedCurrent }`

### Agent 管理

- `spawn_agent(type, name, options?)` → agent entry（tmux window + registry + log path）
  - `type`：`claude` / `codex` / `gemini`
  - `options.cwd`（string）：Agent 工作目录（默认 project cwd）
  - `options.command` / `options.cmd`（string）：覆盖要执行的命令
  - `options.args`（string[]）：追加到默认参数（或配合自定义命令使用）
- `list_agents(project?)` → `{ project, agents: [...entries with alive:boolean] }`
- `attach_agent(name)` → `{ project, agent, attached, clients }`
- `interrupt_agent(name)` → `{ project, agent, interrupted }`（发送 `Ctrl+C`）
- `kill_agent(name)` → `{ project, agent, killed }`

### Agent I/O

- `send_to_agent(name, text)` → `{ project, agent, sent, bytes }`
- `send_to_window(window, text)` → `{ project, window, sent, bytes }`
- `read_agent_output(name, lines=200)` → `{ project, agent, lines, output }`

## 存储结构

默认情况下，Agent Mux 将状态写在 `projectRoot/.ccx/projects/` 下：

```text
.ccx/projects/<project>/
  project.json
  agents.json
  logs/<agent>.log
.ccx/projects/current.json
```

如果 `.ccx/` 不可写，会回退到 `${os.tmpdir()}/ccx-agent-mux/projects/`。

## License（MIT）

MIT License

Copyright (c) 2026 Agent Mux Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
