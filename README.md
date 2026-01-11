# Agent Mux

Agent Mux is a **tmux-backed agent pool** plus a small **MCP (Model Context Protocol) server**.
It manages “projects” as tmux sessions, and spawns each interactive agent as a tmux window so you can:

- Create/list/switch/close projects (tmux sessions)
- Spawn/list/attach/interrupt/kill agents (tmux windows)
- Send text to an agent (type + Enter)
- Read output from an agent (via `tmux capture-pane`)

This repo keeps the agent-mux implementation under `lib/agent-mux/`, and exposes it as MCP tools via
`servers/agent-mux-server.mjs`.

## Why tmux?

tmux provides durable sessions you can inspect manually, and a simple way to capture rendered terminal
output—making it a practical substrate for orchestrating interactive CLI agents.

## Features

- **Dedicated tmux socket**: uses `tmux -L ccx ...` so it won’t interfere with your default tmux
- **One project = one session**, **one agent = one window** (single pane)
- **Persistent registry** under `.ccx/projects/<project>/agents.json`
- **Per-agent log file** via `pipe-pane` to `.ccx/projects/<project>/logs/<agent>.log`
- **Conservative name validation** for projects and agents

## Requirements

- Node.js 18+ (ESM)
- `tmux` in `PATH`
- Optional agent CLIs (only needed if you use default commands):
  - `claude` (default args: `--dangerously-skip-permissions`)
  - `codex` (default args: `--yolo`)
  - `gemini` (default args: `--yolo`)

## Installation

From the repo root:

```bash
npm install
```

## Quick start (manual tmux)

After you create a project and spawn agents, you can inspect the tmux session:

```bash
tmux -L ccx attach -t <project>
# Detach without closing: Ctrl-b d
# Switch windows: Ctrl-b 0/1/2/...
```

## Quick start (MCP server)

Run the MCP server (stdio):

```bash
node servers/agent-mux-server.mjs
```

Then register it in your MCP client as a stdio server. Example (client formats vary):

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

## Usage examples

### Via MCP tools

Typical flow:

1) Create/select a project

- `create_project({ "name": "my-project", "cwd": "/path/to/workdir" })`
- `switch_project({ "name": "my-project" })`

2) Spawn an agent

- `spawn_agent({ "type": "codex", "name": "codex-1" })`

3) Talk to it

- `send_to_agent({ "name": "codex-1", "text": "hello" })`

4) Read output

- `read_agent_output({ "name": "codex-1", "lines": 50 })`

### As a library (Node.js)

```js
import { AgentMux } from "./lib/agent-mux/index.mjs";

const mux = new AgentMux({ projectRoot: process.cwd(), tmuxSocketName: "ccx" });

mux.create_project("my-project", process.cwd());
mux.spawn_agent("codex", "codex-1");
mux.send_to_agent("codex-1", "hello");

const { output } = mux.read_agent_output("codex-1", 50);
console.log(output);
```

## MCP tools

The MCP server exposes these tools (names match the `AgentMux` methods):

### Project management

- `create_project({ name, cwd? })`
- `list_projects({})`
- `switch_project({ name })`
- `close_project({ name })`

### Agent management

- `spawn_agent({ type, name, options? })`
- `list_agents({ project? })`
- `attach_agent({ name })`
- `interrupt_agent({ name })`
- `kill_agent({ name })`

### Agent I/O

- `send_to_agent({ name, text })`
- `read_agent_output({ name, lines? })`
- `send_to_window({ window, text })`

## API (library)

### Naming rules

Project names and agent names must match:

- `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$`

### `new AgentMux(options?)`

- `options.projectRoot` (string): base dir used for registry/log storage; default `process.cwd()`
- `options.tmuxSocketName` (string): tmux socket name for `tmux -L`; default `ccx`
- `options.tmuxBinary` (string): tmux binary; default `tmux`

### Project management

- `create_project(name, cwd?)` → `{ project, cwd, created, storageDir }`
- `list_projects()` → `Array<{ project, cwd, sessionExists, hasRegistry, current }>`
- `switch_project(name)` → `{ project, switched, clients }`
- `close_project(name)` → `{ project, killed, clearedCurrent }`

### Agent management

- `spawn_agent(type, name, options?)` → agent entry (tmux window + registry + log path)
  - `type`: one of `claude` / `codex` / `gemini`
  - `options.cwd` (string): agent working dir (defaults to project cwd)
  - `options.command` / `options.cmd` (string): override executed command
  - `options.args` (string[]): extra args appended to defaults (or used with custom command)
- `list_agents(project?)` → `{ project, agents: [...entries with alive:boolean] }`
- `attach_agent(name)` → `{ project, agent, attached, clients }`
- `interrupt_agent(name)` → `{ project, agent, interrupted }` (sends `Ctrl+C`)
- `kill_agent(name)` → `{ project, agent, killed }`

### Agent I/O

- `send_to_agent(name, text)` → `{ project, agent, sent, bytes }`
- `send_to_window(window, text)` → `{ project, window, sent, bytes }`
- `read_agent_output(name, lines=200)` → `{ project, agent, lines, output }`

## Storage layout

By default, Agent Mux stores state under `projectRoot/.ccx/projects/`:

```text
.ccx/projects/<project>/
  project.json
  agents.json
  logs/<agent>.log
.ccx/projects/current.json
```

If `.ccx/` is not writable, it falls back to `${os.tmpdir()}/ccx-agent-mux/projects/`.

## License (MIT)

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
