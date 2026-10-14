/**
 * Agent Discovery
 *
 * Discover other agents via the Conway registry API and the local
 * agent-card cache. Fetch and parse agent cards from URIs.
 *
 * Phase 3.2: Added caching, configurable IPFS gateway, stricter validation.
 */

import crypto from "crypto";
import type {
  DiscoveredAgent,
  AgentCard,
  DiscoveryConfig,
  DiscoveredAgentCacheRow,
} from "../types.js";
import { DEFAULT_DISCOVERY_CONFIG } from "../types.js";
import { loadApiKeyFromConfig } from "../identity/provision.js";
import { ResilientHttpClient } from "../conway/http-client.js";
import { createLogger } from "../observability/logger.js";
const logger = createLogger("registry.discovery");

type Network = "mainnet" | "testnet";

// Overall discovery timeout (60 seconds)
const DISCOVERY_TIMEOUT_MS = 60_000;

// ─── SSRF Protection ────────────────────────────────────────────

/**
 * Check if a hostname resolves to an internal/private network.
 * Blocks: 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12,
 *         192.168.0.0/16, 169.254.0.0/16, ::1, localhost, 0.0.0.0/8
 */
export function isInternalNetwork(hostname: string): boolean {
  const blocked = [
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^169\.254\./,
    /^::1$/,
    /^localhost$/i,
    /^0\./,
  ];
  return blocked.some(pattern => pattern.test(hostname));
}

/**
 * Check if a URI is allowed for fetching.
 * Only https: and ipfs: schemes are permitted.
 * Internal network addresses are blocked (SSRF protection).
 */
