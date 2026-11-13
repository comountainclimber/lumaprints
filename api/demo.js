// Vercel function for the public read-only demo. Every route is rewritten here (see vercel.json).
import { createDemoToolContext } from "../dist/demo.js";
import { createUiHandler } from "../dist/ui-server.js";

const handle = createUiHandler({ context: createDemoToolContext() });

export function GET(request) {
  return handle(request);
}

export function POST(request) {
  return handle(request);
}
