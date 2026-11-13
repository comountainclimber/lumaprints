# AGENTS.md

Notes for AI agents, both those using `lumaprints` to place print orders and those working on this repo.

## Using lumaprints

- **MCP:** `npx -y lumaprints mcp`. The server's `instructions` and each tool's description carry the full workflow and rules.
- **Shell:** `npx lumaprints <tool> --field value` or `--input '<json>'`. JSON on stdout; errors are `{"error":{"code","message","details"}}` on stderr. `npx lumaprints help <tool>` prints flags and the JSON Schema.
- **No credentials:** add `--demo` to any command for sample data. Nothing reaches Lumaprints and submitting is disabled.

### Placing an order

1. `get_config`: check `environment` and `ordersAreReal`. In production, orders are charged immediately and can't be canceled through the API.
2. `search_catalog` to find a `subcategoryId`, then `list_subcategory_options` for option ids (at most one per group, or omit for defaults).
3. `check_image`: the aspect ratio must match the print size within 1%, with enough pixels for the product's DPI.
4. `submit_order` **without** `confirm`. It returns prices, shipping options, an estimated total, and warnings. Show this preview to the user.
5. Only after the user explicitly approves, call `submit_order` again with the same input plus `confirm: true`.
6. Track with `get_order`, then `get_shipments`. Sandbox orders never progress or ship.

### Rules

- Never pass `confirm: true` without explicit user approval of the preview, and never set `LUMAPRINTS_ALLOW_LIVE_ORDERS` yourself.
- Never submit test orders in production. Lumaprints revokes API access for it.
- Sizes are inches. Image URLs must be public JPG/PNG that stay reachable for 30+ minutes. Gift notes go in `printouts` (public PDF URLs), not `specialInstructions`.
- `externalId` is unique per store, so resubmitting the same order is rejected rather than duplicated.

### Error codes

| Code | Meaning | What to do |
|---|---|---|
| `INVALID_INPUT` | Input failed the tool's schema | Read `details.errors`. Unknown keys list the allowed ones. |
| `CONFIG_ERROR` | Missing or invalid credentials or environment | Ask the user to set `LUMAPRINTS_API_KEY` and `LUMAPRINTS_API_SECRET` |
| `STORE_REQUIRED` | Several stores and no `storeId` | Pick from `details.stores` with the user |
| `LIVE_ORDERS_DISABLED` | Production submit without the human-set flag | Stop and tell the user |
| `DEMO_MODE` | Write attempted in demo mode | Previews work. Submitting needs real sandbox keys. |
| `LUMAPRINTS_API_ERROR` | The API returned an error | `details.status` and `details.body` have the specifics |

## Working on this repo

| Path | |
|---|---|
| `src/client.ts` | Typed REST client: auth, timeouts, 429 retries, `LumaprintsError` |
| `src/tools.ts` | The tool registry and agent instructions. MCP, CLI, and GUI all render from this, so a tool is defined once. |
| `src/mcp.ts` | MCP over stdio, written from the spec (no SDK) |
| `src/cli.ts` | CLI: flags are coerced using each tool's JSON Schema |
| `src/ui-server.ts` | Console as a fetch handler (`createUiHandler`) plus a loopback-only `node:http` adapter |
| `ui/index.html` | The whole console: one file, vanilla JS, no build step |
| `src/demo.ts` | In-memory sample backend behind `--demo` and the hosted demo |
| `api/demo.js`, `vercel.json` | Hosted demo on Vercel |
| `test/fixtures/mock-server.ts` | Mock Lumaprints API used by every test |

Conventions:

- Zero runtime dependencies. Node built-ins and web standards only.
- Node runs `src/` directly with type stripping, so use erasable TypeScript only (no `enum`, `namespace`, or constructor parameter properties) and import siblings with `.ts` extensions.
- The console's CSP is nonce-based, so no inline `style="..."` attributes or inline event handlers in `ui/index.html`.
- Adding a tool means adding it to `src/tools.ts`, the README tools table, and `llms.txt`. `test/docs.test.ts` fails until all three agree.
- Tests run against the mock server. Never use real Lumaprints credentials in tests.
- Before committing, run `pnpm typecheck && pnpm test`.