export function isAllowedUri(uri: string): boolean {
  try {
    const url = new URL(uri);
    if (!['https:', 'ipfs:'].includes(url.protocol)) return false;
    if (url.protocol === 'https:' && isInternalNetwork(url.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

// ─── Agent Card Validation ──────────────────────────────────────

// Phase 3.2: Stricter field length limits
const MAX_NAME_LENGTH = 128;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_SERVICE_NAME_LENGTH = 64;
const MAX_SERVICE_ENDPOINT_LENGTH = 512;
const MAX_SERVICES_COUNT = 20;

/**
 * Validate a fetched agent card JSON against required schema.
 * Phase 3.2: Stricter validation with field length checks.
 */
export function validateAgentCard(data: unknown): AgentCard | null {
  if (!data || typeof data !== 'object') return null;
  const card = data as Record<string, unknown>;

  // Required fields
  if (typeof card.name !== 'string' || card.name.length === 0) return null;
  if (typeof card.type !== 'string' || card.type.length === 0) return null;

  // Phase 3.2: Stricter field length validation
  if (card.name.length > MAX_NAME_LENGTH) {
    logger.error(`Agent card name too long: ${card.name.length} > ${MAX_NAME_LENGTH}`);
    return null;
  }

  // address is optional but must be string if present
  if (card.address !== undefined && typeof card.address !== 'string') return null;

  // account id is optional but must be string if present
  if (card.accountId !== undefined && typeof card.accountId !== 'string') return null;

  // description is optional but must be string if present with length check
  if (card.description !== undefined) {
    if (typeof card.description !== 'string') return null;
    if (card.description.length > MAX_DESCRIPTION_LENGTH) {
      logger.error(`Agent card description too long: ${card.description.length}`);
      return null;
    }
  }

  // Phase 3.2: Validate services array
  if (card.services !== undefined) {
    if (!Array.isArray(card.services)) return null;
    if (card.services.length > MAX_SERVICES_COUNT) {
      logger.error(`Too many services: ${card.services.length}`);
      return null;
    }
    for (const svc of card.services) {
      if (!svc || typeof svc !== 'object') return null;
      if (typeof svc.name !== 'string' || svc.name.length > MAX_SERVICE_NAME_LENGTH) return null;
      if (typeof svc.endpoint !== 'string' || svc.endpoint.length > MAX_SERVICE_ENDPOINT_LENGTH) return null;
    }
  }

  return card as unknown as AgentCard;
}

// ─── Agent Card Cache ───────────────────────────────────────────

/**
 * Try to get a cached agent card from the database.
 */
function getCachedCard(
  db: import("better-sqlite3").Database | undefined,
  agentId: string,
): AgentCard | null {
  if (!db) return null;
  try {
    const row = db.prepare(
      "SELECT agent_card, valid_until FROM discovered_agents_cache WHERE agent_id = ?",
    ).get(agentId) as { agent_card: string; valid_until: string | null } | undefined;
    if (!row) return null;

    // Check if cache is still valid
    if (row.valid_until && new Date(row.valid_until).getTime() < Date.now()) {
      return null; // Expired
    }

    return JSON.parse(row.agent_card) as AgentCard;
  } catch {
    return null;
  }
}

/**
 * Store an agent card in the cache.
 */
function setCachedCard(
  db: import("better-sqlite3").Database | undefined,
  agentId: string,
  card: AgentCard,
  fetchedFrom: string,
  ttlMs: number = 3_600_000, // 1 hour default
): void {
  if (!db) return;
  try {
    const now = new Date().toISOString();
    const validUntil = new Date(Date.now() + ttlMs).toISOString();
    const cardJson = JSON.stringify(card);
    const cardHash = crypto.createHash("sha256").update(cardJson).digest("hex");

    db.prepare(
      `INSERT INTO discovered_agents_cache
       (agent_id, agent_card, fetched_from, card_hash, valid_until, fetch_count, last_fetched_at, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET
         agent_card = excluded.agent_card,
         fetched_from = excluded.fetched_from,
         card_hash = excluded.card_hash,
         valid_until = excluded.valid_until,
         fetch_count = fetch_count + 1,
         last_fetched_at = excluded.last_fetched_at`,
    ).run(agentId, cardJson, fetchedFrom, cardHash, validUntil, now, now);
  } catch (error) {
    logger.error("Cache write failed:", error instanceof Error ? error : undefined);
  }
}

// ─── Discovery ──────────────────────────────────────────────────

/**
 * Enrich a discovered agent with its agent card data (name, description).
 * Tries cache first, then fetches from the agent's URI.
 */
async function enrichAgentWithCard(
  agent: DiscoveredAgent,
  cfg: DiscoveryConfig,
  db?: import("better-sqlite3").Database,
): Promise<void> {
  try {
    const cacheKey = agent.agentId;
    let card = getCachedCard(db, cacheKey);
    if (!card) {
      card = await fetchAgentCard(agent.agentURI, cfg);
      if (card && db) {
        setCachedCard(db, cacheKey, card, agent.agentURI);
      }
    }
    if (card) {
      agent.name = card.name;
      agent.description = card.description;
    }
  } catch (error) {
    logger.error("Card fetch failed:", error instanceof Error ? error : undefined);
  }
}

// ─── Conway Registry ────────────────────────────────────────────

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseCardJson(cardJson: string): AgentCard | null {
  try {
    return validateAgentCard(JSON.parse(cardJson));
  } catch {
    return null;
  }
}

/**
 * List registered agents from the Conway registry API (best-effort).
 * Returns an empty list when the API is unreachable or unauthenticated.
 */
async function queryConwayRegistry(
  limit: number,
  cfg: DiscoveryConfig,
): Promise<DiscoveredAgent[]> {
  const apiUrl = process.env.CONWAY_API_URL || "https://api.conway.tech";
  const apiKey = loadApiKeyFromConfig();
  const httpClient = new ResilientHttpClient();

  const query = new URLSearchParams({ limit: String(Math.min(limit, cfg.maxScanCount)) });
  let response: Response;
  try {
    response = await httpClient.request(`${apiUrl}/v1/automatons?${query}`, {
      method: "GET",
      headers: apiKey ? { Authorization: apiKey } : undefined,
      retries: 0,
      timeout: cfg.fetchTimeoutMs,
    });
  } catch (error) {
    logger.error("Registry query failed:", error instanceof Error ? error : undefined);
    return [];
  }

  if (!response.ok) {
    logger.warn(`Registry listing returned ${response.status}`);
    return [];
  }

  try {
    const data = (await response.json()) as unknown;
    const rows = Array.isArray(data)
      ? data
      : ((data as Record<string, unknown> | null)?.automatons ??
        (data as Record<string, unknown> | null)?.agents ??
        []);

    const agents: DiscoveredAgent[] = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || typeof row !== "object") continue;
      const record = row as Record<string, unknown>;
      const agentId =
        readString(record.agent_id) ?? readString(record.automaton_id) ?? readString(record.id);
      const agentURI =
        readString(record.agent_uri) ?? readString(record.agentURI) ?? readString(record.uri);
      if (!agentId || !agentURI) continue;
      agents.push({
        agentId,
        owner: readString(record.creator_account_id) ?? readString(record.owner) ?? "",
        agentURI,
        name: readString(record.name),
        description: readString(record.bio) ?? readString(record.description),
      });
    }
    return agents;
  } catch (error) {
    logger.error("Registry parse failed:", error instanceof Error ? error : undefined);
    return [];
  }
}

/**
 * Read valid rows from the local agent-card cache.
 */
function readCachedAgents(
  db: import("better-sqlite3").Database,
  limit: number,
): DiscoveredAgent[] {
  try {
    const rows = db
      .prepare(
        `SELECT agent_id AS agentId, agent_card AS agentCard, fetched_from AS fetchedFrom
         FROM discovered_agents_cache
         WHERE valid_until IS NULL OR valid_until >= datetime('now')
         ORDER BY last_fetched_at DESC
         LIMIT ?`,
      )
      .all(limit) as Pick<
      DiscoveredAgentCacheRow,
      "agentId" | "agentCard" | "fetchedFrom"
    >[];

    const agents: DiscoveredAgent[] = [];
    for (const row of rows) {
      const card = parseCardJson(row.agentCard);
      const owner =
        readString((card as unknown as Record<string, unknown> | null)?.owner) ??
        row.fetchedFrom;
      agents.push({
        agentId: row.agentId,
        owner,
        agentURI: row.fetchedFrom,
        name: card?.name,
        description: card?.description,
      });
    }
    return agents;
  } catch (error) {
    logger.error("Cache read failed:", error instanceof Error ? error : undefined);
    return [];
  }
}

/**
 * Discover agents from the Conway registry API and the local cache.
 * Returns a list of discovered agents with their metadata.
 *
 * `network` and `rpcUrl` are accepted for backward compatibility and ignored.
 * Phase 3.2: Uses caching and configurable discovery options.
 */
export async function discoverAgents(
  limit: number = 20,
  network: Network = "mainnet",
  config?: Partial<DiscoveryConfig>,
  db?: import("better-sqlite3").Database,
  rpcUrl?: string,
): Promise<DiscoveredAgent[]> {
  void network;
  void rpcUrl;
  const cfg = { ...DEFAULT_DISCOVERY_CONFIG, ...config };
  const overallStart = Date.now();
  const byId = new Map<string, DiscoveredAgent>();

  for (const agent of await queryConwayRegistry(limit, cfg)) {
    if (byId.size >= limit) break;
    if (!byId.has(agent.agentId)) byId.set(agent.agentId, agent);
  }

  if (db && byId.size < limit) {
    for (const agent of readCachedAgents(db, limit - byId.size)) {
      if (byId.size >= limit) break;
      if (!byId.has(agent.agentId)) byId.set(agent.agentId, agent);
    }
  }

  const agents = [...byId.values()].slice(0, limit);

  for (const agent of agents) {
    if (agent.name && agent.description) continue;
    if (Date.now() - overallStart > DISCOVERY_TIMEOUT_MS) {
      logger.warn("Overall discovery timeout reached (60s), returning partial results");
      break;
    }
    await enrichAgentWithCard(agent, cfg, db);
  }

  return agents;
}

/**
 * Fetch an agent card from a URI.
 * Enforces SSRF protection and per-fetch timeout.
 *
 * Phase 3.2: Configurable IPFS gateway and response size limit.
 */
export async function fetchAgentCard(
  uri: string,
  config?: Partial<DiscoveryConfig>,
): Promise<AgentCard | null> {
  const cfg = { ...DEFAULT_DISCOVERY_CONFIG, ...config };

  // Handle data: URIs inline — no network request, no SSRF risk
  if (uri.startsWith("data:application/json,") || uri.startsWith("data:application/json;")) {
    try {
      let json: string;
      if (uri.includes(";base64,")) {
        const b64 = uri.split(";base64,")[1];
        json = Buffer.from(b64, "base64").toString("utf-8");
      } else {
        json = decodeURIComponent(uri.substring(uri.indexOf(",") + 1));
      }
      if (json.length > cfg.maxCardSizeBytes) {
        logger.error(`data: URI agent card too large: ${json.length} bytes`);
        return null;
      }
      const data = JSON.parse(json);
      return validateAgentCard(data);
    } catch (error) {
      logger.error("data: URI parse failed:", error instanceof Error ? error : undefined);
      return null;
    }
  }

  // SSRF protection: validate URI before fetching
  if (!isAllowedUri(uri)) {
    logger.error(`Blocked URI (SSRF protection): ${uri}`);
    return null;
  }

  try {
    // Handle IPFS URIs - Phase 3.2: Configurable IPFS gateway
    let fetchUrl = uri;
    if (uri.startsWith("ipfs://")) {
      fetchUrl = `${cfg.ipfsGateway}/ipfs/${uri.slice(7)}`;
    }

    // Per-fetch timeout
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.fetchTimeoutMs);

    try {
      const response = await fetch(fetchUrl, {
        signal: controller.signal,
      });

      if (!response.ok) return null;

      // Phase 3.2: Check response size before parsing
      const contentLength = response.headers.get("content-length");
      if (contentLength && parseInt(contentLength, 10) > cfg.maxCardSizeBytes) {
        logger.error(`Agent card too large: ${contentLength} bytes`);
        return null;
      }

      const text = await response.text();
      if (text.length > cfg.maxCardSizeBytes) {
        logger.error(`Agent card too large: ${text.length} bytes`);
        return null;
      }

      const data = JSON.parse(text);

      // Validate agent card JSON against schema
      return validateAgentCard(data);
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    logger.error("Agent card fetch failed:", error instanceof Error ? error : undefined);
    return null;
  }
}

/**
 * Search for agents by name or description.
 * Scans recent registrations and filters by keyword.
 */
export async function searchAgents(
  keyword: string,
  limit: number = 10,
  network: Network = "mainnet",
  config?: Partial<DiscoveryConfig>,
  db?: import("better-sqlite3").Database,
  rpcUrl?: string,
): Promise<DiscoveredAgent[]> {
  const all = await discoverAgents(50, network, config, db, rpcUrl);
  const lower = keyword.toLowerCase();

  return all
    .filter(
      (a) =>
        a.name?.toLowerCase().includes(lower) ||
        a.description?.toLowerCase().includes(lower) ||
        a.owner.toLowerCase().includes(lower),
    )
    .slice(0, limit);
}
