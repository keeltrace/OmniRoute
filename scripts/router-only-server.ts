import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

export type RouterOnlyDependencies = {
  loadChatRoute: () => Promise<{ POST: (request: Request) => Promise<Response>; OPTIONS: () => Promise<Response> }>;
  loadResponsesRoute: () => Promise<{ POST: (request: Request) => Promise<Response>; OPTIONS: () => Promise<Response> }>;
  loadModelsCatalog: () => Promise<{ getUnifiedModelsResponse: (request: Request, cors?: Record<string, string>, options?: Record<string, unknown>) => Promise<Response> }>;
  loadCandidatesRoute: () => Promise<{ GET: (request: Request, context: { params: Promise<{ channel: string }> }) => Promise<Response>; OPTIONS: () => Promise<Response> }>;
};

export const defaultRouterOnlyDependencies: RouterOnlyDependencies = {
  loadChatRoute: () => import("@/app/api/v1/chat/completions/route.ts"),
  loadResponsesRoute: () => import("@/app/api/v1/responses/route.ts"),
  loadModelsCatalog: () => import("@/app/api/v1/models/catalog.ts"),
  loadCandidatesRoute: () => import("@/app/api/v1/auto-combo/[channel]/candidates/route.ts"),
};

export function normalizeRouterPath(pathname: string): string {
  if (pathname === "/api/v1") return "/v1";
  if (pathname.startsWith("/api/v1/")) return pathname.slice(4);
  if (pathname === "/chat/completions") return "/v1/chat/completions";
  if (pathname === "/models") return "/v1/models";
  if (pathname === "/responses") return "/v1/responses";
  return pathname;
}

function methodNotAllowed(allow: string): Response {
  return Response.json(
    { error: { message: "Method not allowed", type: "invalid_request_error", code: "method_not_allowed" } },
    { status: 405, headers: { Allow: allow } }
  );
}

function notFound(pathname: string): Response {
  return Response.json(
    { error: { message: `Unknown API route: ${pathname}`, type: "not_found", code: "unknown_route" } },
    { status: 404 }
  );
}

export async function dispatchRouterRequest(
  request: Request,
  dependencies: RouterOnlyDependencies = defaultRouterOnlyDependencies
): Promise<Response> {
  const url = new URL(request.url);
  const pathname = normalizeRouterPath(url.pathname);
  const method = request.method.toUpperCase();

  if (pathname === "/health" || pathname === "/api/health" || pathname === "/v1/health") {
    return Response.json({ status: "ok", mode: "router-only" });
  }
  if (pathname === "/v1") {
    return Response.json({ object: "omniroute.router", mode: "router-only" });
  }

  if (pathname === "/v1/chat/completions") {
    const route = await dependencies.loadChatRoute();
    if (method === "OPTIONS") return route.OPTIONS();
    if (method === "POST") return route.POST(request);
    return methodNotAllowed("POST, OPTIONS");
  }

  if (pathname === "/v1/models") {
    if (method === "OPTIONS") {
      return new Response(null, {
        headers: { "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS", "Access-Control-Allow-Headers": "*" },
      });
    }
    if (method === "HEAD") {
      return new Response(null, { status: 200, headers: { "content-type": "application/json" } });
    }
    if (method !== "GET") return methodNotAllowed("GET, HEAD, OPTIONS");
    const { getUnifiedModelsResponse } = await dependencies.loadModelsCatalog();
    // Deliberately omit Next's `after()` scheduler. catalogCache's default scheduler
    // already falls back to setTimeout outside a Next request scope.
    return getUnifiedModelsResponse(request, {}, {});
  }

  if (pathname === "/v1/responses") {
    const route = await dependencies.loadResponsesRoute();
    if (method === "OPTIONS") return route.OPTIONS();
    if (method === "POST") return route.POST(request);
    return methodNotAllowed("POST, OPTIONS");
  }

  const candidateMatch = /^\/v1\/auto-combo\/([^/]+)\/candidates$/.exec(pathname);
  if (candidateMatch) {
    const route = await dependencies.loadCandidatesRoute();
    if (method === "OPTIONS") return route.OPTIONS();
    if (method !== "GET") return methodNotAllowed("GET, OPTIONS");
    const channel = decodeURIComponent(candidateMatch[1]);
    return route.GET(request, { params: Promise.resolve({ channel }) });
  }

  return notFound(pathname);
}

function headersFromIncoming(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

export function incomingToFetchRequest(
  req: IncomingMessage,
  host: string,
  port: number,
  signal?: AbortSignal
): Request {
  const rawUrl = req.url || "/";
  const authority = req.headers.host || `${host}:${port}`;
  const url = new URL(rawUrl, `http://${authority}`);
  const method = (req.method || "GET").toUpperCase();
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers: headersFromIncoming(req),
    signal,
  };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  return new Request(url, init);
}

export async function writeFetchResponse(
  requestMethod: string,
  response: Response,
  res: ServerResponse
): Promise<void> {
  res.statusCode = response.status;
  res.statusMessage = response.statusText || res.statusMessage;

  const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const cookies = typeof getSetCookie === "function" ? getSetCookie.call(response.headers) : [];
  response.headers.forEach((value, name) => {
    if (name.toLowerCase() !== "set-cookie") res.setHeader(name, value);
  });
  if (cookies.length > 0) res.setHeader("set-cookie", cookies);

  if (requestMethod === "HEAD" || !response.body) {
    res.end();
    return;
  }

  const body = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
  body.on("error", (error) => {
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    if (!res.writableEnded) res.end(JSON.stringify({ error: "response_stream_error" }));
    console.error("[router-only] response stream error:", error);
  });
  res.on("close", () => {
    if (!res.writableEnded) body.destroy();
  });
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    res.once("finish", done);
    res.once("close", done);
    body.pipe(res);
  });
}

