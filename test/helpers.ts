import { createToolContext, type ToolContext } from "../src/tools.ts";
import { MOCK_CREDENTIALS, type MockLumaprints } from "./fixtures/mock-server.ts";

export function mockEnv(mock: MockLumaprints, extra: Record<string, string> = {}): Record<string, string> {
  return {
    LUMAPRINTS_API_KEY: MOCK_CREDENTIALS.apiKey,
    LUMAPRINTS_API_SECRET: MOCK_CREDENTIALS.apiSecret,
    LUMAPRINTS_BASE_URL: mock.url,
    ...extra,
  };
}

export function mockContext(mock: MockLumaprints, extra: Record<string, string> = {}): ToolContext {
  return createToolContext({ env: mockEnv(mock, extra) });
}

export function sampleOrder(overrides: Record<string, unknown> = {}) {
  return {
    externalId: "test-order-1",
    recipient: {
      firstName: "Jane",
      lastName: "Doe",
      addressLine1: "123 Main St",
      city: "New York",
      state: "NY",
      zipCode: "10001",
      country: "US",
    },
    orderItems: [
      {
        subcategoryId: 103001,
        externalItemId: "1",
        quantity: 2,
        width: 8,
        height: 10,
        file: { imageUrl: "https://example.com/art-8x10.jpg" },
      },
    ],
    ...overrides,
  };
}

export function apiCalls(mock: MockLumaprints, method: string, path: string) {
  return mock.requests.filter((r) => r.method === method && r.path === path);
}
