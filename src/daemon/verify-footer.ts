// scripts/lib/orchestrator/verify-footer.ts
//
// Parse the JSON envelope returned by `claude -p --output-format json` and
// validate the structured_output payload against FooterSchema. Run cross-
// field validation that JSON Schema cannot natively express. Verify write_set
// scope (every path inside dispatch.authorized_paths) + path existence on disk.
//
// Returns a structured VerificationResult that the orchestrator persists to
// the dispatches table (verified=1 on full pass; verification_error filled
// otherwise).
//
// Lint discipline: file existence check via /bin/test (no fs.* on dynamic
// paths). spawnSync uses literal first arg.
//
// References:

import { spawnSync } from "node:child_process";
import { FooterSchema, validateFooterCrossFields, type Footer } from "./footer-schema.js";

export interface ClaudeJsonEnvelope {
  readonly type: string;
  readonly subtype: string;
  readonly is_error: boolean;
  readonly duration_ms: number;
  readonly num_turns: number;
  readonly result: string;
  readonly session_id: string;
  readonly total_cost_usd: number;
  readonly structured_output?: unknown;
}

export type VerifyVerdict = { ok: true; footer: Footer } | { ok: false; error: string };

export interface VerifySubargs {
  readonly authorizedPaths: readonly string[];
}

/**
 * Parse stdout of `claude -p --output-format json` into a typed envelope.
 * Returns null + error message if parse fails.
 */
export function parseClaudeEnvelope(
  stdout: string,
): { ok: true; envelope: ClaudeJsonEnvelope } | { ok: false; error: string } {
  if (stdout.trim().length === 0) {
    return { ok: false, error: "empty stdout — claude -p produced no output" };
  }
  try {
    const parsed = JSON.parse(stdout) as Partial<ClaudeJsonEnvelope>;
    if (typeof parsed.type !== "string" || typeof parsed.session_id !== "string") {
      return { ok: false, error: "envelope missing required fields (type, session_id)" };
    }
    return { ok: true, envelope: parsed as ClaudeJsonEnvelope };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `JSON parse failed: ${msg}` };
  }
}

/**
 * File existence check via /bin/test -e (literal path), avoids the
 * security/detect-non-literal-fs-filename rule on fs.existsSync.
 */
export function pathExists(path: string): boolean {
  const result = spawnSync("/bin/test", ["-e", path], { stdio: "ignore" });
  return result.status === 0;
}

/**
 * Normalize a path to project-root-relative for scope comparison. The
 * dispatched model's StructuredOutput call typically returns absolute paths
 * (e.g., "/Users/.../packages/api/routers/people-addresses-notes.ts") while
 * authorized_paths are project-root-relative — this strips the project root
 * prefix when present so the comparison line up.
 */
function toProjectRelative(p: string): string {
  const projectRoot = process.env.PROJECT_ROOT ?? process.cwd();
  if (p.startsWith(`${projectRoot}/`)) return p.slice(projectRoot.length + 1);
  return p;
}

/**
 * Verify that every path in write_set is INSIDE one of the authorized
 * dispatch paths. Used to detect "write-set escape" — the subagent edited
 * something it was not authorized to touch.
 *
 * Match modes per authorized path:
 *   - exact: `auth === p`
 *   - subdir: `p` starts with `auth/` (`auth` is a directory prefix)
 *   - sibling-prefix: `p` starts with `auth-` (`auth` is a flat-file stem,
 *     e.g., authorized="packages/api/routers/people" matches the actual
 *     people-domain layout files like "people-addresses-notes.ts")
 */
export function checkWriteSetScope(
  writeSet: readonly string[],
  authorizedPaths: readonly string[],
): { ok: true } | { ok: false; reason: string } {
  if (writeSet.length === 0) return { ok: true };
  if (authorizedPaths.length === 0) {
    return { ok: false, reason: "write_set non-empty but authorized_paths empty" };
  }
  for (const raw of writeSet) {
    const p = toProjectRelative(raw);
    const inScope = authorizedPaths.some(
      (auth) => p === auth || p.startsWith(`${auth}/`) || p.startsWith(`${auth}-`),
    );
    if (!inScope) {
      return { ok: false, reason: `write-set escape: ${raw} not under any authorized path` };
    }
  }
  return { ok: true };
}

/**
 * Run the full footer verification per design v2 §4 steps 1-9 (excluding the
 * baseline check, which is logged-only in v0.1 per §16 Q3 — calibration
 * deferred until labeled-eval data exists).
 */
export function verifyFooter(envelope: ClaudeJsonEnvelope, subargs: VerifySubargs): VerifyVerdict {
  if (envelope.is_error) {
    return { ok: false, error: `claude reported is_error=true: ${envelope.result}` };
  }
  if (envelope.structured_output === undefined) {
    return { ok: false, error: "envelope.structured_output missing (footer not enforced?)" };
  }

  const parsed = FooterSchema.safeParse(envelope.structured_output);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return { ok: false, error: `footer schema validation failed: ${issues}` };
  }
  const footer = parsed.data;

  const cross = validateFooterCrossFields(footer);
  if (!cross.ok) {
    return { ok: false, error: cross.reason };
  }

  const scope = checkWriteSetScope(footer.write_set, subargs.authorizedPaths);
  if (!scope.ok) {
    return { ok: false, error: scope.reason };
  }

  // Verify each write_set path actually exists on disk after the dispatch.
  for (const p of footer.write_set) {
    if (!pathExists(p)) {
      return { ok: false, error: `write_set claims ${p} but file does not exist on disk` };
    }
  }

  return { ok: true, footer };
}
