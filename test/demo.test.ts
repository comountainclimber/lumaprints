import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { createDemoToolContext } from "../src/demo.ts";
import { createMcpHandler } from "../src/mcp.ts";
import { runTool, ToolError } from "../src/tools.ts";
import { createUiHandler } from "../src/ui-server.ts";
import { sampleOrder } from "./helpers.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

describe("demo mode", () => {
  const ctx = createDemoToolContext();
  const run = (name: string, input: Record<string, unknown> = {}) => runTool(name, input, ctx) as Promise<any>;

  it("reports itself as a demo that can't submit", async () => {
    const config = await run("get_config");
    assert.equal(config.demo, true);
    assert.equal(config.canSubmitOrders, false);
    assert.equal(config.ordersAreReal, false);
    assert.match(config.notes[0], /Demo mode/);
  });

  it("answers catalog, pricing, and order lookups from sample data without any network", async () => {
    const frames = await run("search_catalog", { query: "black frame" });
    assert.ok(frames.total >= 3);
    assert.ok(frames.matches.every((m: { categoryId: number }) => m.categoryId === 105));

    const price = await run("get_product_price", { subcategoryId: 103001, width: 8, height: 10 });
    assert.equal(typeof price.price, "number");
    assert.ok(price.price > 0);

    const tooBig = run("get_product_price", { subcategoryId: 105001, width: 80, height: 100 });
    await assert.rejects(tooBig, (error: ToolError) => error.code === "LUMAPRINTS_API_ERROR" && /outside/.test(error.message));

    const orders = await run("list_orders");
    assert.equal(orders.orders.length, 4);
    const shipped = orders.orders.find((o: { orderStatus: string }) => o.orderStatus === "Shipped");
    const shipments = await run("get_shipments", { orderNumber: shipped.orderNumber });
    assert.ok(shipments.shipments[0].trackingNumber);

    assert.equal((await run("check_image", { imageUrl: "https://example.com/art.jpg", subcategoryId: 103001, printWidth: 8, printHeight: 10 })).ok, true);
    assert.equal((await run("check_image", { imageUrl: "https://example.com/art-small.jpg", subcategoryId: 103001, printWidth: 8, printHeight: 10 })).ok, false);
  });

  it("previews orders but refuses to submit them or register webhooks", async () => {
    const preview = await run("submit_order", sampleOrder());
    assert.equal(preview.submitted, false);
    assert.equal(preview.demo, true);
    assert.ok(preview.estimate.estimatedTotalBeforeTax > 0);

    await assert.rejects(run("submit_order", { ...sampleOrder(), confirm: true }), (error: ToolError) => error.code === "DEMO_MODE");
    await assert.rejects(run("subscribe_webhook", { url: "https://example.com/hook" }), (error: ToolError) => error.code === "DEMO_MODE");
  });

  it("tells MCP clients they're connected to the demo", async () => {
    const response = (await createMcpHandler(ctx)({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })) as any;
    assert.match(response.result.instructions, /DEMO MODE/);
  });
});

describe("ui fetch handler (as deployed on Vercel)", () => {
  const handle = createUiHandler({ context: createDemoToolContext() });
  const host = "lumaprints-demo.vercel.app";
  const post = (tool: string, input: unknown, headers: Record<string, string> = {}) =>
    handle(new Request(`https://${host}/api/tools/${tool}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: host, Origin: `https://${host}`, ...headers },
      body: JSON.stringify(input),
    }));

  it("serves the page and demo metadata", async () => {
    const page = await handle(new Request(`https://${host}/`));
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'nonce-/);

    const meta = (await (await handle(new Request(`https://${host}/api/meta`))).json()) as any;
    assert.equal(meta.demo, true);
    assert.equal(meta.config.allowLiveOrders, false);
  });

  it("runs read tools, blocks submits with 403, and checks origin against the forwarded host", async () => {
    const ok = await post("search_catalog", { query: "canvas" });
    assert.equal(ok.status, 200);

    const blocked = await post("submit_order", { ...sampleOrder(), confirm: true });
    assert.equal(blocked.status, 403);
    assert.equal(((await blocked.json()) as any).error.code, "DEMO_MODE");

    const proxied = await post("list_stores", {}, { Host: "internal.vercel", "X-Forwarded-Host": host });
    assert.equal(proxied.status, 200);

    const foreign = await post("list_stores", {}, { Origin: "https://evil.example" });
    assert.equal(foreign.status, 403);
  });
});

describe("cli --demo", () => {
  function cli(args: string[]) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH ?? "" } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  }

  it("works with no credentials and refuses to submit", async () => {
    const stores = await cli(["list-stores", "--demo"]);
    assert.equal(stores.code, 0);
    assert.equal(JSON.parse(stores.stdout).stores[0].storeName, "Demo Print Shop");

    const submit = await cli(["submit-order", "--demo", "--input", JSON.stringify({ ...sampleOrder(), confirm: true })]);
    assert.equal(submit.code, 1);
    assert.equal(JSON.parse(submit.stderr).error.code, "DEMO_MODE");
  });
});
