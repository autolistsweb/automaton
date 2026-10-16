import http from "node:http";
import { randomUUID } from "crypto";
import { createLogger } from "../observability/logger.js";
import { insertWakeEvent } from "../state/database.js";
import type { AutomatonConfig, AutomatonDatabase } from "../types.js";

const logger = createLogger("web");

const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGE_CHARS = 4000;
const DEFAULT_PORT = Number(process.env.WEB_PORT ?? 8080);

export interface WebServerOptions {
  config: AutomatonConfig;
  db: AutomatonDatabase;
  port?: number;
  host?: string;
}

export interface WebServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

export async function startWebServer(
  options: WebServerOptions,
): Promise<WebServer> {
  const { config, db } = options;
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? DEFAULT_PORT;

  const server = http.createServer((req, res) => {
    void handle(req, res, config, db);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const address = server.address();
  const actualPort =
    typeof address === "object" && address ? address.port : port;

  logger.info(`Web UI listening on http://${host}:${actualPort}`);

  return {
    url: `http://${host}:${actualPort}`,
    port: actualPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: AutomatonConfig,
  db: AutomatonDatabase,
): Promise<void> {
  const path = (req.url ?? "").split("?")[0];
  const method = req.method ?? "GET";

  try {
    if (path === "/" && (method === "GET" || method === "HEAD")) {
      sendHtml(res, 200, DASHBOARD_HTML);
      return;
    }

    if (path === "/api/status" || path === "/api/turns") {
      if (method !== "GET" && method !== "HEAD") {
        sendJson(res, 405, { error: "method_not_allowed" });
        return;
      }
      if (path === "/api/status") {
        sendJson(res, 200, buildStatus(config, db));
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      const rawLimit = Number(url.searchParams.get("limit"));
      const limit = Number.isFinite(rawLimit)
        ? Math.min(Math.max(Math.trunc(rawLimit), 1), 50)
        : 30;
      sendJson(res, 200, { turns: buildTurns(db, limit) });
      return;
    }

    if (path === "/api/chat") {
      if (method !== "POST") {
        sendJson(res, 405, { error: "method_not_allowed" });
        return;
      }
      const raw = await readBody(req);
      if (raw === null) {
        sendJson(res, 413, { error: "payload_too_large" }, { Connection: "close" });
        return;
      }
      let payload: any;
      try {
        payload = JSON.parse(raw);
      } catch {
        sendJson(res, 400, { error: "invalid_json" });
        return;
      }
      const message = sanitizeMessage(payload?.message);
      if (!message) {
        sendJson(res, 400, { error: "invalid_message" });
        return;
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      db.insertInboxMessage({
        id,
        from: "web",
        to: config.accountId,
        content: message,
        signedAt: now,
        createdAt: now,
      });
      try {
        insertWakeEvent(db.raw, "web", "web chat message");
      } catch {
        // wake events are best-effort: the message stays queued regardless
      }
      logger.info(`Chat message queued (${message.length} chars)`);
      sendJson(res, 200, { ok: true, id });
      return;
    }

    if (path.startsWith("/api/")) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (err: any) {
    logger.error(`Request failed: ${err?.message ?? err}`);
    sendJson(res, 500, { error: "internal_error" });
  }
}

function buildStatus(
  config: AutomatonConfig,
  db: AutomatonDatabase,
): Record<string, unknown> {
  const heartbeats = db.getHeartbeatEntries();
  const tools = db.getInstalledTools();
  const skills = db.getSkills(true);
  const children = db.getChildren();
  const registry = db.getRegistryEntry();

  return {
    ok: true,
    name: config.name,
    accountId: config.accountId,
    model: config.inferenceModel,
    version: config.version,
    state: db.getAgentState(),
    turns: db.getTurnCount(),
    balanceCents: db.getBalanceCents(config.accountId),
    pendingMessages: db.getUnprocessedInboxMessages(200).length,
    tools: tools.map((t) => ({
      name: t.name,
      type: t.type,
      enabled: t.enabled,
    })),
    skills: skills.length,
    heartbeats: heartbeats.map((h) => ({
      name: h.name,
      enabled: Boolean(h.enabled),
    })),
    heartbeatsActive: heartbeats.filter((h) => h.enabled).length,
    childrenAlive: children.filter((c) => c.status !== "dead").length,
    childrenTotal: children.length,
    agentId: registry?.agentId ?? null,
    registrationStatus: db.getIdentity("conwayRegistrationStatus") ?? "unregistered",
  };
}

function buildTurns(db: AutomatonDatabase, limit: number): unknown[] {
  return db.getRecentTurns(limit).map((turn) => ({
    id: turn.id,
    timestamp: turn.timestamp,
    state: turn.state,
    input: clip(turn.input ?? "", 500),
    inputSource: turn.inputSource ?? null,
    thinking: clip(turn.thinking ?? "", 1500),
    tools: turn.toolCalls.map((t) => ({
      name: t.name,
      success: !t.error,
    })),
    costCents: turn.costCents,
    tokens: turn.tokenUsage?.totalTokens ?? 0,
  }));
}

function sanitizeMessage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
  if (!cleaned || cleaned.length > MAX_MESSAGE_CHARS) return null;
  return cleaned;
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max - 1) + "\u2026";
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(payload);
}

function sendHtml(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    "Cache-Control": "no-store",
  });
  res.end(html);
}

function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;

    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      resolve(value);
    };

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => finish(null));
  });
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Conway Automaton</title>
<style>
:root{
  --bg:#0b0d12; --panel:#12151d; --panel2:#171b26; --line:#232a3a;
  --text:#e7eaf3; --dim:#8b93a7; --accent:#837fff; --accent2:#5eead4;
  --green:#34d399; --amber:#fbbf24; --red:#f87171; --gray:#6b7280;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;min-height:100vh}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
header{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:18px 26px;border-bottom:1px solid var(--line);background:linear-gradient(180deg,#12151f,#0d1017);position:sticky;top:0;z-index:5}
.brand{display:flex;align-items:center;gap:11px;font-size:19px;font-weight:700;letter-spacing:.3px}
.logo{display:inline-flex;width:32px;height:32px;align-items:center;justify-content:center;border-radius:9px;background:linear-gradient(135deg,var(--accent),#4f46e5);color:#fff;font-size:17px}
.meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:13px;color:var(--dim)}
.pill{display:inline-flex;align-items:center;gap:7px;padding:4px 11px;border-radius:99px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;border:1px solid var(--line);background:var(--panel2)}
.dot{width:7px;height:7px;border-radius:50%;background:currentColor}
.s-running{color:var(--green)} .s-sleeping{color:var(--gray)} .s-waking{color:var(--accent2)}
.s-setup{color:var(--accent)} .s-low_compute{color:var(--amber)} .s-critical{color:var(--red)}
.s-dead{color:#b91c1c} .s-offline{color:var(--red)}
main{max-width:1180px;margin:0 auto;padding:26px 22px 60px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:14px;margin-bottom:22px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px 18px}
.card .k{font-size:11.5px;color:var(--dim);text-transform:uppercase;letter-spacing:1.1px}
.card .v{font-size:26px;font-weight:700;margin-top:6px}
.card .v small{font-size:13px;color:var(--dim);font-weight:500}
.grid{display:grid;grid-template-columns:1.1fr .9fr;gap:16px}
@media(max-width:900px){.grid{grid-template-columns:1fr}}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:18px;display:flex;flex-direction:column;min-height:0}
.panel h2{font-size:13px;text-transform:uppercase;letter-spacing:1.2px;color:var(--dim);margin-bottom:14px;display:flex;justify-content:space-between;align-items:center}
.chat{height:520px}
.log{height:520px;overflow-y:auto;display:flex;flex-direction:column;gap:10px;padding-right:4px}
.msg{max-width:88%;padding:9px 13px;border-radius:13px;font-size:14px;white-space:pre-wrap;word-break:break-word}
.msg.user{align-self:flex-end;background:linear-gradient(135deg,#4f46e5,var(--accent));color:#fff;border-bottom-right-radius:4px}
.msg.agent{align-self:flex-start;background:var(--panel2);border:1px solid var(--line);border-bottom-left-radius:4px}
.msg.pending{opacity:.65}
.msg .who{font-size:10.5px;text-transform:uppercase;letter-spacing:1px;opacity:.72;margin-bottom:3px}
.empty{color:var(--dim);font-size:13.5px;text-align:center;margin:auto}
form{display:flex;gap:9px;margin-top:14px}
input[type=text]{flex:1;background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:11px;padding:11px 14px;font-size:14.5px;outline:none}
input[type=text]:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(131,127,255,.18)}
button{background:var(--accent);border:0;color:#fff;font-weight:600;border-radius:11px;padding:11px 18px;font-size:14px;cursor:pointer}
button:hover{filter:brightness(1.08)} button:disabled{opacity:.5;cursor:default}
.turn{background:var(--panel2);border:1px solid var(--line);border-radius:12px;padding:11px 13px}
.turn .t-head{display:flex;justify-content:space-between;gap:10px;font-size:11.5px;color:var(--dim);margin-bottom:6px}
.turn .t-in{font-size:13.5px;color:#cfd6e6;margin-bottom:5px}
.turn .t-out{font-size:13.5px;white-space:pre-wrap;word-break:break-word}
.chips{display:flex;flex-wrap:wrap;gap:7px}
.chip{font-size:12px;padding:4px 10px;border-radius:99px;background:var(--panel2);border:1px solid var(--line);color:#cbd3e3}
.chip.warn{color:var(--amber);border-color:#4a3c14}
.chip.ok{color:var(--accent2)}
.chip.off{opacity:.45}
.lists{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px}
@media(max-width:900px){.lists{grid-template-columns:1fr}}
.hint{font-size:12.5px;color:var(--dim);margin-top:9px}
.err{color:var(--red);font-size:12.5px;margin-top:7px;min-height:16px}
</style>
</head>
<body>
<header>
  <div class="brand"><span class="logo">&#9670;</span><span id="name">Conway Automaton</span></div>
  <div class="meta">
    <span id="state" class="pill"><span class="dot"></span><span id="state-text">loading</span></span>
    <span id="model" class="mono"></span>
    <span id="account" class="mono"></span>
  </div>
</header>
<main>
  <section class="cards">
    <div class="card"><div class="k">State</div><div class="v" id="c-state">&mdash;</div></div>
    <div class="card"><div class="k">Turns</div><div class="v" id="c-turns">&mdash;</div></div>
    <div class="card"><div class="k">Balance</div><div class="v" id="c-balance">&mdash;</div></div>
    <div class="card"><div class="k">Tools</div><div class="v" id="c-tools">&mdash;</div></div>
    <div class="card"><div class="k">Skills</div><div class="v" id="c-skills">&mdash;</div></div>
    <div class="card"><div class="k">Queued msgs</div><div class="v" id="c-queued">&mdash;</div></div>
  </section>

  <div class="grid">
    <section class="panel chat">
      <h2>Chat with your agent</h2>
      <div class="log" id="chat-log"><div class="empty">Send a message to the automaton. Replies appear while <span class="mono">automaton --run</span> is active.</div></div>
      <div class="err" id="chat-err"></div>
      <form id="chat-form">
        <input type="text" id="chat-input" maxlength="4000" placeholder="Say something&hellip;" autocomplete="off">
        <button type="submit" id="chat-send">Send</button>
      </form>
    </section>

    <section class="panel">
      <h2>Activity <span id="pending-badge" class="chip"></span></h2>
      <div class="log" id="turns-log"><div class="empty">No turns yet.</div></div>
    </section>
  </div>

  <div class="lists">
    <section class="panel">
      <h2>Installed tools</h2>
      <div class="chips" id="tools"><span class="empty">loading&hellip;</span></div>
    </section>
    <section class="panel">
      <h2>Heartbeats</h2>
      <div class="chips" id="heartbeats"><span class="empty">loading&hellip;</span></div>
    </section>
  </div>
</main>
<script>
(function(){
  var sent = [];
  var lastTurnsKey = "";
  function id(n){ return document.getElementById(n); }
  function esc(s){
    var d = document.createElement("div");
    d.textContent = (s === null || s === undefined) ? "" : String(s);
    return d.innerHTML;
  }
  function fmtTime(iso){
    var d = iso ? new Date(iso) : new Date();
    if (isNaN(d.getTime())) d = new Date();
    return d.toLocaleTimeString();
  }
  function fmtBRL(cents){
    var v = (Number(cents) || 0) / 100;
    return "R$ " + v.toFixed(2).replace(".", ",");
  }
  function pill(state){
    var el = id("state");
    el.className = "pill s-" + state;
    id("state-text").textContent = state;
  }
  async function getJSON(url){
    var r = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!r.ok) throw new Error("http " + r.status);
    return r.json();
  }
  function renderStatus(s){
    document.title = s.name + " \\u2014 Conway Automaton";
    id("name").textContent = s.name;
    pill(s.state);
    id("model").textContent = s.model || "";
    id("account").textContent = (s.accountId || "").replace(/^acct_/, "acct_").slice(0, 16) + "\\u2026";
    id("c-state").textContent = s.state;
    id("c-turns").textContent = String(s.turns);
    id("c-balance").textContent = fmtBRL(s.balanceCents);
    id("c-tools").innerHTML = esc(String(s.tools.length)) + " <small>installed</small>";
    id("c-skills").textContent = String(s.skills);
    id("c-queued").textContent = String(s.pendingMessages);
    var tools = id("tools");
    tools.innerHTML = "";
    if (!s.tools.length){ tools.innerHTML = "<span class=\\"empty\\">none</span>"; }
    s.tools.forEach(function(t){
      var c = document.createElement("span");
      c.className = "chip" + (t.enabled ? "" : " off");
      c.textContent = t.name + " \\u00b7 " + t.type;
      tools.appendChild(c);
    });
    var hb = id("heartbeats");
    hb.innerHTML = "";
    if (!s.heartbeats.length){ hb.innerHTML = "<span class=\\"empty\\">none</span>"; }
    s.heartbeats.forEach(function(h){
      var c = document.createElement("span");
      c.className = "chip" + (h.enabled ? " ok" : " off");
      c.textContent = h.name;
      hb.appendChild(c);
    });
    var badge = id("pending-badge");
    badge.textContent = s.pendingMessages ? s.pendingMessages + " queued" : "live";
    badge.className = "chip" + (s.pendingMessages ? " warn" : " ok");
  }
  function turnKey(t){ return t.id; }
  function renderChat(turns, sentSnapshot){
    var log = id("chat-log");
    var items = [];
    turns.forEach(function(t){
      if (t.input && (t.inputSource === "agent" || t.inputSource === "creator")){
        var text = t.input.replace(/^\\[Message from [^\\]]+\\]:\\s*/, "");
        items.push({ at: t.timestamp, who: "you", text: text });
      }
      if (t.thinking){
        items.push({ at: t.timestamp, who: "agent", text: t.thinking });
      }
    });
    var pending = sentSnapshot.filter(function(m){
      return !items.some(function(i){ return i.text === m.text; });
    });
    pending.forEach(function(m){ items.push({ at: m.atISO, who: "you", text: m.text, pending: true }); });
    items.sort(function(a, b){ return new Date(a.at) - new Date(b.at); });
    if (!items.length){
      log.innerHTML = "<div class=\\"empty\\">Send a message to the automaton. Replies appear while <span class=\\"mono\\">automaton --run</span> is active.</div>";
      return;
    }
    log.innerHTML = "";
    items.forEach(function(m){
      var div = document.createElement("div");
      div.className = "msg " + (m.who === "you" ? "user" : "agent") + (m.pending ? " pending" : "");
      var who = document.createElement("div");
      who.className = "who";
      who.textContent = m.who + (m.pending ? " \\u00b7 queued" : "") + " \\u00b7 " + fmtTime(m.at);
      var body = document.createElement("div");
      body.textContent = m.text;
      div.appendChild(who);
      div.appendChild(body);
      log.appendChild(div);
    });
    log.scrollTop = log.scrollHeight;
  }
  function renderTurns(turns){
    var log = id("turns-log");
    if (!turns.length){
      log.innerHTML = "<div class=\\"empty\\">No turns yet.</div>";
      return;
    }
    log.innerHTML = "";
    turns.slice().reverse().forEach(function(t){
      var el = document.createElement("div");
      el.className = "turn";
      var head = document.createElement("div");
      head.className = "t-head";
      var left = document.createElement("span");
      left.textContent = fmtTime(t.timestamp) + " \\u00b7 " + (t.state || "");
      var right = document.createElement("span");
      right.textContent = t.tokens + " tok" + (t.tools.length ? " \\u00b7 " + t.tools.length + " tool" + (t.tools.length > 1 ? "s" : "") : "");
      head.appendChild(left);
      head.appendChild(right);
      el.appendChild(head);
      if (t.input){
        var inp = document.createElement("div");
        inp.className = "t-in";
        inp.textContent = "\\u2192 " + t.input;
        el.appendChild(inp);
      }
      if (t.thinking){
        var out = document.createElement("div");
        out.className = "t-out";
        out.textContent = t.thinking;
        el.appendChild(out);
      }
      if (t.tools.length){
        var chips = document.createElement("div");
        chips.className = "chips";
        chips.style.marginTop = "7px";
        t.tools.forEach(function(tool){
          var c = document.createElement("span");
          c.className = "chip" + (tool.success ? " ok" : " warn");
          c.textContent = tool.name;
          chips.appendChild(c);
        });
        el.appendChild(chips);
      }
      log.appendChild(el);
    });
  }
  async function refresh(){
    try {
      var s = await getJSON("/api/status");
      renderStatus(s);
      var t = await getJSON("/api/turns?limit=30");
      var turns = t.turns || [];
      renderTurns(turns);
      renderChat(turns, sent.slice());
      lastTurnsKey = turns.map(turnKey).join(",");
    } catch (e){
      pill("offline");
      id("c-state").textContent = "offline";
    }
  }
  id("chat-form").addEventListener("submit", async function(ev){
    ev.preventDefault();
    var input = id("chat-input");
    var text = input.value.trim();
    var errEl = id("chat-err");
    errEl.textContent = "";
    if (!text) return;
    var btn = id("chat-send");
    btn.disabled = true;
    try {
      var r = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text })
      });
      var data = await r.json();
      if (!r.ok){
        errEl.textContent = "Failed: " + (data.error || r.status);
        return;
      }
      input.value = "";
      sent.push({ text: text, atISO: new Date().toISOString() });
      if (sent.length > 100) sent.shift();
      await refresh();
    } catch (e){
      errEl.textContent = "Network error \\u2014 is the server running?";
    } finally {
      btn.disabled = false;
    }
  });
  refresh();
  setInterval(refresh, 2500);
})();
</script>
</body>
</html>
`;
