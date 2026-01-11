/**
 * CCX Agent Mux - tmux backend
 *
 * A thin wrapper around `tmux` using a private socket: `tmux -L ccx ...`
 * - One project = one tmux session
 * - One agent = one tmux window (single pane)
 */

import { spawnSync } from "child_process";

export function shellEscapeSingleQuotes(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

export class TmuxBackend {
  constructor(options = {}) {
    this.socketName = options.socketName || "ccx";
    this.tmuxBinary = options.tmuxBinary || "tmux";
    this.env = options.env || process.env;
  }

  _buildArgs(args = []) {
    return ["-L", this.socketName, ...args.map((a) => String(a))];
  }

  runRaw(args, opts = {}) {
    const res = spawnSync(this.tmuxBinary, this._buildArgs(args), {
      cwd: opts.cwd,
      env: opts.env || this.env,
      encoding: "utf8",
      maxBuffer: opts.maxBuffer ?? 10 * 1024 * 1024,
    });

    const stdout = res.stdout || "";
    const stderr = res.stderr || "";
    const status = Number.isFinite(res.status) ? res.status : null;
    const ok = status === 0;

    if (res.error) {
      return {
        ok: false,
        status,
        stdout,
        stderr: `${stderr}\n${res.error.message}`.trim(),
      };
    }

    return { ok, status, stdout, stderr };
  }

  exec(args, opts = {}) {
    const { ok, status, stdout, stderr } = this.runRaw(args, opts);
    if (!ok) {
      const msg = (stderr || stdout || `tmux exited with code ${status}`).trim();
      const err = new Error(
        `[tmux -L ${this.socketName}] ${args.join(" ")} failed: ${msg}`
      );
      err.status = status;
      err.stdout = stdout;
      err.stderr = stderr;
      throw err;
    }
    return (stdout ?? "").toString();
  }

  // ---------- Session / project ----------
  hasSession(name) {
    const res = this.runRaw(["has-session", "-t", name]);
    return res.ok;
  }

  listSessions() {
    const res = this.runRaw(["list-sessions", "-F", "#{session_name}"]);
    if (!res.ok) return [];
    return res.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  createSession(name, cwd) {
    if (this.hasSession(name)) return { created: false };
    const args = ["new-session", "-d", "-s", name, "-n", "main"];
    if (cwd) args.push("-c", cwd);
    this.exec(args);
    return { created: true };
  }

  killSession(name) {
    this.exec(["kill-session", "-t", name]);
    return { killed: true };
  }

  // ---------- Windows / agents ----------
  createWindow({ session, windowName, cwd, command, commandArgs = [] }) {
    const args = [
      "new-window",
      "-d",
      "-t",
      session,
      "-n",
      windowName,
      "-P",
      "-F",
      "#{window_id}|#{window_index}|#{window_name}",
    ];
    if (cwd) args.push("-c", cwd);
    if (command) args.push(command, ...commandArgs.map(String));
    const out = this.exec(args).trim();
    const [windowId, windowIndex, createdName] = out.split("|");
    return {
      windowId: windowId?.trim(),
      windowIndex: Number.parseInt(windowIndex, 10),
      windowName: (createdName || windowName)?.trim(),
    };
  }

  listWindows(session) {
    const res = this.runRaw([
      "list-windows",
      "-t",
      session,
      "-F",
      "#{window_id}|#{window_index}|#{window_name}",
    ]);
    if (!res.ok) return [];
    return res.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const [windowId, windowIndex, windowName] = line.split("|");
        return {
          windowId: windowId?.trim(),
          windowIndex: Number.parseInt(windowIndex, 10),
          windowName: windowName?.trim(),
        };
      });
  }

  killWindow(target) {
    this.exec(["kill-window", "-t", target]);
    return { killed: true };
  }

  getWindowFirstPaneId(windowTarget) {
    const out = this.exec(["list-panes", "-t", windowTarget, "-F", "#{pane_id}"]);
    const paneId = out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)[0];
    if (!paneId) throw new Error(`No pane found for window target: ${windowTarget}`);
    return paneId;
  }

  setWindowOption(windowTarget, key, value) {
    this.exec(["set-option", "-w", "-t", windowTarget, key, String(value)]);
  }

  showWindowOption(windowTarget, key) {
    const res = this.runRaw(["show-options", "-w", "-t", windowTarget, "-v", key]);
    if (!res.ok) return null;
    return res.stdout.trim();
  }

  pipePane(paneTarget, shellCommand, { onlyIfNotRunning = false } = {}) {
    const args = ["pipe-pane", "-t", paneTarget];
    if (onlyIfNotRunning) args.push("-o");
    args.push(shellCommand);
    this.exec(args);
  }

  setBuffer(bufferName, text) {
    this.exec(["set-buffer", "-b", bufferName, String(text)]);
  }

  pasteBuffer(bufferName, paneTarget, { deleteAfter = true } = {}) {
    const args = ["paste-buffer", "-b", bufferName, "-t", paneTarget];
    if (deleteAfter) args.push("-d");
    this.exec(args);
  }

  sendKeys(paneTarget, keys = []) {
    this.exec(["send-keys", "-t", paneTarget, ...keys.map(String)]);
  }

  selectWindow(targetWindow) {
    this.exec(["select-window", "-t", targetWindow]);
  }

  listClients() {
    const res = this.runRaw(["list-clients", "-F", "#{client_tty}"]);
    if (!res.ok) return [];
    return res.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  switchClient(clientTty, session) {
    this.exec(["switch-client", "-c", clientTty, "-t", session]);
  }

  capturePane(paneTarget, { history = 2000 } = {}) {
    // capture-pane returns clean rendered text without ANSI codes
    const args = ["capture-pane", "-t", paneTarget, "-p", "-S", `-${history}`];
    const res = this.runRaw(args);
    return res.ok ? res.stdout : "";
  }
}

// Singleton export (consistent with other CCX libs)
let _instance = null;
export function getTmuxBackend(options) {
  if (!_instance) _instance = new TmuxBackend(options);
  return _instance;
}

export default TmuxBackend;

