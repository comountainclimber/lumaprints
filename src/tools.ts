import { LumaprintsError, type LumaprintsClient } from "./client.ts";
import {
  createLumaprintsClientFromConfig,
  ENV_VARS,
  hasCredentials,
  LumaprintsConfigError,
  readConfigFromEnv,
  type LumaprintsConfig,
} from "./env.ts";
import type {
  CheckImageInput,
  CreateOrderInput,
  ProductPriceInput,
  ShippingQuote,
  ShippingQuoteInput,
  Store,
  Subcategory,
} from "./types.ts";
import { isPlainObject, validate, type JsonSchema } from "./validate.ts";

export type { JsonSchema } from "./validate.ts";

export const AGENT_INSTRUCTIONS = `Lumaprints is a print-on-demand lab. You send a public image URL plus a product spec; Lumaprints prints, packs, and ships it to the recipient under the store's name.

Placing an order:
1. get_config: check the environment. In production, orders are real: charged to the store's card immediately, and they cannot be edited or canceled through the API.
2. search_catalog (or list_categories, then list_subcategories) to find a subcategoryId. list_subcategory_options gives option ids; pick at most one per option group, or omit them for the defaults.
3. check_image: the image's aspect ratio must match the print size within 1%, with enough pixels for the product's DPI.
4. get_product_price and get_shipping_quote for costs.
5. submit_order without confirm returns a priced preview and submits nothing. Show it to the user. Only call submit_order again with confirm: true after the user explicitly approves.
6. get_order and get_shipments to track. New orders take a few minutes to appear. Sandbox orders never move past their first status and never ship.

Rules: sizes are inches (decimals allowed). externalId is unique per store and duplicates are rejected, so retrying a submission cannot double-order. Image URLs must be public JPG/PNG and stay reachable for 30+ minutes; publish changed artwork under a new URL because files are cached by URL. Gift notes go in printouts (public PDF URLs), not specialInstructions. Rate limit: 40 requests per minute.`;

export type ToolCategory = "setup" | "catalog" | "pricing" | "orders" | "webhooks";

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface LumaprintsTool {
  name: string;
  title: string;
  category: ToolCategory;
  description: string;
  inputSchema: JsonSchema & { type: "object" };
  annotations: ToolAnnotations;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<Record<string, unknown>>;
}

export type ToolDefinition = Omit<LumaprintsTool, "run">;

export type ToolErrorCode =
  | "UNKNOWN_TOOL"
  | "INVALID_INPUT"
  | "CONFIG_ERROR"
  | "STORE_REQUIRED"
  | "LIVE_ORDERS_DISABLED"
  | "DEMO_MODE"
  | "LUMAPRINTS_API_ERROR"
  | "INTERNAL_ERROR";

export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly details?: unknown;

  constructor(code: ToolErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { code: this.code, message: this.message, ...(this.details === undefined ? {} : { details: this.details }) };
  }
}

export interface CatalogEntry {
  categoryId: number;
  categoryName: string;
  subcategoryId: number;
  name: string;
  minimumWidth: number;
  maximumWidth: number;
  minimumHeight: number;
  maximumHeight: number;
  requiredDPI: number;
}

export interface ToolContext {
  readonly config: LumaprintsConfig;
  /** Sample data only: tools that submit orders or register webhooks refuse to run. */
  readonly demo: boolean;
  /** Throws a CONFIG_ERROR ToolError when credentials are missing. */
  client(): LumaprintsClient;
  /** Explicit id, then LUMAPRINTS_STORE_ID, then the account's only Standard Store. */
  resolveStoreId(storeId?: number): Promise<number>;
  /** Every subcategory with its category, cached for the context's lifetime (default 1 hour). */
  catalog(): Promise<CatalogEntry[]>;
}

export interface CreateToolContextOptions {
  config?: LumaprintsConfig;
  env?: Record<string, string | undefined>;
  client?: LumaprintsClient;
  catalogTtlMs?: number;
  demo?: boolean;
}

