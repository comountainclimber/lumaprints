import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type { CreateOrderInput, Order, Store } from "../../src/types.ts";

export const MOCK_CREDENTIALS = { apiKey: "test-key", apiSecret: "test-secret" };

const EXPECTED_AUTH = `Basic ${Buffer.from(`${MOCK_CREDENTIALS.apiKey}:${MOCK_CREDENTIALS.apiSecret}`).toString("base64")}`;

export const fixtures = {
  stores: [{ storeId: 1088, storeName: "Hikari Test Store" }] as Store[],
  categories: [
    { id: 101, name: "Canvas" },
    { id: 103, name: "Fine Art Paper" },
    { id: 105, name: "Framed Fine Art Paper" },
  ],
  subcategories: {
    101: [
      { subcategoryId: 101001, name: "0.75in Stretched Canvas", minimumWidth: 5, maximumWidth: 120, minimumHeight: 5, maximumHeight: 52, requiredDPI: 200 },
      { subcategoryId: 101002, name: "1.25in Stretched Canvas", minimumWidth: 8, maximumWidth: 120, minimumHeight: 8, maximumHeight: 52, requiredDPI: 200 },
      { subcategoryId: 101003, name: "1.50in Stretched Canvas", minimumWidth: 8, maximumWidth: 120, minimumHeight: 8, maximumHeight: 52, requiredDPI: 200 },
    ],
    103: [
      { subcategoryId: 103001, name: "Archival Matte Fine Art Paper", minimumWidth: 4, maximumWidth: 60, minimumHeight: 4, maximumHeight: 90, requiredDPI: 300 },
      { subcategoryId: 103002, name: "Glossy Fine Art Paper", minimumWidth: 4, maximumWidth: 60, minimumHeight: 4, maximumHeight: 90, requiredDPI: 300 },
      { subcategoryId: 103003, name: "Cold Press Fine Art Paper", minimumWidth: 4, maximumWidth: 60, minimumHeight: 4, maximumHeight: 90, requiredDPI: 300 },
    ],
    105: [
      { subcategoryId: 105001, name: "0.875w x 0.875h Black Frame", minimumWidth: 5, maximumWidth: 40, minimumHeight: 5, maximumHeight: 60, requiredDPI: 300 },
      { subcategoryId: 105002, name: "0.875w x 0.875h White Frame", minimumWidth: 5, maximumWidth: 40, minimumHeight: 5, maximumHeight: 60, requiredDPI: 300 },
      { subcategoryId: 105003, name: "0.875w x 0.875h Oak Frame", minimumWidth: 5, maximumWidth: 40, minimumHeight: 5, maximumHeight: 60, requiredDPI: 300 },
    ],
  } as Record<number, Array<Record<string, unknown>>>,
  options: {
    103001: [{ optionGroup: "Bleed", optionGroupItems: [{ optionId: 39, optionName: "No Bleed" }, { optionId: 40, optionName: "0.25in Bleed" }] }],
    105001: [
      { optionGroup: "Mat Size", optionGroupItems: [{ optionId: 64, optionName: "No Mat" }, { optionId: 66, optionName: "2in Mat" }] },
      { optionGroup: "Paper", optionGroupItems: [{ optionId: 74, optionName: "Archival Matte" }, { optionId: 76, optionName: "Cold Press" }] },
      { optionGroup: "Hanging Hardware", optionGroupItems: [{ optionId: 83, optionName: "Hanging Wire" }] },
      { optionGroup: "Backing", optionGroupItems: [{ optionId: 95, optionName: "Kraft Paper" }] },
    ],
  } as Record<number, unknown[]>,
  shippingMethods: [
    { carrier: "USPS", method: "usps_ground_advantage", cost: 9.35 },
    { carrier: "USPS", method: "usps_priority_mail", cost: 10.75 },
    { carrier: "FedEx/UPS/GLS", method: "ground", cost: 11.8 },
    { carrier: "FedEx/UPS/GLS", method: "2_day", cost: 25.1 },
    { carrier: "FedEx/UPS/GLS", method: "overnight", cost: 32.15 },
  ],
};

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  authorization: string | undefined;
  userAgent: string | undefined;
}

