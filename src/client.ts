import type {
  Category,
  CheckImageInput,
  CheckImageResult,
  CreateOrderInput,
  CreateOrderResult,
  ListOrdersInput,
  LumaprintsEnvironment,
  OptionGroup,
  Order,
  OrderList,
  ProductPrice,
  ProductPriceInput,
  RateLimitInfo,
  ShipmentList,
  ShippingQuote,
  ShippingQuoteInput,
  Store,
  Subcategory,
  SubscribeWebhookInput,
  SubscribeWebhookResult,
} from "./types.ts";
import { VERSION } from "./version.ts";

export const LUMAPRINTS_BASE_URLS = {
  sandbox: "https://us.api-sandbox.lumaprints.com",
  production: "https://us.api.lumaprints.com",
} as const satisfies Record<LumaprintsEnvironment, string>;

export interface LumaprintsClientOptions {
  apiKey: string;
  apiSecret: string;
  /** Defaults to "sandbox". There is no automatic fallback between environments. */
  environment?: LumaprintsEnvironment;
  /** Overrides the environment's base URL, e.g. for a proxy or a local mock. */
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  /** Per-request timeout. Defaults to 30 seconds. */
  timeoutMs?: number;
  /** Retries after HTTP 429, waiting for x-ratelimit-reset. Defaults to 2. */
  maxRetries?: number;
  userAgent?: string;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
}

export interface RawResponse {
  status: number;
  body: unknown;
  rateLimit: RateLimitInfo;
}

export class LumaprintsError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly rateLimit: RateLimitInfo;

  constructor(init: {
    message: string;
    status: number;
    method: string;
    path: string;
    body: unknown;
    rateLimit?: RateLimitInfo;
    cause?: unknown;
  }) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "LumaprintsError";
    this.status = init.status;
    this.method = init.method;
    this.path = init.path;
    this.body = init.body;
    this.rateLimit = init.rateLimit ?? EMPTY_RATE_LIMIT;
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      status: this.status,
      method: this.method,
      path: this.path,
      body: this.body,
    };
  }
}

export interface LumaprintsClient {
  readonly environment: LumaprintsEnvironment;
  readonly baseUrl: string;

  /** Low-level escape hatch for endpoints this client doesn't wrap yet. */
  request<T = unknown>(method: HttpMethod, path: string, options?: RequestOptions): Promise<T>;

  listStores(): Promise<Store[]>;
  listCategories(): Promise<Category[]>;
  listSubcategories(categoryId: number): Promise<Subcategory[]>;
  listSubcategoryOptions(subcategoryId: number): Promise<OptionGroup[]>;

  getProductPrice(input: ProductPriceInput): Promise<ProductPrice>;
  /** Prices many products in one call. Results keep request order; failed items have success: false. */
  getProductPrices(items: ProductPriceInput[]): Promise<ProductPrice[]>;
  getShippingQuote(input: ShippingQuoteInput): Promise<ShippingQuote>;

  /** Returns ok: false instead of throwing when the image is sized incorrectly. */
  checkImage(input: CheckImageInput): Promise<CheckImageResult>;

  /** Places a real order in production: charged immediately, cannot be edited or canceled via API. */
  createOrder(input: CreateOrderInput): Promise<CreateOrderResult>;
  getOrder(orderNumber: number | string): Promise<Order>;
  listOrders(input: ListOrdersInput): Promise<OrderList>;
  getShipments(orderNumber: number | string): Promise<ShipmentList>;

  subscribeWebhook(input: SubscribeWebhookInput): Promise<SubscribeWebhookResult>;
}

const EMPTY_RATE_LIMIT: RateLimitInfo = { limit: null, remaining: null, resetSeconds: null };
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const MAX_RATE_LIMIT_WAIT_SECONDS = 60;

