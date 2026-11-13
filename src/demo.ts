import { createLumaprintsClient } from "./client.ts";
import type { LumaprintsConfig } from "./env.ts";
import { createToolContext, type ToolContext } from "./tools.ts";
import type { Order, Shipment, ShipmentList, Subcategory } from "./types.ts";

/**
 * Sample data for demo mode. Shapes match the real API; names, ids, sizes, and
 * prices are illustrative, not the live Lumaprints catalog or price list.
 */
const STORE = { storeId: 1088, storeName: "Demo Print Shop" };

const CATEGORIES = [
  { id: 101, name: "Canvas" },
  { id: 102, name: "Framed Canvas" },
  { id: 103, name: "Fine Art Paper" },
  { id: 105, name: "Framed Fine Art Paper" },
];

const sub = (subcategoryId: number, name: string, maxW: number, maxH: number, dpi: number, min = 5): Subcategory => ({
  subcategoryId,
  name,
  minimumWidth: min,
  maximumWidth: maxW,
  minimumHeight: min,
  maximumHeight: maxH,
  requiredDPI: dpi,
});

const FRAMES: Array<[number, string]> = [
  [105001, "0.875w x 0.875h Black Frame"],
  [105002, "0.875w x 0.875h White Frame"],
  [105003, "0.875w x 0.875h Oak Frame"],
  [105005, "1.25w x 0.875h Black Frame"],
  [105006, "1.25w x 0.875h White Frame"],
  [105007, "1.25w x 0.875h Oak Frame"],
  [105022, "1.25w x 0.875h Maple Wood Frame"],
  [105008, "0.875w x 1.125h Natural Wood Frame"],
  [105009, "0.875w x 1.125h Black Frame"],
  [105010, "0.875w x 1.125h White Frame"],
  [105011, "0.875w x 1.125h Gold Frame"],
  [105012, "0.875w x 1.125h Espresso Frame"],
  [105016, "1.125w x 0.75h Slimwoods Black Silver Frame"],
  [105017, "1.125w x 0.75h Slimwoods Black Gold Frame"],
  [105025, "1.625w x 1.375h Matte Black Frame"],
  [105013, "2w x 1.0625h Framer's Choice Black with Gold Frame"],
  [105020, "2.5625w x 1h Plein Air Espresso Gold Frame"],
  [105023, "3w x 1.125h Gold Plein Air Frame"],
  [105018, "3w x 1h Driftwood Gray Frame"],
  [105019, "3w x 1h Driftwood White Frame"],
  [105021, "3.250w x 1.375h Vintage Collection Copper Frame"],
];

const SUBCATEGORIES: Record<number, Subcategory[]> = {
  101: [
    sub(101001, "0.75in Stretched Canvas", 120, 52, 150),
    sub(101002, "1.25in Stretched Canvas", 120, 52, 150, 8),
    sub(101003, "1.50in Stretched Canvas", 120, 52, 150, 8),
  ],
  102: [
    sub(102001, "0.75in Framed Canvas", 60, 40, 150, 8),
    sub(102002, "1.25in Framed Canvas", 60, 40, 150, 8),
    sub(102003, "1.50in Framed Canvas", 60, 40, 150, 8),
  ],
  103: [
    sub(103001, "Archival Matte Fine Art Paper", 60, 90, 200, 4),
    sub(103003, "Cold Press Fine Art Paper", 60, 90, 200, 4),
  ],
  105: FRAMES.map(([id, name]) => sub(id, name, 40, 60, 200)),
};

const group = (optionGroup: string, items: Array<[number, string]>) => ({
  optionGroup,
  optionGroupItems: items.map(([optionId, optionName]) => ({ optionId, optionName })),
});

