import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createMcpHandler, SUPPORTED_PROTOCOL_VERSIONS } from "../src/mcp.ts";
import { tools } from "../src/tools.ts";
import { startMockLumaprints, type MockLumaprints } from "./fixtures/mock-server.ts";
import { mockContext, mockEnv, sampleOrder } from "./helpers.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

type ToolResult = { isError?: boolean; structuredContent?: Record<string, any>; content: Array<{ type: string; text: string }> };

describe("MCP server (official SDK client over stdio)", () => {
  let mock: MockLumaprints;
  let client: Client;

  before(async () => {
    mock = await startMockLumaprints();
    client = new Client({ name: "lumaprints-test", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env: mockEnv(mock), cwd: tmpdir(), stderr: "pipe" }),
    );
  });
  after(async () => {
    await client.close();
    await mock.close();
  });

  it("negotiates the latest protocol and sends agent instructions", () => {
    assert.equal(client.getServerVersion()?.name, "lumaprints");
    assert.deepEqual(client.getServerCapabilities()?.tools, { listChanged: false });
    const instructions = client.getInstructions() ?? "";
    assert.match(instructions, /confirm: true/);
    assert.match(instructions, /Active environment: sandbox/);
  });

  it("lists every tool with schemas and annotations", async () => {
    const { tools: listed } = await client.listTools();
    assert.deepEqual(listed.map((t) => t.name), tools.map((t) => t.name));
    const submit = listed.find((t) => t.name === "submit_order")!;
    assert.equal(submit.annotations?.destructiveHint, true);
    assert.equal(submit.inputSchema.type, "object");
    assert.ok(submit.inputSchema.properties?.confirm);
  });

  it("returns structured content and a JSON text block", async () => {
    const result = (await client.callTool({ name: "list_stores", arguments: {} })) as ToolResult;
    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent?.stores, [{ storeId: 1088, storeName: "Hikari Test Store" }]);
    assert.deepEqual(JSON.parse(result.content[0]!.text), result.structuredContent);
  });

  it("previews orders unless confirm is true", async () => {
    const preview = (await client.callTool({ name: "submit_order", arguments: sampleOrder() })) as ToolResult;
    assert.equal(preview.structuredContent?.submitted, false);
    assert.equal(mock.orders.size, 0);
  });

  it("reports tool failures as isError results the model can read", async () => {
    const result = (await client.callTool({ name: "list_subcategories", arguments: { categoryId: "abc" } })) as ToolResult;
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0]!.text).error.code, "INVALID_INPUT");
  });

  it("rejects unknown tools at the protocol level", async () => {
    await assert.rejects(client.callTool({ name: "does_not_exist", arguments: {} }), /Unknown tool/);
  });
});

describe("createMcpHandler (raw JSON-RPC)", () => {
  let mock: MockLumaprints;
  before(async () => {
    mock = await startMockLumaprints();
  });
  after(() => mock.close());

  it("echoes supported protocol versions and falls back to the newest", async () => {
    const handle = createMcpHandler(mockContext(mock));
    const init = (version: string) =>
      handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: version, capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    assert.equal(((await init("2024-11-05")) as any).result.protocolVersion, "2024-11-05");
    assert.equal(((await init("2099-01-01")) as any).result.protocolVersion, SUPPORTED_PROTOCOL_VERSIONS[0]);
  });

  it("handles ping, notifications, unknown methods, and batches", async () => {
    const handle = createMcpHandler(mockContext(mock));
    assert.deepEqual(await handle({ jsonrpc: "2.0", id: 7, method: "ping" }), { jsonrpc: "2.0", id: 7, result: {} });
    assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
    assert.equal(((await handle({ jsonrpc: "2.0", id: 8, method: "resources/list" })) as any).error.code, -32601);
    const batch = (await handle([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ])) as any[];
    assert.deepEqual(batch.map((r) => r.id), [1, 2]);
  });
});
