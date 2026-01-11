#!/usr/bin/env node
/**
 * Agent Mux MCP Server
 *
 * Dynamic agent pool using tmux:
 * - Private socket: `tmux -L ccx ...`
 * - One project = one tmux session
 * - One agent = one tmux window (not pane)
 * - Window metadata via user options: @ccx_agent_name / @ccx_agent_type
 * - Send text via buffer paste: set-buffer + paste-buffer
 * - Read output via pipe-pane to: .ccx/projects/<project>/logs/<agent>.log
 * - Registry: .ccx/projects/<project>/agents.json
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { getAgentMux } from "../index.mjs";

const agentMux = getAgentMux({ projectRoot: process.cwd(), tmuxSocketName: "ccx" });

const server = new Server(
  { name: "agent-mux", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // ---------- Project management ----------
    {
      name: "create_project",
      description: "Create a new project (tmux session) and initialize .ccx/projects/<project>/ directory",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Project name (tmux session name)" },
          cwd: { type: "string", description: "Project working directory (optional, for tmux start-directory)" },
        },
        required: ["name"],
      },
    },
    {
      name: "list_projects",
      description: "List all projects (tmux sessions + local registry directories)",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "switch_project",
      description: "Switch current project (writes to .ccx/projects/current.json and best-effort switches tmux clients)",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", description: "Project name (tmux session name)" } },
        required: ["name"],
      },
    },
    {
      name: "close_project",
      description: "Close entire project (kill tmux session; keeps .ccx/projects/<project>/ files)",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", description: "Project name (tmux session name)" } },
        required: ["name"],
      },
    },

    // ---------- Agent management ----------
    {
      name: "spawn_agent",
      description: "Create agent (type: claude/codex/gemini), one agent = one tmux window",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", description: "Agent type: claude/codex/gemini" },
          name: { type: "string", description: "Agent name (used for window name & registry key)" },
          options: {
            type: "object",
            description: "Optional: override cwd/command/args",
            properties: {
              cwd: { type: "string", description: "Agent window working directory (defaults to project cwd)" },
              command: { type: "string", description: "Start command (defaults by type)" },
              args: { type: "array", items: { type: "string" }, description: "Start arguments array (defaults by type)" },
            },
            required: [],
          },
        },
        required: ["type", "name"],
      },
    },
    {
      name: "send_to_agent",
      description: "Send message to agent (via tmux send-keys)",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Agent name" },
          text: { type: "string", description: "Text to send" },
        },
        required: ["name", "text"],
      },
    },
    {
      name: "read_agent_output",
      description: "Read agent output (tail N lines from pipe-pane log file)",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Agent name" },
          lines: { type: "number", description: "Number of tail lines (default 200)" },
        },
        required: ["name"],
      },
    },
    {
      name: "interrupt_agent",
      description: "Interrupt agent (Ctrl+C)",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", description: "Agent name" } },
        required: ["name"],
      },
    },
    {
      name: "kill_agent",
      description: "Close agent (kill tmux window + update registry)",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", description: "Agent name" } },
        required: ["name"],
      },
    },
    {
      name: "list_agents",
      description: "List agents (defaults to current project; can specify project)",
      inputSchema: {
        type: "object",
        properties: { project: { type: "string", description: "Project name (optional)" } },
        required: [],
      },
    },
    {
      name: "attach_agent",
      description: "Switch to agent window (best-effort: switch tmux clients to project + select-window)",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", description: "Agent name" } },
        required: ["name"],
      },
    },
    {
      name: "send_to_window",
      description: "Send message to any tmux window (not limited to registered agents, can send to main window)",
      inputSchema: {
        type: "object",
        properties: {
          window: { type: "string", description: "Window name (e.g., main, claude-1)" },
          text: { type: "string", description: "Text to send" },
        },
        required: ["window", "text"],
      },
    },
  ],
}));

function okResponse(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

function errResponse(toolName, err) {
  const msg = err?.message ? String(err.message) : String(err);
  return { content: [{ type: "text", text: `Error in ${toolName}: ${msg}` }], isError: true };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "create_project") {
      return okResponse(agentMux.create_project(args?.name, args?.cwd));
    }
    if (name === "list_projects") {
      return okResponse(agentMux.list_projects());
    }
    if (name === "switch_project") {
      return okResponse(agentMux.switch_project(args?.name));
    }
    if (name === "close_project") {
      return okResponse(agentMux.close_project(args?.name));
    }
    if (name === "spawn_agent") {
      return okResponse(agentMux.spawn_agent(args?.type, args?.name, args?.options));
    }
    if (name === "send_to_agent") {
      return okResponse(agentMux.send_to_agent(args?.name, args?.text));
    }
    if (name === "read_agent_output") {
      return okResponse(agentMux.read_agent_output(args?.name, args?.lines));
    }
    if (name === "interrupt_agent") {
      return okResponse(agentMux.interrupt_agent(args?.name));
    }
    if (name === "kill_agent") {
      return okResponse(agentMux.kill_agent(args?.name));
    }
    if (name === "list_agents") {
      return okResponse(agentMux.list_agents(args?.project));
    }
    if (name === "attach_agent") {
      return okResponse(agentMux.attach_agent(args?.name));
    }
    if (name === "send_to_window") {
      return okResponse(agentMux.send_to_window(args?.window, args?.text));
    }
    return errResponse(name, new Error(`Unknown tool: ${name}`));
  } catch (e) {
    return errResponse(name, e);
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("agent-mux MCP server started (tmux socket: ccx)");
}

main().catch((err) => {
  console.error("MCP server error:", err);
  process.exit(1);
});