export function createToolContext(options: CreateToolContextOptions = {}): ToolContext {
  const config = options.config ?? readConfigFromEnv(options.env);
  const catalogTtlMs = options.catalogTtlMs ?? 60 * 60 * 1000;
  let client = options.client;
  let storeIdPromise: Promise<number> | undefined;
  let catalogCache: { at: number; promise: Promise<CatalogEntry[]> } | undefined;

  const ctx: ToolContext = {
    config,
    demo: options.demo ?? false,
    client() {
      if (!client) {
        try {
          client = createLumaprintsClientFromConfig(config);
        } catch (error) {
          throw toToolError(error);
        }
      }
      return client;
    },
    async resolveStoreId(storeId) {
      if (storeId !== undefined) return storeId;
      if (config.defaultStoreId !== undefined) return config.defaultStoreId;
      storeIdPromise ??= pickOnlyStore(ctx.client()).catch((error) => {
        storeIdPromise = undefined;
        throw error;
      });
      return storeIdPromise;
    },
    catalog() {
      if (!catalogCache || Date.now() - catalogCache.at > catalogTtlMs) {
        const promise = loadCatalog(ctx.client()).catch((error) => {
          if (catalogCache?.promise === promise) catalogCache = undefined;
          throw error;
        });
        catalogCache = { at: Date.now(), promise };
      }
      return catalogCache.promise;
    },
  };
  return ctx;
}

async function pickOnlyStore(client: LumaprintsClient): Promise<number> {
  const stores = await client.listStores();
  if (stores.length === 1) return stores[0]!.storeId;
  if (stores.length === 0) {
    throw new ToolError(
      "STORE_REQUIRED",
      "This account has no Standard Stores. Create one in the Lumaprints dashboard; stores connected through Shopify, WooCommerce, etc. cannot take API orders.",
    );
  }
  throw new ToolError(
    "STORE_REQUIRED",
    `This account has ${stores.length} Standard Stores. Pass storeId or set ${ENV_VARS.storeId}: ${describeStores(stores)}.`,
    { stores },
  );
}

function describeStores(stores: Store[]): string {
  return stores.map((store) => `${store.storeId} (${store.storeName})`).join(", ");
}

async function loadCatalog(client: LumaprintsClient): Promise<CatalogEntry[]> {
  const categories = await client.listCategories();
  const groups = await Promise.all(
    categories.map(async (category) => {
      const subcategories: Subcategory[] = await client.listSubcategories(category.id);
      return subcategories.map((subcategory) => ({
        categoryId: category.id,
        categoryName: category.name,
        ...subcategory,
      }));
    }),
  );
  return groups.flat();
}

// ---------------------------------------------------------------------------
// Shared schema fragments

const noInput: JsonSchema & { type: "object" } = { type: "object", properties: {}, additionalProperties: false };

const positiveInteger = (description: string, example?: number): JsonSchema => ({
  type: "integer",
  minimum: 1,
  description,
  ...(example === undefined ? {} : { examples: [example] }),
});
const inches = (description: string, example?: number): JsonSchema => ({
  type: "number",
  exclusiveMinimum: 0,
  description,
  ...(example === undefined ? {} : { examples: [example] }),
});
const text = (example: string, extra: JsonSchema = {}): JsonSchema => ({
  type: "string",
  maxLength: 191,
  examples: [example],
  ...extra,
});

const storeIdProperty: JsonSchema = positiveInteger(
  `Standard Store id. Defaults to ${ENV_VARS.storeId}, or the account's only Standard Store.`,
);

const subcategoryIdProperty = positiveInteger(
  "Product subcategory id, e.g. 103001 (Archival Matte Fine Art Paper) or 105001 (black-framed fine art paper). Find ids with search_catalog.",
  103001,
);

const optionIdsProperty: JsonSchema = {
  type: "array",
  items: { type: "integer" },
  description:
    "Option ids from list_subcategory_options, at most one per option group. Omit or pass [] for the subcategory defaults. Framed canvas (102001-102003) requires a frame style option.",
};

