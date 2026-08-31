import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { BRIDGE_DEFAULT_PORT, BRIDGE_LOOPBACK_HOST, pairRequestSchema } from "@writing-mcp/host-bridge-protocol";
import type { PairingManager } from "./auth.js";
import type { BridgeState } from "./state.js";

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export interface BridgeServerConfig {
  port?: number;
  host?: string;
  allowedOrigins?: string[];
  bodyLimitBytes?: number;
}

export interface BridgeServerOptions {
  auth: PairingManager;
  state: BridgeState;
  config: BridgeServerConfig;
  log?: (line: string) => void;
}

export interface BridgeServer {
  listen(): Promise<void>;
  port(): number;
  close(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
}

function okData(res: ServerResponse, data: unknown): void {
  sendJson(res, 200, { protocolVersion: 1, ok: true, data });
}

function fail(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { protocolVersion: 1, ok: false, error: { code, message } });
}

async function readBody(req: IncomingMessage, limitBytes: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > limitBytes) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Loopback security boundary for the bridge. Request order follows the frozen
 * auth matrix: loopback peer, Host header, Origin allowlist, then Bearer.
 * Diagnostic log lines carry hash-prefix identifiers only — never codes,
 * tokens, or absolute paths.
 */
export function createBridgeServer({ auth, state, config, log }: BridgeServerOptions): BridgeServer {
  const allowedOrigins = new Set(config.allowedOrigins ?? []);
  const bodyLimitBytes = config.bodyLimitBytes ?? 64 * 1024;
  const httpServer: Server = createServer((req, res) => {
    void handle(req, res).catch(() => fail(res, 500, "BRIDGE_SNAPSHOT_INVALID", "internal error"));
  });
  let actualPort = 0;

  const withCors = (req: IncomingMessage, res: ServerResponse): void => {
    const origin = req.headers.origin;
    if (origin !== undefined && allowedOrigins.has(origin)) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "Origin");
    }
  };

  const bearerToken = (req: IncomingMessage): string | null => {
    const header = req.headers.authorization;
    if (header === undefined || !header.startsWith("Bearer ") || header.length <= 7) return null;
    return header.slice(7);
  };

  const requireBearer = (req: IncomingMessage, res: ServerResponse): boolean => {
    const token = bearerToken(req);
    const verdict = auth.validateBearer(token ?? "");
    if (!verdict.ok) {
      fail(res, 401, "BRIDGE_TOKEN_EXPIRED", "present a valid bearer token");
      return false;
    }
    return true;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      return fail(res, 403, "BRIDGE_HOST_DENIED", "loopback peers only");
    }
    const port = actualPort;
    const hostHeader = req.headers.host ?? "";
    if (hostHeader !== `127.0.0.1:${port}` && hostHeader !== `localhost:${port}` && hostHeader !== `[::1]:${port}`) {
      return fail(res, 403, "BRIDGE_HOST_DENIED", "host header mismatch");
    }
    const pathname = (req.url ?? "/").split("?")[0];
    const origin = req.headers.origin;
    const originAllowed = origin !== undefined && allowedOrigins.has(origin);
    if (req.method === "OPTIONS") {
      if (!originAllowed) return fail(res, 403, "BRIDGE_ORIGIN_DENIED", "origin not allowed");
      res.statusCode = 204;
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("access-control-allow-headers", "Authorization, Content-Type");
      res.setHeader("access-control-max-age", "600");
      res.setHeader("vary", "Origin");
      if ((req.headers["access-control-request-private-network"] ?? "") === "true") {
        res.setHeader("access-control-allow-private-network", "true");
      }
      res.end();
      return;
    }
    if (origin !== undefined && !originAllowed) return fail(res, 403, "BRIDGE_ORIGIN_DENIED", "origin not allowed");
    if (origin === undefined && pathname !== "/v1/health") return fail(res, 403, "BRIDGE_ORIGIN_DENIED", "origin required");
    withCors(req, res);

    if (req.method === "GET" && pathname === "/v1/health") {
      return okData(res, { processState: state.processState, requiresPairing: auth.activeTokenCount() === 0 });
    }
    if (req.method === "POST" && pathname === "/v1/pair") {
      const body = await readBody(req, bodyLimitBytes);
      if (body === null) return fail(res, 413, "BRIDGE_REQUEST_TOO_LARGE", "request body exceeds the limit");
      let parsedBody: unknown = {};
      try {
        parsedBody = body.length === 0 ? {} : JSON.parse(body);
      } catch {
        return fail(res, 400, "BRIDGE_PAIRING_CODE_INVALID", "body is not valid JSON");
      }
      const parsed = pairRequestSchema.safeParse(parsedBody);
      if (!parsed.success) return fail(res, 400, "BRIDGE_PAIRING_CODE_INVALID", "pairing code missing or malformed");
      const result = auth.pair(parsed.data.pairingCode);
      if (!result.ok) {
        log?.(`pair failed code=${result.code}`);
        return fail(res, 401, result.code, result.code === "BRIDGE_PAIRING_CODE_EXPIRED" ? "pairing code expired" : "unknown pairing code");
      }
      log?.(`pair ok tokenId=${auth.tokenLogId(result.token)}`);
      return okData(res, { token: result.token, tokenExpiresInSeconds: Math.round((result.expiresAt - Date.now()) / 1000) });
    }
    if (req.method === "POST" && pathname === "/v1/unpair") {
      if (!requireBearer(req, res)) return;
      const token = bearerToken(req) ?? "";
      const revoked = auth.unpair(token);
      log?.(`unpair tokenId=${auth.tokenLogId(token)} revoked=${revoked}`);
      return okData(res, { revoked });
    }
    if (pathname.startsWith("/v1/") || pathname.startsWith("/v1")) {
      if (!requireBearer(req, res)) return;
    }
    sendJson(res, 404, { error: "not_found" });
  };

  return {
    listen(): Promise<void> {
      return new Promise((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        httpServer.once("error", onError);
        httpServer.listen(config.port ?? BRIDGE_DEFAULT_PORT, config.host ?? BRIDGE_LOOPBACK_HOST, () => {
          httpServer.removeListener("error", onError);
          actualPort = (httpServer.address() as AddressInfo).port;
          resolve();
        });
      });
    },
    port(): number {
      return actualPort;
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        if (httpServer.listening) httpServer.close(() => resolve());
        else resolve();
      });
    },
  };
};
