import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb } from "./mocks.js";
import { createConfig } from "../config.js";
import { startWebServer } from "../web/server.js";
import type { WebServer } from "../web/server.js";
import type { AutomatonConfig, AutomatonDatabase, AgentTurn } from "../types.js";

let db: AutomatonDatabase;
let config: AutomatonConfig;
let server: WebServer;

beforeEach(async () => {
  db = createTestDb();
  config = createConfig({
    name: "WebBot",
    genesisPrompt: "test prompt",
    creatorAccountId: "acct_0123456789abcdef",
    registeredWithConway: false,
    sandboxId: "sandbox-web-test",
    accountId: "acct_0123456789abcdef",
    apiKey: "",
  });
  server = await startWebServer({
    config,
    db,
    port: 0,
    host: "127.0.0.1",
  });
});

afterEach(async () => {
  await server.close();
  db.close();
});

describe("web server", () => {
  it("serves the dashboard HTML at /", async () => {
    const res = await fetch(server.url + "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Conway Automaton");
    expect(html).toContain("/api/chat");
  });

  it("returns status JSON", async () => {
    const res = await fetch(server.url + "/api/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.name).toBe("WebBot");
    expect(body.state).toBe(db.getAgentState());
    expect(body.turns).toBe(0);
    expect(body.balanceCents).toBe(0);
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.pendingMessages).toBe(0);
  });

  it("returns recent turns", async () => {
    const turn: AgentTurn = {
      id: "01J000000000000000000000",
      timestamp: new Date().toISOString(),
      state: "running",
      input: "[Message from web]: hello there",
      inputSource: "agent",
      thinking: "The creator said hello, I should greet them.",
      toolCalls: [],
      tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      costCents: 0,
    };
    db.insertTurn(turn);

    const res = await fetch(server.url + "/api/turns?limit=10");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.turns).toHaveLength(1);
    expect(body.turns[0].input).toContain("hello there");
    expect(body.turns[0].thinking).toContain("greet them");
    expect(body.turns[0].tokens).toBe(15);
  });

  it("clamps the turns limit", async () => {
    const res = await fetch(server.url + "/api/turns?limit=99999");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ turns: [] });
  });

  it("queues a chat message into the inbox", async () => {
    const res = await fetch(server.url + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "  build me a website  " }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.id).toBe("string");

    const pending = db.getUnprocessedInboxMessages(10);
    expect(pending).toHaveLength(1);
    expect(pending[0].content).toBe("build me a website");
    expect(pending[0].from).toBe("web");
  });

  it("rejects empty, non-string and oversized messages", async () => {
    for (const payload of [
      { message: "   " },
      { message: 42 },
      { message: "x".repeat(4001) },
      {},
    ]) {
      const res = await fetch(server.url + "/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(res.status).toBe(400);
    }
    expect(db.getUnprocessedInboxMessages(10)).toHaveLength(0);
  });

  it("rejects invalid JSON bodies", async () => {
    const res = await fetch(server.url + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_json" });
  });

  it("answers 405 for wrong methods", async () => {
    const res = await fetch(server.url + "/api/status", { method: "POST" });
    expect(res.status).toBe(405);
    const res2 = await fetch(server.url + "/", { method: "POST" });
    expect(res2.status).toBe(404);
  });

  it("answers 404 for unknown paths", async () => {
    const res = await fetch(server.url + "/api/nope");
    expect(res.status).toBe(404);
    const res2 = await fetch(server.url + "/favicon.ico");
    expect(res2.status).toBe(404);
  });
});
