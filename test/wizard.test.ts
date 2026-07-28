import { test } from "node:test";
import assert from "node:assert/strict";
import { buildConfigNonInteractive, checkProjectVolumeCollision } from "../src/wizard.js";
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

// checkProjectVolumeCollision takes an already-fetched volume listing so it
// can be tested without depending on this machine's real Docker volumes.
test("checkProjectVolumeCollision does nothing when there are no existing volumes", () => {
  assert.equal(checkProjectVolumeCollision("cortex", [], false), undefined);
});

test("--yes rejects a colliding project name when CORTEX_PROJECT_NAME was not set", () => {
  assert.throws(
    () =>
      checkProjectVolumeCollision(
        "cortex",
        ["cortex_neo4j_data", "cortex_uploads_data"],
        false
      ),
    (err: unknown) => {
      const m = (err as Error).message;
      assert.match(m, /cortex_neo4j_data/);
      assert.match(m, /cortex_uploads_data/);
      assert.match(m, /CORTEX_PROJECT_NAME/);
      return true;
    }
  );
});

test("an explicitly chosen CORTEX_PROJECT_NAME reusing existing data warns instead of throwing", () => {
  const warning = checkProjectVolumeCollision("cortex", ["cortex_neo4j_data"], true);
  assert.match(warning ?? "", /cortex/i);
  assert.match(warning ?? "", /NEO4J_PASSWORD/);
});

// --- numeric validation -----------------------------------------------------
// Every numeric field used to be a bare Number(), which cannot fail — it returns
// NaN. `CORTEX_EMBEDDING_DIMENSION=not-a-number` therefore rendered into .env as
// literally `EMBEDDING_DIMENSION=NaN` and the install carried on through the
// 1.7 GB pull to a container that failed on a value nobody had typed.
test("rejects a non-numeric embedding dimension instead of writing NaN", () => {
  assert.throws(
    () => buildConfigNonInteractive(
      { ...MINIMAL, CORTEX_EMBEDDING_DIMENSION: "not-a-number" }, stack, "/tmp/c"
    ),
    (err: unknown) => {
      const m = (err as Error).message;
      assert.match(m, /CORTEX_EMBEDDING_DIMENSION/);
      assert.match(m, /not-a-number/, "the offending value must be quoted back");
      assert.doesNotMatch(m, /NaN/);
      return true;
    }
  );
});

test("rejects a fractional embedding dimension", () => {
  assert.throws(
    () => buildConfigNonInteractive({ ...MINIMAL, CORTEX_EMBEDDING_DIMENSION: "1536.5" }, stack, "/tmp/c"),
    /CORTEX_EMBEDDING_DIMENSION/
  );
});

test("rejects a zero or negative embedding dimension", () => {
  for (const v of ["0", "-1"]) {
    assert.throws(
      () => buildConfigNonInteractive({ ...MINIMAL, CORTEX_EMBEDDING_DIMENSION: v }, stack, "/tmp/c"),
      /CORTEX_EMBEDDING_DIMENSION/,
      `dimension ${v} should be rejected`
    );
  }
});

test("rejects a non-numeric port instead of writing NaN", () => {
  assert.throws(
    () => buildConfigNonInteractive({ ...MINIMAL, CORTEX_APP_PORT: "eighty" }, stack, "/tmp/c"),
    /CORTEX_APP_PORT/
  );
});

test("rejects an out-of-range port", () => {
  assert.throws(
    () => buildConfigNonInteractive({ ...MINIMAL, CORTEX_NEO4J_BOLT_PORT: "70000" }, stack, "/tmp/c"),
    /CORTEX_NEO4J_BOLT_PORT/
  );
});

test("reports every bad value in one run, alongside the missing ones", () => {
  try {
    buildConfigNonInteractive(
      {
        CORTEX_ADMIN_EMAIL: "me@example.com",
        CORTEX_OPENAI_MODEL: "gpt-5.2",
        CORTEX_EMBEDDING_MODEL: "text-embedding-3-small",
        CORTEX_EMBEDDING_DIMENSION: "banana",
        CORTEX_APP_PORT: "nope",
        CORTEX_CHAT_PORT: "-5",
      },
      stack, "/tmp/c"
    );
    assert.fail("should have thrown");
  } catch (err) {
    const m = (err as Error).message;
    assert.match(m, /CORTEX_OPENAI_API_KEY/, "still lists what is missing");
    assert.match(m, /CORTEX_EMBEDDING_DIMENSION/);
    assert.match(m, /CORTEX_APP_PORT/);
    assert.match(m, /CORTEX_CHAT_PORT/);
  }
});

test("a blank numeric override falls back to the default rather than failing", () => {
  const cfg = buildConfigNonInteractive({ ...MINIMAL, CORTEX_APP_PORT: "" }, stack, "/tmp/c");
  assert.equal(cfg.ports.app, 3000);
});

test("valid port overrides are still honoured", () => {
  const cfg = buildConfigNonInteractive({ ...MINIMAL, CORTEX_APP_PORT: "8080" }, stack, "/tmp/c");
  assert.equal(cfg.ports.app, 8080);
  assert.equal(cfg.ports.chat, 3001, "unset ports keep their defaults");
});
