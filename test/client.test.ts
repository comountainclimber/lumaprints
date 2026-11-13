import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import { createLumaprintsClient, LUMAPRINTS_BASE_URLS, LumaprintsError, VERSION } from "../src/index.ts";
import { MOCK_CREDENTIALS, startMockLumaprints, type MockLumaprints } from "./fixtures/mock-server.ts";

describe("createLumaprintsClient", () => {
  let mock: MockLumaprints;
  const client = () => createLumaprintsClient({ ...MOCK_CREDENTIALS, baseUrl: mock.url });

  before(async () => {
    mock = await startMockLumaprints();
  });
  after(() => mock.close());
  beforeEach(() => {
    mock.requests.length = 0;
    mock.rateLimitNext = 0;
  });

  it("defaults to sandbox and never picks production implicitly", () => {
    assert.equal(createLumaprintsClient(MOCK_CREDENTIALS).baseUrl, LUMAPRINTS_BASE_URLS.sandbox);
    assert.equal(
      createLumaprintsClient({ ...MOCK_CREDENTIALS, environment: "production" }).baseUrl,
      LUMAPRINTS_BASE_URLS.production,
    );
  });

  it("rejects missing credentials and unknown environments", () => {
    assert.throws(() => createLumaprintsClient({ apiKey: "", apiSecret: "x" }), /apiKey and apiSecret/);
    assert.throws(
      () => createLumaprintsClient({ ...MOCK_CREDENTIALS, environment: "prod" as never }),
      /must be "sandbox" or "production"/,
    );
  });

  it("sends Basic auth and a versioned user agent", async () => {
    const stores = await client().listStores();
    assert.deepEqual(stores, [{ storeId: 1088, storeName: "Hikari Test Store" }]);
    const [request] = mock.requests;
    assert.equal(request!.authorization, `Basic ${btoa("test-key:test-secret")}`);
    assert.equal(request!.userAgent, `lumaprints-js/${VERSION}`);
  });

  it("wraps the catalog endpoints", async () => {
    assert.equal((await client().listCategories()).length, 3);
    assert.equal((await client().listSubcategories(105))[0]!.subcategoryId, 105001);
    assert.equal((await client().listSubcategoryOptions(105001)).length, 4);
    assert.deepEqual(
      mock.requests.map((r) => r.path),
      [
        "/api/v1/products/categories",
        "/api/v1/products/categories/105/subcategories",
        "/api/v1/products/subcategories/105001/options",
      ],
    );
  });

  it("nests size and defaults options to [] for pricing", async () => {
    const price = await client().getProductPrice({ subcategoryId: 103001, width: 8, height: 10 });
    assert.equal(price.price, 10.8);
    assert.deepEqual(mock.requests[0]!.body, { subcategoryId: 103001, size: { width: 8, height: 10 }, options: [] });

    const prices = await client().getProductPrices([
      { subcategoryId: 103001, width: 8, height: 10, options: [39] },
      { subcategoryId: 999999, width: 8, height: 10 },
    ]);
    assert.equal(prices[0]!.success, true);
    assert.equal(prices[1]!.success, false);
  });

  it("builds list query strings and drops empty params", async () => {
    await client().listOrders({ storeId: 1088, page: 2, orderDateStart: undefined });
    assert.deepEqual(mock.requests[0]!.query, { storeId: "1088", page: "2" });
  });

  it("throws LumaprintsError with status, body, and an auth hint", async () => {
    const bad = createLumaprintsClient({ apiKey: "test-key", apiSecret: "wrong", baseUrl: mock.url });
    await assert.rejects(bad.listStores(), (error: unknown) => {
      assert.ok(error instanceof LumaprintsError);
      assert.equal(error.status, 401);
      assert.deepEqual(error.body, { statusCode: 401, message: "Unauthorized" });
      assert.match(error.message, /sandbox and production keys are separate/);
      return true;
    });

    await assert.rejects(client().getOrder(42), (error: unknown) => {
      assert.ok(error instanceof LumaprintsError);
      assert.equal(error.status, 404);
      assert.match(error.message, /Order not found!/);
      return true;
    });
  });

  it("retries 429 responses after x-ratelimit-reset, then gives up", async () => {
    mock.rateLimitNext = 1;
    assert.equal((await client().listStores()).length, 1);
    assert.equal(mock.requests.length, 2);

    mock.requests.length = 0;
    mock.rateLimitNext = 5;
    const impatient = createLumaprintsClient({ ...MOCK_CREDENTIALS, baseUrl: mock.url, maxRetries: 1 });
    await assert.rejects(impatient.listStores(), (error: unknown) => {
      assert.ok(error instanceof LumaprintsError);
      assert.equal(error.status, 429);
      assert.equal(error.rateLimit.remaining, 0);
      return true;
    });
    assert.equal(mock.requests.length, 2);
  });

  it("reports a wrongly sized image as ok: false instead of throwing", async () => {
    const input = { subcategoryId: 103001, printWidth: 8, printHeight: 10 };
    const good = await client().checkImage({ ...input, imageUrl: "https://example.com/big.jpg" });
    assert.equal(good.ok, true);
    assert.deepEqual(mock.requests[0]!.body, { ...input, imageUrl: "https://example.com/big.jpg", orderItemOptions: [] });

    const small = await client().checkImage({ ...input, imageUrl: "https://example.com/small.jpg" });
    assert.equal(small.ok, false);
    assert.equal(small.expectedWidth, 2400);

    await assert.rejects(client().checkImage({ ...input, imageUrl: "https://example.com/missing.jpg" }), LumaprintsError);
  });

  it("treats a 400 status inside a 201 webhook response as an error", async () => {
    const ok = await client().subscribeWebhook({ event: "shipping", storeId: 1088, url: "https://example.com/hook" });
    assert.equal(ok.status, 201);
    await assert.rejects(
      client().subscribeWebhook({ event: "shipping", storeId: 1088, url: "https://example.com/duplicate" }),
      /already exists/,
    );
  });

  it("wraps network failures with status 0", async () => {
    const offline = createLumaprintsClient({
      ...MOCK_CREDENTIALS,
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await assert.rejects(offline.listStores(), (error: unknown) => {
      assert.ok(error instanceof LumaprintsError);
      assert.equal(error.status, 0);
      assert.match(error.message, /Could not reach Lumaprints/);
      return true;
    });
  });

  it("keeps VERSION in sync with package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(VERSION, pkg.version);
  });
});
