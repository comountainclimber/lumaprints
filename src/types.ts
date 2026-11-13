// Shapes follow https://api-docs.lumaprints.com/ (OpenAPI exports, Nov 2026).

export type LumaprintsEnvironment = "sandbox" | "production";

export interface Store {
  storeId: number;
  storeName: string;
}

export interface Category {
  id: number;
  name: string;
}

export interface Subcategory {
  subcategoryId: number;
  name: string;
  minimumWidth: number;
  maximumWidth: number;
  minimumHeight: number;
  maximumHeight: number;
  requiredDPI: number;
}

export interface OptionGroup {
  optionGroup: string;
  optionGroupItems: Array<{ optionId: number; optionName: string }>;
}

/**
 * Any method code returned by the shipping quote endpoint is valid, including
 * ones missing from this list.
 */
export type ShippingMethod =
  | "default"
  | "pickup"
  | "ground"
  | "ground_economy"
  | "2_day"
  | "overnight"
  | "usps_ground_advantage"
  | "usps_priority_mail"
  | "usps_priority_mail_express"
  | "usps_first_class_mail_international"
  | "usps_priority_mail_international"
  | "usps_priority_mail_express_international"
  | "freight"
  | (string & {});

export type ProductionTime = "regular" | "nextday" | "sameday";

export interface Recipient {
  firstName: string;
  lastName: string;
  company?: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  zipCode: string;
  /** ISO 3166-1 alpha-2 country code, e.g. "US". */
  country: string;
  phone?: string;
}

export interface OrderItemInput {
  subcategoryId: number;
  /** Your line item id. Letters, numbers, hyphens and underscores only. */
  externalItemId: string;
  quantity: number;
  /** Inches. Decimals are allowed. */
  width: number;
  /** Inches. Decimals are allowed. */
  height: number;
  file: {
    /** Publicly accessible JPG or PNG. Must stay reachable for 30 minutes after submission. */
    imageUrl: string;
    saveImage?: boolean;
  };
  /** One option id per option group. An empty array uses the subcategory defaults. */
  orderItemOptions: number[];
  /** Only used with option 3 (Solid Color Wrap). Format "#rrggbb". */
  solidColorHexCode?: string | null;
}

export interface CreateOrderInput {
  /** Unique per store. Letters, numbers, hyphens and underscores only. */
  externalId: string;
  storeId: number;
  shippingMethod?: ShippingMethod;
  productionTime?: ProductionTime;
  recipient: Recipient;
  orderItems: OrderItemInput[];
  /** For the Lumaprints production team, not for gift notes. */
  specialInstructions?: string | null;
  /** Up to 3 printed pages total, as public URLs. Use this for gift notes and inserts. */
  printouts?: string[] | null;
  shipAsFlat?: boolean;
}

export interface CreateOrderResult {
  message: string;
  orderNumber: number;
}

export type OrderStatus =
  | "Pending Payment"
  | "Awaiting Fulfillment"
  | "Shipped"
  | "Canceled"
  | (string & {});

export interface OrderItem {
  subcategoryId: number;
  externalItemId: string;
  quantity: number;
  width: number;
  height: number;
  file: { imageUrl: string };
  orderItemOptions: Array<{ optionId: number; optionName: string }>;
  itemCostTotal: number;
}

export interface Order {
  orderNumber: number;
  externalId: string;
  storeId: number;
  orderDate: string;
  email: string | null;
  shippingMethod: string;
  productionTime: string;
  orderStatus: OrderStatus;
  recipient: Omit<Recipient, "company" | "addressLine2" | "phone"> & {
    company: string | null;
    addressLine2: string | null;
    phone: string | null;
  };
  orderItems: OrderItem[];
  discountTotal: number;
  shippingTotal: number;
  taxTotal: number;
  subTotal: number;
  orderTotal: number;
}

export interface OrderList {
  orders: Order[];
  totalOrders: number;
  currentPage: number;
  totalPages: number;
}

export interface ListOrdersInput {
  storeId: number;
  page?: number;
  /** YYYY-MM-DD */
  orderDateStart?: string;
  /** YYYY-MM-DD */
  orderDateEnd?: string;
}

export interface Shipment {
  carrier: string;
  shippingMethod: string;
  trackingNumber: string;
  shipmentDate: string;
  shipmentItems: Array<{
    externalItemId: string;
    product: string;
    quantity: number;
  }>;
}

export interface ShipmentList {
  orderNumber: number;
  shipments: Shipment[];
}

/** Body Lumaprints POSTs to your webhook URL for the `shipping` event. */
export interface ShippingWebhookPayload extends ShipmentList {
  externalId?: string;
}

export interface ProductPriceInput {
  subcategoryId: number;
  width: number;
  height: number;
  /** Option ids. Framed canvas (102001-102003) requires a frame style option. */
  options?: number[];
}

export interface ProductPrice {
  success: boolean;
  subcategoryId: number;
  size: { width: number; height: number };
  price: number;
  options: Array<{
    optionId: number;
    optionGroupName: string;
    optionName: string;
    price: number;
  }>;
  error?: string;
  statusCode?: number;
}

export interface ShippingQuoteItem {
  subcategoryId: number;
  quantity: number;
  width: number;
  height: number;
  orderItemOptions?: number[];
}

export interface ShippingQuoteInput {
  recipient: Partial<Recipient> &
    Pick<Recipient, "addressLine1" | "city" | "state" | "zipCode" | "country">;
  orderItems: ShippingQuoteItem[];
  shipAsFlat?: boolean;
  storeId?: number;
}

export interface ShippingQuote {
  /** Non-empty when some carriers could not quote, e.g. a likely bad address. */
  message: string;
  shippingMethods: Array<{ carrier: string; method: string; cost: number }>;
}

export interface CheckImageInput {
  subcategoryId: number;
  /** Inches. */
  printWidth: number;
  /** Inches. */
  printHeight: number;
  imageUrl: string;
  orderItemOptions?: number[];
}

export interface CheckImageResult {
  /** False when Lumaprints rejects the image size (HTTP 406). */
  ok: boolean;
  message: string;
  imageUrl: string;
  recommendedWidth?: number;
  recommendedHeight?: number;
  expectedWidth?: number;
  expectedHeight?: number;
  expectedAspectRatio?: string;
  actualImageWidth?: number;
  actualImageHeight?: number;
  actualImageAspectRatio?: string;
}

export interface SubscribeWebhookInput {
  event: "shipping";
  storeId: number;
  url: string;
  username?: string | null;
  password?: string | null;
}

export interface SubscribeWebhookResult {
  status: number;
  message: string;
}

export interface RateLimitInfo {
  limit: number | null;
  remaining: number | null;
  resetSeconds: number | null;
}