const orderNumberProperty: JsonSchema = {
  type: ["integer", "string"],
  description: "Lumaprints order number returned by submit_order, e.g. 10000045686.",
};

const recipientProperties: Record<string, JsonSchema> = {
  firstName: text("Jane", { minLength: 1 }),
  lastName: text("Doe", { minLength: 1 }),
  company: text("Acme Gallery"),
  addressLine1: text("123 Main St", { minLength: 1 }),
  addressLine2: text("Apt 4"),
  city: text("New York", { minLength: 1 }),
  state: text("NY", { minLength: 1, description: "State or province code, e.g. NY." }),
  zipCode: text("10001", { minLength: 1 }),
  country: text("US", { minLength: 2, maxLength: 2, description: "ISO 3166-1 alpha-2 code, e.g. US." }),
  phone: text("555-555-0100"),
};

const recipientSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["firstName", "lastName", "addressLine1", "city", "state", "zipCode", "country"],
  properties: recipientProperties,
  description: "Ship-to address. Lumaprints does not validate addresses on submission.",
};

const shippingRecipientSchema: JsonSchema = {
  ...recipientSchema,
  required: ["addressLine1", "city", "state", "zipCode", "country"],
  description: "Destination address. Names are optional for quotes.",
};

const orderItemSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["subcategoryId", "externalItemId", "quantity", "width", "height", "file"],
  properties: {
    subcategoryId: subcategoryIdProperty,
    externalItemId: {
      type: "string",
      minLength: 1,
      maxLength: 191,
      pattern: "^[A-Za-z0-9_-]+$",
      description: "Your line item id, unique within the order. Letters, numbers, hyphens and underscores.",
      examples: ["1"],
    },
    quantity: positiveInteger("Number of prints.", 1),
    width: inches("Print width in inches. Decimals allowed.", 8),
    height: inches("Print height in inches. Decimals allowed.", 10),
    file: {
      type: "object",
      additionalProperties: false,
      required: ["imageUrl"],
      properties: {
        imageUrl: {
          type: "string",
          minLength: 6,
          maxLength: 1024,
          description: "Public JPG or PNG URL (max 100MB). Must stay reachable for 30 minutes after submission.",
          examples: ["https://example.com/art-8x10.jpg"],
        },
        saveImage: { type: "boolean", description: "Save to the Lumaprints image library." },
      },
    },
    orderItemOptions: optionIdsProperty,
    solidColorHexCode: {
      type: ["string", "null"],
      pattern: "^#[0-9A-Fa-f]{6}$",
      description: "Only with option 3 (Solid Color Wrap). Defaults to #000000.",
    },
  },
};

const shippingItemSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["subcategoryId", "quantity", "width", "height"],
  properties: {
    subcategoryId: subcategoryIdProperty,
    quantity: positiveInteger("Number of prints.", 1),
    width: inches("Print width in inches.", 8),
    height: inches("Print height in inches.", 10),
    orderItemOptions: optionIdsProperty,
  },
};

const priceItemSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["subcategoryId", "width", "height"],
  properties: {
    subcategoryId: subcategoryIdProperty,
    width: inches("Width in inches.", 8),
    height: inches("Height in inches.", 10),
    options: optionIdsProperty,
  },
};

const shippingMethodProperty: JsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 191,
  description:
    "Shipping method code. Omit or use 'default' for the cheapest. Any method returned by get_shipping_quote is valid, e.g. usps_ground_advantage, ground, 2_day, overnight, usps_priority_mail_express.",
};

const shipAsFlatProperty: JsonSchema = {
  type: "boolean",
  description:
    "true ships flat (fine art paper under 30x40 only; adds $7), false never ships flat, omit to follow the store setting.",
};

const readOnly: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

// ---------------------------------------------------------------------------
// Tools

