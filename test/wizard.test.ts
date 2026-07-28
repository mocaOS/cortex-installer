import { test } from "node:test";
import assert from "node:assert/strict";
import { buildConfigNonInteractive } from "../src/wizard.js";
import { parseStack } from "../src/stack.js";

const stack = parseStack({
  stack: "1.0.0",
  components: { backend: "1.0.0", frontend: "1.0.0", chat: "1.0.0", neo4j: "5.26-community", caddy: "2-alpine" },
  minInstaller: "1.0.0",
});

const MINIMAL = {
  CORTEX_ADMIN_EMAIL: "me@example.com",
  CORTEX_OPENAI_API_KEY: "sk-test",
  CORTEX_OPENAI_MODEL: "gpt-5.2",
  CORTEX_EMBEDDING_MODEL: "text-embedding-3-small",
  CORTEX_EMBEDDING_DIMENSION: "1536",
};

test("builds a localhost config from the minimum environment", () => {
  const cfg = buildConfigNonInteractive(MINIMAL, stack, "/tmp/c");
  assert.equal(cfg.mode, "localhost");
  assert.equal(cfg.adminEmail, "me@example.com");
  assert.equal(cfg.llm.embeddingDimension, 1536);
});

test("generates secrets when none are supplied", () => {
  const cfg = buildConfigNonInteractive(MINIMAL, stack, "/tmp/c");
  assert.ok(cfg.secrets.adminPassword.length > 0);
  assert.match(cfg.secrets.adminApiKey, /^cortex_admin_/);
});

test("honours supplied secrets instead of generating", () => {
  const cfg = buildConfigNonInteractive(
    { ...MINIMAL, CORTEX_ADMIN_PASSWORD: "My-Own-Pass-9x" },
    stack, "/tmp/c"
  );
  assert.equal(cfg.secrets.adminPassword, "My-Own-Pass-9x");
});

test("rejects a supplied secret that the backend would refuse", () => {
  assert.throws(
    () => buildConfigNonInteractive({ ...MINIMAL, CORTEX_ADMIN_PASSWORD: "your-secure-admin-password" }, stack, "/tmp/c"),
    /placeholder/i
  );
});

test("lists every missing required value at once rather than one at a time", () => {
  try {
    buildConfigNonInteractive({}, stack, "/tmp/c");
    assert.fail("should have thrown");
  } catch (err) {
    const m = (err as Error).message;
    assert.match(m, /CORTEX_ADMIN_EMAIL/);
    assert.match(m, /CORTEX_OPENAI_API_KEY/);
    assert.match(m, /CORTEX_OPENAI_MODEL/);
  }
});

test("domain mode requires the three domain values", () => {
  assert.throws(
    () => buildConfigNonInteractive({ ...MINIMAL, CORTEX_MODE: "domain" }, stack, "/tmp/c"),
    /CORTEX_APP_DOMAIN/
  );
});

test("domain mode succeeds when the domain values are present", () => {
  const cfg = buildConfigNonInteractive({
    ...MINIMAL,
    CORTEX_MODE: "domain",
    CORTEX_APP_DOMAIN: "c.example.com",
    CORTEX_CHAT_DOMAIN: "ch.example.com",
    CORTEX_ACME_EMAIL: "a@example.com",
  }, stack, "/tmp/c");
  assert.equal(cfg.mode, "domain");
  assert.equal(cfg.domains?.app, "c.example.com");
});

test("error reporting defaults to off", () => {
  assert.equal(buildConfigNonInteractive(MINIMAL, stack, "/tmp/c").errorReporting, false);
});

test("rejects an unknown mode", () => {
  assert.throws(
    () => buildConfigNonInteractive({ ...MINIMAL, CORTEX_MODE: "sideways" }, stack, "/tmp/c"),
    /sideways/
  );
});
