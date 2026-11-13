import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { AGENT_INSTRUCTIONS, getTool, runTool, toolDefinitions, toToolError, type ToolContext } from "./tools.ts";
import { isPlainObject } from "./validate.ts";
import { VERSION } from "./version.ts";

/** Newest first. Unknown client versions get the newest; the client decides whether to continue. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

type JsonRpcId = string | number | null;

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export type McpMessageHandler = (message: unknown) => Promise<JsonRpcResponse | JsonRpcResponse[] | null>;

/** Transport-agnostic MCP handler: takes a parsed JSON-RPC message, returns the response (or null for notifications). */
export function createMcpHandler(ctx: ToolContext): McpMessageHandler {
  async function dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "initialize": {
        const requested = params.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.find((version) => version === requested)
          ?? SUPPORTED_PROTOCOL_VERSIONS[0];
        return {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "lumaprints", title: "Lumaprints", version: VERSION },
          instructions: ctx.demo
            ? `${AGENT_INSTRUCTIONS}\n\nDEMO MODE: sample catalog, prices, and orders; nothing reaches Lumaprints. Previews work; submitting orders and registering webhooks are disabled.`
            : `${AGENT_INSTRUCTIONS}\n\nActive environment: ${ctx.config.environment}.`,
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: toolDefinitions().map(({ category: _category, ...tool }) => tool) };
      case "tools/call": {
        const name = params.name;
        if (typeof name !== "string" || !getTool(name)) {
          throw new RpcError(-32602, `Unknown tool: ${String(name)}`);
        }
        try {
          const result = await runTool(name, params.arguments ?? {}, ctx);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
            isError: false,
          };
        } catch (error) {
          const toolError = toToolError(error);
          return {
            content: [{ type: "text", text: JSON.stringify({ error: toolError.toJSON() }, null, 2) }],
            isError: true,
          };
        }
      }
      default:
        throw new RpcError(-32601, `Method not found: ${method}`);
    }
  }

  async function handle(message: unknown): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
    if (Array.isArray(message)) {
      const responses = (await Promise.all(message.map(handle))).flat().filter((r) => r !== null);
      return responses.length ? (responses as JsonRpcResponse[]) : null;
    }
    if (!isPlainObject(message)) return rpcError(null, -32600, "Invalid Request");

    const id = (message.id ?? null) as JsonRpcId;
    if (typeof message.method !== "string") {
      // Responses to server-initiated requests; this server never sends any.
      if ("result" in message || "error" in message) return null;
      return rpcError(id, -32600, "Invalid Request");
    }

    const isNotification = message.id === undefined;
    if (isNotification) return null;

    try {
      const params = isPlainObject(message.params) ? message.params : {};
      return { jsonrpc: "2.0", id, result: await dispatch(message.method, params) };
    } catch (error) {
      if (error instanceof RpcError) return rpcError(id, error.code, error.message);
      return rpcError(id, -32603, error instanceof Error ? error.message : String(error));
    }
  }

  return handle;
}

function rpcError(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export interface ServeMcpStdioOptions {
  context: ToolContext;
  input?: Readable;
  output?: Writable;
}

/** Serves MCP over newline-delimited JSON-RPC on stdio. Resolves when input closes. */
export async function serveMcpStdio(options: ServeMcpStdioOptions): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const handle = createMcpHandler(options.context);
  const pending = new Set<Promise<void>>();

  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    const text = line.trim();
    if (!text) continue;

    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      output.write(`${JSON.stringify(rpcError(null, -32700, "Parse error"))}\n`);
      continue;
    }

    const task = handle(message).then((response) => {
      if (response) output.write(`${JSON.stringify(response)}\n`);
    });
    pending.add(task);
    void task.finally(() => pending.delete(task));
  }

  await Promise.allSettled(pending);
}
