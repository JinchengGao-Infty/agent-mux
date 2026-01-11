/**
 * CCX Agent Mux - dynamic agent pool (agent-mux)
 *
 * High-level API used by MCP server:
 * - Project management (tmux sessions)
 * - Agent lifecycle (tmux windows + registry + logs)
 */

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

import { getAgentRegistry } from "./registry.mjs";
import { getTmuxBackend, shellEscapeSingleQuotes } from "./tmux-backend.mjs";

const ALLOWED_AGENT_TYPES = new Set(["claude", "codex", "gemini"]);

function assertSafeName(kind, name) {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error(`${kind} name must be a non-empty string`);
  }
  const n = name.trim();
  // Conservative: avoid tmux target parsing issues and unsafe file names.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(n)) {
    throw new Error(
      `${kind} name must match /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/ (got: ${name})`
    );
  }
  return n;
}

function ensureEndsWithNewline(text) {
  const s = String(text ?? "");
  return s.endsWith("\n") ? s : `${s}\n`;
}

function stripAnsi(str) {
  // Remove ANSI escape codes: CSI sequences, OSC sequences, and simple escapes
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]|\x1b[=>]|\r/g, "");
}

function tailFile(filePath, maxLines = 200, { stripAnsiCodes = true } = {}) {
  const linesWanted = Number.isFinite(maxLines) ? Math.max(1, Number(maxLines)) : 200;
  if (!fs.existsSync(filePath)) return "";

  const fd = fs.openSync(filePath, "r");
  try {
    const { size } = fs.fstatSync(fd);
    if (size <= 0) return "";

    const chunkSize = 64 * 1024;
    let position = size;
    let remainingLines = linesWanted + 1; // include last partial line
    const chunks = [];

    while (position > 0 && remainingLines > 0) {
      const readSize = Math.min(chunkSize, position);
      position -= readSize;
      const buffer = Buffer.alloc(readSize);
      fs.readSync(fd, buffer, 0, readSize, position);
      const chunk = buffer.toString("utf-8");
      chunks.push(chunk);
      remainingLines -= (chunk.match(/\n/g) || []).length;
    }

    let text = chunks.reverse().join("");
    if (stripAnsiCodes) text = stripAnsi(text);
    const lines = text.split("\n").filter(line => line.trim().length > 0);
    return lines.slice(-linesWanted).join("\n");
  } finally {
    fs.closeSync(fd);
  }
}

function buildDefaultCommand(type) {
  if (type === "claude") return { command: "claude", args: ["--dangerously-skip-permissions"] };
  if (type === "codex") return { command: "codex", args: ["--yolo"] };
  if (type === "gemini") return { command: "gemini", args: ["--yolo"] };
  throw new Error(`Unsupported agent type: ${type}`);
}