export interface MockLumaprints {
  url: string;
  requests: RecordedRequest[];
  orders: Map<number, Order>;
  /** Respond 429 (with x-ratelimit-reset: 0) to the next N requests. */
  rateLimitNext: number;
  stores: Store[];
  close(): Promise<void>;
}

export async function startMockLumaprints(port = 0): Promise<MockLumaprints> {
  const mock: MockLumaprints = {
    url: "",
    requests: [],
    orders: new Map(),
    rateLimitNext: 0,
    stores: [...fixtures.stores],
    close: async () => {},
  };
  let nextOrderNumber = 10000000001;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://mock");
    const rawBody = await readBody(req);
    const body = rawBody ? JSON.parse(rawBody) : undefined;
    mock.requests.push({
      method: req.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
      authorization: req.headers.authorization,
      userAgent: req.headers["user-agent"],
    });

    const rate = { "x-ratelimit-limit": "40", "x-ratelimit-remaining": "39", "x-ratelimit-reset": "0" };
    if (mock.rateLimitNext > 0) {
      mock.rateLimitNext--;
      return send(res, 429, { statusCode: 429, message: "ThrottlerException: Too Many Requests" }, { ...rate, "x-ratelimit-remaining": "0" });
    }
    if (req.headers.authorization !== EXPECTED_AUTH) {
      return send(res, 401, { statusCode: 401, message: "Unauthorized" }, rate);
    }

    const route = `${req.method} ${url.pathname}`;
    let match: RegExpMatchArray | null;

    if (route === "GET /api/v1/stores") return send(res, 200, mock.stores, rate);
    if (route === "GET /api/v1/products/categories") return send(res, 200, fixtures.categories, rate);
    if ((match = route.match(/^GET \/api\/v1\/products\/categories\/(\d+)\/subcategories$/))) {
      return send(res, 200, fixtures.subcategories[Number(match[1])] ?? [], rate);
    }
    if ((match = route.match(/^GET \/api\/v1\/products\/subcategories\/(\d+)\/options$/))) {
      return send(res, 200, fixtures.options[Number(match[1])] ?? [], rate);
    }
    if (route === "POST /api/v1/pricing/product") return send(res, 200, price(body), rate);
    if (route === "POST /api/v1/pricing/products") return send(res, 200, (body as Array<Parameters<typeof price>[0]>).map((item) => price(item)), rate);
    if (route === "POST /api/v1/pricing/shipping") {
      if (body?.recipient?.zipCode === "00000") {
        return send(res, 406, { statusCode: 406, message: "No shipping method available for the provided address and/or products." }, rate);
      }
      return send(res, 200, { message: "", shippingMethods: fixtures.shippingMethods }, rate);
    }
    if (route === "POST /api/v1/images/checkImageConfig") {
      if (String(body.imageUrl).includes("missing")) {
        return send(res, 400, { statusCode: 400, message: `${body.imageUrl} is invalid or not accessible.` }, rate);
      }
      if (String(body.imageUrl).includes("small")) {
        return send(res, 406, {
          message: "The image is sized incorrectly.",
          imageUrl: body.imageUrl,
          expectedWidth: body.printWidth * 300,
          expectedHeight: body.printHeight * 300,
          actualImageWidth: 800,
          actualImageHeight: 1000,
        }, rate);
      }
      return send(res, 200, {
        message: "The aspect ratio of the image is the same as the ordered size.",
        imageUrl: body.imageUrl,
        recommendedWidth: body.printWidth * 300,
        recommendedHeight: body.printHeight * 300,
        expectedAspectRatio: "4:5",
        actualImageWidth: body.printWidth * 300,
        actualImageHeight: body.printHeight * 300,
        actualImageAspectRatio: "4:5",
      }, rate);
    }
    if (route === "POST /api/v1/orders") {
      const order = body as CreateOrderInput;
      if ([...mock.orders.values()].some((o) => o.externalId === order.externalId && o.storeId === order.storeId)) {
        return send(res, 400, { statusCode: 400, message: `Order with externalId ${order.externalId} already exists.` }, rate);
      }
      const orderNumber = nextOrderNumber++;
      mock.orders.set(orderNumber, toOrder(orderNumber, order));
      return send(res, 201, { message: "Order has been successfully submitted.", orderNumber }, rate);
    }
    if (route === "GET /api/v1/orders") {
      const storeId = Number(url.searchParams.get("storeId"));
      const orders = [...mock.orders.values()].filter((o) => o.storeId === storeId).reverse();
      return send(res, 200, { orders, totalOrders: orders.length, currentPage: Number(url.searchParams.get("page") ?? 1), totalPages: 1 }, rate);
    }
    if ((match = route.match(/^GET \/api\/v1\/orders\/(\d+)$/))) {
      const order = mock.orders.get(Number(match[1]));
      return order ? send(res, 200, order, rate) : send(res, 404, { statusCode: 404, message: "Order not found!" }, rate);
    }
    if ((match = route.match(/^GET \/api\/v1\/shipments\/(\d+)$/))) {
      const orderNumber = Number(match[1]);
      if (!mock.orders.has(orderNumber)) return send(res, 404, { statusCode: 404, message: "Order not found!" }, rate);
      return send(res, 200, { orderNumber, shipments: [] }, rate);
    }
    if (route === "POST /api/v1/webhook") {
      if (String(body.url).includes("duplicate")) {
        return send(res, 201, { status: 400, message: "A webhook with the same URL and store ID already exists." }, rate);
      }
      return send(res, 201, { status: 201, message: "Webhook has been successfully created." }, rate);
    }

    send(res, 404, { statusCode: 404, message: `Cannot ${route}` }, rate);
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  mock.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  mock.close = () => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  return mock;
}

