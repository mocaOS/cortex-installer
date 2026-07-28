import { test } from "node:test";
import assert from "node:assert/strict";
import { renderEnv, REQUIRED_VARS, type InstallConfig } from "../src/env.js";
import { parseStack } from "../src/stack.js";
import { generateSecrets } from "../src/secrets.js";

const stack = parseStack({
  stack: "1.0.0",
  components: { backend: "1.0.0", frontend: "1.0.0", chat: "1.0.0", neo4j: "5.26-community", caddy: "2-alpine" },
  minInstaller: "1.0.0",
});

function base(over: Partial<InstallConfig> = {}): InstallConfig {
  return {
    mode: "localhost",
    dir: "/tmp/cortex",
    projectName: "cortex",
    stack,
    secrets: generateSecrets(),
    adminEmail: "me@example.com",
    llm: {
      providerId: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      chatModel: "gpt-5.2",
      embeddingModel: "text-embedding-3-small",
      embeddingDimension: 1536,
      embeddingSendDimensions: true,
    },
    ports: { app: 3000, chat: 3001, api: 8000, neo4jHttp: 7474, neo4jBolt: 7687 },
    errorReporting: false,
    ...over,
  };
}

function parse(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq > 0) out[t.slice(0, eq)] = t.slice(eq + 1);
  }
  return out;
}

test("localhost mode selects the ports overlay", () => {
  assert.equal(parse(renderEnv(base())).COMPOSE_FILE, "docker-compose.yml:docker-compose.ports.yml");
});

test("domain mode selects the caddy overlay", () => {
  const cfg = base({ mode: "domain", domains: { app: "c.example.com", chat: "ch.example.com", acmeEmail: "a@example.com" } });
  assert.equal(parse(renderEnv(cfg)).COMPOSE_FILE, "docker-compose.yml:docker-compose.caddy.yml");
});

test("pins all three image refs from the stack", () => {
  const e = parse(renderEnv(base()));
  assert.equal(e.CORTEX_BACKEND_IMAGE, "ghcr.io/mocaos/cortex-backend:1.0.0");
  assert.equal(e.CORTEX_FRONTEND_IMAGE, "ghcr.io/mocaos/cortex-frontend:1.0.0");
  assert.equal(e.CORTEX_CHAT_IMAGE, "ghcr.io/mocaos/cortex-chat:1.0.0");
  assert.equal(e.NEO4J_VERSION, "5.26-community");
  assert.equal(e.CADDY_VERSION, "2-alpine");
});

test("every required variable is present and non-empty in localhost mode", () => {
  const e = parse(renderEnv(base()));
  for (const v of REQUIRED_VARS.filter((v) => !["APP_DOMAIN", "CHAT_DOMAIN", "ACME_EMAIL"].includes(v))) {
    assert.ok(e[v] && e[v].length > 0, `${v} missing or empty`);
  }
});

test("localhost mode omits the three domain-only vars entirely", () => {
  const e = parse(renderEnv(base()));
  assert.equal("APP_DOMAIN" in e, false);
  assert.equal("CHAT_DOMAIN" in e, false);
  assert.equal("ACME_EMAIL" in e, false);
});

test("domain mode also fills the three domain-only required vars", () => {
  const cfg = base({ mode: "domain", domains: { app: "c.example.com", chat: "ch.example.com", acmeEmail: "a@example.com" } });
  const e = parse(renderEnv(cfg));
  assert.equal(e.APP_DOMAIN, "c.example.com");
  assert.equal(e.CHAT_DOMAIN, "ch.example.com");
  assert.equal(e.ACME_EMAIL, "a@example.com");
});

test("NEVER writes SESSION_COOKIE_SECURE — the overlay owns it", () => {
  assert.equal("SESSION_COOKIE_SECURE" in parse(renderEnv(base())), false);
  const cfg = base({ mode: "domain", domains: { app: "a.example.com", chat: "b.example.com", acmeEmail: "c@example.com" } });
  assert.equal("SESSION_COOKIE_SECURE" in parse(renderEnv(cfg)), false);
});

test("NEVER writes NEXT_PUBLIC_API_URL", () => {
  assert.equal("NEXT_PUBLIC_API_URL" in parse(renderEnv(base())), false);
  const cfg = base({ mode: "domain", domains: { app: "a.example.com", chat: "b.example.com", acmeEmail: "c@example.com" } });
  assert.equal("NEXT_PUBLIC_API_URL" in parse(renderEnv(cfg)), false);
});

test("error reporting is off by default — DSNs empty, chat disabled", () => {
  const e = parse(renderEnv(base()));
  assert.equal(e.SENTRY_DSN_BACKEND, "");
  assert.equal(e.SENTRY_DSN_FRONTEND, "");
  assert.equal(e.CHAT_SENTRY_DISABLED, "1");
});

test("opting into error reporting does not invent a DSN", () => {
  const e = parse(renderEnv(base({ errorReporting: true })));
  assert.equal(e.CHAT_SENTRY_DISABLED, "0");
});

test("domain mode narrows CORS to the two real origins", () => {
  const cfg = base({ mode: "domain", domains: { app: "c.example.com", chat: "ch.example.com", acmeEmail: "a@example.com" } });
  assert.equal(parse(renderEnv(cfg)).CORS_ALLOWED_ORIGINS, "https://c.example.com,https://ch.example.com");
});

test("domain mode sets CHAT_BASE_URL so password reset links work", () => {
  const cfg = base({ mode: "domain", domains: { app: "c.example.com", chat: "ch.example.com", acmeEmail: "a@example.com" } });
  assert.equal(parse(renderEnv(cfg)).CHAT_BASE_URL, "https://ch.example.com");
});

test("localhost mode writes the chosen ports", () => {
  const e = parse(renderEnv(base({ ports: { app: 4000, chat: 4001, api: 9000, neo4jHttp: 8474, neo4jBolt: 8687 } })));
  assert.equal(e.APP_PORT, "4000");
  assert.equal(e.CHAT_PORT, "4001");
  assert.equal(e.API_PORT, "9000");
});

test("binds loopback only", () => {
  assert.equal(parse(renderEnv(base())).BIND_ADDR, "127.0.0.1");
});

test("embedding settings come from the probe results", () => {
  const e = parse(renderEnv(base()));
  assert.equal(e.EMBEDDING_DIMENSION, "1536");
  assert.equal(e.EMBEDDING_SEND_DIMENSIONS, "true");
});

test("omits optional advanced vars when unset", () => {
  const text = renderEnv(base());
  assert.doesNotMatch(text, /^GRAPH_EXTRACTION_MODEL=/m);
  assert.doesNotMatch(text, /^SMTP_HOST=/m);
});

test("includes advanced overrides when provided", () => {
  const text = renderEnv(base({ advanced: { graphExtractionModel: "qwen3", visionModel: "qwen3-vl" } }));
  assert.match(text, /^GRAPH_EXTRACTION_MODEL=qwen3$/m);
  assert.match(text, /^VISION_MODEL=qwen3-vl$/m);
});

test("output has no CRLF and ends with a newline", () => {
  const text = renderEnv(base());
  assert.doesNotMatch(text, /\r/);
  assert.ok(text.endsWith("\n"));
});
