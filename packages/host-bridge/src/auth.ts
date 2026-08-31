import { createHash, randomBytes } from "node:crypto";

export type PairingCodeReason = "startup" | "paired" | "expired" | "unpaired";

export interface PairingCodeInfo {
  code: string;
  expiresAt: number;
}

export type PairResult =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; code: "BRIDGE_PAIRING_CODE_INVALID" | "BRIDGE_PAIRING_CODE_EXPIRED" };

export type BearerResult = { ok: true; tokenId: string } | { ok: false; code: "BRIDGE_TOKEN_EXPIRED" };

export interface PairingManagerOptions {
  now?: () => number;
  codeTtlMs?: number;
  tokenTtlMs?: number;
  entropyBytes?: number;
  onCode?: (code: string, reason: PairingCodeReason) => void;
}

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/**
 * Tab-local bearer tokens and single-use pairing codes. Only SHA-256 hashes of
 * secrets are retained; the plaintext code exists solely to be handed to the
 * terminal and pasted back by the author.
 */
export function createPairingManager(options: PairingManagerOptions = {}) {
  const now = options.now ?? Date.now;
  const codeTtlMs = options.codeTtlMs ?? 600_000;
  const tokenTtlMs = options.tokenTtlMs ?? 3_600_000;
  const entropyBytes = options.entropyBytes ?? 16;
  const onCode = options.onCode ?? (() => undefined);
  const tokens = new Map<string, { expiresAt: number }>();
  let current: PairingCodeInfo = { code: "", expiresAt: 0 };
  rotate("startup");

  function rotate(reason: PairingCodeReason): void {
    current = { code: randomBytes(entropyBytes).toString("base64url"), expiresAt: now() + codeTtlMs };
    onCode(current.code, reason);
  }

  function pair(input: string): PairResult {
    if (input !== current.code) return { ok: false, code: "BRIDGE_PAIRING_CODE_INVALID" };
    if (now() >= current.expiresAt) {
      rotate("expired");
      return { ok: false, code: "BRIDGE_PAIRING_CODE_EXPIRED" };
    }
    const token = randomBytes(32).toString("base64url");
    const expiresAt = now() + tokenTtlMs;
    tokens.set(sha256(token), { expiresAt });
    rotate("paired");
    return { ok: true, token, expiresAt };
  }

  function validateBearer(token: string): BearerResult {
    if (!token) return { ok: false, code: "BRIDGE_TOKEN_EXPIRED" };
    const hash = sha256(token);
    const entry = tokens.get(hash);
    if (!entry) return { ok: false, code: "BRIDGE_TOKEN_EXPIRED" };
    if (now() >= entry.expiresAt) {
      tokens.delete(hash);
      return { ok: false, code: "BRIDGE_TOKEN_EXPIRED" };
    }
    return { ok: true, tokenId: hash.slice(0, 8) };
  }

  function unpair(token: string): boolean {
    const hash = sha256(token);
    const entry = tokens.get(hash);
    if (!entry) return false;
    tokens.delete(hash);
    if (now() < entry.expiresAt) rotate("unpaired");
    return true;
  }

  function revokeAll(): void {
    tokens.clear();
  }

  function pruneExpired(): void {
    const time = now();
    for (const [hash, entry] of tokens) if (time >= entry.expiresAt) tokens.delete(hash);
  }

  return {
    currentCode(): PairingCodeInfo {
      if (now() >= current.expiresAt) rotate("expired");
      return current;
    },
    pair,
    validateBearer,
    unpair,
    revokeAll,
    activeTokenCount(): number {
      pruneExpired();
      return tokens.size;
    },
    tokenLogId: (token: string) => sha256(token).slice(0, 8),
    codeLogId: () => sha256(current.code).slice(0, 8),
  };
}

export type PairingManager = ReturnType<typeof createPairingManager>;
