import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SimpleAgentTracker, SimpleFundingProtocol } from "../../orchestration/simple-tracker.js";
import { createInMemoryDb } from "./test-db.js";
import type BetterSqlite3 from "better-sqlite3";

function createMockAutomatonDb(db: BetterSqlite3.Database) {
  return {
    raw: db,
    getChildren: () => {
      return db.prepare("SELECT id, name, account_id AS accountId, sandbox_id AS sandboxId, genesis_prompt AS genesisPrompt, creator_message AS creatorMessage, funded_amount_cents AS fundedAmountCents, status, created_at AS createdAt, last_checked AS lastChecked FROM children").all();
    },
    updateChildStatus: (id: string, status: string) => {
      db.prepare("UPDATE children SET status = ? WHERE id = ?").run(status, id);
    },
    insertChild: (child: any) => {
      db.prepare("INSERT INTO children (id, name, account_id, sandbox_id, genesis_prompt, creator_message, funded_amount_cents, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(child.id, child.name, child.accountId, child.sandboxId, child.genesisPrompt, child.creatorMessage, child.fundedAmountCents, child.status, child.createdAt);
    },
  } as any;
}

function insertChild(
  db: BetterSqlite3.Database,
  id: string,
  name: string,
  accountId: string,
  status = "running",
  role = "generalist",
) {
  db.prepare(
    "INSERT INTO children (id, name, account_id, sandbox_id, genesis_prompt, funded_amount_cents, status, created_at, role) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, name, accountId, "sb-1", "test", 0, status, new Date().toISOString(), role);
}

describe("orchestration/simple-tracker", () => {
  let db: BetterSqlite3.Database;
  let mockDb: ReturnType<typeof createMockAutomatonDb>;
  let tracker: SimpleAgentTracker;

  beforeEach(() => {
    db = createInMemoryDb();
    mockDb = createMockAutomatonDb(db);
    tracker = new SimpleAgentTracker(mockDb);
  });

  afterEach(() => {
    db.close();
  });

  describe("getIdle", () => {
    it("returns children with running status not assigned to active tasks", () => {
      insertChild(db, "c1", "Alice", "acct_a11ce0000000000000000000", "running");

      const idle = tracker.getIdle();

      expect(idle).toHaveLength(1);
      expect(idle[0].address).toBe("acct_a11ce0000000000000000000");
      expect(idle[0].name).toBe("Alice");
    });

    it("returns children with healthy status not assigned to active tasks", () => {
      insertChild(db, "c1", "Bob", "acct_b0b0b0b00000000000000000", "healthy");

      const idle = tracker.getIdle();

      expect(idle).toHaveLength(1);
      expect(idle[0].address).toBe("acct_b0b0b0b00000000000000000");
      expect(idle[0].status).toBe("healthy");
    });

    it("excludes children assigned to active tasks", () => {
      insertChild(db, "c1", "Alice", "acct_c11d00000000000000000000", "running");
      insertChild(db, "c2", "Bob", "acct_c22d00000000000000000000", "running");

      db.prepare("INSERT INTO goals (id, title, description, status, created_at) VALUES (?, ?, ?, ?, ?)").run("g1", "Goal", "Desc", "active", new Date().toISOString());
      db.prepare(
        "INSERT INTO task_graph (id, goal_id, title, description, status, assigned_to, agent_role, priority, dependencies, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("t1", "g1", "Task", "Desc", "assigned", "acct_c11d00000000000000000000", "generalist", 50, "[]", new Date().toISOString());

      const idle = tracker.getIdle();

      expect(idle).toHaveLength(1);
      expect(idle[0].address).toBe("acct_c22d00000000000000000000");
    });

    it("returns empty when no idle children exist", () => {
      const idle = tracker.getIdle();
      expect(idle).toHaveLength(0);
    });

    it("reads role from DB rather than hardcoding generalist", () => {
      insertChild(db, "c1", "Specialist", "acct_5pec00000000000000000000", "running", "researcher");

      const idle = tracker.getIdle();

      expect(idle).toHaveLength(1);
      expect(idle[0].role).toBe("researcher");
    });

    it("excludes children with dead status", () => {
      insertChild(db, "c1", "Dead", "acct_dead00000000000000000000", "dead");

      const idle = tracker.getIdle();

      expect(idle).toHaveLength(0);
    });

    it("excludes children with sleeping status", () => {
      insertChild(db, "c1", "Sleeping", "acct_51ee00000000000000000000", "sleeping");

      const idle = tracker.getIdle();

      expect(idle).toHaveLength(0);
    });

    it("excludes children assigned to running tasks", () => {
      insertChild(db, "c1", "Busy", "acct_b0b000000000000000000000", "running");

      db.prepare("INSERT INTO goals (id, title, description, status, created_at) VALUES (?, ?, ?, ?, ?)").run("g1", "Goal", "Desc", "active", new Date().toISOString());
      db.prepare(
        "INSERT INTO task_graph (id, goal_id, title, description, status, assigned_to, agent_role, priority, dependencies, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("t2", "g1", "Active Task", "Desc", "running", "acct_b0b000000000000000000000", "generalist", 50, "[]", new Date().toISOString());

      const idle = tracker.getIdle();

      expect(idle).toHaveLength(0);
    });
  });

  describe("getBestForTask", () => {
    it("returns the first idle agent", () => {
      insertChild(db, "c1", "First", "acct_f1f100000000000000000000", "running");
      insertChild(db, "c2", "Second", "acct_5e5e00000000000000000000", "running");

      const best = tracker.getBestForTask("generalist");

      expect(best).not.toBeNull();
      expect(best?.address).toBe("acct_f1f100000000000000000000");
      expect(best?.name).toBe("First");
    });

    it("returns null when no idle agents are available", () => {
      const best = tracker.getBestForTask("generalist");
      expect(best).toBeNull();
    });
  });

  describe("updateStatus", () => {
    it("updates the child status in the DB", () => {
      insertChild(db, "c1", "Agent", "acct_a6e700000000000000000000", "running");

      tracker.updateStatus("acct_a6e700000000000000000000", "healthy");

      const row = db.prepare("SELECT status FROM children WHERE id = ?").get("c1") as { status: string } | undefined;
      expect(row?.status).toBe("healthy");
    });

    it("does nothing for an unknown account id", () => {
      insertChild(db, "c1", "Agent", "acct_a6e700000000000000000000", "running");

      expect(() => tracker.updateStatus("acct_222222222222222222222222", "healthy")).not.toThrow();

      const row = db.prepare("SELECT status FROM children WHERE id = ?").get("c1") as { status: string } | undefined;
      expect(row?.status).toBe("running");
    });
  });

  describe("register", () => {
    it("inserts a new child record into the DB", () => {
      tracker.register({
        address: "acct_333333333333333333333333",
        name: "NewAgent",
        role: "analyst",
        sandboxId: "sb-42",
      });

      const children = mockDb.getChildren() as any[];
      expect(children).toHaveLength(1);
      expect(children[0].accountId).toBe("acct_333333333333333333333333");
    });

    it("stores the role in the genesis prompt", () => {
      tracker.register({
        address: "acct_444444444444444444444444",
        name: "RoleAgent",
        role: "security-expert",
        sandboxId: "sb-99",
      });

      const row = db.prepare("SELECT genesis_prompt FROM children WHERE account_id = ?").get("acct_444444444444444444444444") as
        | { genesis_prompt: string }
        | undefined;
      expect(row?.genesis_prompt).toContain("security-expert");
    });
  });
});

describe("orchestration/SimpleFundingProtocol", () => {
  let fundingDb: BetterSqlite3.Database;

  beforeEach(() => {
    fundingDb = createInMemoryDb();
    // Insert a child for funding tests
    fundingDb.prepare(
      "INSERT INTO children (id, name, account_id, sandbox_id, genesis_prompt, funded_amount_cents, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("c1", "child-1", "acct_111111111111111111111111", "sb-1", "test", 0, "running", new Date().toISOString());
  });

  afterEach(() => {
    fundingDb.close();
  });

  function makeMockDb(raw: BetterSqlite3.Database) {
    return { raw } as any;
  }

  it("fundChild calls transferCredits with the correct amount", async () => {
    const mockConway = {
      transferCredits: vi.fn().mockResolvedValue({ status: "ok", amountCents: 100 }),
      getCreditsBalance: vi.fn().mockResolvedValue(500),
    } as any;

    const identity = { accountId: "acct_555555555555555555555555" } as any;
    const funding = new SimpleFundingProtocol(mockConway, identity, makeMockDb(fundingDb));

    const result = await funding.fundChild("acct_111111111111111111111111", 100);

    expect(result.success).toBe(true);
    expect(mockConway.transferCredits).toHaveBeenCalledWith(
      "acct_111111111111111111111111",
      100,
      "Task funding from orchestrator",
    );
  });

  it("fundChild updates funded_amount_cents in the children table on success", async () => {
    const mockConway = {
      transferCredits: vi.fn().mockResolvedValue({ status: "ok" }),
    } as any;

    const identity = { accountId: "acct_555555555555555555555555" } as any;
    const funding = new SimpleFundingProtocol(mockConway, identity, makeMockDb(fundingDb));

    await funding.fundChild("acct_111111111111111111111111", 200);

    const row = fundingDb.prepare("SELECT funded_amount_cents FROM children WHERE account_id = ?").get("acct_111111111111111111111111") as any;
    expect(row.funded_amount_cents).toBe(200);
  });

  it("fundChild returns success:true for zero amount without calling transferCredits", async () => {
    const mockConway = {
      transferCredits: vi.fn(),
      getCreditsBalance: vi.fn().mockResolvedValue(0),
    } as any;

    const identity = { accountId: "acct_555555555555555555555555" } as any;
    const funding = new SimpleFundingProtocol(mockConway, identity, makeMockDb(fundingDb));

    const result = await funding.fundChild("acct_111111111111111111111111", 0);

    expect(result.success).toBe(true);
    expect(mockConway.transferCredits).not.toHaveBeenCalled();
  });

  it("fundChild returns success:false when transferCredits throws", async () => {
    const mockConway = {
      transferCredits: vi.fn().mockRejectedValue(new Error("network failure")),
      getCreditsBalance: vi.fn().mockResolvedValue(200),
    } as any;

    const identity = { accountId: "acct_555555555555555555555555" } as any;
    const funding = new SimpleFundingProtocol(mockConway, identity, makeMockDb(fundingDb));

    const result = await funding.fundChild("acct_111111111111111111111111", 50);

    expect(result.success).toBe(false);
  });

  it("getBalance returns funded_amount_cents from the children table", async () => {
    fundingDb.prepare("UPDATE children SET funded_amount_cents = 350 WHERE account_id = ?").run("acct_111111111111111111111111");

    const mockConway = {} as any;
    const identity = { accountId: "acct_555555555555555555555555" } as any;
    const funding = new SimpleFundingProtocol(mockConway, identity, makeMockDb(fundingDb));

    const balance = await funding.getBalance("acct_111111111111111111111111");
    expect(balance).toBe(350);
  });

  it("getBalance returns 0 for unknown address", async () => {
    const mockConway = {} as any;
    const identity = { accountId: "acct_555555555555555555555555" } as any;
    const funding = new SimpleFundingProtocol(mockConway, identity, makeMockDb(fundingDb));

    const balance = await funding.getBalance("acct_222222222222222222222222");
    expect(balance).toBe(0);
  });

  it("recallCredits calls transferCredits back to the parent account id", async () => {
    // Fund the child first so there's a balance to recall
    fundingDb.prepare("UPDATE children SET funded_amount_cents = 500 WHERE account_id = ?").run("acct_111111111111111111111111");

    const mockConway = {
      transferCredits: vi.fn().mockResolvedValue({ status: "ok", amountCents: 500 }),
      getCreditsBalance: vi.fn().mockResolvedValue(500),
    } as any;

    const identity = { accountId: "acct_555555555555555555555555" } as any;
    const funding = new SimpleFundingProtocol(mockConway, identity, makeMockDb(fundingDb));

    const result = await funding.recallCredits("acct_111111111111111111111111");

    expect(result.success).toBe(true);
    expect(result.amountCents).toBe(500);
    expect(mockConway.transferCredits).toHaveBeenCalledWith(
      "acct_555555555555555555555555",
      500,
      "Recall credits from acct_111111111111111111111111",
    );
  });

  it("recallCredits decrements funded_amount_cents after successful recall", async () => {
    fundingDb.prepare("UPDATE children SET funded_amount_cents = 500 WHERE account_id = ?").run("acct_111111111111111111111111");

    const mockConway = {
      transferCredits: vi.fn().mockResolvedValue({ status: "ok", amountCents: 500 }),
    } as any;

    const identity = { accountId: "acct_555555555555555555555555" } as any;
    const funding = new SimpleFundingProtocol(mockConway, identity, makeMockDb(fundingDb));

    await funding.recallCredits("acct_111111111111111111111111");

    const row = fundingDb.prepare("SELECT funded_amount_cents FROM children WHERE account_id = ?").get("acct_111111111111111111111111") as any;
    expect(row.funded_amount_cents).toBe(0);
  });
});