export function createRouterOnlyServer(
  dependencies: RouterOnlyDependencies = defaultRouterOnlyDependencies,
  options: { host?: string; port?: number } = {}
): http.Server {
  const host = options.host || process.env.HOST || "127.0.0.1";
  const port = options.port ?? Number(process.env.PORT || 20128);

  const server = http.createServer(async (req, res) => {
    const controller = new AbortController();
    req.once("aborted", () => controller.abort());
    res.once("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      const request = incomingToFetchRequest(req, host, port, controller.signal);
      const response = await dispatchRouterRequest(request, dependencies);
      await writeFetchResponse(request.method, response, res);
    } catch (error) {
      console.error("[router-only] request failed:", error);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      if (!res.writableEnded) {
        res.end(JSON.stringify({ error: { message: "Internal router error", type: "server_error" } }));
      }
    }
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 5_000;
  server.setTimeout(0);
  return server;
}

export type RouterOnlyWarmer = {
  name: string;
  run: () => Promise<unknown>;
};

export async function prewarmRouterOnlyRuntime(
  dependencies: RouterOnlyDependencies = defaultRouterOnlyDependencies,
  optionalWarmers?: RouterOnlyWarmer[]
): Promise<void> {
  const startedAt = Date.now();

  // The chat route is mandatory. Loading it before listen() moves tsx/source-module
  // cold-start cost out of the first real request and makes socket readiness honest.
  await dependencies.loadChatRoute();

  const warmers: RouterOnlyWarmer[] = optionalWarmers ?? [
    {
      name: "plugins",
      run: async () => {
        const { preloadPlugins } = await import("@/lib/plugins/hooks");
        await preloadPlugins();
      },
    },
    {
      name: "rate-limits",
      run: async () => {
        const { initializeRateLimits } = await import("../open-sse/services/rateLimitManager.ts");
        await initializeRateLimits();
      },
    },
    {
      name: "provider-credentials",
      run: async () => {
        const { PROVIDERS } = await import("../open-sse/config/constants.ts");
        void Reflect.ownKeys(PROVIDERS);
      },
    },
  ];

  const results = await Promise.allSettled(warmers.map((warmer) => warmer.run()));
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      console.warn(`[router-only] optional prewarm failed: ${warmers[index].name}: ${reason}`);
    }
  });
  console.log(`[router-only] prewarm complete in ${Date.now() - startedAt}ms`);
}

export async function startRouterOnlyServer(): Promise<http.Server> {
  // Load the same persisted DATA_DIR/server.env + .env layers used by the stock
  // Next launchers before resolving bind settings or importing provider/database
  // modules. This preserves encryption keys and API secrets exactly while keeping
  // the headless adapter small.
  const { bootstrapEnv } = await import("./build/bootstrap-env.mjs");
  Object.assign(process.env, bootstrapEnv({ quiet: true }));

  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || 20128);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${process.env.PORT}`);
  }

  // Reuse OmniRoute's existing production initialization, but collapse API_PORT
  // onto PORT so its bridge sees apiPort===dashboardPort and opens no side listener.
  process.env.API_PORT = String(port);
  process.env.OMNIROUTE_DISABLE_BACKGROUND_SERVICES = "true";
  process.env.OMNIROUTE_ENABLE_LIVE_WS = "0";

  // Tell OmniRoute's graceful-shutdown module that this custom HTTP server owns
  // signal handling. registerNodejs() will still publish the shared cleanup hook,
  // but it will not install a competing process.exit() listener.
  const shutdownGlobal = globalThis as typeof globalThis & {
    __omnirouteCustomServerOwnsShutdown?: boolean;
    __omnirouteRequestShutdown?: (signal: string) => Promise<void>;
  };
  shutdownGlobal.__omnirouteCustomServerOwnsShutdown = true;

  const { registerNodejs } = await import("@/instrumentation-node.ts");
  await registerNodejs();
  await prewarmRouterOnlyRuntime(defaultRouterOnlyDependencies);

  const server = createRouterOnlyServer(defaultRouterOnlyDependencies, { host, port });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  console.log(`[router-only] listening on http://${host}:${port}`);

  let closing = false;
  const close = async (signal: NodeJS.Signals) => {
    if (closing) return;
    closing = true;
    console.log(`[router-only] ${signal}; draining listener`);

    const listenerDrained = new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections?.();
    });
    const forcedDrain = new Promise<void>((resolve) => {
      setTimeout(() => {
        server.closeAllConnections?.();
        resolve();
      }, 10_000).unref();
    });

    await Promise.race([listenerDrained, forcedDrain]);
    await shutdownGlobal.__omnirouteRequestShutdown?.(signal);
    process.exit(0);
  };
  process.once("SIGTERM", () => void close("SIGTERM"));
  process.once("SIGINT", () => void close("SIGINT"));
  process.once("SIGHUP", () => void close("SIGHUP"));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startRouterOnlyServer().catch((error) => {
    console.error("[router-only] fatal startup error:", error);
    process.exit(1);
  });
}
