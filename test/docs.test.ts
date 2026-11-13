import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { tools } from "../src/tools.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("docs", () => {
  for (const [file, pattern] of [
    ["llms.txt", (name: string) => new RegExp(`^- ${name}: `, "m")],
    ["README.md", (name: string) => new RegExp(`^\\| \`${name}\` \\|`, "m")],
  ] as const) {
    it(`${file} lists every tool`, () => {
      const text = read(file);
      const missing = tools.filter((tool) => !pattern(tool.name).test(text)).map((tool) => tool.name);
      assert.deepEqual(missing, []);
    });
  }
});