export const tools: LumaprintsTool[] = [
  {
    name: "get_config",
    title: "Show configuration",
    category: "setup",
    description:
      "Show which Lumaprints environment is active (sandbox or production), whether credentials are set, the default store, and whether orders can be submitted. Makes no API calls. Call this first.",
    inputSchema: noInput,
    annotations: { ...readOnly, openWorldHint: false },
    async run(_input, ctx) {
      const { config } = ctx;
      const production = config.environment === "production";
      const canSubmitOrders = hasCredentials(config) && (!production || config.allowLiveOrders);
      return {
        environment: config.environment,
        demo: ctx.demo,
        credentialsConfigured: hasCredentials(config),
        defaultStoreId: config.defaultStoreId ?? null,
        ordersAreReal: production && !ctx.demo,
        canSubmitOrders: canSubmitOrders && !ctx.demo,
        notes: [
          ...(ctx.demo ? [DEMO_NOTE] : []),
          production
            ? "PRODUCTION: submitted orders are printed, shipped, and charged immediately. They cannot be edited or canceled through the API."
            : "Sandbox: orders are never printed, shipped, or billed, and never move past their first status.",
          ...(hasCredentials(config)
            ? []
            : [`Set ${ENV_VARS.apiKey} and ${ENV_VARS.apiSecret} to call the API.`]),
          ...(production && !config.allowLiveOrders
            ? [`submit_order with confirm: true is disabled until a human sets ${ENV_VARS.allowLiveOrders}=true.`]
            : []),
        ],
      };
    },
  },
  {
    name: "list_stores",
    title: "List stores",
    category: "setup",
    description:
      "List the account's Standard Stores. Only Standard Stores can take API orders; stores connected through Shopify, WooCommerce, etc. are not listed.",
    inputSchema: noInput,
    annotations: readOnly,
    async run(_input, ctx) {
      return { stores: await ctx.client().listStores() };
    },
  },
  {
    name: "search_catalog",
    title: "Search catalog",
    category: "catalog",
    description:
      "Find product subcategories by keyword across all categories, e.g. 'framed black', 'canvas 1.5', 'metal'. Every word must match the category or subcategory name. Returns subcategoryIds with size limits and required DPI. Omit query to list everything. The catalog is cached for an hour.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "Space-separated keywords. Case-insensitive." },
        categoryId: positiveInteger("Only search within this category."),
      },
    },
    annotations: readOnly,
    async run(input, ctx) {
      const query = typeof input.query === "string" ? input.query : "";
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const catalog = await ctx.catalog();
      const matches = catalog.filter((entry) => {
        if (input.categoryId !== undefined && entry.categoryId !== input.categoryId) return false;
        const haystack = `${entry.categoryName} ${entry.name} ${entry.subcategoryId}`.toLowerCase();
        return terms.every((term) => haystack.includes(term));
      });
      return { query, total: matches.length, matches };
    },
  },
  {
    name: "list_categories",
    title: "List categories",
    category: "catalog",
    description: "List top-level product categories (Canvas, Fine Art Paper, Framed Fine Art Paper, Metal, ...).",
    inputSchema: noInput,
    annotations: readOnly,
    async run(_input, ctx) {
      return { categories: await ctx.client().listCategories() };
    },
  },
  {
    name: "list_subcategories",
    title: "List subcategories",
    category: "catalog",
    description:
      "List products in a category with their subcategoryId, min/max width and height in inches, and required DPI.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["categoryId"],
      properties: { categoryId: positiveInteger("Category id from list_categories, e.g. 103.") },
    },
    annotations: readOnly,
    async run(input, ctx) {
      const categoryId = input.categoryId as number;
      return { categoryId, subcategories: await ctx.client().listSubcategories(categoryId) };
    },
  },
  {
    name: "list_subcategory_options",
    title: "List product options",
    category: "catalog",
    description:
      "List option groups for a product (paper type, mat, hanging hardware, canvas wrap, ...). Use at most one optionId per group in orderItemOptions.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["subcategoryId"],
      properties: { subcategoryId: subcategoryIdProperty },
    },
    annotations: readOnly,
    async run(input, ctx) {
      const subcategoryId = input.subcategoryId as number;
      return { subcategoryId, optionGroups: await ctx.client().listSubcategoryOptions(subcategoryId) };
    },
  },
  {
    name: "check_image",
    title: "Check image",
    category: "catalog",
    description:
      "Check that an image works for a print size: the aspect ratio must match within 1% and the resolution must meet the product's DPI. Returns ok: false with expected and actual pixel sizes when it doesn't fit.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["subcategoryId", "printWidth", "printHeight", "imageUrl"],
      properties: {
        subcategoryId: subcategoryIdProperty,
        printWidth: inches("Print width in inches."),
        printHeight: inches("Print height in inches."),
        imageUrl: { type: "string", minLength: 6, maxLength: 1024, description: "Public JPG or PNG URL." },
        orderItemOptions: optionIdsProperty,
      },
    },
    annotations: readOnly,
    async run(input, ctx) {
      return { ...(await ctx.client().checkImage(input as unknown as CheckImageInput)) };
    },
  },
  {
    name: "get_product_price",
    title: "Get product price",
    category: "pricing",
    description:
      "Get the unit price (USD, before shipping and tax) for one product configuration, with the applicable options and their prices.",
    inputSchema: priceItemSchema as JsonSchema & { type: "object" },
    annotations: readOnly,
    async run(input, ctx) {
      return { ...(await ctx.client().getProductPrice(input as unknown as ProductPriceInput)) };
    },
  },
  {
    name: "get_product_prices",
    title: "Get product prices",
    category: "pricing",
    description:
      "Price many product configurations in one call. Results keep request order; items that can't be priced have success: false and an error.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["items"],
      properties: { items: { type: "array", minItems: 1, items: priceItemSchema } },
    },
    annotations: readOnly,
    async run(input, ctx) {
      return { prices: await ctx.client().getProductPrices(input.items as ProductPriceInput[]) };
    },
  },
  {
    name: "get_shipping_quote",
    title: "Get shipping quote",
    category: "pricing",
    description:
      "Quote every available shipping method for a destination and set of items. A non-empty message means some carriers couldn't quote (often a bad address). A freight-only result means the package is too large for parcel shipping.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["recipient", "orderItems"],
      properties: {
        recipient: shippingRecipientSchema,
        orderItems: { type: "array", minItems: 1, items: shippingItemSchema },
        shipAsFlat: shipAsFlatProperty,
        storeId: storeIdProperty,
      },
    },
    annotations: readOnly,
    async run(input, ctx) {
      return { ...(await ctx.client().getShippingQuote(input as unknown as ShippingQuoteInput)) };
    },
  },
  {
    name: "submit_order",
    title: "Submit order",
    category: "orders",
    description:
      "Submit a print order. Without confirm: true this only returns a priced preview (unit prices, shipping options, estimated total) and submits nothing. Show the preview to the user and get explicit approval before calling again with the same input plus confirm: true. In production the order is charged immediately and cannot be edited or canceled through the API. externalId is unique per store, so a retried submission is rejected rather than duplicated.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["externalId", "recipient", "orderItems"],
      properties: {
        externalId: {
          type: "string",
          minLength: 1,
          maxLength: 191,
          pattern: "^[A-Za-z0-9_-]+$",
          description: "Your order id, unique per store. Letters, numbers, hyphens and underscores.",
        },
        storeId: storeIdProperty,
        recipient: recipientSchema,
        orderItems: { type: "array", minItems: 1, items: orderItemSchema },
        shippingMethod: shippingMethodProperty,
        productionTime: {
          type: "string",
          enum: ["regular", "nextday", "sameday"],
          description: "Defaults to regular. Faster production costs more.",
        },
        printouts: {
          type: "array",
          maxItems: 3,
          items: { type: "string", minLength: 1, maxLength: 1024 },
          description: "Public URLs of inserts or gift notes (PDF works well), up to 3 printed pages in total.",
        },
        specialInstructions: {
          type: "string",
          minLength: 1,
          maxLength: 1024,
          description: "Notes for the Lumaprints production team. Not printed; don't use for gift notes.",
        },
        shipAsFlat: shipAsFlatProperty,
        confirm: {
          type: "boolean",
          description: "Set true only after the user has approved the preview. Omit to get a preview.",
        },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    async run(input, ctx) {
      const { confirm, ...rest } = input;
      const order = await buildOrder(rest, ctx);
      const production = ctx.config.environment === "production";

      if (confirm !== true) {
        return { submitted: false, ...(await previewOrder(order, ctx)) };
      }

      if (ctx.demo) throw demoError("Orders can't be submitted in the demo");

      if (production && !ctx.config.allowLiveOrders) {
        throw new ToolError(
          "LIVE_ORDERS_DISABLED",
          `Refusing to submit a real production order: ${ENV_VARS.allowLiveOrders} is not set. A human operator must set ${ENV_VARS.allowLiveOrders}=true to allow agents to place paid orders.`,
        );
      }

      const result = await ctx.client().createOrder(order);
      return {
        submitted: true,
        environment: ctx.config.environment,
        orderNumber: result.orderNumber,
        externalId: order.externalId,
        storeId: order.storeId,
        message: result.message,
        nextSteps:
          "Orders go through a queue and can take a few minutes to appear. Track with get_order, then get_shipments once it ships.",
      };
    },
  },
  {
    name: "get_order",
    title: "Get order",
    category: "orders",
    description:
      "Get an order's status (Pending Payment, Awaiting Fulfillment, Shipped, Canceled), items, recipient, and totals.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["orderNumber"],
      properties: { orderNumber: orderNumberProperty },
    },
    annotations: readOnly,
    async run(input, ctx) {
      return { ...(await ctx.client().getOrder(input.orderNumber as number | string)) };
    },
  },
  {
    name: "list_orders",
    title: "List orders",
    category: "orders",
    description: "List a store's orders, newest first, optionally filtered by order date. Paginated.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        storeId: storeIdProperty,
        page: positiveInteger("Page number, starting at 1."),
        orderDateStart: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD, inclusive." },
        orderDateEnd: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD, inclusive." },
      },
    },
    annotations: readOnly,
    async run(input, ctx) {
      const storeId = await ctx.resolveStoreId(input.storeId as number | undefined);
      return {
        storeId,
        ...(await ctx.client().listOrders({
          storeId,
          page: input.page as number | undefined,
          orderDateStart: input.orderDateStart as string | undefined,
          orderDateEnd: input.orderDateEnd as string | undefined,
        })),
      };
    },
  },
  {
    name: "get_shipments",
    title: "Get shipments",
    category: "orders",
    description:
      "Get carrier, tracking number, ship date, and items for every shipment of an order. Empty until the order ships. Poll at most every 30 minutes.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["orderNumber"],
      properties: { orderNumber: orderNumberProperty },
    },
    annotations: readOnly,
    async run(input, ctx) {
      const result = await ctx.client().getShipments(input.orderNumber as number | string);
      const sandboxNote =
        ctx.config.environment === "sandbox" && result.shipments.length === 0
          ? { note: "Sandbox orders never ship, so this will stay empty." }
          : {};
      return { ...result, ...sandboxNote };
    },
  },
  {
    name: "subscribe_webhook",
    title: "Subscribe to shipping webhook",
    category: "webhooks",
    description:
      "Register a URL that Lumaprints POSTs to when an order ships (the only event). Lumaprints verifies the URL returns 200 before accepting it. Deliveries are not signed and not retried, so keep polling get_shipments as a fallback.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: { type: "string", minLength: 8, description: "Public HTTPS endpoint that accepts POST." },
        storeId: storeIdProperty,
        username: { type: "string", description: "Basic auth username Lumaprints should send, if your endpoint needs it." },
        password: { type: "string", description: "Basic auth password Lumaprints should send." },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async run(input, ctx) {
      if (ctx.demo) throw demoError("Webhooks can't be registered in the demo");
      const storeId = await ctx.resolveStoreId(input.storeId as number | undefined);
      const result = await ctx.client().subscribeWebhook({
        event: "shipping",
        storeId,
        url: input.url as string,
        username: (input.username as string | undefined) ?? null,
        password: (input.password as string | undefined) ?? null,
      });
      return { storeId, ...result };
    },
  },
];

