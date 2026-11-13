import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { hasCredentials } from "./env.ts";
import { AGENT_INSTRUCTIONS, runTool, toolDefinitions, toToolError, type ToolContext, type ToolErrorCode } from "./tools.ts";
import { VERSION } from "./version.ts";

export interface UiHandlerOptions {
  context: ToolContext;
}

export type UiHandler = (request: Request) => Promise<Response>;

export interface UiServerOptions extends UiHandlerOptions {
  /** Defaults to 4848. If taken, the next free port is used. */
  port?: number;
  /** Defaults to 127.0.0.1. Non-loopback hosts expose your credentials to anyone who can reach the port. */
  host?: string;
}

export interface UiServer {
  url: string;
  port: number;
  host: string;
  close(): Promise<void>;
}

const UI_HTML_URL = new URL("../ui/index.html", import.meta.url);
const MAX_BODY_BYTES = 1_000_000;
const PORT_ATTEMPTS = 20;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

const STATUS_BY_CODE: Record<ToolErrorCode, number> = {
  UNKNOWN_TOOL: 404,
  INVALID_INPUT: 400,
  CONFIG_ERROR: 409,
  STORE_REQUIRED: 409,
  LIVE_ORDERS_DISABLED: 403,
  DEMO_MODE: 403,
  LUMAPRINTS_API_ERROR: 502,
  INTERNAL_ERROR: 500,
};

const BASE_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

/**
 * The GUI as a Web-standard fetch handler: serves the page, `GET /api/meta`, and `POST /api/tools/:name`.
 * Runs anywhere that speaks Request/Response. `startUiServer` wraps it for local use.
 */
export function createUiHandler(options: UiHandlerOptions): UiHandler {
  const ctx = options.context;

  return async function handle(request) {
    try {
      const url = new URL(request.url);

      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        const nonce = randomBytes(16).toString("base64");
        const html = (await readFile(UI_HTML_URL, "utf8")).replaceAll("__CSP_NONCE__", nonce);
        return new Response(html, {
          headers: {
            ...BASE_HEADERS,
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy": [
              "default-src 'none'",
              `script-src 'nonce-${nonce}'`,
              `style-src 'nonce-${nonce}'`,
              "img-src 'self' https: http: data:",
              "connect-src 'self'",
              "base-uri 'none'",
              "form-action 'none'",
              "frame-ancestors 'none'",
            ].join("; "),
          },
        });
      }

      if (request.method === "GET" && url.pathname === "/api/meta") {
        return json(200, {
          name: "lumaprints",
          version: VERSION,
          demo: ctx.demo,
          config: {
            environment: ctx.config.environment,
            credentialsConfigured: hasCredentials(ctx.config),
            defaultStoreId: ctx.config.defaultStoreId ?? null,
            allowLiveOrders: ctx.config.allowLiveOrders && !ctx.demo,
          },
          instructions: AGENT_INSTRUCTIONS,
          tools: toolDefinitions(),
        });
      }

      const toolMatch = url.pathname.match(/^\/api\/tools\/([a-z_-]+)$/);
      if (toolMatch && request.method === "POST") {
        if (!isJsonRequest(request) || !isSameOrigin(request)) {
          return json(403, { ok: false, error: { code: "FORBIDDEN", message: "Tool calls must be same-origin JSON requests" } });
        }
        let input: unknown;
        try {
          const body = await request.text();
          if (body.length > MAX_BODY_BYTES) {
            return json(413, { ok: false, error: { code: "INVALID_INPUT", message: "Request body is too large" } });
          }
          input = body ? JSON.parse(body) : {};
        } catch (error) {
          return json(400, { ok: false, error: { code: "INVALID_INPUT", message: `Request body must be JSON: ${String(error)}` } });
        }

        const started = performance.now();
        try {
          const result = await runTool(toolMatch[1]!, input, ctx);
          return json(200, { ok: true, result, durationMs: Math.round(performance.now() - started) });
        } catch (error) {
          const toolError = toToolError(error);
          return json(STATUS_BY_CODE[toolError.code], {
            ok: false,
            error: toolError.toJSON(),
            durationMs: Math.round(performance.now() - started),
          });
        }
      }

      return json(404, { ok: false, error: { code: "NOT_FOUND", message: `${request.method} ${url.pathname}` } });
    } catch (error) {
      return json(500, { ok: false, error: { code: "INTERNAL_ERROR", message: String(error) } });
    }
  };
}

/** Serves the GUI on localhost. */
export async function startUiServer(options: UiServerOptions): Promise<UiServer> {
  const host = options.host ?? "127.0.0.1";
  const loopback = LOOPBACK_HOSTS.has(host);
  const handle = createUiHandler(options);
  let port = options.port ?? 4848;

  const server = createServer((req, res) => {
    handleNodeRequest(req, res).catch((error) => {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: { code: "INTERNAL_ERROR", message: String(error) } }));
    });
  });

  async function handleNodeRequest(req: IncomingMessage, res: ServerResponse) {
    const actualPort = (server.address() as AddressInfo).port;
    // Blocks DNS-rebinding: a malicious page can point its own hostname at 127.0.0.1, but not fake the Host header.
    if (loopback && !isAllowedHost(req.headers.host, actualPort)) {
      return writeResponse(res, json(403, { ok: false, error: { code: "FORBIDDEN", message: "Unexpected Host header" } }));
    }

    let body: string | undefined;
    if (req.method !== "GET" && req.method !== "HEAD") {
      try {
        body = await readBody(req);
      } catch {
        return writeResponse(res, json(413, { ok: false, error: { code: "INVALID_INPUT", message: "Request body is too large" } }));
      }
    }

    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || name.startsWith("x-forwarded-")) continue;
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    await writeResponse(res, await handle(new Request(url, { method: req.method, headers, body })));
  }

  for (let attempt = 0; ; attempt++) {
    try {
      await listen(server, port, host);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE" || attempt >= PORT_ATTEMPTS - 1 || port === 0) throw error;
      port += 1;
    }
  }

  const actual = (server.address() as AddressInfo).port;
  const displayHost = host === "0.0.0.0" || host === "::" ? "localhost" : host.includes(":") ? `[${host}]` : host;
  return {
    url: `http://${displayHost}:${actual}/`,
    port: actual,
    host,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, "Content-Type": "application/json; charset=utf-8" },
  });
}

async function writeResponse(res: ServerResponse, response: Response) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function isAllowedHost(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(hostHeader.toLowerCase());
}

function isJsonRequest(request: Request): boolean {
  return (request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json");
}

/** Behind a proxy (e.g. Vercel) the public host arrives in X-Forwarded-Host. */
function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? new URL(request.url).host;
  try {
    return new URL(origin).host === host.split(",")[0]!.trim();
  } catch {
    return false;
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
