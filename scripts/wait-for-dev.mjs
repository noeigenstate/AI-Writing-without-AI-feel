import { get } from "node:http";

const frontendPort = Number(process.env.FRONTEND_PORT ?? "51773");
const frontendUrl = `http://127.0.0.1:${frontendPort}/`;
const backendUrl = "http://127.0.0.1:8787/api/styles?lang=zh";
const timeoutMs = 30_000;
const retryMs = 250;

function responds(url) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    // `agent: false` guarantees this local readiness probe never follows
    // HTTP_PROXY/HTTPS_PROXY, even while external research requests do.
    const request = get(url, { agent: false }, (response) => {
      response.resume();
      finish(Boolean(response.statusCode && response.statusCode >= 200 && response.statusCode < 400));
    });
    request.setTimeout(1_000, () => {
      finish(false);
      request.destroy();
    });
    request.once("error", () => finish(false));
  });
}

const deadline = Date.now() + timeoutMs;
let ready = false;
let frontendReady = false;
let backendReady = false;

while (Date.now() < deadline) {
  [frontendReady, backendReady] = await Promise.all([
    responds(frontendUrl),
    responds(backendUrl),
  ]);

  if (frontendReady && backendReady) {
    console.log("");
    console.log("============================================");
    console.log("AI写作 is ready.");
    console.log(`Open in your browser: ${frontendUrl}`);
    console.log("Backend API: http://127.0.0.1:8787");
    console.log("Press Ctrl+C once to stop both services.");
    console.log("============================================");
    ready = true;
    break;
  }

  await new Promise((resolve) => setTimeout(resolve, retryMs));
}

if (!ready) {
  console.error("Services did not become ready within 30 seconds.");
  console.error(`Frontend probe: ${frontendReady ? "ready" : "unreachable"} (${frontendUrl})`);
  console.error(`Backend probe: ${backendReady ? "ready" : "unreachable"} (${backendUrl})`);
  process.exitCode = 1;
}