function optionsFor(subcategoryId: number) {
  const category = Math.floor(subcategoryId / 1000);
  switch (category) {
    case 101:
      return [
        group("Canvas Border", [[1, "Image Wrap"], [2, "Mirror Wrap"], [3, "Solid Color Wrap"]]),
        group("Hanging Hardware", [[11, "Sawtooth Hanger"], [12, "Hanging Wire"]]),
      ];
    case 102:
      return [
        group("Frame Style", [[41, "Black Floating Frame"], [42, "White Floating Frame"], [43, "Oak Floating Frame"]]),
        group("Canvas Border", [[1, "Image Wrap"], [2, "Mirror Wrap"]]),
      ];
    case 103:
      return [group("Bleed", [[39, "No Bleed"], [40, "0.25in Bleed"]])];
    case 105:
      return [
        group("Mat Size", [[64, "No Mat"], [65, "1in Mat"], [66, "2in Mat"]]),
        group("Paper", [[74, "Archival Matte"], [76, "Cold Press"]]),
        group("Hanging Hardware", [[83, "Hanging Wire"], [84, "Sawtooth Hanger"]]),
        group("Backing", [[95, "Kraft Paper"]]),
      ];
    default:
      return [];
  }
}

function findSubcategory(subcategoryId: number): Subcategory | undefined {
  return Object.values(SUBCATEGORIES).flat().find((s) => s.subcategoryId === subcategoryId);
}

const round = (n: number) => Math.round(n * 100) / 100;

function price(input: { subcategoryId: number; size: { width: number; height: number }; options?: number[] }) {
  const { subcategoryId, size } = input;
  const subcategory = findSubcategory(subcategoryId);
  const base = { subcategoryId, size, price: 0, options: [] as unknown[] };
  if (!subcategory) return { ...base, success: false as const, error: `Unknown subcategory ${subcategoryId}`, statusCode: 400 };

  const [short, long] = [Math.min(size.width, size.height), Math.max(size.width, size.height)];
  const maxShort = Math.min(subcategory.maximumWidth, subcategory.maximumHeight);
  const maxLong = Math.max(subcategory.maximumWidth, subcategory.maximumHeight);
  if (short < subcategory.minimumWidth || short > maxShort || long > maxLong) {
    return { ...base, success: false as const, error: `${size.width}x${size.height} is outside ${subcategory.name} limits (max ${maxShort}x${maxLong})`, statusCode: 400 };
  }

  const area = size.width * size.height;
  const category = Math.floor(subcategoryId / 1000);
  const depth = subcategoryId % 10 === 3 ? 1.25 : subcategoryId % 10 === 2 ? 1.12 : 1;
  const unit =
    category === 101 ? (12 + area * 0.09) * depth
    : category === 102 ? (34 + area * 0.17) * depth
    : category === 103 ? 4 + area * 0.045
    : 24 + area * 0.14;

  const chosen = new Set(input.options ?? []);
  const options = optionsFor(subcategoryId).flatMap((g) =>
    g.optionGroupItems
      .filter((item) => chosen.has(item.optionId))
      .map((item) => ({
        optionId: item.optionId,
        optionGroupName: g.optionGroup,
        optionName: item.optionName,
        price: item.optionId === 65 || item.optionId === 66 ? round(area * 0.02) : 0,
      })),
  );
  const optionTotal = options.reduce((sum, o) => sum + o.price, 0);
  return { ...base, success: true as const, price: round(unit + optionTotal), options };
}

function shippingQuote(items: Array<{ width: number; height: number; quantity: number }>) {
  const largest = Math.max(...items.map((i) => Math.max(i.width, i.height)));
  if (largest > 72) {
    return { message: "The package is too large to ship via regular shipping method. Please contact customer service for freight quotation.", shippingMethods: [{ carrier: "Freight", method: "freight", cost: 0 }] };
  }
  const bulk = items.reduce((sum, i) => sum + i.width * i.height * i.quantity, 0) / 100;
  const methods: Array<[string, string, number, number]> = [
    ["USPS", "usps_ground_advantage", 8.95, 0.55],
    ["USPS", "usps_priority_mail", 10.4, 0.7],
    ["FedEx/UPS/GLS", "ground", 11.5, 0.6],
    ["FedEx/UPS/GLS", "2_day", 24.8, 1.1],
    ["FedEx/UPS/GLS", "overnight", 31.9, 1.6],
  ];
  const available = largest > 36 ? methods.filter(([, method]) => !method.startsWith("usps")) : methods;
  return { message: "", shippingMethods: available.map(([carrier, method, base, perUnit]) => ({ carrier, method, cost: round(base + bulk * perUnit) })) };
}

