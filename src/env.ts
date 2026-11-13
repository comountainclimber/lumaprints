import { createLumaprintsClient, type LumaprintsClient, type LumaprintsClientOptions } from "./client.ts";
import type { LumaprintsEnvironment } from "./types.ts";

export const ENV_VARS = {
  apiKey: "LUMAPRINTS_API_KEY",
  apiSecret: "LUMAPRINTS_API_SECRET",
  environment: "LUMAPRINTS_ENV",
  storeId: "LUMAPRINTS_STORE_ID",
  allowLiveOrders: "LUMAPRINTS_ALLOW_LIVE_ORDERS",
  baseUrl: "LUMAPRINTS_BASE_URL",
} as const;

export interface LumaprintsConfig {
  apiKey?: string;
  apiSecret?: string;
  environment: LumaprintsEnvironment;
  baseUrl?: string;
  defaultStoreId?: number;
  /** Production order submission is refused unless this is true. */
  allowLiveOrders: boolean;
}

export class LumaprintsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LumaprintsConfigError";
  }
}

type Env = Record<string, string | undefined>;

export function readConfigFromEnv(env: Env = defaultEnv()): LumaprintsConfig {
  const rawEnvironment = clean(env[ENV_VARS.environment])?.toLowerCase() ?? "sandbox";
  if (rawEnvironment !== "sandbox" && rawEnvironment !== "production") {
    throw new LumaprintsConfigError(
      `${ENV_VARS.environment} must be "sandbox" or "production", got "${rawEnvironment}"`,
    );
  }

  const rawStoreId = clean(env[ENV_VARS.storeId]);
  let defaultStoreId: number | undefined;
  if (rawStoreId) {
    defaultStoreId = Number(rawStoreId);
    if (!Number.isInteger(defaultStoreId) || defaultStoreId <= 0) {
      throw new LumaprintsConfigError(`${ENV_VARS.storeId} must be a positive integer, got "${rawStoreId}"`);
    }
  }

  return {
    apiKey: clean(env[ENV_VARS.apiKey]),
    apiSecret: clean(env[ENV_VARS.apiSecret]),
    environment: rawEnvironment,
    baseUrl: clean(env[ENV_VARS.baseUrl]),
    defaultStoreId,
    allowLiveOrders: isTruthy(env[ENV_VARS.allowLiveOrders]),
  };
}

export function hasCredentials(config: LumaprintsConfig): boolean {
  return Boolean(config.apiKey && config.apiSecret);
}

export function createLumaprintsClientFromConfig(
  config: LumaprintsConfig,
  overrides: Partial<LumaprintsClientOptions> = {},
): LumaprintsClient {
  if (!hasCredentials(config)) {
    throw new LumaprintsConfigError(
      `Missing Lumaprints credentials. Set ${ENV_VARS.apiKey} and ${ENV_VARS.apiSecret} ` +
        `(Developer > API Keys in the ${config.environment} dashboard).`,
    );
  }
  return createLumaprintsClient({
    apiKey: config.apiKey!,
    apiSecret: config.apiSecret!,
    environment: config.environment,
    baseUrl: config.baseUrl,
    ...overrides,
  });
}

export function createLumaprintsClientFromEnv(
  env: Env = defaultEnv(),
  overrides: Partial<LumaprintsClientOptions> = {},
): LumaprintsClient {
  return createLumaprintsClientFromConfig(readConfigFromEnv(env), overrides);
}

function defaultEnv(): Env {
  return (globalThis as { process?: { env?: Env } }).process?.env ?? {};
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isTruthy(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
}
