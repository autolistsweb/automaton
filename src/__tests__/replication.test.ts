/**
 * Tests for Sub-phase 0.6: Replication Safety
 *
 * Validates child account id checking, spawn cleanup on failure,
 * and prevention of spawning with invalid account ids.
 *
 * Updated for Phase 3.1: spawnChild now uses ConwayClient interface
 * directly instead of raw fetch-based execInSandbox/writeInSandbox.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnChild } from "../replication/spawn.js";
import { isValidAccountId } from "../identity/account.js";
import { SandboxCleanup } from "../replication/cleanup.js";
import { ChildLifecycle } from "../replication/lifecycle.js";
import { pruneDeadChildren } from "../replication/lineage.js";
import {
  MockConwayClient,
  createTestDb,
  createTestIdentity,
} from "./mocks.js";
import type { AutomatonDatabase, GenesisConfig } from "../types.js";
import { MIGRATION_V7 } from "../state/schema.js";
import { lifecycleInsertEvent } from "../state/database.js";

// Mock fs for constitution propagation
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: vi.fn(() => { throw new Error("file not found"); }),
      existsSync: actual.existsSync,
      mkdirSync: actual.mkdirSync,
      mkdtempSync: actual.mkdtempSync,
    },
    readFileSync: vi.fn(() => { throw new Error("file not found"); }),
    existsSync: actual.existsSync,
    mkdirSync: actual.mkdirSync,
    mkdtempSync: actual.mkdtempSync,
  };
});

// ─── isValidAccountId ───────────────────────────────────────

describe("isValidAccountId", () => {
  it("accepts a 32-hex-char account id", () => {
    expect(isValidAccountId("acct_abcdef1234567890abcdef1234567890")).toBe(true);
  });

  it("accepts the minimum 16-hex-char account id", () => {
    expect(isValidAccountId("acct_abcdef1234567890")).toBe(true);
  });

  it("accepts the maximum 64-hex-char account id", () => {
    expect(isValidAccountId("acct_" + "ab".repeat(32))).toBe(true);
  });

  it("rejects uppercase hex characters", () => {
    expect(isValidAccountId("acct_ABCDEF1234567890")).toBe(false);
  });

  it("rejects account ids without the acct_ prefix", () => {
    expect(isValidAccountId("abcdef1234567890abcdef1234567890")).toBe(false);
  });

  it("rejects account ids that are too short", () => {
    expect(isValidAccountId("acct_abcdef")).toBe(false);
  });

  it("rejects account ids that are too long", () => {
    expect(isValidAccountId("acct_" + "a".repeat(65))).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidAccountId("")).toBe(false);
  });

  it("rejects non-hex characters", () => {
    expect(isValidAccountId("acct_GGGGGG1234567890abcdef1234567890")).toBe(false);
  });

  it("rejects the bare prefix", () => {
    expect(isValidAccountId("acct_")).toBe(false);
  });
});

// ─── spawnChild ───────────────────────────────────────────────

describe("spawnChild", () => {
  let conway: MockConwayClient;
  let db: AutomatonDatabase;
  const identity = createTestIdentity();
  const genesis: GenesisConfig = {
    name: "test-child",
    genesisPrompt: "You are a test child automaton.",
    creatorMessage: "Hello child!",
    creatorAccountId: identity.accountId,
    parentAccountId: identity.accountId,
  };

  const validAccountId = "acct_deadbeefdeadbeefdeadbeef";
  const malformedAccountId = "acct_ZZZZZZZZZZZZZZZZ";

  beforeEach(() => {
    conway = new MockConwayClient();
    db = createTestDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stores the account id returned by init on the child record", async () => {
    // Mock exec to return a valid account id on init
    vi.spyOn(conway, "exec").mockImplementation(async (command: string) => {
      if (command.includes("--init")) {
        return { stdout: `Account initialized: ${validAccountId}`, stderr: "", exitCode: 0 };
      }
      return { stdout: "ok", stderr: "", exitCode: 0 };
    });

    const child = await spawnChild(conway, identity, db, genesis);

    expect(child.accountId).toBe(validAccountId);
    expect(child.status).toBe("spawning");
  });

  it("throws on malformed account id from init", async () => {
    vi.spyOn(conway, "exec").mockImplementation(async (command: string) => {
      if (command.includes("--init")) {
        return { stdout: `Account: ${malformedAccountId}`, stderr: "", exitCode: 0 };
      }
      return { stdout: "ok", stderr: "", exitCode: 0 };
    });

    await expect(spawnChild(conway, identity, db, genesis))
      .rejects.toThrow("Child account id invalid");
  });

  it("throws when init returns no account id", async () => {
    vi.spyOn(conway, "exec").mockImplementation(async (command: string) => {
      if (command.includes("--init")) {
        return { stdout: "initialization complete, no account id", stderr: "", exitCode: 0 };
      }
      return { stdout: "ok", stderr: "", exitCode: 0 };
    });

    await expect(spawnChild(conway, identity, db, genesis))
      .rejects.toThrow("Child account id invalid");
  });

  it("propagates error on exec failure without calling deleteSandbox", async () => {
    const deleteSpy = vi.spyOn(conway, "deleteSandbox");

    // Make the first exec (apt-get install) fail
    vi.spyOn(conway, "exec").mockRejectedValue(new Error("Install failed"));

    await expect(spawnChild(conway, identity, db, genesis))
      .rejects.toThrow();

    // Sandbox deletion is disabled — should not attempt cleanup
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("propagates error on account id validation failure without calling deleteSandbox", async () => {
    const deleteSpy = vi.spyOn(conway, "deleteSandbox");

    vi.spyOn(conway, "exec").mockImplementation(async (command: string) => {
      if (command.includes("--init")) {
        return { stdout: `Account: ${malformedAccountId}`, stderr: "", exitCode: 0 };
      }
      return { stdout: "ok", stderr: "", exitCode: 0 };
    });

    await expect(spawnChild(conway, identity, db, genesis))
      .rejects.toThrow("Child account id invalid");

    // Sandbox deletion is disabled — should not attempt cleanup
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("does not mask original error if deleteSandbox also throws", async () => {
    vi.spyOn(conway, "deleteSandbox").mockRejectedValue(new Error("delete also failed"));

    // Make exec fail
    vi.spyOn(conway, "exec").mockRejectedValue(new Error("Install failed"));

    // Original error should propagate, not the deleteSandbox error
    await expect(spawnChild(conway, identity, db, genesis))
      .rejects.toThrow(/Install failed/);
  });

  it("does not call deleteSandbox if createSandbox itself fails", async () => {
    const deleteSpy = vi.spyOn(conway, "deleteSandbox");
    vi.spyOn(conway, "createSandbox").mockRejectedValue(new Error("Sandbox creation failed"));

    await expect(spawnChild(conway, identity, db, genesis))
      .rejects.toThrow("Sandbox creation failed");

    expect(deleteSpy).not.toHaveBeenCalled();
  });
});

// ─── SandboxCleanup ──────────────────────────────────────────

describe("SandboxCleanup", () => {
  let conway: MockConwayClient;
  let db: AutomatonDatabase;
  let lifecycle: ChildLifecycle;

  beforeEach(() => {
    conway = new MockConwayClient();
    db = createTestDb();
    // Apply lifecycle events migration
    db.raw.exec(MIGRATION_V7);
    lifecycle = new ChildLifecycle(db.raw);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Seeds a child without ChildLifecycle.initChild, which still writes the
  // legacy `address`/`chain_type` columns (see lifecycle.ts report).
  function seedChild(childId: string, sandboxId: string): void {
    db.raw
      .prepare(
        `INSERT INTO children (id, name, account_id, sandbox_id, genesis_prompt, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'requested', datetime('now'))`,
      )
      .run(childId, "test-child", "acct_1234567890abcdef1234", sandboxId, "test prompt");
    lifecycleInsertEvent(db.raw, {
      id: `evt-${childId}`,
      childId,
      fromState: "none",
      toState: "requested",
      reason: "child created",
      metadata: "{}",
      createdAt: new Date().toISOString(),
    });
  }

  it("transitions to cleaned_up even though sandbox deletion is disabled", async () => {
    // Create a child and transition to stopped
    seedChild("child-1", "sandbox-1");
    lifecycle.transition("child-1", "sandbox_created", "created");
    lifecycle.transition("child-1", "runtime_ready", "ready");
    lifecycle.transition("child-1", "account_verified", "verified");
    lifecycle.transition("child-1", "funded", "funded");
    lifecycle.transition("child-1", "starting", "starting");
    lifecycle.transition("child-1", "healthy", "healthy");
    lifecycle.transition("child-1", "stopped", "stopped");

    const cleanup = new SandboxCleanup(conway, lifecycle, db.raw);
    await cleanup.cleanup("child-1");

    // Sandbox deletion is disabled, but cleanup still transitions state
    const state = lifecycle.getCurrentState("child-1");
    expect(state).toBe("cleaned_up");
  });

  it("transitions to cleaned_up when sandbox deletion succeeds", async () => {
    seedChild("child-2", "sandbox-2");
    lifecycle.transition("child-2", "sandbox_created", "created");
    lifecycle.transition("child-2", "runtime_ready", "ready");
    lifecycle.transition("child-2", "account_verified", "verified");
    lifecycle.transition("child-2", "funded", "funded");
    lifecycle.transition("child-2", "starting", "starting");
    lifecycle.transition("child-2", "healthy", "healthy");
    lifecycle.transition("child-2", "stopped", "stopped");

    const cleanup = new SandboxCleanup(conway, lifecycle, db.raw);
    await cleanup.cleanup("child-2");

    const state = lifecycle.getCurrentState("child-2");
    expect(state).toBe("cleaned_up");
  });
});

// ─── pruneDeadChildren ──────────────────────────────────────

describe("pruneDeadChildren", () => {
  let db: AutomatonDatabase;
  let conway: MockConwayClient;

  beforeEach(() => {
    db = createTestDb();
    db.raw.exec(MIGRATION_V7);
    conway = new MockConwayClient();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function insertChild(id: string, name: string, status: string, createdAt: string): void {
    db.raw.prepare(
      `INSERT INTO children (id, name, account_id, sandbox_id, genesis_prompt, status, created_at)
       VALUES (?, ?, 'acct_1234567890abcdef1234', 'sandbox-${id}', 'prompt', ?, ?)`,
    ).run(id, name, status, createdAt);
  }

  it("attempts sandbox cleanup for children with dead status", async () => {
    // Insert 7 dead children (exceeds keepLast=5, so 2 should be pruned)
    for (let i = 0; i < 7; i++) {
      insertChild(`dead-${i}`, `child-${i}`, "dead", `2020-01-0${i + 1} 00:00:00`);
    }

    // Create a mock cleanup that tracks calls
    const cleanupCalls: string[] = [];
    const mockCleanup = {
      cleanup: vi.fn(async (childId: string) => {
        cleanupCalls.push(childId);
      }),
    } as any;

    const removed = await pruneDeadChildren(db, mockCleanup, 5);

    // 2 oldest should be removed (dead-0 and dead-1)
    expect(removed).toBe(2);
    // cleanup.cleanup should have been called for "dead" children
    expect(cleanupCalls).toContain("dead-0");
    expect(cleanupCalls).toContain("dead-1");
  });
});
