import { test } from "node:test";
import assert from "node:assert/strict";
import { formatStatusTable, serviceUrl, redactSecret } from "../src/commands/_shared.js";
import type { InstallState } from "../src/state.js";

const state: InstallState = {
  installer: "1.0.0", stack: "1.0.0",
  components: { backend: "1.0.0", frontend: "1.0.0", chat: "1.0.0", neo4j: "5.26-community", caddy: "2-alpine" },
  mode: "localhost", projectName: "cortex", dir: "/tmp/c",
  installedAt: "2026-07-28T00:00:00.000Z", providerId: "openai",
  ports: { app: 3000, chat: 3001, api: 8000, neo4jHttp: 7474, neo4jBolt: 7687 },
};

test("renders one line per service", () => {
  const rows = formatStatusTable(
    [
      { service: "neo4j", state: "running", health: "healthy" },
      { service: "backend", state: "running", health: "starting" },
    ],
    state
  );
  assert.equal(rows.length, 2);
  assert.match(rows[0], /neo4j/);
  assert.match(rows[0], /healthy/);
});

test("shows the bare state for services without a healthcheck", () => {
  const rows = formatStatusTable([{ service: "frontend", state: "running", health: null }], state);
  assert.match(rows[0], /running/);
  assert.doesNotMatch(rows[0], /healthy/);
});

test("localhost URLs use the configured ports", () => {
  assert.equal(serviceUrl(state, "frontend"), "http://localhost:3000");
  assert.equal(serviceUrl(state, "chat"), "http://localhost:3001");
});

test("domain URLs use https and the configured domains", () => {
  const d: InstallState = { ...state, mode: "domain", domains: { app: "c.example.com", chat: "ch.example.com", acmeEmail: "a@example.com" } };
  assert.equal(serviceUrl(d, "frontend"), "https://c.example.com");
  assert.equal(serviceUrl(d, "chat"), "https://ch.example.com");
});

test("services with no user-facing URL return null", () => {
  assert.equal(serviceUrl(state, "backup"), null);
});

test("redactSecret replaces every occurrence of the secret with ***", () => {
  const fakeKey = "sk-test-FAKESECRET000000000000000000";
  const body = `error: invalid request, saw header Authorization: Bearer ${fakeKey} (echoed twice: ${fakeKey})`;
  const redacted = redactSecret(body, fakeKey);
  assert.doesNotMatch(redacted, new RegExp(fakeKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(redacted, /\*\*\*/);
  assert.equal(redacted.split("***").length - 1, 2);
});

test("redactSecret returns text unchanged when no secret is configured", () => {
  assert.equal(redactSecret("plain error text", undefined), "plain error text");
  assert.equal(redactSecret("plain error text", ""), "plain error text");
});
