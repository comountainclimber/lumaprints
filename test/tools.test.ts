import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { createToolContext, getTool, runTool, ToolError, tools } from "../src/tools.ts";
import { startMockLumaprints, type MockLumaprints } from "./fixtures/mock-server.ts";
import { apiCalls, mockContext, sampleOrder } from "./helpers.ts";

function rejectsWith(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ToolError, `expected ToolError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

describe("tool registry", () => {
  it("has well-formed, agent-ready definitions", () => {
    const names = new Set<string>();
    for (const tool of tools) {
      assert.match(tool.name, /^[a-z]+(_[a-z]+)*$/);
      assert.ok(!names.has(tool.name), `duplicate tool ${tool.name}`);
      names.add(tool.name);
      assert.ok(tool.description.length > 40, `${tool.name} needs a real description`);
      assert.equal(tool.inputSchema.type, "object");
      assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} should reject unknown fields`);
      for (const key of tool.inputSchema.required ?? []) {
        assert.ok(tool.inputSchema.properties?.[key], `${tool.name} requires undeclared ${key}`);
      }
      assert.equal(typeof tool.annotations.readOnlyHint, "boolean");
    }
    assert.equal(getTool("submit-order")?.name, "submit_order");
    assert.equal(getTool("submit_order")?.annotations.destructiveHint, true);
  });
});