export class AgentMux {
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || process.cwd();
    this.tmux = getTmuxBackend({
      socketName: options.tmuxSocketName || "ccx",
      tmuxBinary: options.tmuxBinary || "tmux",
    });
    this.registry = getAgentRegistry({ projectRoot: this.projectRoot });
  }

  _requireCurrentProject() {
    const name = this.registry.getCurrentProject();
    if (!name) throw new Error("No current project selected. Call switch_project(name) first.");
    return name;
  }

  _loadAgent(project, agentName) {
    const data = this.registry.loadAgents(project);
    const agent = (data.agents || []).find((a) => a?.name === agentName);
    if (!agent) {
      throw new Error(`Agent not found: ${agentName} (project=${project})`);
    }
    return { data, agent };
  }

  // ---------- Project management ----------
  create_project(name, cwd = null) {
    const project = assertSafeName("project", name);
    const resolvedCwd = cwd ? path.resolve(String(cwd)) : null;

    this.registry.ensureProject(project, { cwd: resolvedCwd });
    const tmuxRes = this.tmux.createSession(project, resolvedCwd);

    this.registry.setCurrentProject(project);

    return {
      project,
      cwd: resolvedCwd,
      created: tmuxRes.created,
      storageDir: this.registry.getProjectDir(project),
    };
  }

  list_projects() {
    const sessions = new Set(this.tmux.listSessions());
    const dirs = new Set(this.registry.listProjectNames());
    const current = this.registry.getCurrentProject();

    const names = Array.from(new Set([...sessions, ...dirs])).sort();
    return names.map((project) => {
      const meta = this.registry.loadProjectMeta(project);
      return {
        project,
        cwd: meta?.cwd || null,
        sessionExists: sessions.has(project),
        hasRegistry: dirs.has(project),
        current: current === project,
      };
    });
  }

  switch_project(name) {
    const project = assertSafeName("project", name);
    if (!this.tmux.hasSession(project)) {
      throw new Error(`tmux session not found for project: ${project} (did you call create_project?)`);
    }
    this.registry.ensureProject(project);
    this.registry.setCurrentProject(project);

    // Best-effort: if there are tmux clients attached to the ccx socket, switch them.
    const clients = this.tmux.listClients();
    for (const tty of clients) {
      try {
        this.tmux.switchClient(tty, project);
      } catch {
        // ignore
      }
    }

    return { project, switched: true, clients: clients.length };
  }

  close_project(name) {
    const project = assertSafeName("project", name);
    const current = this.registry.getCurrentProject();

    let killed = false;
    if (this.tmux.hasSession(project)) {
      this.tmux.killSession(project);
      killed = true;
    }

    if (current === project) this.registry.clearCurrentProject();

    return { project, killed, clearedCurrent: current === project };
  }

  // ---------- Agent management ----------
  spawn_agent(type, name, options = {}) {
    const project = this._requireCurrentProject();
    const agentName = assertSafeName("agent", name);
    const agentType = String(type || "").trim();
    if (!ALLOWED_AGENT_TYPES.has(agentType)) {
      throw new Error(`Invalid agent type: ${type}. Allowed: claude/codex/gemini`);
    }

    if (!this.tmux.hasSession(project)) {
      throw new Error(`tmux session not found for project: ${project} (did you call create_project?)`);
    }

    this.registry.ensureProject(project);
    const agentsData = this.registry.loadAgents(project);
    if ((agentsData.agents || []).some((a) => a?.name === agentName)) {
      throw new Error(`Agent already exists in registry: ${agentName} (project=${project})`);
    }

    const projectMeta = this.registry.loadProjectMeta(project);
    const defaultCwd = projectMeta?.cwd || process.cwd();
    const agentCwd = options?.cwd ? path.resolve(String(options.cwd)) : defaultCwd;

    // Build command: use custom command if provided, otherwise use default
    // Always merge options.args into the final args
    const baseCmd = options?.command || options?.cmd
      ? { command: String(options.command || options.cmd), args: [] }
      : buildDefaultCommand(agentType);
    const extraArgs = Array.isArray(options?.args) ? options.args.map(String) : [];
    const cmd = { command: baseCmd.command, args: [...baseCmd.args, ...extraArgs] };

    const win = this.tmux.createWindow({
      session: project,
      windowName: agentName,
      cwd: agentCwd,
      command: cmd.command,
      commandArgs: cmd.args,
    });

    // Store required metadata on the window.
    this.tmux.setWindowOption(win.windowId, "@ccx_agent_name", agentName);
    this.tmux.setWindowOption(win.windowId, "@ccx_agent_type", agentType);

    const paneId = this.tmux.getWindowFirstPaneId(win.windowId);

    // Setup log piping: .ccx/projects/<project>/logs/<agent>.log
    const logPath = this.registry.getAgentLogPath(project, agentName);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    try {
      fs.closeSync(fs.openSync(logPath, "a"));
    } catch {
      // ignore
    }

    const pipeCmd = `cat >> ${shellEscapeSingleQuotes(logPath)}`;
    this.tmux.pipePane(paneId, pipeCmd, { onlyIfNotRunning: false });

    const entry = {
      name: agentName,
      type: agentType,
      project,
      windowId: win.windowId,
      windowIndex: win.windowIndex,
      paneId,
      cwd: agentCwd,
      command: cmd,
      logPath,
      createdAt: new Date().toISOString(),
    };

    this.registry.saveAgents(project, {
      ...agentsData,
      agents: [...(agentsData.agents || []), entry],
    });

    return entry;
  }

  list_agents(project = null) {
    const proj = project ? assertSafeName("project", project) : this._requireCurrentProject();
    const data = this.registry.loadAgents(proj);

    let windowIds = new Set();
    if (this.tmux.hasSession(proj)) {
      const windows = this.tmux.listWindows(proj);
      windowIds = new Set(windows.map((w) => w.windowId));
    }

    return {
      project: proj,
      agents: (data.agents || []).map((a) => ({
        ...a,
        alive: a?.windowId ? windowIds.has(a.windowId) : false,
      })),
    };
  }

  send_to_agent(name, text) {
    const project = this._requireCurrentProject();
    const agentName = assertSafeName("agent", name);
    const { agent } = this._loadAgent(project, agentName);
    const paneId = agent.paneId || this.tmux.getWindowFirstPaneId(agent.windowId);

    const payload = String(text ?? "");
    // Use send-keys with literal flag to send text directly, then Enter
    // Small delay between text and Enter to ensure proper handling
    this.tmux.sendKeys(paneId, ["-l", payload]);
    // Sync delay - spawnSync blocks so this ensures ordering
    spawnSync("sleep", ["0.05"]);
    this.tmux.sendKeys(paneId, ["Enter"]);

    return { project, agent: agentName, sent: true, bytes: Buffer.byteLength(payload, "utf-8") };
  }

  // Send to any tmux window (not just registered agents)
  send_to_window(windowName, text) {
    const project = this._requireCurrentProject();
    const target = `${project}:${windowName}`;

    const payload = String(text ?? "");
    this.tmux.sendKeys(target, ["-l", payload]);
    spawnSync("sleep", ["0.05"]);
    this.tmux.sendKeys(target, ["Enter"]);

    return { project, window: windowName, sent: true, bytes: Buffer.byteLength(payload, "utf-8") };
  }

  read_agent_output(name, lines = 200) {
    const project = this._requireCurrentProject();
    const agentName = assertSafeName("agent", name);
    const { agent } = this._loadAgent(project, agentName);

    // Use capture-pane for clean output (no ANSI codes)
    const paneId = agent.paneId || this.tmux.getWindowFirstPaneId(agent.windowId);
    const rawOutput = this.tmux.capturePane(paneId, { history: Math.max(lines * 10, 2000) });

    // Filter empty lines and take last N lines
    const outputLines = rawOutput
      .split("\n")
      .filter(line => line.trim().length > 0)
      .slice(-lines);
    const output = outputLines.join("\n");

    return { project, agent: agentName, lines: Number(lines), output };
  }

  interrupt_agent(name) {
    const project = this._requireCurrentProject();
    const agentName = assertSafeName("agent", name);
    const { agent } = this._loadAgent(project, agentName);
    const paneId = agent.paneId || this.tmux.getWindowFirstPaneId(agent.windowId);
    this.tmux.sendKeys(paneId, ["C-c"]);
    return { project, agent: agentName, interrupted: true };
  }

  kill_agent(name) {
    const project = this._requireCurrentProject();
    const agentName = assertSafeName("agent", name);
    const { data, agent } = this._loadAgent(project, agentName);

    // Best-effort: kill the tmux window.
    try {
      this.tmux.killWindow(agent.windowId || `${project}:${agent.windowIndex}`);
    } catch {
      // ignore
    }

    const nextAgents = (data.agents || []).filter((a) => a?.name !== agentName);
    this.registry.saveAgents(project, { ...data, agents: nextAgents });

    return { project, agent: agentName, killed: true };
  }

  attach_agent(name) {
    const project = this._requireCurrentProject();
    const agentName = assertSafeName("agent", name);
    const { agent } = this._loadAgent(project, agentName);

    // Best-effort: switch any connected clients to the project, then select the window.
    const clients = this.tmux.listClients();
    for (const tty of clients) {
      try {
        this.tmux.switchClient(tty, project);
      } catch {
        // ignore
      }
    }

    this.tmux.selectWindow(agent.windowId || `${project}:${agent.windowIndex}`);
    return { project, agent: agentName, attached: true, clients: clients.length };
  }
}

// Singleton export (consistent with other CCX libs)
let _instance = null;
export function getAgentMux(options) {
  if (!_instance) _instance = new AgentMux(options);
  return _instance;
}

export default AgentMux;

