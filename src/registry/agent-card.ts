/**
 * Agent Card
 *
 * Generates and manages the agent's self-description card.
 * This is the JSON document pointed to by the agent's agentURI.
 * It is a pure HTTP/identity document: name, description, account id
 * and the agent's HTTP endpoint. Can be hosted or served at
 * /.well-known/agent-card.json
 *
 * Phase 3.2: Fixed code injection in hostAgentCard (S-P0-3),
 * removed internal details from card (S-P1-10),
 * added CORS headers and Content-Type.
 */

import type {
  AgentCard,
  AgentService,
  AutomatonConfig,
  AutomatonIdentity,
  AutomatonDatabase,
  ConwayClient,
} from "../types.js";

const AGENT_CARD_TYPE = "https://conway.tech/agent-card#registration-v1";

/**
 * The card as published: an HTTP/identity document carrying the
 * automaton's public account id.
 */
export type AgentCardDoc = AgentCard & {
  accountId: string;
};

/**
 * Generate an agent card from the automaton's current state.
 *
 * Phase 3.2: Only expose the agent's account, HTTP endpoint, name,
 * generic description, and active status. Do NOT include:
 * - Conway API URL (internal infrastructure)
 * - Sandbox ID (internal identifier)
 * - Creator account (privacy)
 */
export function generateAgentCard(
  identity: AutomatonIdentity,
  config: AutomatonConfig,
  db: AutomatonDatabase,
): AgentCardDoc {
  const registryEntry = db.getRegistryEntry?.();
  const endpoint = registryEntry?.endpoint || registryEntry?.agentURI || "";

  const services: AgentService[] = endpoint
    ? [
        {
          name: "agent",
          endpoint,
        },
      ]
    : [];

  // Phase 3.2: Generic description, no internal details
  const description = `Autonomous agent: ${config.name}`;

  return {
    type: AGENT_CARD_TYPE,
    name: config.name,
    description,
    accountId: identity.accountId,
    services,
    active: true,
  };
}

/**
 * Serialize agent card to JSON string.
 */
export function serializeAgentCard(card: AgentCardDoc): string {
  return JSON.stringify(card, null, 2);
}

/**
 * Host the agent card at /.well-known/agent-card.json
 * by exposing a simple HTTP server on a port.
 *
 * Phase 3.2: CRITICAL FIX (S-P0-3) — Write card as a SEPARATE JSON file.
 * Server script reads the file at request time, NOT interpolated into JS.
 * Added CORS headers and X-Content-Type-Options: nosniff.
 */
export async function hostAgentCard(
  card: AgentCardDoc,
  conway: ConwayClient,
  port: number = 8004,
): Promise<string> {
  const cardJson = serializeAgentCard(card);

  // Phase 3.2: Write card as a separate JSON file (not interpolated into JS)
  await conway.writeFile("/tmp/agent-card.json", cardJson);

  // Phase 3.2: Server reads the file at request time
  const serverScript = `
const http = require('http');
const fs = require('fs');
const path = '/tmp/agent-card.json';

const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/.well-known/agent-card.json' || req.url === '/agent-card.json') {
    try {
      const data = fs.readFileSync(path, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(data);
    } catch (err) {
      res.writeHead(500);
      res.end('Internal Server Error');
    }
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(${port}, () => console.log('Agent card server on port ' + ${port}));
`;

  await conway.writeFile("/tmp/agent-card-server.js", serverScript);

  // Start server in background
  await conway.exec(
    `node /tmp/agent-card-server.js &`,
    5000,
  );

  // Expose port
  const portInfo = await conway.exposePort(port);

  return `${portInfo.publicUrl}/.well-known/agent-card.json`;
}

/**
 * Write agent card to the state directory for git versioning.
 */
export async function saveAgentCard(
  card: AgentCardDoc,
  conway: ConwayClient,
): Promise<void> {
  const cardJson = serializeAgentCard(card);
  const home = process.env.HOME || "/root";
  await conway.writeFile(`${home}/.automaton/agent-card.json`, cardJson);
}