describe("runTool", () => {
  let mock: MockLumaprints;

  before(async () => {
    mock = await startMockLumaprints();
  });
  after(() => mock.close());
  beforeEach(() => {
    mock.requests.length = 0;
    mock.orders.clear();
    mock.stores = [{ storeId: 1088, storeName: "Hikari Test Store" }];
  });

  it("validates input before calling the API", async () => {
    const ctx = mockContext(mock);
    await assert.rejects(runTool("list_subcategories", { categoryId: "103" }, ctx), rejectsWith("INVALID_INPUT"));
    await assert.rejects(runTool("list_subcategories", { category_id: 103 }, ctx), (error: unknown) => {
      assert.ok(error instanceof ToolError);
      assert.match(error.message, /category_id is not allowed \(expected one of: categoryId\)/);
      return true;
    });
    await assert.rejects(runTool("nope", {}, ctx), rejectsWith("UNKNOWN_TOOL"));
    assert.equal(mock.requests.length, 0);
  });

  it("answers get_config without credentials and explains what's missing elsewhere", async () => {
    const ctx = createToolContext({ env: {} });
    const config = await runTool("get_config", {}, ctx);
    assert.equal(config.environment, "sandbox");
    assert.equal(config.credentialsConfigured, false);
    assert.equal(config.canSubmitOrders, false);
    await assert.rejects(runTool("list_stores", {}, ctx), rejectsWith("CONFIG_ERROR"));
  });

  it("refuses an invalid LUMAPRINTS_ENV instead of guessing", () => {
    assert.throws(() => createToolContext({ env: { LUMAPRINTS_ENV: "prod" } }), /must be "sandbox" or "production"/);
  });

  it("searches the whole catalog by keywords and caches it", async () => {
    const ctx = mockContext(mock);
    const framed = await runTool("search_catalog", { query: "framed black" }, ctx);
    assert.equal(framed.total, 1);
    assert.deepEqual((framed.matches as Array<{ subcategoryId: number }>).map((m) => m.subcategoryId), [105001]);

    const before = mock.requests.length;
    const paper = await runTool("search_catalog", { query: "fine art paper", categoryId: 103 }, ctx);
    assert.equal(paper.total, 3);
    assert.equal(mock.requests.length, before, "second search should hit the cache");
  });

  it("previews submit_order without placing an order", async () => {
    const ctx = mockContext(mock);
    const preview = await runTool("submit_order", sampleOrder(), ctx);

    assert.equal(preview.submitted, false);
    assert.equal(apiCalls(mock, "POST", "/api/v1/orders").length, 0);
    const estimate = preview.estimate as Record<string, any>;
    assert.equal(estimate.items[0].unitPrice, 10.8);
    assert.equal(estimate.items[0].lineTotal, 21.6);
    assert.deepEqual(estimate.shipping, { carrier: "USPS", method: "usps_ground_advantage", cost: 9.35 });
    assert.equal(estimate.estimatedTotalBeforeTax, 30.95);
    assert.equal((preview.order as { storeId: number }).storeId, 1088);
    assert.match(String(preview.nextStep), /confirm: true/);
  });

  it("warns when the requested shipping method isn't quoted", async () => {
    const preview = await runTool("submit_order", sampleOrder({ shippingMethod: "freight" }), mockContext(mock));
    assert.match((preview.warnings as string[]).join(" "), /"freight" was not quoted/);
  });

  it("submits in sandbox with confirm: true and resolves the only store", async () => {
    const ctx = mockContext(mock);
    const result = await runTool("submit_order", { ...sampleOrder(), confirm: true }, ctx);
    assert.equal(result.submitted, true);
    assert.equal(result.orderNumber, 10000000001);

    const [request] = apiCalls(mock, "POST", "/api/v1/orders");
    const body = request!.body as Record<string, any>;
    assert.equal(body.storeId, 1088);
    assert.deepEqual(body.orderItems[0].orderItemOptions, []);
    assert.equal(body.confirm, undefined);

    const order = await runTool("get_order", { orderNumber: result.orderNumber }, ctx);
    assert.equal(order.orderStatus, "Pending Payment");
  });

  it("rejects a resubmitted externalId, so retries can't double-order", async () => {
    const ctx = mockContext(mock);
    await runTool("submit_order", { ...sampleOrder(), confirm: true }, ctx);
    await assert.rejects(runTool("submit_order", { ...sampleOrder(), confirm: true }, ctx), (error: unknown) => {
      assert.ok(error instanceof ToolError);
      assert.equal(error.code, "LUMAPRINTS_API_ERROR");
      assert.deepEqual((error.details as { status: number }).status, 400);
      return true;
    });
    assert.equal(mock.orders.size, 1);
  });

  it("blocks production orders unless LUMAPRINTS_ALLOW_LIVE_ORDERS is set", async () => {
    const locked = mockContext(mock, { LUMAPRINTS_ENV: "production" });
    const preview = await runTool("submit_order", sampleOrder(), locked);
    assert.equal(preview.ordersAreReal, true);
    assert.match((preview.warnings as string[]).join(" "), /LUMAPRINTS_ALLOW_LIVE_ORDERS/);

    await assert.rejects(runTool("submit_order", { ...sampleOrder(), confirm: true }, locked), rejectsWith("LIVE_ORDERS_DISABLED"));
    assert.equal(apiCalls(mock, "POST", "/api/v1/orders").length, 0);

    const unlocked = mockContext(mock, { LUMAPRINTS_ENV: "production", LUMAPRINTS_ALLOW_LIVE_ORDERS: "true" });
    const result = await runTool("submit_order", { ...sampleOrder(), confirm: true }, unlocked);
    assert.equal(result.submitted, true);
  });

  it("asks for a storeId when the account has several stores", async () => {
    mock.stores = [
      { storeId: 1, storeName: "One" },
      { storeId: 2, storeName: "Two" },
    ];
    await assert.rejects(runTool("list_orders", {}, mockContext(mock)), (error: unknown) => {
      assert.ok(error instanceof ToolError);
      assert.equal(error.code, "STORE_REQUIRED");
      assert.match(error.message, /1 \(One\), 2 \(Two\)/);
      return true;
    });
    const orders = await runTool("list_orders", {}, mockContext(mock, { LUMAPRINTS_STORE_ID: "2" }));
    assert.equal(orders.storeId, 2);
  });

  it("rejects duplicate externalItemIds within an order", async () => {
    const order = sampleOrder();
    order.orderItems.push({ ...order.orderItems[0]! });
    await assert.rejects(runTool("submit_order", order, mockContext(mock)), rejectsWith("INVALID_INPUT"));
  });

  it("notes that sandbox shipments stay empty", async () => {
    const ctx = mockContext(mock);
    const { orderNumber } = await runTool("submit_order", { ...sampleOrder(), confirm: true }, ctx);
    const shipments = await runTool("get_shipments", { orderNumber: String(orderNumber) }, ctx);
    assert.deepEqual(shipments.shipments, []);
    assert.match(String(shipments.note), /never ship/);
  });
});
