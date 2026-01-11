/**
 * CCX Agent Mux - registry
 *
 * Persists project/agent metadata under:
 *   .ccx/projects/<project>/
 *     - project.json
 *     - agents.json
 *     - logs/<agent>.log
 *
 * Required by spec:
 * - Registry: .ccx/projects/<project>/agents.json
 */

import fs from "fs";
import path from "path";
import os from "os";

const CCX_DIR = ".ccx";
const PROJECTS_DIR = "projects";
const PROJECT_META_FILE = "project.json";
const AGENTS_FILE = "agents.json";
const CURRENT_PROJECT_FILE = "current.json";
const LOGS_DIR = "logs";

function canWrite(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, data) {
  const tmp = `${filePath}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

export class AgentRegistry {
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || process.cwd();

    this.ccxDir = path.join(this.projectRoot, CCX_DIR);
    this.projectsDir = path.join(this.ccxDir, PROJECTS_DIR);

    this.fallbackDir = path.join(os.tmpdir(), "ccx-agent-mux");
    this.fallbackProjectsDir = path.join(this.fallbackDir, PROJECTS_DIR);

    this._ensureBaseDirs();
  }

  _ensureBaseDirs() {
    try {
      fs.mkdirSync(this.projectsDir, { recursive: true });
    } catch {
      fs.mkdirSync(this.fallbackProjectsDir, { recursive: true });
    }
  }

  _getProjectsDir() {
    if (canWrite(this.ccxDir)) return this.projectsDir;
    return this.fallbackProjectsDir;
  }

  getProjectDir(projectName) {
    return path.join(this._getProjectsDir(), String(projectName));
  }

  getProjectMetaPath(projectName) {
    return path.join(this.getProjectDir(projectName), PROJECT_META_FILE);
  }

  getAgentsPath(projectName) {
    return path.join(this.getProjectDir(projectName), AGENTS_FILE);
  }

  getLogsDir(projectName) {
    return path.join(this.getProjectDir(projectName), LOGS_DIR);
  }

  getAgentLogPath(projectName, agentName) {
    return path.join(this.getLogsDir(projectName), `${agentName}.log`);
  }

  listProjectNames() {
    const base = this._getProjectsDir();
    try {
      const entries = fs.readdirSync(base, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .filter(Boolean)
        .sort();
    } catch {
      return [];
    }
  }

  ensureProject(projectName, meta = {}) {
    const dir = this.getProjectDir(projectName);
    const logsDir = this.getLogsDir(projectName);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });

    const projectMetaPath = this.getProjectMetaPath(projectName);
    if (!fs.existsSync(projectMetaPath)) {
      writeJsonAtomic(projectMetaPath, {
        name: String(projectName),
        cwd: meta.cwd ? String(meta.cwd) : null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    } else if (meta && Object.keys(meta).length > 0) {
      const current = readJson(projectMetaPath, {});
      writeJsonAtomic(projectMetaPath, {
        ...current,
        ...meta,
        name: String(projectName),
        updatedAt: new Date().toISOString(),
      });
    }

    const agentsPath = this.getAgentsPath(projectName);
    if (!fs.existsSync(agentsPath)) {
      writeJsonAtomic(agentsPath, {
        project: String(projectName),
        agents: [],
        updatedAt: new Date().toISOString(),
      });
    }
  }

  loadProjectMeta(projectName) {
    return readJson(this.getProjectMetaPath(projectName), null);
  }

  saveProjectMeta(projectName, meta) {
    writeJsonAtomic(this.getProjectMetaPath(projectName), {
      ...meta,
      name: String(projectName),
      updatedAt: new Date().toISOString(),
    });
  }

  loadAgents(projectName) {
    return readJson(this.getAgentsPath(projectName), {
      project: String(projectName),
      agents: [],
      updatedAt: null,
    });
  }

  saveAgents(projectName, data) {
    writeJsonAtomic(this.getAgentsPath(projectName), {
      ...data,
      project: String(projectName),
      updatedAt: new Date().toISOString(),
    });
  }

  getCurrentProject() {
    const filePath = path.join(this._getProjectsDir(), CURRENT_PROJECT_FILE);
    const data = readJson(filePath, null);
    return data?.name || null;
  }

  setCurrentProject(projectName) {
    const filePath = path.join(this._getProjectsDir(), CURRENT_PROJECT_FILE);
    writeJsonAtomic(filePath, {
      name: String(projectName),
      updatedAt: new Date().toISOString(),
    });
  }

  clearCurrentProject() {
    const filePath = path.join(this._getProjectsDir(), CURRENT_PROJECT_FILE);
    try {
      fs.unlinkSync(filePath);
    } catch {
      // ignore
    }
  }
}

// Singleton export (consistent with other CCX libs)
let _instance = null;
export function getAgentRegistry(options) {
  if (!_instance) _instance = new AgentRegistry(options);
  return _instance;
}

export default AgentRegistry;

