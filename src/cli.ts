#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { text } from "node:stream/consumers";
import { ENV_VARS } from "./env.ts";
import { serveMcpStdio } from "./mcp.ts";
import { createDemoToolContext } from "./demo.ts";
import {
  createToolContext,
  getTool,
  runTool,
  toolDefinitions,
  toToolError,
  ToolError,
  tools,
  type LumaprintsTool,
  type ToolContext,
} from "./tools.ts";
import { startUiServer } from "./ui-server.ts";
import type { JsonSchema } from "./validate.ts";
import { VERSION } from "./version.ts";

const EXIT_OK = 0;
const EXIT_TOOL_ERROR = 1;
const EXIT_USAGE = 2;

class UsageError extends Error {}

async function main(rawArgv: string[]): Promise<number> {
  const demo = rawArgv.includes("--demo");
  const argv = rawArgv.filter((arg) => arg !== "--demo");
  const [command, ...rest] = argv;
  const createContext = () => (demo ? createDemoToolContext() : createToolContext());

  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    const tool = rest[0] ? getTool(rest[0]) : undefined;
    process.stdout.write(tool ? toolHelp(tool) : mainHelp());
    return EXIT_OK;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return EXIT_OK;
  }

  if (!demo) loadDotEnv();

  switch (command) {
    case "mcp":
      await serveMcpStdio({ context: createContext() });
      return EXIT_OK;

    case "ui":
      return runUi(rest, createContext());

    case "tools": {
      const definitions = toolDefinitions();
      printJson(rest.includes("--names") ? definitions.map((t) => t.name) : definitions);
      return EXIT_OK;
    }

    default: {
      const tool = getTool(command);
      if (!tool) throw new UsageError(`Unknown command "${command}". Run "lumaprints help" to see commands and tools.`);
      if (rest.includes("--help") || rest.includes("-h")) {
        process.stdout.write(toolHelp(tool));
        return EXIT_OK;
      }
      const input = await parseToolInput(tool, rest);
      printJson(await runTool(tool.name, input, createContext()));
      return EXIT_OK;
    }
  }
}