function price(input: { subcategoryId: number; size: { width: number; height: number }; options?: number[] }) {
  const known = Object.values(fixtures.subcategories).flat().some((s) => s.subcategoryId === input.subcategoryId);
  if (!known) {
    return { success: false, subcategoryId: input.subcategoryId, size: input.size, price: 0, options: [], error: "Invalid subcategory", statusCode: 400 };
  }
  const framed = String(input.subcategoryId).startsWith("105");
  const base = (framed ? 25 : 6) + input.size.width * input.size.height * (framed ? 0.18 : 0.06);
  return {
    success: true,
    subcategoryId: input.subcategoryId,
    size: input.size,
    price: Math.round(base * 100) / 100,
    options: (input.options ?? []).map((optionId) => ({ optionId, optionGroupName: "Option", optionName: `Option ${optionId}`, price: 0 })),
  };
}

function toOrder(orderNumber: number, input: CreateOrderInput): Order {
  const items = input.orderItems.map((item) => ({
    subcategoryId: item.subcategoryId,
    externalItemId: item.externalItemId,
    quantity: item.quantity,
    width: item.width,
    height: item.height,
    file: { imageUrl: item.file.imageUrl },
    orderItemOptions: item.orderItemOptions.map((optionId) => ({ optionId, optionName: `Option ${optionId}` })),
    itemCostTotal: price({ subcategoryId: item.subcategoryId, size: { width: item.width, height: item.height } }).price * item.quantity,
  }));
  const subTotal = Math.round(items.reduce((sum, item) => sum + item.itemCostTotal, 0) * 100) / 100;
  return {
    orderNumber,
    externalId: input.externalId,
    storeId: input.storeId,
    orderDate: new Date().toISOString(),
    email: null,
    shippingMethod: input.shippingMethod ?? "default",
    productionTime: input.productionTime ?? "regular",
    orderStatus: "Pending Payment",
    recipient: {
      ...input.recipient,
      company: input.recipient.company ?? null,
      addressLine2: input.recipient.addressLine2 ?? null,
      phone: input.recipient.phone ?? null,
    },
    orderItems: items,
    discountTotal: 0,
    shippingTotal: 9.35,
    taxTotal: 0,
    subTotal,
    orderTotal: Math.round((subTotal + 9.35) * 100) / 100,
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string>) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mock = await startMockLumaprints(Number(process.env.PORT ?? 4010));
  process.stderr.write(
    `Mock Lumaprints API on ${mock.url}\n\nPoint lumaprints at it:\n` +
      `  LUMAPRINTS_BASE_URL=${mock.url} LUMAPRINTS_API_KEY=${MOCK_CREDENTIALS.apiKey} LUMAPRINTS_API_SECRET=${MOCK_CREDENTIALS.apiSecret} node src/cli.ts ui\n`,
  );
}
