import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSecrets, validateSecret, WEAK_VALUES } from "../src/secrets.js";

test("generates all five secrets", () => {
  const s = generateSecrets();
  for (const k of ["neo4jPassword", "adminPassword", "adminApiKey", "sessionSecret", "chatEncryptionKey"] as const) {
    assert.ok(s[k].length > 0, `${k} is empty`);
  }
});

test("admin API key carries the cortex_admin_ prefix", () => {
  assert.match(generateSecrets().adminApiKey, /^cortex_admin_[0-9a-f]{64}$/);
});

test("session secret is comfortably over the 32-char minimum", () => {
  assert.ok(generateSecrets().sessionSecret.length >= 64);
});

test("chat encryption key is 32 bytes base64", () => {
  const k = generateSecrets().chatEncryptionKey;
  assert.equal(Buffer.from(k, "base64").length, 32);
});

test("admin password avoids visually ambiguous characters", () => {
  for (let i = 0; i < 50; i++) {
    assert.doesNotMatch(generateSecrets().adminPassword, /[0O1lI]/);
  }
});

test("generated secrets are never members of the weak set", () => {
  for (let i = 0; i < 50; i++) {
    const s = generateSecrets();
    for (const v of Object.values(s)) assert.equal(WEAK_VALUES.has(v), false);
  }
});

test("every generated secret differs between calls", () => {
  // All five, not just one: a refactor that accidentally reused a single
  // randomBytes call for two fields would otherwise leave the suite green.
  const a = generateSecrets();
  const b = generateSecrets();
  for (const k of Object.keys(a) as Array<keyof typeof a>) {
    assert.notEqual(a[k], b[k], `${k} repeated across calls`);
  }
});

test("every generated secret passes its own validator", () => {
  const s = generateSecrets();
  for (const k of Object.keys(s) as Array<keyof typeof s>) {
    assert.equal(validateSecret(k, s[k]), null, `${k} failed validation`);
  }
});

test("rejects an empty value", () => {
  assert.match(validateSecret("neo4jPassword", "")!, /empty|required/i);
});

test("rejects a session secret shorter than 32 chars", () => {
  assert.match(validateSecret("sessionSecret", "a".repeat(31))!, /32/);
});

test("accepts a session secret of exactly 32 chars", () => {
  assert.equal(validateSecret("sessionSecret", "a".repeat(32)), null);
});

test("rejects known placeholder values the backend refuses", () => {
  assert.ok(validateSecret("adminApiKey", "cortex_admin_your-secure-api-key-here"));
  assert.ok(validateSecret("adminPassword", "your-secure-admin-password"));
  assert.ok(validateSecret("neo4jPassword", "password123"));
});

test("rejects any CHANGE_ME-prefixed value", () => {
  assert.ok(validateSecret("neo4jPassword", "CHANGE_ME_please"));
});

test("rejects a chat encryption key that is not 32 bytes base64", () => {
  assert.ok(validateSecret("chatEncryptionKey", "dGVzdA=="));
});
