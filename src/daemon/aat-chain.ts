/**
 * Forked from Property-Linkware-v2.1/scripts/lib/orchestrator/aat-chain.ts
 * at PLW commit v1 (26c8c049). Diverges from this point. Do not auto-sync.
 */
// scripts/lib/orchestrator/aat-chain.ts
//
// IETF draft-sharif-agent-audit-trail-style hash-chain primitives.
//
// Each event in a session is canonicalized via JSON Canonicalization Scheme
// (RFC 8785 — sort keys lexicographically, use deterministic number formatting),
// hashed with SHA-256, and chained: prev_hash = SHA-256(JCS(event[N-1]) ‖ hash[N-2]).
// The chain head is the latest record's hash; verifying re-computes from seq=0.
//
// Trust levels (L0-L4) per draft-sharif:
//   L0 — unverified claim (e.g., agent self-report without artifact)
//   L1 — claim + filesystem artifact path (we can `cat` it)
//   L2 — claim + git commit SHA (independently reproducible)
//   L3 — claim + cryptographic signature
//   L4 — claim + signature + third-party attestation
//
// plw v0.1 emits L1 + L2 records; L3+ deferred to a future phase.
//
// References:
//   - https://datatracker.ietf.org/doc/draft-sharif-agent-audit-trail/
//   - https://datatracker.ietf.org/doc/html/rfc8785
//   - docs/plans/master-orchestrator-design-v2.md §7 (anti-fabrication mechanisms)

import { createHash } from "node:crypto";

export type TrustLevel = "L0" | "L1" | "L2" | "L3" | "L4";

export interface AatRecord {
  readonly seq: number;
  readonly eventJson: string;
  readonly prevHash: string | null;
  readonly hash: string;
  readonly trustLevel: TrustLevel;
  readonly writtenIso: string;
}

export interface AatRecordInput {
  readonly seq: number;
  readonly event: unknown;
  readonly prevHash: string | null;
  readonly trustLevel: TrustLevel;
}

/**
 * Canonicalize a value per RFC 8785 (JCS). Sorts object keys lexicographically;
 * arrays preserve order; numbers in IEEE 754 double; strings UTF-8.
 *
 * Note: this is a minimal implementation sufficient for plw's event payloads
 * (no NaN/Infinity, no BigInt, no circular references). The official `canonicalize`
 * npm package would be the production-grade choice; we hand-roll here to keep
 * the v0.1 dependency surface flat.
 */
export function jsonCanonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`jsonCanonicalize: non-finite number ${String(value)}`);
    }
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(jsonCanonicalize).join(",") + "]";
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => {
      if (a < b) return -1;
      if (a > b) return 1;
      return 0;
    });
    const parts = entries.map(([k, v]) => JSON.stringify(k) + ":" + jsonCanonicalize(v));
    return "{" + parts.join(",") + "}";
  }
  throw new Error(`jsonCanonicalize: unsupported type ${typeof value}`);
}

/**
 * Compute the SHA-256 hash for an AAT chain record.
 * hash = SHA-256(JCS(event) || (prevHash ?? ""))
 */
export function computeHash(eventJson: string, prevHash: string | null): string {
  const h = createHash("sha256");
  h.update(eventJson, "utf8");
  if (prevHash !== null) h.update(prevHash, "utf8");
  return h.digest("hex");
}

/**
 * Build an AAT record from an event + the prior record's hash.
 */
export function buildRecord(input: AatRecordInput): AatRecord {
  const eventJson = jsonCanonicalize(input.event);
  const hash = computeHash(eventJson, input.prevHash);
  return {
    seq: input.seq,
    eventJson,
    prevHash: input.prevHash,
    hash,
    trustLevel: input.trustLevel,
    writtenIso: new Date().toISOString(),
  };
}

export interface ChainVerifyResult {
  readonly ok: boolean;
  readonly checkedRecords: number;
  readonly firstFailureSeq: number | null;
  readonly firstFailureReason: string | null;
}

/**
 * Verify a chain of records: each hash must equal SHA-256(JCS(event) || prevHash),
 * and prevHash must equal the prior record's hash.
 */
export function verifyChain(records: readonly AatRecord[]): ChainVerifyResult {
  let priorHash: string | null = null;
  let processed = 0;
  for (const [i, r] of records.entries()) {
    if (r.seq !== i) {
      return {
        ok: false,
        checkedRecords: processed,
        firstFailureSeq: i,
        firstFailureReason: `seq mismatch: expected ${i}, got ${r.seq}`,
      };
    }
    if (r.prevHash !== priorHash) {
      return {
        ok: false,
        checkedRecords: processed,
        firstFailureSeq: i,
        firstFailureReason: `prev_hash mismatch at seq ${i}`,
      };
    }
    const expected = computeHash(r.eventJson, r.prevHash);
    if (r.hash !== expected) {
      return {
        ok: false,
        checkedRecords: processed,
        firstFailureSeq: i,
        firstFailureReason: `hash mismatch at seq ${i}: expected ${expected}, got ${r.hash}`,
      };
    }
    priorHash = r.hash;
    processed++;
  }
  return {
    ok: true,
    checkedRecords: records.length,
    firstFailureSeq: null,
    firstFailureReason: null,
  };
}