function sampleOrder(
  orderNumber: number,
  externalId: string,
  orderDate: string,
  orderStatus: string,
  recipient: { firstName: string; lastName: string; addressLine1: string; city: string; state: string; zipCode: string },
  items: Array<[number, number, number, number, number[]]>,
  shippingMethod = "usps_ground_advantage",
): Order {
  const orderItems = items.map(([subcategoryId, width, height, quantity, optionIds], index) => {
    const priced = price({ subcategoryId, size: { width, height }, options: optionIds });
    return {
      subcategoryId,
      externalItemId: String(index + 1),
      quantity,
      width,
      height,
      file: { imageUrl: `https://example.com/demo/${externalId}-${index + 1}.jpg` },
      orderItemOptions: priced.options.map((o) => {
        const option = o as { optionId: number; optionName: string };
        return { optionId: option.optionId, optionName: option.optionName };
      }),
      itemCostTotal: round(priced.price * quantity),
    };
  });
  const subTotal = round(orderItems.reduce((sum, item) => sum + item.itemCostTotal, 0));
  const shippingTotal = shippingQuote(orderItems).shippingMethods[0]!.cost;
  return {
    orderNumber,
    externalId,
    storeId: STORE.storeId,
    orderDate,
    email: null,
    shippingMethod,
    productionTime: "regular",
    orderStatus,
    recipient: { ...recipient, country: "US", company: null, addressLine2: null, phone: null },
    orderItems,
    discountTotal: 0,
    shippingTotal,
    taxTotal: 0,
    subTotal,
    orderTotal: round(subTotal + shippingTotal),
  };
}

const ORDERS: Order[] = [
  sampleOrder(10000045690, "HI-1042", "2026-11-12T16:20:00.000Z", "Pending Payment",
    { firstName: "Aiko", lastName: "Tanaka", addressLine1: "88 Pine St", city: "Seattle", state: "WA", zipCode: "98101" },
    [[105001, 16, 20, 1, [64, 76, 83, 95]]]),
  sampleOrder(10000045689, "HI-1041", "2026-11-10T09:05:00.000Z", "Awaiting Fulfillment",
    { firstName: "Marcus", lastName: "Reed", addressLine1: "410 Elm Ave", city: "Austin", state: "TX", zipCode: "78701" },
    [[103003, 12, 18, 2, [39]], [103003, 8, 10, 1, [39]]]),
  sampleOrder(10000045686, "HI-1038", "2026-11-03T14:42:00.000Z", "Shipped",
    { firstName: "Elena", lastName: "Park", addressLine1: "19 Harbor Rd", city: "Portland", state: "ME", zipCode: "04101" },
    [[101003, 24, 36, 1, [2, 12]]], "ground"),
  sampleOrder(10000045680, "HI-1031", "2026-10-28T11:15:00.000Z", "Canceled",
    { firstName: "Sam", lastName: "Okafor", addressLine1: "702 Lake Dr", city: "Chicago", state: "IL", zipCode: "60601" },
    [[105023, 18, 24, 1, [66, 74, 83, 95]]]),
];

const SHIPMENTS: Record<number, Shipment[]> = {
  10000045686: [{
    carrier: "FedEx",
    shippingMethod: "FedEx Ground",
    trackingNumber: "392964503590",
    shipmentDate: "2026-11-06",
    shipmentItems: [{ externalItemId: "1", product: "24x36 1.50in Stretched Canvas", quantity: 1 }],
  }],
};

const DEMO_BASE_URL = "https://demo.lumaprints.invalid";

