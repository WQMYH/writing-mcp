import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { createPairingManager } from "../packages/host-bridge/src/auth.js";

let clock = 1_000_000;
const now = () => clock;
const advance = (ms: number) => { clock += ms; };

function create(overrides: Record<string, unknown> = {}) {
  const printed: Array<{ code: string; reason: string }> = [];
  const manager = createPairingManager({ now, onCode: (code, reason) => printed.push({ code, reason }), ...overrides });
  return { manager, printed };
}

describe("host bridge pairing and bearer tokens (HB-M1)", () => {
  test("prints an initial code with at least 128 bits of entropy", () => {
    const { manager, printed } = create();
    expect(printed).toHaveLength(1);
    expect(printed[0].reason).toBe("startup");
    expect(Buffer.from(manager.currentCode().code, "base64url").length).toBeGreaterThanOrEqual(16);
  });

  test("pairs with the current code and issues a 60-minute tab-local token", () => {
    const { manager, printed } = create();
    expect(manager.pair("not-the-code")).toEqual({ ok: false, code: "BRIDGE_PAIRING_CODE_INVALID" });
    const result = manager.pair(manager.currentCode().code);
    if (!result.ok) throw new Error("pair should succeed");
    expect(result.token.length).toBeGreaterThanOrEqual(32);
    expect(result.expiresAt - clock).toBe(3_600_000);
    expect(manager.validateBearer(result.token)).toEqual({ ok: true, tokenId: createHash("sha256").update(result.token).digest("hex").slice(0, 8) });
    expect(printed.at(-1)?.reason).toBe("paired");
  });

  test("codes are single-use and rotate after a successful pair", () => {
    const { manager, printed } = create();
    const first = manager.currentCode().code;
    const result = manager.pair(first);
    if (!result.ok) throw new Error("pair should succeed");
    expect(manager.pair(first)).toEqual({ ok: false, code: "BRIDGE_PAIRING_CODE_INVALID" });
    expect(manager.currentCode().code).not.toBe(first);
    expect(printed).toHaveLength(2);
  });

  test("an expired code is rejected as expired and immediately rotated", () => {
    const { manager, printed } = create();
    const first = manager.currentCode().code;
    advance(600_001);
    expect(manager.pair(first)).toEqual({ ok: false, code: "BRIDGE_PAIRING_CODE_EXPIRED" });
    expect(manager.currentCode().code).not.toBe(first);
    expect(printed).toHaveLength(2);
    expect(manager.pair(manager.currentCode().code).ok).toBe(true);
  });

  test("expired bearers fail closed one millisecond after their deadline", () => {
    const { manager } = create();
    const result = manager.pair(manager.currentCode().code);
    if (!result.ok) throw new Error("pair should succeed");
    advance(3_599_999);
    expect(manager.validateBearer(result.token).ok).toBe(true);
    advance(1);
    expect(manager.validateBearer(result.token)).toEqual({ ok: false, code: "BRIDGE_TOKEN_EXPIRED" });
    expect(manager.activeTokenCount()).toBe(0);
  });

  test("two tabs pair independently and both tokens stay valid", () => {
    const { manager } = create();
    const first = manager.pair(manager.currentCode().code);
    if (!first.ok) throw new Error("pair should succeed");
    const second = manager.pair(manager.currentCode().code);
    if (!second.ok) throw new Error("pair should succeed");
    expect(first.token).not.toBe(second.token);
    expect(manager.activeTokenCount()).toBe(2);
    expect(manager.validateBearer(first.token).ok).toBe(true);
    expect(manager.validateBearer(second.token).ok).toBe(true);
  });

  test("unpair revokes only the requesting token and rotates the code", () => {
    const { manager } = create();
    const first = manager.pair(manager.currentCode().code);
    const second = manager.pair(manager.currentCode().code);
    if (!first.ok || !second.ok) throw new Error("pairs should succeed");
    const codeBefore = manager.currentCode().code;
    expect(manager.unpair(first.token)).toBe(true);
    expect(manager.validateBearer(first.token).ok).toBe(false);
    expect(manager.validateBearer(second.token).ok).toBe(true);
    expect(manager.currentCode().code).not.toBe(codeBefore);
    expect(manager.unpair(first.token)).toBe(false);
  });

  test("revoking the plugin invalidates every token", () => {
    const { manager } = create();
    const first = manager.pair(manager.currentCode().code);
    const second = manager.pair(manager.currentCode().code);
    if (!first.ok || !second.ok) throw new Error("pairs should succeed");
    manager.revokeAll();
    expect(manager.activeTokenCount()).toBe(0);
    expect(manager.validateBearer(first.token).ok).toBe(false);
    expect(manager.validateBearer(second.token).ok).toBe(false);
  });

  test("missing and malformed bearers are rejected with the frozen token error", () => {
    const { manager } = create();
    expect(manager.validateBearer("")).toEqual({ ok: false, code: "BRIDGE_TOKEN_EXPIRED" });
    expect(manager.validateBearer("garbage")).toEqual({ ok: false, code: "BRIDGE_TOKEN_EXPIRED" });
  });

  test("log identifiers are hash prefixes, never raw secrets", () => {
    const { manager } = create();
    const result = manager.pair(manager.currentCode().code);
    if (!result.ok) throw new Error("pair should succeed");
    const logId = manager.tokenLogId(result.token);
    expect(logId).toBe(createHash("sha256").update(result.token).digest("hex").slice(0, 8));
    expect(logId).not.toContain(result.token);
    expect(manager.codeLogId()).not.toContain(manager.currentCode().code);
  });
});
