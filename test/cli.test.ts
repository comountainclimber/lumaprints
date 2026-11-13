import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { startMockLumaprints, type MockLumaprints } from "./fixtures/mock-server.ts";
import { mockEnv, sampleOrder } from "./helpers.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

describe("cli", () => {
  let mock: MockLumaprints;
  const cwd = mkdtempSync(join(tmpdir(), "lumaprints-cli-"));

  function run(args: string[], stdin?: string, env: Record<string, string> = {}) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [CLI, ...args], {
        cwd,
        env: { PATH: process.env.PATH ?? "", ...mockEnv(mock), ...env },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(stdin);
    });
  }

  before(async () => {
    mock = await startMockLumaprints();
  });
  after(() => mock.close());

  it("runs a tool and prints JSON", async () => {
    const { code, stdout } = await run(["list-stores"]);
    assert.equal(code, 0);
    assert.equal(JSON.parse(stdout).stores[0].storeId, 1088);
  });

  it("coerces flags using the tool's schema", async () => {
    const { code, stdout } = await run(["get-product-price", "--subcategory-id", "103001", "--width", "8", "--height=10", "--options", "39"]);
    assert.equal(code, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.price, 10.8);
    assert.deepEqual(result.options.map((o: { optionId: number }) => o.optionId), [39]);
  });

  it("reads --input from a file and from stdin", async () => {
    const file = join(cwd, "order.json");
    writeFileSync(file, JSON.stringify(sampleOrder()));
    const fromFile = await run(["submit-order", "--input", `@${file}`]);
    assert.equal(fromFile.code, 0);
    assert.equal(JSON.parse(fromFile.stdout).submitted, false);

    const fromStdin = await run(["search-catalog", "--input", "-"], JSON.stringify({ query: "canvas 1.50" }));
    assert.equal(JSON.parse(fromStdin.stdout).total, 1);
  });

  it("uses exit 2 and JSON on stderr for bad input", async () => {
    const { code, stdout, stderr } = await run(["list-subcategories", "--category-id", "abc"]);
    assert.equal(code, 2);
    assert.equal(stdout, "");
    assert.equal(JSON.parse(stderr).error.code, "INVALID_INPUT");

    const unknown = await run(["frobnicate"]);
    assert.equal(unknown.code, 2);
    assert.equal(JSON.parse(unknown.stderr).error.code, "USAGE");
  });

  it("uses exit 1 for API errors", async () => {
    const { code, stderr } = await run(["get-order", "--order-number", "42"]);
    assert.equal(code, 1);
    const error = JSON.parse(stderr).error;
    assert.equal(error.code, "LUMAPRINTS_API_ERROR");
    assert.equal(error.details.status, 404);
  });

  it("loads credentials from .env in the working directory", async () => {
    const envDir = mkdtempSync(join(tmpdir(), "lumaprints-env-"));
    writeFileSync(join(envDir, ".env"), Object.entries(mockEnv(mock)).map(([k, v]) => `${k}=${v}`).join("\n"));
    const child = spawn(process.execPath, [CLI, "list-stores"], { cwd: envDir, env: { PATH: process.env.PATH ?? "" } });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, 0);
    assert.equal(JSON.parse(stdout).stores.length, 1);
  });

  it("lists tools for agents", async () => {
    const { stdout } = await run(["tools", "--names"]);
    assert.ok(JSON.parse(stdout).includes("submit_order"));
    const help = await run(["help", "submit-order"]);
    assert.match(help.stdout, /--confirm <boolean>/);
  });
});
