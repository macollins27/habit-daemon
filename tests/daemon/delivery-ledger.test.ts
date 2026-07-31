// Duplicate-delivery protection, including the crash the old ordering could not
// even detect: process death AFTER the external post and BEFORE the local state
// update.

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import {
  abandonDelivery,
  beginDelivery,
  completeDelivery,
  deliveryKey,
  listInDoubtDeliveries,
  readDelivery,
  resolveInDoubtDelivery,
} from "../../src/daemon/delivery-ledger.js";

const SCHEMA = `
CREATE TABLE escalation_deliveries (
  delivery_key TEXT PRIMARY KEY, run_id TEXT NOT NULL, level INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('in_flight','delivered','abandoned')),
  message_id TEXT, worker TEXT, attempt_started_at INTEGER NOT NULL,
  completed_at INTEGER, resolved_note TEXT
);
`;

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SCHEMA);
});

/**
 * The production sequence, with an injectable crash point. `postFn` stands in
 * for the irreversible channel write.
 */
function attemptDelivery(
  database: Database.Database,
  runId: string,
  level: number,
  now: number,
  postFn: () => string,
  crashAfterPost = false,
): { outcome: string; posted: boolean } {
  const claim = beginDelivery(database, runId, level, now, "test-worker");
  if (claim !== "claimed") return { outcome: claim, posted: false };
  const messageId = postFn(); // <- irreversible
  if (crashAfterPost) {
    // Process dies here: the post happened, nothing local was written.
    return { outcome: "crashed", posted: true };
  }
  completeDelivery(database, runId, level, messageId, now);
  return { outcome: "delivered", posted: true };
}

describe("escalation delivery ledger", () => {
  it("gives each (run, level) pair its own identity", () => {
    expect(deliveryKey("run-a", 1)).toBe("run-a:1");
    expect(deliveryKey("run-a", 2)).not.toBe(deliveryKey("run-a", 1));
  });

  it("a clean delivery records the message id", () => {
    let posts = 0;
    const r = attemptDelivery(db, "run-1", 1, 1_000, () => { posts += 1; return "msg-1"; });
    expect(r.outcome).toBe("delivered");
    expect(posts).toBe(1);
    const row = readDelivery(db, "run-1", 1);
    expect(row?.state).toBe("delivered");
    expect(row?.message_id).toBe("msg-1");
  });

  it("never posts the same (run, level) twice", () => {
    let posts = 0;
    const post = () => { posts += 1; return `msg-${String(posts)}`; };
    attemptDelivery(db, "run-1", 1, 1_000, post);
    const second = attemptDelivery(db, "run-1", 1, 2_000, post);
    expect(second.outcome).toBe("already_delivered");
    expect(second.posted).toBe(false);
    expect(posts).toBe(1);
  });

  it("the next level is a different delivery and is allowed", () => {
    let posts = 0;
    const post = () => { posts += 1; return `msg-${String(posts)}`; };
    attemptDelivery(db, "run-1", 1, 1_000, post);
    const lvl2 = attemptDelivery(db, "run-1", 2, 2_000, post);
    expect(lvl2.outcome).toBe("delivered");
    expect(posts).toBe(2);
  });

  it("SIMULATED CRASH after the post: the retry does NOT post again", () => {
    let posts = 0;
    const post = () => { posts += 1; return `msg-${String(posts)}`; };

    const crashed = attemptDelivery(db, "run-1", 1, 1_000, post, true);
    expect(crashed.posted).toBe(true);   // the message really did go out
    expect(posts).toBe(1);

    // The scheduler comes back around. Under the OLD ordering this re-posted.
    const retry = attemptDelivery(db, "run-1", 1, 2_000, post);
    expect(retry.outcome).toBe("in_doubt");
    expect(retry.posted).toBe(false);
    expect(posts).toBe(1); // <- the whole point
  });

  it("an in-doubt delivery is discoverable rather than silently stuck", () => {
    attemptDelivery(db, "run-1", 1, 1_000, () => "msg-1", true);
    const stuck = listInDoubtDeliveries(db, 5_000);
    expect(stuck).toHaveLength(1);
    expect(stuck[0]?.run_id).toBe("run-1");
    expect(stuck[0]?.level).toBe(1);
  });

  it("an in-doubt delivery can be adjudicated either way, with a note", () => {
    attemptDelivery(db, "run-1", 1, 1_000, () => "msg-1", true);
    resolveInDoubtDelivery(db, "run-1", 1, true, "found in channel history", 3_000);
    const row = readDelivery(db, "run-1", 1);
    expect(row?.state).toBe("delivered");
    expect(row?.resolved_note).toBe("found in channel history");
    expect(listInDoubtDeliveries(db, 9_000)).toHaveLength(0);
  });

  it("a failure BEFORE the post releases the claim so a retry is clean", () => {
    let posts = 0;
    expect(beginDelivery(db, "run-1", 1, 1_000, "w1")).toBe("claimed");
    abandonDelivery(db, "run-1", 1, 1_100); // dispatch failed; nothing was sent
    const retry = attemptDelivery(db, "run-1", 1, 2_000, () => { posts += 1; return "msg-1"; });
    expect(retry.outcome).toBe("delivered");
    expect(posts).toBe(1);
  });

  it("two concurrent workers cannot both claim the same delivery", () => {
    expect(beginDelivery(db, "run-1", 1, 1_000, "worker-a")).toBe("claimed");
    expect(beginDelivery(db, "run-1", 1, 1_000, "worker-b")).toBe("in_doubt");
    expect(readDelivery(db, "run-1", 1)?.worker).toBe("worker-a");
  });

  it("abandon never releases a claim that already completed", () => {
    attemptDelivery(db, "run-1", 1, 1_000, () => "msg-1");
    abandonDelivery(db, "run-1", 1, 2_000);
    expect(readDelivery(db, "run-1", 1)?.state).toBe("delivered");
  });

  it("a missing table fails open rather than blocking every check-in", () => {
    const bare = new Database(":memory:");
    expect(beginDelivery(bare, "run-1", 1, 1_000, "w")).toBe("claimed");
    expect(listInDoubtDeliveries(bare, 1)).toEqual([]);
  });
});