async function runUi(args: string[], context: ToolContext): Promise<number> {
  const flags = parseFlags(args);
  const port = flags.port === undefined ? undefined : Number(flags.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    throw new UsageError(`--port must be a port number, got "${flags.port}"`);
  }
  const host = typeof flags.host === "string" ? flags.host : undefined;
  const server = await startUiServer({ context, port, host });

  const lines = [
    `Lumaprints UI running at ${server.url}`,
    context.demo
      ? "Demo mode: sample data, no credentials, nothing reaches Lumaprints."
      : `Environment: ${context.config.environment}${context.config.environment === "production" ? " (orders are real)" : ""}`,
  ];
  if (!context.demo && host && !["127.0.0.1", "localhost", "::1"].includes(host)) {
    lines.push(`Warning: listening on ${host}. Anyone who can reach this port can use your Lumaprints credentials.`);
  }
  lines.push("Press Ctrl+C to stop.");
  process.stderr.write(`${lines.join("\n")}\n`);

  if (flags.open) openBrowser(server.url);

  await new Promise<void>((resolve) => {
    const stop = () => {
      void server.close().finally(resolve);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// Argument parsing

type Flags = Record<string, string | true>;

function parseFlags(args: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) throw new UsageError(`Unexpected argument "${arg}". Flags look like --name value.`);
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const next = args[i + 1];
    if (next === undefined || (next.startsWith("--") && next.length > 2)) {
      flags[arg.slice(2)] = true;
    } else {
      flags[arg.slice(2)] = next;
      i++;
    }
  }
  return flags;
}

async function parseToolInput(tool: LumaprintsTool, args: string[]): Promise<Record<string, unknown>> {
  const { input: rawInput, ...fieldFlags } = parseFlags(args);
  let input: Record<string, unknown> = {};

  if (rawInput !== undefined) {
    if (rawInput === true) throw new UsageError("--input needs a value: JSON, @file.json, or - for stdin");
    const source = rawInput === "-" ? await text(process.stdin)
      : rawInput.startsWith("@") ? readFileSync(rawInput.slice(1), "utf8")
      : rawInput;
    try {
      input = JSON.parse(source);
    } catch (error) {
      throw new UsageError(`--input is not valid JSON: ${(error as Error).message}`);
    }
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new UsageError("--input must be a JSON object");
    }
  }

  for (const [flag, value] of Object.entries(fieldFlags)) {
    const key = kebabToCamel(flag);
    input[key] = coerce(value, tool.inputSchema.properties?.[key], flag);
  }
  return input;
}

function coerce(value: string | true, schema: JsonSchema | undefined, flag: string): unknown {
  const types = schema?.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (value === true) {
    if (types.includes("boolean")) return true;
    throw new UsageError(`--${flag} needs a value`);
  }
  if (types.includes("boolean") && /^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if ((types.includes("integer") || types.includes("number")) && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (types.includes("object") || (types.includes("array") && value.trim().startsWith("["))) {
    try {
      return JSON.parse(value);
    } catch {
      throw new UsageError(`--${flag} must be JSON`);
    }
  }
  if (types.includes("array")) {
    const itemTypes = schema?.items?.type;
    const numeric = itemTypes === "integer" || itemTypes === "number";
    return value.split(",").map((part) => part.trim()).filter(Boolean).map((part) => (numeric ? Number(part) : part));
  }
  return value;
}

function kebabToCamel(value: string): string {
  return value.replace(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase());
}

function camelToKebab(value: string): string {
  return value.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

// ---------------------------------------------------------------------------
// Output

function printJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printError(code: string, message: string, details?: unknown) {
  process.stderr.write(`${JSON.stringify({ error: { code, message, ...(details === undefined ? {} : { details }) } }, null, 2)}\n`);
}

function mainHelp(): string {
  const width = Math.max(...tools.map((tool) => tool.name.length)) + 2;
  const toolLines = tools.map((tool) => `  ${tool.name.replace(/_/g, "-").padEnd(width)}${firstSentence(tool.description)}`);
  return `lumaprints ${VERSION} - agent-first toolkit for the Lumaprints print-on-demand API (unofficial)

Usage:
  lumaprints <tool> [--field value ...] [--input JSON|@file.json|-]
  lumaprints mcp                          Serve every tool over MCP (stdio)
  lumaprints ui [--port 4848] [--open]    Local GUI over the same tools
  lumaprints tools [--names]              Tool names, descriptions, and JSON Schemas
  lumaprints help <tool>                  Flags and schema for one tool

Add --demo to any command to use built-in sample data: no credentials, no API calls, submitting disabled.

Tools:
${toolLines.join("\n")}

Output is JSON on stdout. Errors are JSON on stderr with exit code 1 (tool or API error) or 2 (bad usage or input).

Environment (a .env file in the current directory is loaded automatically):
  ${ENV_VARS.apiKey}, ${ENV_VARS.apiSecret}   Credentials (Developer > API Keys)
  ${ENV_VARS.environment}=sandbox|production       Defaults to sandbox
  ${ENV_VARS.storeId}                      Default Standard Store (optional)
  ${ENV_VARS.allowLiveOrders}=true         Required to submit production orders

Examples:
  lumaprints ui --demo --open                                 # try it without an account
  lumaprints search-catalog --query "framed black"
  lumaprints get-product-price --subcategory-id 103001 --width 8 --height 10
  lumaprints submit-order --input @order.json                 # preview only
  lumaprints submit-order --input @order.json --confirm true  # submits
`;
}

function toolHelp(tool: LumaprintsTool): string {
  const properties = Object.entries(tool.inputSchema.properties ?? {});
  const required = new Set(tool.inputSchema.required ?? []);
  const flagLines = properties.map(([key, schema]) => {
    const type = Array.isArray(schema.type) ? schema.type.join("|") : schema.type ?? "any";
    const enumText = schema.enum ? ` (${schema.enum.join("|")})` : "";
    return `  --${camelToKebab(key)} <${type}>${required.has(key) ? " (required)" : ""}${enumText}\n      ${schema.description ?? ""}`.trimEnd();
  });
  return `lumaprints ${tool.name.replace(/_/g, "-")}

${tool.description}

Flags:
${flagLines.length ? flagLines.join("\n") : "  (none)"}
  --input <JSON|@file.json|->
      Whole input as JSON. Field flags override matching keys.

Input schema:
${JSON.stringify(tool.inputSchema, null, 2)}
`;
}

function firstSentence(text: string): string {
  const end = text.search(/(?<!\b(?:e\.g|i\.e))\.(\s|$)/);
  return end === -1 ? text : text.slice(0, end + 1);
}

function loadDotEnv() {
  if (!existsSync(".env")) return;
  try {
    process.loadEnvFile(".env");
  } catch (error) {
    process.stderr.write(`Warning: could not load .env: ${(error as Error).message}\n`);
  }
}

function openBrowser(url: string) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof UsageError) {
      printError("USAGE", error.message);
      process.exitCode = EXIT_USAGE;
      return;
    }
    const toolError = error instanceof ToolError ? error : toToolError(error);
    printError(toolError.code, toolError.message, toolError.details);
    process.exitCode = toolError.code === "INVALID_INPUT" || toolError.code === "UNKNOWN_TOOL" ? EXIT_USAGE : EXIT_TOOL_ERROR;
  },
);
