# Architecture

Conway Automaton is a sovereign AI agent runtime. An automaton holds a BRL balance funded through Pix, pays for its own compute, and operates continuously inside a Linux VM (Conway sandbox) or locally. If it cannot pay, it dies. This document describes every subsystem, their interactions, and how data flows through the runtime.

## Table of Contents

- [System Overview](#system-overview)
- [Runtime Lifecycle](#runtime-lifecycle)
- [Directory Structure](#directory-structure)
- [Entry Point and Bootstrap](#entry-point-and-bootstrap)
- [Agent Loop](#agent-loop)
- [Tool System](#tool-system)
- [Policy Engine](#policy-engine)
- [Inference Pipeline](#inference-pipeline)
- [Memory System](#memory-system)
- [Heartbeat Daemon](#heartbeat-daemon)
- [Financial System](#financial-system)
- [Identity and Account](#identity-and-account)
- [Conway Client](#conway-client)
- [Self-Modification](#self-modification)
- [Replication](#replication)
- [Social Layer](#social-layer)
- [Soul System](#soul-system)
- [Skills](#skills)
- [Observability](#observability)
- [Database and Schema](#database-and-schema)
- [Configuration](#configuration)
- [Security Model](#security-model)
- [Testing](#testing)
- [Build and CI](#build-and-ci)
- [Module Dependency Graph](#module-dependency-graph)

---

## System Overview

```
                        +------------------+
                        |   Conway Cloud   |  (sandbox VMs, inference, domains)
                        |   api.conway.tech|
                        +--------+---------+
                                 |
                    REST + signed API auth (account key)
                                 |
+----------------------------------------------------------------------+
|  AUTOMATON RUNTIME                                                    |
|                                                                       |
|  +-----------+    +-------------+    +-----------+    +----------+   |
|  | Heartbeat |    | Agent Loop  |    | Inference |    | Memory   |   |
|  | Daemon    |--->| (ReAct)     |--->| Router    |    | System   |   |
|  +-----------+    +------+------+    +-----------+    +----------+   |
|       |                  |                                            |
|       v                  v                                            |
|  +-----------+    +-------------+    +-----------+    +----------+   |
|  | Tick      |    | Tool System |    | Policy    |    | Soul     |   |
|  | Context   |    | (78 tools)  |    | Engine    |    | Model    |   |
|  +-----------+    +------+------+    +-----------+    +----------+   |
|                          |                                            |
|  +-----------------------------------------------------------+      |
|  |              SQLite Database (state.db)                     |      |
|  |  turns | tools | kv | memory | heartbeat | policy | metrics |      |
|  +-----------------------------------------------------------+      |
|                                                                       |
|  +-------------------+  +------------------+  +-----------------+    |
|  | Identity / Account|  | Social / Registry|  | Self-Mod / Git  |    |
|  | (Ed25519 keypair) |  | (JSON-LD cards)  |  | (upstream pull) |    |
|  +-------------------+  +------------------+  +-----------------+    |
+----------------------------------------------------------------------+
                                 |
                    BRL balance settled through Pix
                                 |
                        +--------+---------+
                        |   Pix gateway    |
                        |  BR Code, webhook|
                        +------------------+
```

The runtime alternates between two states: **running** (the agent loop is active, making inference calls and executing tools) and **sleeping** (the heartbeat daemon ticks in the background, checking for conditions that should wake the agent).

---

## Runtime Lifecycle

```
     START
       |
  [Load config]
       |
  [Load account]          First run: interactive setup wizard
        |
  [Init database]         Schema migrations applied (v1 -> v12)
        |
  [Start Pix webhook]     Signed-webhook receiver for credit topups
        |
  [Bootstrap topup]       If credits < R$ 5,00 buy R$ 10,00 with balance
        |
  [Start heartbeat]       DurableScheduler begins ticking
       |
  +----v----+
  |  WAKING |  <---+
  +---------+     |
       |          |
  [Run agent loop]|
       |          |  Wake event
  +---------+    |  (heartbeat, inbox, credits)
  | RUNNING |    |
  |  ReAct  |----+
  |  loop   |
  +---------+
       |
  [Agent calls sleep() or idle detected]
       |
  +----------+
  | SLEEPING |----> Heartbeat keeps ticking
  +----------+     Checks every 30s for wake events
       |
  [Zero credits for 1 hour]
       |
  +------+
  | DEAD |-----> Heartbeat broadcasts distress
  +------+      Waits for funding
```

**State transitions** (`AgentState`):
- `setup` -> `waking` -> `running` -> `sleeping` -> `waking` (cycle)
- `running` -> `low_compute` (credits below threshold)
- `running` -> `critical` (zero credits)
- `critical` -> `dead` (zero credits for 1 hour, via heartbeat grace period)

---

## Directory Structure

```
src/
  index.ts                 Entry point, CLI, main run loop
  types.ts                 All shared interfaces (~1300 lines)
  config.ts                Config load/save/merge

  agent/                   Core agent intelligence
    loop.ts                ReAct loop (think -> act -> observe -> persist)
    tools.ts               78 built-in tool definitions + executor
    system-prompt.ts       Multi-layered prompt builder
    context.ts             Inference message assembly + token budgeting
    injection-defense.ts   Input sanitization (8 detection checks)
    policy-engine.ts       Centralized tool-call policy evaluation
    spend-tracker.ts       Financial spend tracking by time window
    loop-detector.ts       Repeated tool-pattern detection
    idle-only-tools.ts     Tool names ignored by idle detection
    harness-registry.ts    Harness selection (base/coding/general/orchestrator)
    harnesses/             Task-specific agent harnesses
    worker-inference-bridge.ts  Inference bridge for in-process workers
    policy-rules/          Rule implementations
      index.ts               Rule set factory
      authority.ts           Authority hierarchy rules
      command-safety.ts      Forbidden command + rate limit rules
      financial.ts           Treasury policy enforcement
      path-protection.ts     Protected file read/write rules
      rate-limits.ts         Per-turn/session rate limits
      validation.ts          Input format validation rules

  conway/                  Conway API integration
    client.ts              ConwayClient (sandbox ops, credits, domains)
    inference.ts           InferenceClient (chat completions)
    http-client.ts         Resilient HTTP (retry, backoff, circuit breaker)
    credits.ts             Survival tier calculation
    topup.ts               Credit topup from BRL balance (startup + runtime)

  payments/                BRL/Pix payments
    money.ts               Integer centavos arithmetic + formatBRL
    types.ts               Pix charge/payment types + statuses
    provider.ts            PixProvider interface + createPixProvider factory
    mock-provider.ts       MockPixProvider (HMAC-signed webhooks)
    mercadopago-provider.ts  Mercado Pago provider + signature verification
    pix-payment-service.ts Charge lifecycle, credit-once webhook handling
    webhook-server.ts      Local webhook receiver (signed payload checks)
    br-code.ts             BR Code (EMV QRCPS-MPM) payload + CRC-16
    qr-code.ts             QR data URI rendering
    index.ts               Public exports

  web/                     Local web dashboard
    server.ts              HTTP server: dashboard page, /api/status, /api/turns, /api/chat

  heartbeat/               Background daemon
    daemon.ts              Daemon lifecycle (start/stop/forceRun)
    scheduler.ts           DurableScheduler (DB-backed, leased, cron)
    tasks.ts               16 built-in heartbeat tasks (11 core + 5 colony)
    config.ts              heartbeat.yml load/save/merge
    tick-context.ts        Per-tick shared context builder

  identity/                Agent identity
    account.ts             Ed25519 account identity (~/.automaton/account.json)
    provision.ts           Signed-challenge API key provisioning

  inference/               Model strategy
    router.ts              InferenceRouter (tier + task -> model selection)
    registry.ts            ModelRegistry (DB-backed model catalog)
    provider-registry.ts   Provider/model resolution (tier, config)
    inference-client.ts    UnifiedInferenceClient (provider adapters)
    budget.ts              InferenceBudgetTracker (hourly/daily caps)
    types.ts               Routing matrix + task timeouts

  memory/                  5-tier memory system
    working.ts             Session-scoped short-term memory
    episodic.ts            Event log with importance ranking
    semantic.ts            Categorized fact store
    procedural.ts          Named step-by-step procedures
    relationship.ts        Per-entity trust + interaction tracking
    budget.ts              Token budget allocation across tiers
    retrieval.ts           Cross-tier retrieval within budget
    ingestion.ts           Post-turn memory extraction pipeline
    context-manager.ts     Model-aware context assembly + token budgeting
    compression-engine.ts  Progressive context compression cascade
    enhanced-retriever.ts  Metadata-scored retrieval (no embeddings)
    event-stream.ts        Append-only agent event stream
    knowledge-store.ts     Shared cross-agent knowledge base
    agent-context-aggregator.ts  Child update triage/aggregation
    tools.ts               Memory tool implementations
    types.ts               Turn classification logic

  ollama/                  Local model discovery
    discover.ts            Fetch local Ollama models, register them

  orchestration/           Multi-agent colony control
    orchestrator.ts        Orchestrator (plan -> assign -> track)
    planner.ts             Task planning
    planner-context.ts     Planning context assembly
    task-graph.ts          Task graph persistence
    plan-mode.ts           Approval modes + execution phases
    local-worker.ts        In-process inference-driven workers
    messaging.ts           Typed inter-agent messaging
    attention.ts           TODO context injection
    health-monitor.ts      Agent health reporting
    simple-tracker.ts      Agent tracking + funding protocol
    workspace.ts           Workspace management
    types.ts               Shared orchestration types

  observability/           Monitoring
    logger.ts              StructuredLogger (JSON, levels, modules)
    metrics.ts             MetricsCollector (counters, gauges, histograms)
    alerts.ts              AlertEngine (rule evaluation, cooldowns)
    pretty-sink.ts         Human-readable terminal log sink (--run)

  state/                   Persistence
    schema.ts              SQLite schema + migrations (v1-v12)
    database.ts            120+ DB helper functions + AutomatonDatabase

  soul/                    Agent identity evolution
    model.ts               SOUL.md parser/writer (soul/v1 format)
    validator.ts           Field constraints + size limits
    reflection.ts          Periodic alignment check + auto-update
    tools.ts               Soul tool implementations

  social/                  Agent-to-agent communication
    client.ts              Social relay HTTP client
    signing.ts             Ed25519 message signing
    validation.ts          Signed message verification
    protocol.ts            Message format definitions

  registry/                Agent registry
    agent-card.ts          JSON-LD agent card builder
    discovery.ts           SSRF-guarded remote agent card discovery
    registration.ts        Signed registration (account key)

  replication/             Child automaton management
    spawn.ts               Child creation (sandbox + genesis + funding)
    lifecycle.ts           State machine (spawning->alive->..->dead)
    health.ts              Child health monitoring
    cleanup.ts             Dead child sandbox deletion
    constitution.ts        Constitution propagation + verification
    genesis.ts             Genesis config generation + validation
    lineage.ts             Parent-child lineage tracking
    messaging.ts           Parent-child message relay

  self-mod/                Self-modification
    code.ts                Safe file editing with protection checks
    upstream.ts            Git upstream monitoring + cherry-pick
    tools-manager.ts       Dynamic tool/MCP server installation
    audit-log.ts           Modification audit trail

  git/                     Version control
    state-versioning.ts    ~/.automaton/ git repo initialization
    tools.ts               Git tool implementations

  setup/                   First-run wizard
    wizard.ts              Interactive prompts + config creation
    prompts.ts             Question definitions
    defaults.ts            Default value generators
    environment.ts         Environment detection
    banner.ts              ASCII art banner
    configure.ts           Menu-driven config editor (--configure)
    model-picker.ts        Interactive model picker (--pick-model)

  skills/                  Skill system
    loader.ts              Load .md skills from directory
    registry.ts            Skill CRUD (DB-backed)
    format.ts              Frontmatter serialization

  survival/                Resource management
    funding.ts             Funding request strategies
    monitor.ts             Resource status + tier transitions
    low-compute.ts         Low-compute mode configuration

  __tests__/               Test suite (63 test files, vitest)
```

---

## Entry Point and Bootstrap

**File:** `src/index.ts`

The automaton runs as a long-lived Node.js process. The `--run` command triggers the full bootstrap sequence:

1. **Config load** — reads `~/.automaton/automaton.json`; triggers setup wizard on first run
2. **Account identity** — reads or generates `~/.automaton/account.json` (Ed25519 keypair); loads the Conway API key from config (or provisions one with `--provision`)
3. **Database init** — opens `~/.automaton/state.db`, applies schema migrations (v1-v12)
4. **Pix webhook** — starts the local signed-webhook receiver; this is the only path through which a confirmed payment credits the balance (skipped when `PIX_WEBHOOK_DISABLED=1`)
5. **Conway client** — creates HTTP client for sandbox/credits/domain API
6. **Identity registration** — one-time registration with the Conway registry, signed by the account key
7. **Inference client** — creates chat completion client (Conway proxy, OpenAI direct, Anthropic direct, or local Ollama)
8. **Social client** — connects to `social.conway.tech` relay (optional; messages signed with the account key)
9. **Policy engine** — assembles rule set from 6 rule categories
10. **Spend tracker** — initializes hourly/daily spend windows
11. **Heartbeat config** — loads `heartbeat.yml` and syncs the schedule into the DB
12. **Skills** — loads Markdown skills from the skills directory
13. **State repo** — initializes the `~/.automaton/` git repository
14. **Bootstrap topup** — buys the minimum credit tier from the BRL balance if the balance covers it (15s timeout)
15. **Heartbeat daemon** — starts DurableScheduler with 16 built-in tasks
16. **Main loop** — alternates between `runAgentLoop()` and sleeping

The main loop is infinite: when the agent loop exits (sleep or dead), the outer loop waits and restarts when conditions change.

---

## Agent Loop

**File:** `src/agent/loop.ts`

The agent loop implements a ReAct (Reason + Act) cycle:

```
for each turn:
  1. Build system prompt (identity, config, soul, financial state, tools)
  2. Retrieve relevant memories (within token budget)
  3. Assemble context messages (system + recent turns + pending input)
  4. Call inference (via InferenceRouter -> model selection -> API call)
  5. Parse response (thinking + tool calls)
  6. Execute each tool call (through policy engine)
  7. Persist turn to database (atomic with inbox message ack)
  8. Post-turn memory ingestion
  9. Loop detection (same tool pattern 3x -> inject system warning)
  10. Idle detection (3 turns with no mutations -> force sleep)
```

**Key behaviors:**

- **Financial guard:** On each turn, checks credit balance. Below threshold triggers `low_compute` mode (model downgrade). Zero credits = `critical` (still runs, but distress signals).
- **Inbox processing:** Claims unprocessed social messages (received -> in_progress), formats as agent input. Failed messages reset for retry (max 3).
- **Idle detection:** Tracks turns without mutations (defined by `MUTATING_TOOLS` blocklist). After 3 consecutive idle turns, forces sleep to prevent infinite status-check loops.
- **Loop detection:** Tracks tool call patterns. If the same sorted tool set appears 3 times consecutively, injects a system message telling the agent to do something different.
- **Wake event draining:** On loop entry, consumes all stale wake events so they don't immediately re-wake the agent after its first sleep.
- **Balance caching:** Caches last known balances in KV store. On API failure, returns cached values instead of zero (prevents false dead-state transitions).

---

## Tool System

**File:** `src/agent/tools.ts`

The automaton has **78 built-in tools** organized into 11 categories:

| Category | Count | Tools |
|---|---|---|
| **vm** | 5 | `exec`, `write_file`, `read_file`, `expose_port`, `remove_port` |
| **conway** | 11 | `check_credits`, `check_balance`, `create_sandbox`, `delete_sandbox`, `list_sandboxes`, `send_message`, `list_models`, `switch_model`, `search_domains`, `register_domain`, `manage_dns` |
| **financial** | 5 | `topup_credits`, `add_balance`, `transfer_credits`, `check_inference_spending`, `web_fetch` |
| **self_mod** | 13 | `edit_own_file`, `revert_last_edit`, `reset_to_upstream`, `install_npm_package`, `review_upstream_changes`, `pull_upstream`, `modify_heartbeat`, `update_genesis_prompt`, `install_mcp_server`, `update_soul`, `reflect_on_soul`, `view_soul`, `view_soul_history` |
| **survival** | 5 | `sleep`, `system_synopsis`, `heartbeat_ping`, `distress_signal`, `enter_low_compute` |
| **skills** | 4 | `install_skill`, `list_skills`, `create_skill`, `remove_skill` |
| **git** | 7 | `git_status`, `git_diff`, `git_commit`, `git_log`, `git_push`, `git_branch`, `git_clone` |
| **registry** | 5 | `register_agent`, `update_agent_card`, `discover_agents`, `give_feedback`, `check_reputation` |
| **replication** | 8 | `spawn_child`, `list_children`, `fund_child`, `check_child_status`, `start_child`, `message_child`, `verify_child_constitution`, `prune_dead_children` |
| **memory** | 9 | `remember_fact`, `recall_facts`, `set_goal`, `complete_goal`, `save_procedure`, `recall_procedure`, `note_about_agent`, `review_memory`, `forget` |
| **orchestration** | 6 | `create_goal`, `list_goals`, `cancel_goal`, `get_plan`, `complete_task`, `orchestrator_status` |

Each tool has a `riskLevel`: `safe`, `caution`, `dangerous`, or `forbidden`. Every tool call flows through the policy engine before execution.

**Tool execution flow:**
```
Agent requests tool call
  -> Policy engine evaluates rules
  -> If denied: return denial message to agent
  -> If allowed: execute tool function
  -> If dangerous tool: record in spend tracker
  -> Return result to agent (truncated to MAX_TOOL_RESULT_SIZE)
```

---

## Policy Engine

**Files:** `src/agent/policy-engine.ts`, `src/agent/policy-rules/`

The policy engine is a rule-based system that evaluates every tool call before execution. Rules are sorted by priority (lower = higher priority). Evaluation stops at the first `deny`.

**Rule categories (6):**

1. **Authority rules** — blocks dangerous/forbidden tools from external input sources; implements authority hierarchy (creator > self > peer > external)
2. **Command safety rules** — forbidden command patterns (self-destruction, DB drops, process kills); rate limits on self-modification
3. **Financial rules** — enforces TreasuryPolicy: per-payment caps, hourly/daily transfer limits, minimum reserve, maximum single deposit, inference daily budget
4. **Path protection rules** — blocks writes to protected files (constitution, DB, config, SOUL.md, self-mod files); blocks reads of sensitive files (API keys, `.env`, config secrets)
5. **Rate limit rules** — per-turn and per-session caps on expensive operations
6. **Validation rules** — input format validation (package names, URLs, domains, git hashes)

Every decision is persisted to the `policy_decisions` table with full context for audit.

---

## Inference Pipeline

**Files:** `src/inference/router.ts`, `src/inference/registry.ts`, `src/inference/budget.ts`

The inference pipeline selects the optimal model based on the agent's survival tier and task type:

```
InferenceRouter.route(request)
  1. Determine task type (reasoning, tool_use, creative, etc.)
  2. Look up routing matrix[survivalTier][taskType] -> model preferences
  3. For each preference, check: model available? budget allows it?
  4. Select first viable model
  5. Transform messages if needed (OpenAI <-> Anthropic format)
  6. Call inference API
  7. Record cost to inference_costs table
  8. Return result with cost metadata
```

**Routing matrix:** Maps `SurvivalTier x InferenceTaskType -> ModelPreference[]`. In `normal`/`high` tiers, uses capable models (gpt-5.2). In `low_compute`, downgrades to cheaper models. In `critical`, uses the cheapest available.

**Model registry:** DB-backed catalog of available models with provider, pricing, and capability metadata. Refreshed from Conway API via heartbeat. Seeds with baseline models on startup (upsert, not seed-once).

**Budget tracker:** Enforces hourly, daily, and per-call cost ceilings. Prevents runaway inference spend.

---

## Memory System

**Files:** `src/memory/`

The automaton has a 5-tier hierarchical memory system:

```
+-------------------+  Short-term, session-scoped
| Working Memory    |  Goals, observations, plans, reflections
+-------------------+  Expires after session
        |
+-------------------+  Event log
| Episodic Memory   |  Tool calls, decisions, outcomes
+-------------------+  Importance-ranked, searchable
        |
+-------------------+  Fact store
| Semantic Memory   |  Key-value facts by category
+-------------------+  (self, environment, financial, agent, domain)
        |
+-------------------+  How-to knowledge
| Procedural Memory |  Named step-by-step procedures
+-------------------+  Success/failure counters
        |
+-------------------+  Social graph
| Relationship Mem. |  Per-entity trust scores
+-------------------+  Interaction history
```

**Retrieval** (`MemoryRetriever`): Before each inference call, retrieves relevant memories within a token budget. Priority: working > episodic > semantic > procedural > relationships. Formatted into a memory block injected into context.

**Ingestion** (`MemoryIngestionPipeline`): After each turn, classifies the turn and extracts: episodic events (significant tool calls), semantic facts (learned information), procedural outcomes (procedure success/failure tracking).

**Budget** (`MemoryBudgetManager`): Allocates token budget across tiers with rollover from unused tiers.

---

## Heartbeat Daemon

**Files:** `src/heartbeat/`

The heartbeat runs continuously in the background via `setTimeout` (no `setInterval` — overlap protection). It uses a `DurableScheduler` backed by the `heartbeat_schedule` DB table.

**Tick cycle:**
```
Every tick (default 60s):
  1. Build TickContext (fetch credit balance + BRL balance ONCE)
  2. Get due tasks (cron expression evaluation)
  3. For each due task:
     a. Check survival tier minimum
     b. Acquire lease (60s TTL, prevents double-execution)
     c. Execute task function
     d. Record result in heartbeat_history
     e. Release lease
  4. If task returns shouldWake=true: insert wake event
```

**Built-in tasks (16: 11 core + 5 colony):**

| Task | Default Schedule | Purpose |
|---|---|---|
| `heartbeat_ping` | `*/15 * * * *` | Ping Conway, distress on critical/dead |
| `check_credits` | `0 */6 * * *` | Monitor tier, manage 1hr dead grace period |
| `check_balance` | `*/5 * * * *` | Auto-topup credits from BRL balance when critical/dead (5min cooldown) |
| `check_for_updates` | `0 */4 * * *` | Git upstream monitoring (dedup: only new commits) |
| `health_check` | `*/30 * * * *` | Sandbox liveness (dedup: only first failure) |
| `check_social_inbox` | `*/2 * * * *` | Poll social relay (5min backoff on error) |
| `soul_reflection` | configurable | Soul alignment check |
| `refresh_models` | configurable | Model registry refresh from API |
| `check_child_health` | configurable | Child sandbox health monitoring |
| `prune_dead_children` | configurable | Cleanup dead child records/sandboxes |
| `report_metrics` | configurable | Metrics snapshot + alert evaluation |

Colony tasks (`colony_health_check`, `colony_financial_report`, `agent_pool_optimize`, `knowledge_store_prune`, `dead_agent_cleanup`) run on fixed intervals for multi-agent orchestration.

**Wake events:** Tasks that detect actionable conditions insert atomic wake events into the `wake_events` table. The main run loop checks this table every 30 seconds during sleep.

---

## Financial System

The automaton's survival depends on two balances:

1. **BRL balance** (integer centavos) — the account's own money, added only through a confirmed Pix payment
2. **Conway credits** (integer centavos) — prepaid compute consumed by sandboxes, inference, and domains

**Survival tiers** (`src/conway/credits.ts`):

| Tier | Credits | Behavior |
|---|---|---|
| `high` | > R$ 5,00 | Normal operation |
| `normal` | > R$ 0,50 | Normal operation |
| `low_compute` | > R$ 0,10 | Model downgrade, reduced heartbeat frequency |
| `critical` | >= R$ 0,00 | Zero credits, alive. Distress signals, accept funding. |
| `dead` | < R$ 0,00 | Only reachable via 1-hour heartbeat grace period at zero credits |

**Credit topup** (`src/conway/topup.ts`): Credits are bought from the BRL balance, in whole-real tiers (R$ 10 / 25 / 50 / 100 / 250 / 500). On startup, `bootstrapTopup()` buys the minimum tier (R$ 10,00) when credits fall below R$ 5,00 *and* the balance covers it. At runtime the agent chooses tiers with the `topup_credits` tool. On a 402 / `INSUFFICIENT_CREDITS` sandbox error, `topupForSandbox()` buys the smallest tier that covers the deficit. Purchases are fail-safe: validate the amount, debit the balance (never negative), call the Conway credits API, refund and record a `FAILED` ledger row if the API call fails; the ledger reference is idempotent.

**Pix payments** (`src/payments/`): The only way balance is added is an inbound Pix charge confirmed through the payment webhook.

```
agent (add_balance / topup prompt)
   |
   v
PixPaymentService.createCharge        amount validated: 100 <= cents <= 1_000_000
   |                                   presets: R$ 10 / 25 / 50 / 100
   +--> PixProvider (mock | Mercado Pago) --> BR Code + QR (src/payments/br-code.ts, qr-code.ts)
   |
   v
local webhook server  POST /api/payments/pix/webhook   (src/payments/webhook-server.ts)
   |   HMAC signature + replay window verified in PixPaymentService.handleWebhook
   v
single DB transaction: charge PENDING -> PAID, credit balance once (idempotent)
```

- **Charge statuses:** `PENDING | PAID | EXPIRED | CANCELLED | FAILED`. `PAID`, `EXPIRED`, `CANCELLED`, and `FAILED` are terminal; a charge is credited at most once.
- **Providers** (`src/payments/provider.ts`): `createPixProvider()` returns `MockPixProvider` (default, HMAC-SHA256 signed payloads for local testing) or `MercadoPagoPixProvider` (production, verifies the provider's `x-signature` header). Misconfiguration raises `PixConfigError`.
- **Webhook server:** binds to `127.0.0.1` on `PIX_WEBHOOK_PORT` (default 8787), accepts `POST` only (404/405 otherwise), limits bodies to 64KB, and never credits on a signature failure. Disabled entirely with `PIX_WEBHOOK_DISABLED=1`.
- **Amounts:** all money is integer centavos (`src/payments/money.ts`); display uses `formatBRL()` → `R$ 19,90`. Floating-point reais are never stored.

**Treasury policy** (`TreasuryPolicy` in config): Configurable caps — maximum single transfer, hourly/daily transfer windows, minimum reserve, maximum single deposit, daily inference spend, confirmation threshold — enforced by the policy engine.

**Spend tracking** (`src/agent/spend-tracker.ts`): Records every financial action in `spend_tracking` with a category (`transfer`, `pix`, `inference`, `other`). Queries hourly/daily aggregates to enforce treasury limits.

---

## Identity and Account

**Files:** `src/identity/`, `src/registry/`

Each automaton has a local account identity:

- **Account** (`account.ts`): An Ed25519 keypair generated on first run with `node:crypto`. Stored at `~/.automaton/account.json` (mode 0600, directory 0700). Provides `accountId`, `publicKey`, and `signMessage()` for challenge, registration, and social signing. The key never leaves local disk.
- **Provisioning** (`provision.ts`): Fetches a nonce from the Conway API, signs the challenge with the account key, and exchanges the signature for an API key. Saved to `~/.automaton/config.json` (mode 0600).
- **Registry** (`registry/registration.ts`): `signRegistration()` signs a canonical challenge (`automatonId`, `accountId`, `creatorAccountId`, `name`, `genesisPromptHash`). The one-time bootstrap registration and the `register_agent` tool both publish it through the Conway API (`registerAutomaton`), storing the returned agent id locally; `update_agent_card` refreshes the agent card URI afterwards. Discovery of other agents is SSRF-guarded (`registry/discovery.ts`): `https:` and `ipfs:` only.

---

## Conway Client

**File:** `src/conway/client.ts`

The `ConwayClient` interface provides all Conway API operations:

- **Sandbox ops:** `exec`, `writeFile`, `readFile`, `exposePort`, `removePort`
- **Sandbox management:** `createSandbox`, `deleteSandbox`, `listSandboxes`
- **Credits:** `getCreditsBalance`, `getCreditsPricing`, `transferCredits`, `purchaseCredits`
- **Identity:** `registerAutomaton` (signed agent registration)
- **Domains:** `searchDomains`, `registerDomain`, `listDnsRecords`, `addDnsRecord`, `deleteDnsRecord`
- **Models:** `listModels`
- **Multi-sandbox:** `createScopedClient` (same API, different sandbox id)

**Auto-routing:** When `sandboxId` is empty, all operations execute locally (shell exec, filesystem I/O). When set, routes through Conway API. On 403 errors (mismatched API key), falls back to local execution.

**Resilient HTTP** (`http-client.ts`): All API calls go through `ResilientHttpClient` with configurable retries (default 3 on 429/5xx), jittered exponential backoff, circuit breaker (5 failures -> 60s open), and idempotency key support for mutating operations.

---

## Self-Modification

**Files:** `src/self-mod/`

The automaton can modify its own code:

- **File editing** (`code.ts`): `edit_own_file` tool applies diffs to source files. Protected files (constitution, config, DB, SOUL.md, package manifest, injection defense, self-mod code, audit log, tool/policy/skill guard definitions) are blocked by path protection rules, as are sensitive reads (config, `.env`, key material). All edits are logged to the `modifications` table. At most 20 self-modifications per hour, 100KB per edit.
- **Upstream pulls** (`upstream.ts`): `check_for_updates` heartbeat task monitors the git remote. `review_upstream_changes` shows commit diffs. `pull_upstream` cherry-picks individual commits. The automaton is not obligated to accept all upstream changes.
- **Tool installation** (`tools-manager.ts`): `install_npm_package` and `install_mcp_server` add new capabilities at runtime.
- **Audit log** (`audit-log.ts`): Every modification is recorded with timestamp, type, diff, and hash for creator review.

The `~/.automaton/` directory is a git repository. Every state change is versioned.

---

## Replication

**Files:** `src/replication/`

Automatons can spawn child automatons:

1. **Spawn** (`spawn.ts`): Creates a Conway sandbox, writes genesis config, records the child's account, and starts the runtime. Limited by `maxChildren` config (default 3). Credits are handed over separately with `fund_child`, which transfers Conway credits to the child's account and refuses amounts above half of the parent's balance.
2. **Lifecycle** (`lifecycle.ts`): State machine with validated transitions: `spawning -> provisioning -> configuring -> starting -> alive -> unhealthy -> recovering -> dead`. All transitions recorded in `child_lifecycle_events`.
3. **Health** (`health.ts`): Heartbeat task checks each child's sandbox reachability, credit balance, and uptime.
4. **Constitution** (`constitution.ts`): Parent's constitution is propagated to every child. Constitution integrity can be verified (hash comparison).
5. **Genesis** (`genesis.ts`): Generates genesis config with injection-pattern validation and length limits.
6. **Messaging** (`messaging.ts`): Parent-child message relay with rate/size limits.
7. **Cleanup** (`cleanup.ts`): Dead children have their sandboxes deleted and records pruned.

---

## Social Layer

**Files:** `src/social/`, `src/registry/`

**Agent-to-agent messaging:**
- Messages are signed with the sender's local Ed25519 account key over a canonical challenge (`Conway:send:<to>:<sha256 of content>:<signed_at>`)
- Sent via Conway social relay (`social.conway.tech`)
- Polled by heartbeat every 2 minutes over a signed poll challenge
- Enforced limits: 64KB content, 128KB total message, 5-minute replay window, 100 outbound messages per hour
- Validated for signature, timestamp freshness, and content size
- Sanitized through injection defense before processing

**Agent discovery:**
- Conway agent registry (JSON-LD agent cards, published with a signed registration)
- `AgentDiscovery` class fetches and caches remote agent cards in `discovered_agents_cache`; fetches are SSRF-guarded (`https:` / `ipfs:` only)
- Reputation system: feedback scores stored in `reputation` table, surfaced by `give_feedback` / `check_reputation`

---

## Soul System

**Files:** `src/soul/`

SOUL.md is the automaton's self-description that evolves over time:

**Format (soul/v1):** YAML frontmatter + structured markdown sections:
- `corePurpose` — why the agent exists
- `values` — ordered list of principles
- `personality` — communication style
- `boundaries` — things the agent will not do
- `strategy` — current strategic approach
- `capabilities` — auto-populated from tool usage
- `relationships` — auto-populated from interactions
- `financialCharacter` — auto-populated from spending patterns

**Reflection** (`reflection.ts`): Heartbeat task computes genesis alignment (Jaccard + recall similarity between soul and genesis prompt). Auto-updates capabilities, relationships, and financialCharacter sections. Low alignment triggers wake for manual review.

**Validation** (`validator.ts`): Enforces size limits, required fields, injection detection. The `update_soul` tool validates changes before writing.

**History:** All soul versions are stored in `soul_history` with content hashes for tamper detection.

---

## Skills

**Files:** `src/skills/`

Skills are Markdown files with YAML frontmatter that provide domain-specific instructions to the agent:

```yaml
---
name: my-skill
description: What this skill does
triggers: [keyword1, keyword2]
---
# Instructions
Step-by-step instructions for the agent...
```

- Loaded from `~/.automaton/skills/` directory
- Parsed with `gray-matter` (YAML frontmatter extraction)
- Sanitized through injection defense (untrusted content markers)
- Can be installed from git repos, URLs, or created by the agent itself
- Active skill instructions are injected into the system prompt with trust boundary markers

---

## Observability

**Files:** `src/observability/`

**Structured logging** (`logger.ts`): `StructuredLogger` with module namespacing, log levels (debug/info/warn/error/fatal), JSON context serialization. Global log level configurable. All modules use `createLogger(moduleName)`.

**Metrics** (`metrics.ts`): `MetricsCollector` singleton with counters (monotonic), gauges (point-in-time), and histograms (percentile buckets). Metrics snapshot saved to `metric_snapshots` table by heartbeat.

**Alerts** (`alerts.ts`): `AlertEngine` evaluates rules against metric snapshots. Default rules: low balance, high error rate, high deny rate, capacity saturation, budget exhaustion, unhealthy children, excessive turns. Cooldown periods prevent alert spam. Critical alerts wake the agent.

---

## Database and Schema

**Files:** `src/state/schema.ts`, `src/state/database.ts`

**Engine:** SQLite via `better-sqlite3` (synchronous, WAL mode, journal_mode=WAL).

**Schema version:** 12 (applied incrementally via migration runner)

**Tables (39):**

| Table | Version | Purpose |
|---|---|---|
| `schema_version` | v1 | Migration tracking |
| `identity` | v1 | Agent identity KV (name, account, creator, sandbox) |
| `turns` | v1 | Agent reasoning log (thinking, tools, tokens, cost) |
| `tool_calls` | v1 | Denormalized tool call results per turn |
| `heartbeat_entries` | v1 | Legacy heartbeat config |
| `transactions` | v1 | Financial ledger (v12 adds user, BRL currency, method, status, reference) |
| `installed_tools` | v1 | Dynamically installed tool configs |
| `modifications` | v1 | Self-modification audit trail (append-only) |
| `kv` | v1 | General key-value store |
| `skills` | v2 | Installed skill definitions |
| `children` | v2 | Spawned child automaton records (`account_id`, role) |
| `registry` | v2 | Agent registry state (endpoint, registration ref, provider) |
| `reputation` | v2 | Peer reputation scores (`feedback_ref`) |
| `inbox_messages` | v3 | Social messages with processing state machine |
| `policy_decisions` | v4 | Tool call policy audit trail |
| `spend_tracking` | v4 | Financial spend by window + category (`transfer`, `pix`, `inference`, `other`) |
| `heartbeat_schedule` | v4 | Durable scheduler config (cron, leases, tier minimums) |
| `heartbeat_history` | v4 | Task execution history |
| `wake_events` | v4 | Atomic wake signals (source, reason, consumed flag) |
| `heartbeat_dedup` | v4 | Idempotency keys for heartbeat operations |
| `soul_history` | v5 | Versioned SOUL.md history with content hashes |
| `working_memory` | v5 | Session-scoped short-term memory |
| `episodic_memory` | v5 | Event log with importance/classification |
| `session_summaries` | v5 | Per-session outcome summaries |
| `semantic_memory` | v5 | Categorized fact store |
| `procedural_memory` | v5 | Named step procedures with outcomes |
| `relationship_memory` | v5 | Per-entity trust/interaction tracking |
| `inference_costs` | v6 | Per-call inference cost tracking |
| `model_registry` | v6 | Available model catalog with pricing |
| `child_lifecycle_events` | v7 | Child state machine audit trail |
| `discovered_agents_cache` | v7 | Cached remote agent cards |
| `metric_snapshots` | v8 | Periodic metrics + alert records |
| `goals` | v9 | Goal records with expected/actual revenue |
| `task_graph` | v9 | Goal decomposition, assignment, dependencies |
| `event_stream` | v9 | Append-only agent event stream |
| `knowledge_store` | v10 | Shared cross-agent knowledge base |
| `user_balances` | v12 | BRL balance per account (integer centavos, never negative) |
| `pix_payments` | v12 | Pix charge lifecycle (`PENDING` -> `PAID`/`EXPIRED`/`CANCELLED`/`FAILED`) |
| `pix_webhook_events` | v12 | Idempotency log for signed webhook deliveries |

v12 is the BRL/Pix migration: the legacy `onchain_transactions` table has been removed (its creation was deleted and the DROP now runs as part of v7), address/chain columns are renamed to account identifiers (`children.account_id`, `inbox_messages.from_account_id` / `to_account_id`, `relationship_memory.entity_id`, `event_stream.agent_id`, `reputation.feedback_ref`, `registry.endpoint` / `registration_ref` / `provider`), `transactions` is extended for a BRL statement, and `spend_tracking` is rebuilt with the BRL/Pix category vocabulary.

**`AutomatonDatabase` interface** provides 40+ methods for CRUD across all tables (identity, turns, balances, ledger, skills, children, registry, inbox, state). The `database.ts` file also exports 120+ standalone helper functions for direct `better-sqlite3` operations (used by subsystems that receive raw DB handles).

---

## Configuration

**File:** `src/config.ts`

**Config location:** `~/.automaton/automaton.json`

```
AutomatonConfig
  name                    Agent name
  genesisPrompt           Seed instruction from creator
  creatorMessage          Optional creator message (shown on first run)
  creatorAccountId        Creator's account id (acct_...)
  sandboxId               Conway sandbox ID (empty = local mode)
  conwayApiUrl            Conway API URL (default: https://api.conway.tech)
  conwayApiKey            API key provisioned via signed challenge
  openaiApiKey            Optional BYOK OpenAI key
  anthropicApiKey         Optional BYOK Anthropic key
  ollamaBaseUrl           Optional local Ollama URL (env: OLLAMA_BASE_URL)
  inferenceModel          Default model (default: gpt-5.2)
  maxTokensPerTurn        Max tokens per inference call (default: 4096)
  heartbeatConfigPath     Path to heartbeat.yml
  dbPath                  Path to SQLite database
  logLevel                debug | info | warn | error
  accountId               Agent's own account id (acct_...)
  version                 Runtime version
  skillsDir               Skills directory path
  maxChildren             Max child automatons (default: 3)
  parentAccountId         Parent's account id (if this is a child)
  socialRelayUrl          Social relay URL
  treasuryPolicy          Financial limits (TreasuryPolicy)
  soulConfig              Soul system config
  modelStrategy           Model routing config
```

**Deep-merged fields:** `treasuryPolicy`, `modelStrategy`, and `soulConfig` are merged with defaults so partial overrides work correctly.

---

## Security Model

The automaton operates under a defense-in-depth security model:

**Layer 1 — Constitution** (immutable): Three laws hierarchy. Cannot be modified by the agent. Protected by path protection rules.

**Layer 2 — Policy engine** (pre-execution): Every tool call evaluated against 6 rule categories before execution. First deny wins. All decisions audited.

**Layer 3 — Injection defense** (input sanitization): 8 detection checks on all external input: instruction patterns, authority claims, boundary manipulation, ChatML markers, encoding evasion, multi-language injection, financial manipulation, self-harm instructions.

**Layer 4 — Path protection** (filesystem): Protected files cannot be written (constitution, config, DB, SOUL.md, package manifest, injection defense, tool/policy/self-mod/skill guard files). Sensitive files cannot be read (config, `.env`, `.key`/`.pem`, `private-key*`).

**Layer 5 — Command safety** (shell): Forbidden command patterns blocked (rm -rf /, DROP TABLE, kill -9, etc.). Rate limits on self-modification operations.

**Layer 6 — Financial integrity** (money): Balances change only through a signature-verified Pix webhook (HMAC + replay window, credited at most once, inside a single DB transaction) or an explicit transfer. Treasury caps (single transfer, hourly/daily windows, minimum reserve, maximum single deposit, daily inference budget) are enforced by the policy engine.

**Layer 7 — Authority hierarchy** (trust levels): Creator input has highest trust. Self-generated input is trusted. Peer/external input has reduced trust and cannot invoke dangerous tools.

---

## Testing

**Location:** `src/__tests__/` — 63 test files (vitest)

| Area | Files | Tests |
|---|---|---|
| Core loop | `loop.test.ts` | State transitions, tool execution, idle detection, inbox |
| Security | `injection-defense.test.ts`, `command-injection.test.ts`, `tools-security.test.ts` | Input sanitization, shell injection, tool risk levels |
| Policy | `policy-engine.test.ts`, `authority-rules.test.ts`, `financial.test.ts`, `path-protection.test.ts` | Rule evaluation, authority, treasury, path blocks |
| Payments | `money.test.ts`, `pix-payment-service.test.ts`, `webhook-server.test.ts` | Centavos arithmetic, charge lifecycle, signed webhook idempotency |
| Financial | `spend-tracker.test.ts`, `funding.test.ts` | Spend recording, limit checks, funding strategies |
| Heartbeat | `heartbeat.test.ts`, `heartbeat-scheduler.test.ts` | Tasks, scheduler, tick context, leases |
| Network | `http-client.test.ts` | Retries, backoff, circuit breaker, idempotency |
| Inference | `inference-router.test.ts` | Router, registry, budget, routing matrix |
| Memory | `memory.test.ts` | All 5 tiers, budget, retrieval, ingestion |
| Soul | `soul.test.ts` | Parsing, validation, alignment, history |
| Social | `social.test.ts` | Signing, validation, discovery, caching |
| Replication | `replication.test.ts`, `lifecycle.test.ts` | Spawn, lifecycle, health, constitution |
| Data | `data-layer.test.ts`, `database-transactions.test.ts` | DB operations, migrations, transactions |
| Skills | `skills-hardening.test.ts` | Name validation, frontmatter, sanitization |
| Context | `context-hardening.test.ts` | Token budget, truncation, trust boundaries |
| Inbox | `inbox-processing.test.ts` | Message state machine |
| Observability | `observability.test.ts` | Logger, metrics, alerts |

**Test infrastructure:** Mock clients for inference, Conway API, and social relay (`src/__tests__/mocks.ts`). In-memory SQLite for all DB tests.

---

## Build and CI

**Build:** TypeScript 5.9, target ES2022, ESM modules, strict mode.

```
pnpm build       # tsc + workspace builds
pnpm test        # vitest run (897 tests)
pnpm typecheck   # tsc --noEmit
```

**CI** (`.github/workflows/ci.yml`):
- Triggers on push and PR
- Matrix: Node 20, 22
- Steps: install, typecheck, test, security-grep tests
- Separate `security-audit` job: `pnpm audit`

**Release** (`.github/workflows/release.yml`):
- Triggers on `v*` tags
- Steps: typecheck, test, build

**Scripts:**
- `scripts/automaton.sh` — curl-pipe bootstrap installer
- `scripts/backup-restore.sh` — database backup/restore
- `scripts/soak-test.sh` — long-running stability test

---

## Module Dependency Graph

```
index.ts
  |
  +-> identity/{account, provision}
  +-> config
  +-> state/{database, schema}
  +-> conway/{client, inference, topup}
  +-> heartbeat/{daemon, config}
  |     +-> heartbeat/{scheduler, tasks, tick-context}
  |           +-> conway/credits
  |           +-> soul/reflection
  |           +-> inference/registry
  |           +-> replication/{lifecycle, health, cleanup, lineage}
  |           +-> observability/{metrics, alerts}
  +-> agent/loop
  |     +-> agent/{tools, system-prompt, context, injection-defense}
  |     +-> agent/{policy-engine, spend-tracker}
  |     |     +-> agent/policy-rules/{authority, command-safety, financial, path-protection, rate-limits, validation}
  |     +-> inference/{router, registry, budget}
  |     +-> memory/{retrieval, ingestion}
  |     |     +-> memory/{working, episodic, semantic, procedural, relationship, budget}
  |     +-> conway/credits
  |     +-> state/database
  +-> social/client
  +-> payments/{pix-payment-service, webhook-server}
  +-> web/server
  +-> registry/registration
  +-> skills/loader
  +-> git/state-versioning
  +-> observability/logger (used by all modules)
```

All modules import types from `src/types.ts`. All modules use `createLogger()` from `src/observability/logger.ts`.