const DEMO_NOTE =
  "Demo mode: sample catalog, prices, and orders. Nothing reaches Lumaprints. Previews work; submitting orders and registering webhooks are disabled.";

function demoError(action: string): ToolError {
  return new ToolError(
    "DEMO_MODE",
    `${action}: this is the read-only demo with sample data. Run lumaprints with your own sandbox API keys (LUMAPRINTS_API_KEY, LUMAPRINTS_API_SECRET) to do this for real.`,
  );
}

async function buildOrder(input: Record<string, unknown>, ctx: ToolContext): Promise<CreateOrderInput> {
  const order = input as unknown as Omit<CreateOrderInput, "storeId"> & { storeId?: number };
  const duplicates = findDuplicates(order.orderItems.map((item) => item.externalItemId));
  if (duplicates.length) {
    throw new ToolError("INVALID_INPUT", `externalItemId must be unique within the order: ${duplicates.join(", ")}`);
  }
  return {
    ...order,
    storeId: await ctx.resolveStoreId(order.storeId),
    orderItems: order.orderItems.map((item) => ({ ...item, orderItemOptions: item.orderItemOptions ?? [] })),
  };
}

async function previewOrder(order: CreateOrderInput, ctx: ToolContext) {
  const client = ctx.client();
  const production = ctx.config.environment === "production";
  const warnings: string[] = [];

  const [pricesResult, shippingResult] = await Promise.allSettled([
    client.getProductPrices(
      order.orderItems.map((item) => ({
        subcategoryId: item.subcategoryId,
        width: item.width,
        height: item.height,
        options: item.orderItemOptions,
      })),
    ),
    client.getShippingQuote({
      recipient: order.recipient,
      orderItems: order.orderItems.map(({ subcategoryId, quantity, width, height, orderItemOptions }) => ({
        subcategoryId,
        quantity,
        width,
        height,
        orderItemOptions,
      })),
      shipAsFlat: order.shipAsFlat,
      storeId: order.storeId,
    }),
  ]);

  const prices = pricesResult.status === "fulfilled" ? pricesResult.value : [];
  if (pricesResult.status === "rejected") warnings.push(`Could not price items: ${errorText(pricesResult.reason)}`);

  const items = order.orderItems.map((item, index) => {
    const price = prices[index];
    const priced = price && price.success !== false && typeof price.price === "number";
    if (price && !priced) warnings.push(`Item ${item.externalItemId}: ${price.error ?? "could not be priced"}`);
    return {
      externalItemId: item.externalItemId,
      subcategoryId: item.subcategoryId,
      size: `${item.width}x${item.height}`,
      quantity: item.quantity,
      unitPrice: priced ? price.price : null,
      lineTotal: priced ? round(price.price * item.quantity) : null,
      options: price?.options ?? [],
    };
  });

  let shipping: ShippingQuote | null = null;
  let selectedShipping: { carrier: string; method: string; cost: number } | null = null;
  if (shippingResult.status === "fulfilled") {
    shipping = shippingResult.value;
    if (shipping.message) warnings.push(`Shipping: ${shipping.message}`);
    selectedShipping = pickShipping(shipping, order.shippingMethod);
    if (!selectedShipping && order.shippingMethod && order.shippingMethod !== "default") {
      warnings.push(
        `Shipping method "${order.shippingMethod}" was not quoted for this address. Available: ${shipping.shippingMethods.map((m) => m.method).join(", ") || "none"}.`,
      );
    }
  } else {
    warnings.push(`Could not quote shipping: ${errorText(shippingResult.reason)}`);
  }

  const allPriced = items.every((item) => item.lineTotal !== null);
  const productSubtotal = allPriced ? round(items.reduce((sum, item) => sum + (item.lineTotal ?? 0), 0)) : null;
  const estimatedTotal =
    productSubtotal !== null && selectedShipping ? round(productSubtotal + selectedShipping.cost) : null;

  if (production && !ctx.config.allowLiveOrders) {
    warnings.push(`Submitting is disabled until a human sets ${ENV_VARS.allowLiveOrders}=true.`);
  }
  if (ctx.demo) warnings.push("Demo mode: sample prices, and submitting is disabled.");

  return {
    environment: ctx.config.environment,
    demo: ctx.demo,
    ordersAreReal: production && !ctx.demo,
    estimate: {
      currency: "USD",
      items,
      productSubtotal,
      shipping: selectedShipping,
      shippingOptions: shipping?.shippingMethods ?? [],
      estimatedTotalBeforeTax: estimatedTotal,
    },
    warnings,
    order,
    nextStep: ctx.demo
      ? "Demo preview with sample prices. With real keys, an agent shows this to the user and, after approval, calls submit_order again with the same input plus confirm: true."
      : production
      ? "PRODUCTION: confirming charges the store's card immediately and cannot be undone through the API. Show this preview to the user. Only after explicit approval, call submit_order again with the same input plus confirm: true."
      : "Sandbox: nothing will be printed, shipped, or billed. To submit, call submit_order again with the same input plus confirm: true.",
  };
}

