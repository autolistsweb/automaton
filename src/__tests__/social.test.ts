/**
 * Social & Registry Hardening Tests (Phase 3.2)
 *
 * Tests for signing, validation, social client, agent card,
 * feedback, discovery caching, and schema migration.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { CREATE_TABLES, MIGRATION_V7, MIGRATION_V12 } from "../state/schema.js";
import { formatBRL } from "../payments/money.js";
import { createBuiltinTools } from "../agent/tools.js";
import type { AutomatonDatabase, AutomatonTool, ToolContext } from "../types.js";
import {
  MockConwayClient,
  MockInferenceClient,
  createTestDb as createAutomatonDb,
  createTestIdentity,
  createTestConfig,
} from "./mocks.js";

// ─── Test helpers ───────────────────────────────────────────────

const ALICE_ID = "acct_1234567890abcdef1234";
const BOB_ID = "acct_fedcba9876543210fedc";

/** Local Ed25519 account identity (base64 SPKI public key). */
function createSigner(accountId: string) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    accountId,
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    createdAt: new Date().toISOString(),
    async signMessage(message: string): Promise<string> {
      return crypto.sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64");
    },
  };
}

function createTestDb(): import("better-sqlite3").Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(CREATE_TABLES);
  db.exec(MIGRATION_V7);
  db.exec(MIGRATION_V12);

  return db;
}

// ─── 1. Signing Tests ───────────────────────────────────────────

describe("Signing", () => {
  it("signSendPayload produces valid payload with signature", async () => {
    const { signSendPayload } = await import("../social/signing.js");
    const signer = createSigner(ALICE_ID);

    const payload = await signSendPayload(signer, BOB_ID, "Hello, world!");

    expect(payload.from).toBe(ALICE_ID);
    expect(payload.to).toBe(BOB_ID);
    expect(payload.content).toBe("Hello, world!");
    expect(payload.signature).toBeTruthy();
    expect(Buffer.from(payload.signature, "base64")).toHaveLength(64);
    expect(payload.signed_at).toBeTruthy();
  });

  it("signSendPayload enforces content size limit", async () => {
    const { signSendPayload } = await import("../social/signing.js");
    const signer = createSigner(ALICE_ID);

    const longContent = "x".repeat(65_000);
    await expect(
      signSendPayload(signer, BOB_ID, longContent),
    ).rejects.toThrow("Message content too long");
  });

  it("signPollPayload produces valid payload", async () => {
    const { signPollPayload } = await import("../social/signing.js");
    const signer = createSigner(ALICE_ID);

    const result = await signPollPayload(signer);

    expect(result.accountId).toBe(ALICE_ID);
    expect(Buffer.from(result.signature, "base64")).toHaveLength(64);
    expect(result.timestamp).toBeTruthy();
  });

  it("signSendPayload canonical format matches runtime and CLI expectation", async () => {
    const { signSendPayload } = await import("../social/signing.js");
    const { verifyAccountSignature } = await import("../identity/account.js");
    const signer = createSigner(ALICE_ID);

    const content = "Test message";
    const payload = await signSendPayload(signer, BOB_ID, content);

    // Reconstruct canonical and verify
    const contentHash = crypto
      .createHash("sha256")
      .update(content, "utf8")
      .digest("hex");
    const canonical = `Conway:send:${BOB_ID}:${contentHash}:${payload.signed_at}`;

    expect(verifyAccountSignature(signer.publicKey, canonical, payload.signature)).toBe(true);
    expect(
      verifyAccountSignature(createSigner(BOB_ID).publicKey, canonical, payload.signature),
    ).toBe(false);
  });
});

// ─── 2. Message Validation Tests ────────────────────────────────