/** A fetch implementation that answers Lumaprints API routes from in-memory sample data. Never touches the network. */
export function createDemoFetch(): typeof globalThis.fetch {
  return async (resource, init) => {
    const request = new Request(resource, init);
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    const body: any = request.method === "GET" ? undefined : await request.json().catch(() => undefined);
    const json = (status: number, data: unknown) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", "x-ratelimit-limit": "40", "x-ratelimit-remaining": "40", "x-ratelimit-reset": "60" },
      });
    let match: RegExpMatchArray | null;

    if (route === "GET /api/v1/stores") return json(200, [STORE]);
    if (route === "GET /api/v1/products/categories") return json(200, CATEGORIES);
    if ((match = route.match(/^GET \/api\/v1\/products\/categories\/(\d+)\/subcategories$/))) {
      return json(200, SUBCATEGORIES[Number(match[1])] ?? []);
    }
    if ((match = route.match(/^GET \/api\/v1\/products\/subcategories\/(\d+)\/options$/))) {
      return json(200, optionsFor(Number(match[1])));
    }
    if (route === "POST /api/v1/pricing/product") {
      const result = price(body);
      return result.success ? json(200, result) : json(400, { statusCode: 400, message: result.error });
    }
    if (route === "POST /api/v1/pricing/products") return json(200, (body as Parameters<typeof price>[0][]).map((item) => price(item)));
    if (route === "POST /api/v1/pricing/shipping") return json(200, shippingQuote(body.orderItems));
    if (route === "POST /api/v1/images/checkImageConfig") {
      const subcategory = findSubcategory(body.subcategoryId);
      const dpi = subcategory?.requiredDPI ?? 200;
      const expected = { width: Math.round(body.printWidth * dpi), height: Math.round(body.printHeight * dpi) };
      const ratio = ratioLabel(body.printWidth, body.printHeight);
      if (/small|low|thumb/i.test(String(body.imageUrl))) {
        return json(406, {
          message: "The image is sized incorrectly. (Demo: simulated because the URL contains 'small'. Images aren't downloaded in demo mode.)",
          imageUrl: body.imageUrl,
          expectedWidth: expected.width,
          expectedHeight: expected.height,
          actualImageWidth: Math.round(expected.width / 3),
          actualImageHeight: Math.round(expected.height / 3),
        });
      }
      return json(200, {
        message: "The aspect ratio of the image is the same as the ordered size. (Demo: simulated. Images aren't downloaded in demo mode; include 'small' in the URL to see a failure.)",
        imageUrl: body.imageUrl,
        recommendedWidth: expected.width,
        recommendedHeight: expected.height,
        expectedAspectRatio: ratio,
        actualImageWidth: expected.width,
        actualImageHeight: expected.height,
        actualImageAspectRatio: ratio,
      });
    }
    if (route === "GET /api/v1/orders") {
      const page = Number(url.searchParams.get("page") ?? 1);
      const orders = Number(url.searchParams.get("storeId")) === STORE.storeId && page === 1 ? ORDERS : [];
      return json(200, { orders, totalOrders: ORDERS.length, currentPage: page, totalPages: 1 });
    }
    if ((match = route.match(/^GET \/api\/v1\/orders\/(\d+)$/))) {
      const order = ORDERS.find((o) => o.orderNumber === Number(match![1]));
      return order ? json(200, order) : json(404, { statusCode: 404, message: "Order not found!" });
    }
    if ((match = route.match(/^GET \/api\/v1\/shipments\/(\d+)$/))) {
      const orderNumber = Number(match[1]);
      if (!ORDERS.some((o) => o.orderNumber === orderNumber)) return json(404, { statusCode: 404, message: "Order not found!" });
      return json(200, { orderNumber, shipments: SHIPMENTS[orderNumber] ?? [] } satisfies ShipmentList);
    }
    if (route === "POST /api/v1/orders" || route === "POST /api/v1/webhook") {
      return json(403, { statusCode: 403, message: "The demo is read-only." });
    }
    return json(404, { statusCode: 404, message: `Cannot ${route}` });
  };
}

function ratioLabel(width: number, height: number): string {
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const scale = 100;
  const [w, h] = [Math.round(width * scale), Math.round(height * scale)];
  const divisor = gcd(w, h);
  return `${w / divisor}:${h / divisor}`;
}

export const DEMO_CONFIG: LumaprintsConfig = {
  apiKey: "demo",
  apiSecret: "demo",
  environment: "sandbox",
  baseUrl: DEMO_BASE_URL,
  defaultStoreId: STORE.storeId,
  allowLiveOrders: false,
};

/** Tool context backed by sample data: no credentials, no network, and order/webhook writes disabled. */
export function createDemoToolContext(): ToolContext {
  return createToolContext({
    config: DEMO_CONFIG,
    client: createLumaprintsClient({ apiKey: "demo", apiSecret: "demo", baseUrl: DEMO_BASE_URL, fetch: createDemoFetch() }),
    demo: true,
  });
}
