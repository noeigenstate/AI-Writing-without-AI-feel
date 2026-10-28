import { createApp } from "./app.js";
import { config } from "./core/config.js";
import { configureEnvProxy } from "./core/proxy.js";

/** Bootstrap the backend: build the app and listen on the configured port. */
const proxyStatus = configureEnvProxy();
if (proxyStatus === "enabled") {
  console.log("Backend environment proxy enabled.");
} else if (proxyStatus === "unsupported") {
  console.warn("HTTP_PROXY/HTTPS_PROXY is configured, but this Node.js version lacks runtime proxy support (requires Node.js 24.14+).");
}

const app = createApp();

app.listen(config.port, config.host, () => {
  console.log(`AI写作 backend listening on http://${config.host}:${config.port}`);
});