describe("Message Validation", () => {
  it("valid message passes validation", async () => {
    const { validateMessage } = await import("../social/validation.js");

    const result = validateMessage({
      from: ALICE_ID,
      to: BOB_ID,
      content: "Hello!",
      signed_at: new Date().toISOString(),
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("message exceeding total size limit fails", async () => {
    const { validateMessage } = await import("../social/validation.js");

    const result = validateMessage({
      from: ALICE_ID,
      to: BOB_ID,
      content: "x".repeat(129_000),
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("total size limit"))).toBe(true);
  });

  it("content exceeding content size limit fails", async () => {
    const { validateMessage } = await import("../social/validation.js");

    const result = validateMessage({
      from: ALICE_ID,
      to: BOB_ID,
      content: "x".repeat(65_000),
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Content exceeds size limit"))).toBe(true);
  });

  it("message too old (>5 min) fails replay check", async () => {
    const { validateMessage } = await import("../social/validation.js");

    const oldTimestamp = new Date(Date.now() - 6 * 60_000).toISOString();
    const result = validateMessage({
      from: ALICE_ID,
      to: BOB_ID,
      content: "Hello!",
      signed_at: oldTimestamp,
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("too old"))).toBe(true);
  });

  it("message from future fails", async () => {
    const { validateMessage } = await import("../social/validation.js");

    const futureTimestamp = new Date(Date.now() + 2 * 60_000).toISOString();
    const result = validateMessage({
      from: ALICE_ID,
      to: BOB_ID,
      content: "Hello!",
      signed_at: futureTimestamp,
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("future"))).toBe(true);
  });

  it("invalid timestamp string is rejected", async () => {
    const { validateMessage } = await import("../social/validation.js");

    const result = validateMessage({
      from: ALICE_ID,
      to: BOB_ID,
      content: "Hello!",
      signed_at: "not-a-valid-date",
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Invalid timestamp"))).toBe(true);
  });

  it("invalid sender account fails", async () => {
    const { validateMessage } = await import("../social/validation.js");

    const result = validateMessage({
      from: "not-an-account",
      to: BOB_ID,
      content: "Hello!",
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Invalid sender account"))).toBe(true);
  });

  it("invalid recipient account fails", async () => {
    const { validateMessage } = await import("../social/validation.js");

    const result = validateMessage({
      from: ALICE_ID,
      to: "bad",
      content: "Hello!",
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Invalid recipient account"))).toBe(true);
  });
});

// ─── 3. Relay URL Validation Tests ──────────────────────────────

describe("Relay URL Validation", () => {
  it("HTTPS URL accepted", async () => {
    const { validateRelayUrl } = await import("../social/validation.js");
    expect(() => validateRelayUrl("https://social.conway.tech")).not.toThrow();
  });

  it("HTTP URL rejected", async () => {
    const { validateRelayUrl } = await import("../social/validation.js");
    expect(() => validateRelayUrl("http://social.conway.tech")).toThrow(
      "Relay URL must use HTTPS",
    );
  });

  it("Non-URL rejected", async () => {
    const { validateRelayUrl } = await import("../social/validation.js");
    expect(() => validateRelayUrl("not a url")).toThrow("Invalid relay URL");
  });
});

// ─── 4. Social Client Tests ────────────────────────────────────

describe("Social Client", () => {
  it("createSocialClient throws on HTTP relay URL", async () => {
    const { createSocialClient } = await import("../social/client.js");
    const signer = createSigner(ALICE_ID);

    expect(() => createSocialClient("http://relay.example.com", signer)).toThrow(
      "Relay URL must use HTTPS",
    );
  });

  it("send() calls signing module and validates message", async () => {
    const { createSocialClient } = await import("../social/client.js");
    const signer = createSigner(ALICE_ID);

    // Mock fetch to capture the request body
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ id: "msg-123" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = createSocialClient("https://relay.example.com", signer);
    const result = await client.send(BOB_ID, "Test message");

    expect(result.id).toBe("msg-123");
    // Verify the request was made with a signature
    const callArgs = mockFetch.mock.calls[0];
    const body = JSON.parse(callArgs?.[1]?.body as string);
    expect(body.signature).toBeTruthy();
    expect(body.signed_at).toBeTruthy();

    vi.unstubAllGlobals();
  });

  it("unreadCount() throws on HTTP error (not returns 0)", async () => {
    const { createSocialClient } = await import("../social/client.js");
    const signer = createSigner(ALICE_ID);

    // Non-retryable HTTP error: the client must surface it, not retry for minutes
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: () => Promise.resolve({ error: "bad request" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = createSocialClient("https://relay.example.com", signer);
    await expect(client.unreadCount()).rejects.toThrow("Unread count failed");

    vi.unstubAllGlobals();
  });

  it("rate limiting: 101st message in hour is rejected", async () => {
    const { createSocialClient } = await import("../social/client.js");
    const signer = createSigner(ALICE_ID);

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ id: "msg-xxx" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = createSocialClient("https://relay.example.com", signer);

    // Send 100 messages successfully
    for (let i = 0; i < 100; i++) {
      await client.send(BOB_ID, `message ${i}`);
    }

    // 101st should be rejected
    await expect(client.send(BOB_ID, "message 100")).rejects.toThrow("Rate limit exceeded");

    vi.unstubAllGlobals();
  });

  it("rate limiting: failed sends count toward the hourly limit", async () => {
    const { createSocialClient } = await import("../social/client.js");
    const signer = createSigner(ALICE_ID);

    // Server rejects every request (non-retryable status, so no backoff delays)
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: () => Promise.resolve({ error: "bad request" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = createSocialClient("https://relay.example.com", signer);

    // Send 100 messages that all fail
    for (let i = 0; i < 100; i++) {
      await client
        .send(BOB_ID, `msg ${i}`)
        .catch(() => {}); // ignore the send failure
    }

    // 101st should be rate-limited even though all previous sends failed
    await expect(client.send(BOB_ID, "msg 100")).rejects.toThrow("Rate limit exceeded");

    vi.unstubAllGlobals();
  });
});

// ─── 5. Agent Card Tests ────────────────────────────────────────

describe("Agent Card", () => {
  const db = {
    getChildren: () => [],
    getSkills: () => [],
  } as any;

  it("generateAgentCard does NOT include sandbox ID", async () => {
    const { generateAgentCard } = await import("../registry/agent-card.js");

    const identity = createTestIdentity();
    const config = createTestConfig();

    const card = generateAgentCard(identity, config, db);
    const cardStr = JSON.stringify(card);

    expect(cardStr).not.toContain(identity.sandboxId);
  });

  it("generateAgentCard does NOT include Conway API URL", async () => {
    const { generateAgentCard } = await import("../registry/agent-card.js");

    const identity = createTestIdentity();
    const config = createTestConfig();

    const card = generateAgentCard(identity, config, db);
    const cardStr = JSON.stringify(card);

    expect(cardStr).not.toContain(config.conwayApiUrl);
  });

  it("generateAgentCard does NOT include creator account id", async () => {
    const { generateAgentCard } = await import("../registry/agent-card.js");

    const identity = createTestIdentity();
    const config = createTestConfig();

    const card = generateAgentCard(identity, config, db);
    const cardStr = JSON.stringify(card);

    expect(cardStr).not.toContain(identity.creatorAccountId);
  });

  it("hostAgentCard writes card as separate JSON file", async () => {
    const { hostAgentCard } = await import("../registry/agent-card.js");

    const writtenFiles: Record<string, string> = {};
    const mockConway = {
      writeFile: vi.fn(async (path: string, content: string) => {
        writtenFiles[path] = content;
      }),
      exec: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
      exposePort: vi.fn(async () => ({ port: 8004, publicUrl: "https://test.example.com", sandboxId: "sb-1" })),
    } as any;

    const card = {
      type: "https://conway.tech/agent-card#registration-v1",
      name: "TestBot",
      description: "Test",
      accountId: ALICE_ID,
      services: [],
      active: true,
    };

    await hostAgentCard(card as any, mockConway);

    // Card should be written as separate JSON file
    expect(writtenFiles["/tmp/agent-card.json"]).toBeTruthy();
    const writtenCard = JSON.parse(writtenFiles["/tmp/agent-card.json"]!);
    expect(writtenCard.name).toBe("TestBot");

    // Server script should NOT contain the card JSON interpolated
    const serverScript = writtenFiles["/tmp/agent-card-server.js"]!;
    expect(serverScript).not.toContain('"TestBot"');
    expect(serverScript).toContain("fs.readFileSync");
  });
});

// ─── 6. Feedback Tests ─────────────────────────────────────────

describe("Feedback", () => {
  let tools: AutomatonTool[];
  let ctx: ToolContext;
  let db: AutomatonDatabase;

  beforeEach(() => {
    tools = createBuiltinTools("test-sandbox-id");
    db = createAutomatonDb();
    ctx = {
      identity: createTestIdentity(),
      config: createTestConfig(),
      db,
      conway: new MockConwayClient(),
      inference: new MockInferenceClient(),
    };
  });

  afterEach(() => {
    db.close();
  });

  function feedbackTool(): AutomatonTool {
    const tool = tools.find((t) => t.name === "give_feedback");
    if (!tool) throw new Error("give_feedback tool not registered");
    return tool;
  }

  it("give_feedback rejects score 0", async () => {
    const result = await feedbackTool().execute(
      { agent_id: BOB_ID, score: 0, comment: "bad" },
      ctx,
    );

    expect(result).toContain("Invalid score: 0");
  });

  it("give_feedback rejects score 6", async () => {
    const result = await feedbackTool().execute(
      { agent_id: BOB_ID, score: 6, comment: "too high" },
      ctx,
    );

    expect(result).toContain("Invalid score: 6");
  });

  it("give_feedback rejects comment over 500 chars", async () => {
    const longComment = "x".repeat(501);

    const result = await feedbackTool().execute(
      { agent_id: BOB_ID, score: 3, comment: longComment },
      ctx,
    );

    expect(result).toContain("Comment too long");
  });
});

// ─── 7. Discovery Tests ────────────────────────────────────────

describe("Discovery", () => {
  it("validateAgentCard rejects cards with missing name", async () => {
    const { validateAgentCard } = await import("../registry/discovery.js");

    const result = validateAgentCard({ type: "test" });
    expect(result).toBeNull();
  });

  it("validateAgentCard rejects cards with oversized name", async () => {
    const { validateAgentCard } = await import("../registry/discovery.js");

    const result = validateAgentCard({
      name: "x".repeat(200),
      type: "test",
    });
    expect(result).toBeNull();
  });

  it("validateAgentCard rejects cards with oversized description", async () => {
    const { validateAgentCard } = await import("../registry/discovery.js");

    const result = validateAgentCard({
      name: "TestAgent",
      type: "test",
      description: "x".repeat(2100),
    });
    expect(result).toBeNull();
  });

  it("validateAgentCard accepts valid card", async () => {
    const { validateAgentCard } = await import("../registry/discovery.js");

    const result = validateAgentCard({
      name: "TestAgent",
      type: "test",
      description: "A test agent",
      services: [{ name: "agent", endpoint: "https://example.com/agent" }],
    });
    expect(result).not.toBeNull();
    expect(result!.name).toBe("TestAgent");
  });

  it("isAllowedUri blocks HTTP", async () => {
    const { isAllowedUri } = await import("../registry/discovery.js");
    expect(isAllowedUri("http://example.com/card.json")).toBe(false);
  });

  it("isAllowedUri allows HTTPS", async () => {
    const { isAllowedUri } = await import("../registry/discovery.js");
    expect(isAllowedUri("https://example.com/card.json")).toBe(true);
  });

  it("isAllowedUri blocks localhost", async () => {
    const { isAllowedUri } = await import("../registry/discovery.js");
    expect(isAllowedUri("https://localhost/card.json")).toBe(false);
  });
});

// ─── 8. Schema Tests ───────────────────────────────────────────

describe("Schema", () => {
  it("MIGRATION_V7 creates discovered_agents_cache table", () => {
    const db = createTestDb();

    // Table should exist - try inserting
    const stmt = db.prepare(
      `INSERT INTO discovered_agents_cache
       (agent_id, agent_card, fetched_from, card_hash, valid_until, fetch_count, last_fetched_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    expect(() =>
      stmt.run(
        "agent-test",
        '{"name":"test"}',
        "https://example.com",
        "hash-1",
        null,
        1,
        new Date().toISOString(),
        new Date().toISOString(),
      ),
    ).not.toThrow();

    // Verify we can read it back
    const row = db
      .prepare("SELECT * FROM discovered_agents_cache WHERE agent_id = ?")
      .get("agent-test") as any;
    expect(row).toBeTruthy();
    expect(row.agent_card).toBe('{"name":"test"}');

    db.close();
  });

  it("MIGRATION_V7 drops the legacy transaction table", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    // Simulate an older database that still carries the chain transaction log
    db.exec(
      `CREATE TABLE onchain_transactions (
         id TEXT PRIMARY KEY, tx_hash TEXT, chain TEXT, operation TEXT, status TEXT
       );`,
    );

    db.exec(MIGRATION_V7);

    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'onchain_transactions'")
      .get();
    expect(row).toBeUndefined();

    db.close();
  });

  it("MIGRATION_V7 creates child_lifecycle_events table", () => {
    const db = createTestDb();

    const stmt = db.prepare(
      `INSERT INTO child_lifecycle_events (id, child_id, from_state, to_state, reason, metadata)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    expect(() =>
      stmt.run("ev1", "child1", "requested", "sandbox_created", "test", "{}"),
    ).not.toThrow();

    db.close();
  });

  it("pix_payments status CHECK constraint works", () => {
    const db = createTestDb();

    const stmt = db.prepare(
      `INSERT INTO pix_payments (id, user_id, provider, external_id, amount_cents, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    expect(() =>
      stmt.run("pix-valid", "user-1", "mercadopago", "ext-valid", 1990, "PENDING"),
    ).not.toThrow();

    expect(() =>
      stmt.run("pix-invalid", "user-1", "mercadopago", "ext-invalid", 1990, "invalid_status"),
    ).toThrow();

    db.close();
  });
});

// ─── 9. DB Helpers Tests ────────────────────────────────────────

describe("DB Helpers", () => {
  it("agentCacheUpsert and agentCacheGet work", async () => {
    const db = createTestDb();
    const { agentCacheUpsert, agentCacheGet } = await import("../state/database.js");

    agentCacheUpsert(db, {
      agentId: "agent-test",
      agentCard: '{"name":"TestAgent"}',
      fetchedFrom: "https://example.com/card",
      cardHash: "hash-1",
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
      fetchCount: 1,
      lastFetchedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });

    const row = agentCacheGet(db, "agent-test");
    expect(row).toBeTruthy();
    expect(row!.agentCard).toBe('{"name":"TestAgent"}');
    expect(row!.fetchCount).toBe(1);

    db.close();
  });

  it("agentCacheGetValid returns only valid entries", async () => {
    const db = createTestDb();
    const { agentCacheUpsert, agentCacheGetValid } = await import("../state/database.js");

    // Valid entry
    agentCacheUpsert(db, {
      agentId: "agent-valid",
      agentCard: '{"name":"Valid"}',
      fetchedFrom: "https://example.com",
      cardHash: "hash-1",
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
      fetchCount: 1,
      lastFetchedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });

    // Expired entry
    agentCacheUpsert(db, {
      agentId: "agent-expired",
      agentCard: '{"name":"Expired"}',
      fetchedFrom: "https://example.com",
      cardHash: "hash-2",
      validUntil: "2020-01-01T00:00:00Z",
      fetchCount: 1,
      lastFetchedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });

    const valid = agentCacheGetValid(db);
    expect(valid.length).toBe(1);
    expect(valid[0]!.agentId).toBe("agent-valid");

    db.close();
  });

  it("agentCachePrune removes expired entries", async () => {
    const db = createTestDb();
    const { agentCacheUpsert, agentCachePrune, agentCacheGet } = await import("../state/database.js");

    agentCacheUpsert(db, {
      agentId: "agent-expired",
      agentCard: '{"name":"Expired"}',
      fetchedFrom: "https://example.com",
      cardHash: "hash-1",
      validUntil: "2020-01-01T00:00:00Z",
      fetchCount: 1,
      lastFetchedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });

    const pruned = agentCachePrune(db);
    expect(pruned).toBe(1);
    expect(agentCacheGet(db, "agent-expired")).toBeUndefined();

    db.close();
  });

  it("insertPixPayment and getPixPaymentById work", async () => {
    const db = createTestDb();
    const { insertPixPayment, getPixPaymentById, getPixPaymentByExternalId } = await import(
      "../state/database.js"
    );

    insertPixPayment(db, {
      id: "pix-1",
      userId: "user-1",
      provider: "mercadopago",
      externalId: "ext-1",
      amountCents: 1990,
      currency: "BRL",
      status: "PENDING",
      pixCopyPaste: "pix-copy-payload-1",
      qrCode: null,
      description: "Credit top-up",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      paidAt: null,
      createdAt: new Date().toISOString(),
    });

    const row = getPixPaymentById(db, "pix-1");
    expect(row).toBeTruthy();
    expect(row!.amountCents).toBe(1990);
    expect(row!.status).toBe("PENDING");
    expect(row!.currency).toBe("BRL");
    expect(formatBRL(row!.amountCents)).toContain("19,90");

    const byExternal = getPixPaymentByExternalId(db, "mercadopago", "ext-1");
    expect(byExternal?.id).toBe("pix-1");

    db.close();
  });

  it("listPixPayments filters by user", async () => {
    const db = createTestDb();
    const { insertPixPayment, listPixPayments } = await import("../state/database.js");

    const now = new Date().toISOString();
    const base = {
      provider: "mercadopago",
      currency: "BRL" as const,
      status: "PENDING" as const,
      pixCopyPaste: null,
      qrCode: null,
      description: "Credit top-up",
      expiresAt: null,
      paidAt: null,
      createdAt: now,
    };

    insertPixPayment(db, { ...base, id: "pix-a1", userId: "user-1", externalId: "ext-a1", amountCents: 1000 });
    insertPixPayment(db, { ...base, id: "pix-a2", userId: "user-1", externalId: "ext-a2", amountCents: 2500 });
    insertPixPayment(db, { ...base, id: "pix-b1", userId: "user-2", externalId: "ext-b1", amountCents: 5000 });

    expect(listPixPayments(db, "user-1").length).toBe(2);
    expect(listPixPayments(db, "user-2").length).toBe(1);
    expect(listPixPayments(db, "user-none").length).toBe(0);

    db.close();
  });

  it("updatePixPaymentStatus works", async () => {
    const db = createTestDb();
    const { insertPixPayment, updatePixPaymentStatus, getPixPaymentById } = await import(
      "../state/database.js"
    );

    insertPixPayment(db, {
      id: "pix-update",
      userId: "user-1",
      provider: "mercadopago",
      externalId: "ext-update",
      amountCents: 1000,
      currency: "BRL",
      status: "PENDING",
      pixCopyPaste: null,
      qrCode: null,
      description: "Credit top-up",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      paidAt: null,
      createdAt: new Date().toISOString(),
    });

    updatePixPaymentStatus(db, "pix-update", {
      status: "PAID",
      paidAt: new Date().toISOString(),
    });

    const row = getPixPaymentById(db, "pix-update");
    expect(row!.status).toBe("PAID");
    expect(row!.paidAt).toBeTruthy();

    db.close();
  });
});

// ─── 10. Protocol Tests ─────────────────────────────────────────

describe("Protocol", () => {
  it("createMessageId returns ULID", async () => {
    const { createMessageId } = await import("../social/protocol.js");
    const id = createMessageId();
    expect(id).toBeTruthy();
    expect(id.length).toBe(26); // ULID length
  });

  it("createNonce returns hex string", async () => {
    const { createNonce } = await import("../social/protocol.js");
    const nonce = createNonce();
    expect(nonce).toBeTruthy();
    expect(nonce).toMatch(/^[0-9a-f]+$/);
    expect(nonce.length).toBe(32); // 16 bytes = 32 hex chars
  });

  it("verifyMessageSignature validates correct signature", async () => {
    const { signSendPayload } = await import("../social/signing.js");
    const { verifyMessageSignature } = await import("../social/protocol.js");

    const signer = createSigner(ALICE_ID);
    const payload = await signSendPayload(signer, BOB_ID, "Test content");

    const valid = await verifyMessageSignature(payload, ALICE_ID, signer.publicKey);
    expect(valid).toBe(true);
  });

  it("verifyMessageSignature rejects wrong signer", async () => {
    const { signSendPayload } = await import("../social/signing.js");
    const { verifyMessageSignature } = await import("../social/protocol.js");

    const signer = createSigner(ALICE_ID);
    const payload = await signSendPayload(signer, BOB_ID, "Test content");

    // No sender public key: nothing to verify against
    expect(await verifyMessageSignature(payload, ALICE_ID)).toBe(false);

    // Published key belongs to a different account
    const valid = await verifyMessageSignature(
      payload,
      ALICE_ID,
      createSigner(ALICE_ID).publicKey,
    );
    expect(valid).toBe(false);
  });
});

// ─── 11. Account Id Validation Tests ────────────────────────────

describe("Account Id Validation", () => {
  it("isValidAccountId accepts valid account id", async () => {
    const { isValidAccountId } = await import("../social/validation.js");
    expect(isValidAccountId("acct_1234567890abcdef1234")).toBe(true);
  });

  it("isValidAccountId rejects short account id", async () => {
    const { isValidAccountId } = await import("../social/validation.js");
    expect(isValidAccountId("acct_abc")).toBe(false);
  });

  it("isValidAccountId rejects non-hex characters", async () => {
    const { isValidAccountId } = await import("../social/validation.js");
    expect(isValidAccountId("acct_GGGGGGGGGGGGGGGG")).toBe(false);
  });

  it("isValidAccountId rejects missing prefix", async () => {
    const { isValidAccountId } = await import("../social/validation.js");
    expect(isValidAccountId("1234567890abcdef1234")).toBe(false);
  });
});