function pickShipping(quote: ShippingQuote, method: string | undefined) {
  const methods = quote.shippingMethods.filter((option) => option.method !== "freight" || option.cost > 0);
  if (!method || method === "default") {
    return methods.reduce<ShippingQuote["shippingMethods"][number] | null>(
      (cheapest, option) => (!cheapest || option.cost < cheapest.cost ? option : cheapest),
      null,
    );
  }
  return quote.shippingMethods.find((option) => option.method === method) ?? null;
}

function findDuplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) (seen.has(value) ? duplicates : seen).add(value);
  return [...duplicates];
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Running tools

export function getTool(name: string): LumaprintsTool | undefined {
  const normalized = name.trim().replace(/-/g, "_");
  return tools.find((tool) => tool.name === normalized);
}

export function toolDefinitions(): ToolDefinition[] {
  return tools.map(({ run: _run, ...definition }) => definition);
}

/** Validates input against the tool's schema, runs it, and normalizes every failure to a ToolError. */
export async function runTool(name: string, input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
  const tool = getTool(name);
  if (!tool) {
    throw new ToolError("UNKNOWN_TOOL", `Unknown tool "${name}". Available: ${tools.map((t) => t.name).join(", ")}`);
  }
  const args = input === undefined || input === null ? {} : input;
  if (!isPlainObject(args)) {
    throw new ToolError("INVALID_INPUT", `${tool.name} input must be a JSON object`);
  }
  const errors = validate(tool.inputSchema, args);
  if (errors.length) {
    throw new ToolError("INVALID_INPUT", `Invalid input for ${tool.name}: ${errors.join("; ")}`, { errors });
  }
  try {
    return await tool.run(args, ctx);
  } catch (error) {
    throw toToolError(error);
  }
}

export function toToolError(error: unknown): ToolError {
  if (error instanceof ToolError) return error;
  if (error instanceof LumaprintsConfigError) return new ToolError("CONFIG_ERROR", error.message);
  if (error instanceof LumaprintsError) {
    return new ToolError("LUMAPRINTS_API_ERROR", error.message, { status: error.status, body: error.body });
  }
  return new ToolError("INTERNAL_ERROR", errorText(error));
}
