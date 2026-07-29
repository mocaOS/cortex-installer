import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderEnv, writeEnvFile, REQUIRED_VARS, type InstallConfig } from "../src/env.js";
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
    chat: false,
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
  const cfg = base({
    chat: true,
    mode: "domain",
    domains: { app: "c.example.com", chat: "ch.example.com", acmeEmail: "a@example.com" },
  });
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
  const cfg = base({
    chat: true,
    mode: "domain",
    domains: { app: "c.example.com", chat: "ch.example.com", acmeEmail: "a@example.com" },
  });
  assert.equal(parse(renderEnv(cfg)).CORS_ALLOWED_ORIGINS, "https://c.example.com,https://ch.example.com");
});

test("domain mode sets CHAT_BASE_URL so password reset links work", () => {
  const cfg = base({
    chat: true,
    mode: "domain",
    domains: { app: "c.example.com", chat: "ch.example.com", acmeEmail: "a@example.com" },
  });
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

// --- writeEnvFile: atomic, and 600 from the moment it exists -----------------
// `update` rewrites the file that holds the ONLY copy of NEO4J_PASSWORD. A plain
// writeFileSync opens it O_TRUNC, so a crash in that window loses the password
// permanently — Neo4j reads NEO4J_AUTH only when its data volume is first
// created, so the graph can never be authenticated against again.
test("writeEnvFile creates the file at mode 600, never briefly world-readable", () => {
  const dir = mkdtempSync(join(tmpdir(), "envw-"));
  const path = join(dir, ".env");
  writeEnvFile(path, "NEO4J_PASSWORD=hunter2\n");
  assert.equal(readFileSync(path, "utf8"), "NEO4J_PASSWORD=hunter2\n");
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("writeEnvFile replaces an existing file and leaves no temp file behind", () => {
  const dir = mkdtempSync(join(tmpdir(), "envw-"));
  const path = join(dir, ".env");
  writeFileSync(path, "OLD=1\n");
  writeEnvFile(path, "NEW=2\n");
  assert.equal(readFileSync(path, "utf8"), "NEW=2\n");
  assert.equal(existsSync(`${path}.tmp`), false, "the temp file must be renamed away, not left behind");
});

test("writeEnvFile tightens the mode even when a stale temp file exists from an interrupted run", () => {
  const dir = mkdtempSync(join(tmpdir(), "envw-"));
  const path = join(dir, ".env");
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, "LEFTOVER=1\n");
  chmodSync(tmp, 0o644); // writeFileSync's `mode` option does not apply to an existing file
  writeEnvFile(path, "NEO4J_PASSWORD=hunter2\n");
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("writeEnvFile leaves the original intact when the write cannot be performed", () => {
  const dir = mkdtempSync(join(tmpdir(), "envw-"));
  const path = join(dir, ".env");
  writeEnvFile(path, "NEO4J_PASSWORD=keepme\n");
  // A directory in the temp file's place makes the write fail; the point is that
  // the previous .env still holds the password afterwards, which is precisely
  // what a truncating write could not promise.
  mkdirSync(`${path}.tmp`);
  assert.throws(() => writeEnvFile(path, "NEO4J_PASSWORD=replacement\n"));
  assert.equal(readFileSync(path, "utf8"), "NEO4J_PASSWORD=keepme\n");
});

test("chat off omits COMPOSE_PROFILES but keeps the two vars Compose still reads", () => {
  const env = renderEnv(base({ chat: false }));
  assert.ok(!/^COMPOSE_PROFILES=/m.test(env), "COMPOSE_PROFILES must be absent with chat off");
  // Interpolation runs before profile filtering, so an unset value here aborts
  // the entire compose project even though chat never starts.
  assert.match(env, /^CORTEX_CHAT_IMAGE=ghcr\.io\/mocaos\/cortex-chat:/m);
  assert.match(env, /^CHAT_APP_ENCRYPTION_KEY=.+/m);
  // Retained so enabling chat later is a single line.
  assert.match(env, /^CHAT_PORT=\d+/m);
});

test("chat on writes the profile line", () => {
  assert.match(renderEnv(base({ chat: true })), /^COMPOSE_PROFILES=chat$/m);
});

test("chat off in domain mode writes no chat domain and no chat CORS origin", () => {
  const env = renderEnv(
    base({ chat: false, mode: "domain", domains: { app: "a.example.com", acmeEmail: "o@example.com" } })
  );
  assert.ok(!/^CHAT_DOMAIN=/m.test(env));
  assert.ok(!/^CHAT_BASE_URL=/m.test(env));
  assert.match(env, /^CORS_ALLOWED_ORIGINS=https:\/\/a\.example\.com$/m);
});

test("chat on in domain mode writes both origins", () => {
  const env = renderEnv(
    base({
      chat: true,
      mode: "domain",
      domains: { app: "a.example.com", chat: "c.example.com", acmeEmail: "o@example.com" },
    })
  );
  assert.match(env, /^CHAT_DOMAIN=c\.example\.com$/m);
  assert.match(env, /^CHAT_BASE_URL=https:\/\/c\.example\.com$/m);
  assert.match(env, /^CORS_ALLOWED_ORIGINS=https:\/\/a\.example\.com,https:\/\/c\.example\.com$/m);
});

test("CHAT_DOMAIN is no longer a required var", () => {
  // The compose relaxed it to ${CHAT_DOMAIN:-}; this list must mirror the
  // compose's ${VAR:?} guards or it lies about what a valid .env needs.
  assert.ok(!(REQUIRED_VARS as readonly string[]).includes("CHAT_DOMAIN"));
  assert.ok((REQUIRED_VARS as readonly string[]).includes("CORTEX_CHAT_IMAGE"));
  assert.ok((REQUIRED_VARS as readonly string[]).includes("CHAT_APP_ENCRYPTION_KEY"));
});