export function createLumaprintsClient(options: LumaprintsClientOptions): LumaprintsClient {
  const { apiKey, apiSecret } = options;
  if (!apiKey || !apiSecret) {
    throw new TypeError("createLumaprintsClient: apiKey and apiSecret are required");
  }

  const environment = options.environment ?? "sandbox";
  if (environment !== "sandbox" && environment !== "production") {
    throw new TypeError(
      `createLumaprintsClient: environment must be "sandbox" or "production", got "${String(environment)}"`,
    );
  }

  const baseUrl = (options.baseUrl ?? LUMAPRINTS_BASE_URLS[environment]).replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new TypeError("createLumaprintsClient: no fetch implementation available");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const headers: Record<string, string> = {
    Authorization: basicAuth(apiKey, apiSecret),
    Accept: "application/json",
    "User-Agent": options.userAgent ?? `lumaprints-js/${VERSION}`,
  };

  async function send(method: HttpMethod, path: string, init: RequestOptions = {}): Promise<RawResponse> {
    const url = buildUrl(baseUrl, path, init.query);
    const hasBody = init.body !== undefined;

    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method,
          headers: hasBody ? { ...headers, "Content-Type": "application/json" } : headers,
          body: hasBody ? JSON.stringify(init.body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (cause) {
        throw new LumaprintsError({
          message: `Could not reach Lumaprints (${method} ${path}): ${errorMessage(cause)}`,
          status: 0,
          method,
          path,
          body: null,
          cause,
        });
      }

      const rateLimit = readRateLimit(response.headers);
      const body = await readBody(response);

      if (response.status === 429 && attempt < maxRetries) {
        const waitSeconds = Math.min(rateLimit.resetSeconds ?? attempt + 1, MAX_RATE_LIMIT_WAIT_SECONDS);
        await sleep(Math.max(waitSeconds, 0) * 1000);
        continue;
      }

      return { status: response.status, body, rateLimit };
    }
  }

  async function request<T>(method: HttpMethod, path: string, init?: RequestOptions): Promise<T> {
    const raw = await send(method, path, init);
    if (raw.status < 200 || raw.status >= 300) {
      throw errorFromResponse(method, path, raw);
    }
    return raw.body as T;
  }

  return {
    environment,
    baseUrl,
    request,

    listStores: () => request<Store[]>("GET", "/api/v1/stores"),
    listCategories: () => request<Category[]>("GET", "/api/v1/products/categories"),
    listSubcategories: (categoryId) =>
      request<Subcategory[]>("GET", `/api/v1/products/categories/${pathId(categoryId)}/subcategories`),
    listSubcategoryOptions: (subcategoryId) =>
      request<OptionGroup[]>("GET", `/api/v1/products/subcategories/${pathId(subcategoryId)}/options`),

    getProductPrice: (input) =>
      request<ProductPrice>("POST", "/api/v1/pricing/product", { body: toPriceRequest(input) }),
    getProductPrices: (items) =>
      request<ProductPrice[]>("POST", "/api/v1/pricing/products", { body: items.map(toPriceRequest) }),
    getShippingQuote: (input) => request<ShippingQuote>("POST", "/api/v1/pricing/shipping", { body: input }),

    async checkImage(input) {
      const path = "/api/v1/images/checkImageConfig";
      const raw = await send("POST", path, {
        body: { ...input, orderItemOptions: input.orderItemOptions ?? [] },
      });
      if (raw.status === 200 || raw.status === 201 || raw.status === 406) {
        return { ok: raw.status !== 406, ...(raw.body as Omit<CheckImageResult, "ok">) };
      }
      throw errorFromResponse("POST", path, raw);
    },

    createOrder: (input) => request<CreateOrderResult>("POST", "/api/v1/orders", { body: input }),
    getOrder: (orderNumber) => request<Order>("GET", `/api/v1/orders/${pathId(orderNumber)}`),
    listOrders: ({ storeId, page, orderDateStart, orderDateEnd }) =>
      request<OrderList>("GET", "/api/v1/orders", {
        query: { storeId, page, orderDateStart, orderDateEnd },
      }),
    getShipments: (orderNumber) => request<ShipmentList>("GET", `/api/v1/shipments/${pathId(orderNumber)}`),

    async subscribeWebhook(input) {
      const path = "/api/v1/webhook";
      const result = await request<SubscribeWebhookResult>("POST", path, { body: input });
      // Duplicate and unreachable-URL failures can arrive as HTTP 201 with a 400 status in the body.
      if (typeof result?.status === "number" && result.status >= 400) {
        throw new LumaprintsError({
          message: `Lumaprints rejected the webhook: ${result.message}`,
          status: result.status,
          method: "POST",
          path,
          body: result,
        });
      }
      return result;
    },
  };
}

function toPriceRequest(input: ProductPriceInput) {
  return {
    subcategoryId: input.subcategoryId,
    size: { width: input.width, height: input.height },
    options: input.options ?? [],
  };
}

function basicAuth(apiKey: string, apiSecret: string): string {
  const bytes = new TextEncoder().encode(`${apiKey}:${apiSecret}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

function buildUrl(baseUrl: string, path: string, query: RequestOptions["query"]): string {
  const url = new URL(`${baseUrl}${path.startsWith("/") ? path : `/${path}`}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function pathId(value: number | string): string {
  const text = String(value).trim();
  if (!text) throw new TypeError("Expected a non-empty id");
  return encodeURIComponent(text);
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function readRateLimit(headers: Headers): RateLimitInfo {
  const num = (name: string) => {
    const value = headers.get(name);
    if (value === null || value.trim() === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return {
    limit: num("x-ratelimit-limit"),
    remaining: num("x-ratelimit-remaining"),
    resetSeconds: num("x-ratelimit-reset"),
  };
}

function errorFromResponse(method: string, path: string, raw: RawResponse): LumaprintsError {
  const detail = describeBody(raw.body);
  const hint =
    raw.status === 401 || raw.status === 403
      ? " Check that your API key and secret belong to this environment (sandbox and production keys are separate)."
      : raw.status === 429
        ? " Rate limited: Lumaprints allows 40 requests per minute per API key."
        : "";
  return new LumaprintsError({
    message: `Lumaprints ${method} ${path} failed with HTTP ${raw.status}${detail ? `: ${detail}` : ""}.${hint}`,
    status: raw.status,
    method,
    path,
    body: raw.body,
    rateLimit: raw.rateLimit,
  });
}

function describeBody(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 500);
  if (body && typeof body === "object" && "message" in body) {
    const message = (body as { message: unknown }).message;
    if (Array.isArray(message)) return message.join("; ");
    if (typeof message === "string") return message;
  }
  return "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
