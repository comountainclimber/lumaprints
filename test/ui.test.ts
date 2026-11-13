import assert from "node:assert/strict";
import { request } from "node:http";
import { after, before, describe, it } from "node:test";
import { startUiServer, type UiServer } from "../src/ui-server.ts";
import { startMockLumaprints, type MockLumaprints } from "./fixtures/mock-server.ts";
import { mockContext, sampleOrder } from "./helpers.ts";

function rawRequest(port: number, options: { method?: string; path: string; headers?: Record<string, string>; body?: string }) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: options.method ?? "GET", path: options.path, headers: options.headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

describe("ui server", () => {
  let mock: MockLumaprints;
  let ui: UiServer;
  const post = (tool: string, input: unknown) =>
    fetch(`${ui.url}api/tools/${tool}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  const json = async (res: Response | Promise<Response>): Promise<any> => (await res).json();

  before(async () => {
    mock = await startMockLumaprints();
    ui = await startUiServer({ context: mockContext(mock), port: 0 });
  });
  after(async () => {
    await ui.close();
    await mock.close();
  });

  it("serves the console with a per-request CSP nonce", async () => {
    const res = await fetch(ui.url);
    const html = await res.text();
    const csp = res.headers.get("content-security-policy") ?? "";
    const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
    assert.ok(nonce);
    assert.ok(html.includes(`<script nonce="${nonce}">`));
    assert.ok(!html.includes("__CSP_NONCE__"));
    assert.match(csp, /frame-ancestors 'none'/);
  });

  it("exposes config and tool definitions without secrets", async () => {
    const meta = await json(fetch(`${ui.url}api/meta`));
    assert.equal(meta.config.environment, "sandbox");
    assert.equal(meta.config.credentialsConfigured, true);
    assert.equal(meta.tools.length, 15);
    assert.ok(!JSON.stringify(meta).includes("test-secret"));
  });

  it("runs tools and maps errors to HTTP statuses", async () => {
    const ok = await post("list_stores", {});
    assert.equal(ok.status, 200);
    assert.equal((await json(ok)).result.stores[0].storeId, 1088);

    const preview = await json(post("submit_order", sampleOrder()));
    assert.equal(preview.result.submitted, false);

    const invalid = await post("list_subcategories", { categoryId: "x" });
    assert.equal(invalid.status, 400);
    assert.equal((await json(invalid)).error.code, "INVALID_INPUT");

    const unknown = await post("nope", {});
    assert.equal(unknown.status, 404);
  });

  it("rejects foreign Host headers, cross-origin calls, and non-JSON posts", async () => {
    const rebound = await rawRequest(ui.port, { path: "/api/meta", headers: { Host: "evil.example:80" } });
    assert.equal(rebound.status, 403);

    const crossOrigin = await rawRequest(ui.port, {
      method: "POST",
      path: "/api/tools/list_stores",
      headers: { Host: `127.0.0.1:${ui.port}`, Origin: "https://evil.example", "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(crossOrigin.status, 403);

    const form = await rawRequest(ui.port, {
      method: "POST",
      path: "/api/tools/list_stores",
      headers: { Host: `127.0.0.1:${ui.port}`, "Content-Type": "text/plain" },
      body: "{}",
    });
    assert.equal(form.status, 403);
  });

  it("moves to the next port when the requested one is taken", async () => {
    const second = await startUiServer({ context: mockContext(mock), port: ui.port });
    try {
      assert.notEqual(second.port, ui.port);
    } finally {
      await second.close();
    }
  });
});
