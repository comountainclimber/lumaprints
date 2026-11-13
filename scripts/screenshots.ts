// Regenerates docs/screenshots/*.png from the demo console using headless Chrome.
// Usage: node scripts/screenshots.ts   (CHROME=/path/to/chrome to override)
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDemoToolContext } from "../src/demo.ts";
import { startUiServer } from "../src/ui-server.ts";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = new URL("../docs/screenshots/", import.meta.url);
const DEBUG_PORT = 9333;

const ORDER_ITEMS = [
  { subcategoryId: 105001, externalItemId: "1", quantity: 1, width: 16, height: 20, file: { imageUrl: "https://example.com/art/great-wave.jpg" }, orderItemOptions: [64, 76, 83, 95] },
  { subcategoryId: 103003, externalItemId: "2", quantity: 2, width: 8, height: 10, file: { imageUrl: "https://example.com/art/fuji.jpg" }, orderItemOptions: [39] },
];

interface Scene {
  name: string;
  hash: string;
  height?: number;
  /** Runs in the page after load; may return a promise. */
  script?: string;
}

const scenes: Scene[] = [
  { name: "catalog", hash: "", height: 1300 },
  {
    name: "order-preview",
    hash: "#tool=submit_order",
    script: `(async () => {
      const items = document.getElementById("f-orderItems");
      items.value = ${JSON.stringify(JSON.stringify(ORDER_ITEMS, null, 2))};
      items.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("[data-run]").click();
      for (let i = 0; i < 50 && !document.querySelector("#result .pill"); i++) await new Promise((r) => setTimeout(r, 50));
      document.getElementById("result").scrollIntoView({ block: "start" });
      document.querySelector("main").scrollTop -= 20;
    })()`,
  },
  { name: "connect", hash: "#connect" },
];

class Cdp {
  #ws: WebSocket;
  #id = 0;
  #pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  #listeners = new Map<string, Array<() => void>>();

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        const pending = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (message.error) pending?.reject(new Error(message.error.message));
        else pending?.resolve(message.result);
      } else if (message.method) {
        for (const listener of this.#listeners.get(message.method) ?? []) listener();
        this.#listeners.delete(message.method);
      }
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    return new Cdp(ws);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.#id;
    this.#ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  once(event: string): Promise<void> {
    return new Promise((resolve) => this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), resolve]));
  }

  close() {
    this.#ws.close();
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function pageTarget(): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const targets = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
      const page = targets.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome is still starting.
    }
    await sleep(100);
  }
  throw new Error("Chrome did not expose a page target");
}

const server = await startUiServer({ context: createDemoToolContext(), port: 0 });
const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "lumaprints-shots-"))}`,
  "--hide-scrollbars",
  "--no-first-run",
  "--no-default-browser-check",
  "about:blank",
], { stdio: "ignore" });

try {
  const cdp = await Cdp.connect(await pageTarget());
  await cdp.send("Page.enable");
  mkdirSync(OUT, { recursive: true });

  for (const theme of ["dark", "light"]) {
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
    for (const scene of scenes) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: scene.height ?? 900, deviceScaleFactor: 2, mobile: false });
      const loaded = cdp.once("Page.loadEventFired");
      await cdp.send("Page.navigate", { url: `${server.url}?shot=${scene.name}-${theme}${scene.hash}` });
      await loaded;
      await sleep(400);
      if (scene.script) await cdp.send("Runtime.evaluate", { expression: scene.script, awaitPromise: true });
      await sleep(300);
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
      const file = new URL(`${scene.name}-${theme}.png`, OUT);
      writeFileSync(file, Buffer.from(data, "base64"));
      console.log(`wrote ${file.pathname}`);
    }
  }
  cdp.close();
} finally {
  chrome.kill();
  await server.close();
}
