import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import multer from "multer";
import healthRoutes from "./routes/health.routes.js";
import scoreRoutes from "./routes/score.routes.js";
import stylesRoutes from "./routes/styles.routes.js";
import articleRoutes from "./routes/article.routes.js";
import novelRoutes from "./routes/novel.routes.js";
import rewriteRoutes from "./routes/rewrite.routes.js";
import gzhRoutes from "./routes/gzh.routes.js";
import { config } from "./core/config.js";

export interface AppOptions {
  corsOrigins?: readonly string[];
}

/**
 * Build the Express application: middleware plus all feature routers.
 *
 * Kept separate from {@link ./index.ts} so it can be imported in tests without
 * binding a port.
 *
 * @returns A configured (but not yet listening) Express app.
 */
export function createApp(options: AppOptions = {}): Express {
  const app = express();
  const allowedOrigins = options.corsOrigins ?? config.corsOrigins;
  app.use((req, res, next) => {
    const origin = req.get("origin");
    if (!isCorsOriginAllowed(origin, allowedOrigins)) {
      res.status(403).json({ error: "Origin not allowed." });
      return;
    }
    next();
  });
  app.use(
    cors({
      origin(origin, callback) {
        callback(null, isCorsOriginAllowed(origin, allowedOrigins));
      },
    })
  );
  app.use(express.json({ limit: "10mb" }));
  app.use(sanitizeJsonResponses);

  app.use(healthRoutes);
  app.use(scoreRoutes);
  app.use(stylesRoutes);
  app.use(articleRoutes);
  app.use(novelRoutes);
  app.use(rewriteRoutes);
  app.use(gzhRoutes);
  app.use(apiErrorHandler);

  return app;
}

/** Exact-origin CORS policy; requests without Origin remain available to CLI/same-origin clients. */
export function isCorsOriginAllowed(origin: string | undefined, allowedOrigins: readonly string[]): boolean {
  return origin === undefined || allowedOrigins.includes(origin);
}

/** Replace provider/server details with a stable public message before JSON leaves the process. */
export function sanitizeApiResponseBody(body: unknown, statusCode: number, lang: "en" | "zh"): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const record = sanitizeProviderDiagnostics(body as Record<string, unknown>, lang);
  const providerFailure = record.ok === false && typeof record.error === "string";
  if (statusCode < 500 && !providerFailure) return record;

  const error = lang === "zh" ? "服务暂时不可用，请稍后重试。" : "Service temporarily unavailable. Please try again.";
  if (statusCode >= 500) return { error };
  return { ...record, error };
}

/** Strip raw exception text from research-source status arrays at any JSON nesting level. */
function sanitizeProviderDiagnostics(value: Record<string, unknown>, lang: "en" | "zh"): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "unavailableSources" && Array.isArray(child)) {
      const suffix = lang === "zh" ? "暂时不可用" : "temporarily unavailable";
      output[key] = child.map((entry) => {
        const raw = typeof entry === "string" ? entry : "";
        const label = raw.match(/^([\p{L}\p{N} .()&/+_-]{1,100}):/u)?.[1]?.trim();
        return `${label || (lang === "zh" ? "研究信息源" : "Research source")}: ${suffix}`;
      });
      continue;
    }
    if (Array.isArray(child)) {
      output[key] = child.map((item) =>
        item && typeof item === "object" && Object.getPrototypeOf(item) === Object.prototype
          ? sanitizeProviderDiagnostics(item as Record<string, unknown>, lang)
          : item
      );
    } else if (child && typeof child === "object" && Object.getPrototypeOf(child) === Object.prototype) {
      output[key] = sanitizeProviderDiagnostics(child as Record<string, unknown>, lang);
    } else {
      output[key] = child;
    }
  }
  return output;
}

function sanitizeJsonResponses(req: Request, res: Response, next: NextFunction): void {
  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    const lang = req.body?.lang === "zh" || req.query.lang === "zh" ? "zh" : "en";
    return originalJson(sanitizeApiResponseBody(body, res.statusCode, lang));
  }) as Response["json"];
  next();
}

function apiErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof multer.MulterError) {
    const message =
      err.code === "LIMIT_FILE_SIZE"
        ? "Uploaded file is too large. Each file must be 10 MB or smaller."
        : err.message;
    res.status(400).json({ error: message });
    return;
  }

  // Do not hand unexpected errors to Express' development handler: it can
  // serialize stacks and upstream/provider messages into the HTTP response.
  void err;
  res.status(500).json({ error: "Service temporarily unavailable. Please try again." });
}
