import { test } from "node:test";
import assert from "node:assert/strict";
import { startFakeOpenAI } from "./fake-openai.js";
import { listModels, probeChat, probeEmbedding } from "../src/validate.js";
import { PROVIDERS } from "../src/providers.js";

test("every provider preset has an id, label and https base URL (except local ones)", () => {
  assert.ok(PROVIDERS.length >= 5);
  for (const p of PROVIDERS) {
    assert.ok(p.id && p.label, `provider missing id/label: ${JSON.stringify(p)}`);
    if (p.id !== "ollama" && p.id !== "other") {
      assert.match(p.baseUrl, /^https:\/\//, `${p.id} base URL should be https`);
    }
  }
});

test("provider ids are unique", () => {
  assert.equal(new Set(PROVIDERS.map((p) => p.id)).size, PROVIDERS.length);
});

test("lists models from a compliant endpoint", async () => {
  const f = await startFakeOpenAI();
  try {
    const models = await listModels({ baseUrl: f.url, apiKey: "k", model: "" });
    assert.deepEqual(models, ["gpt-test", "text-embedding-test"]);
  } finally { await f.close(); }
});

test("returns an empty list when /v1/models is absent, rather than throwing", async () => {
  const f = await startFakeOpenAI({ noModelsEndpoint: true });
  try {
    assert.deepEqual(await listModels({ baseUrl: f.url, apiKey: "k", model: "" }), []);
  } finally { await f.close(); }
});

test("chat probe succeeds and reports elapsed ms", async () => {
  const f = await startFakeOpenAI();
  try {
    const r = await probeChat({ baseUrl: f.url, apiKey: "k", model: "gpt-test" });
    assert.equal(r.ok, true);
    assert.ok((r as any).ms >= 0);
  } finally { await f.close(); }
});

test("chat probe surfaces a 401 with its status", async () => {
  const f = await startFakeOpenAI({ unauthorized: true });
  try {
    const r = await probeChat({ baseUrl: f.url, apiKey: "bad", model: "gpt-test" });
    assert.equal(r.ok, false);
    assert.equal((r as any).status, 401);
  } finally { await f.close(); }
});

test("embedding probe detects the natural dimension", async () => {
  const f = await startFakeOpenAI({ dimension: 1024 });
  try {
    const r = await probeEmbedding({ baseUrl: f.url, apiKey: "k", model: "e" });
    assert.equal(r.ok, true);
    assert.equal((r as any).dimension, 1024);
  } finally { await f.close(); }
});

test("embedding probe reports sendDimensions=true when the model accepts the parameter", async () => {
  const f = await startFakeOpenAI({ dimension: 1536 });
  try {
    const r = await probeEmbedding({ baseUrl: f.url, apiKey: "k", model: "e" });
    assert.equal((r as any).sendDimensions, true);
  } finally { await f.close(); }
});

test("embedding probe reports sendDimensions=false for fixed-dimension models", async () => {
  const f = await startFakeOpenAI({ dimension: 4096, rejectDimensions: true });
  try {
    const r = await probeEmbedding({ baseUrl: f.url, apiKey: "k", model: "e" });
    assert.equal(r.ok, true);
    assert.equal((r as any).dimension, 4096);
    assert.equal((r as any).sendDimensions, false);
  } finally { await f.close(); }
});

test("probes time out rather than hanging forever", async () => {
  const f = await startFakeOpenAI({ hang: true });
  try {
    const r = await probeChat({ baseUrl: f.url, apiKey: "k", model: "m", timeoutMs: 300 });
    assert.equal(r.ok, false);
    assert.match(String((r as any).body ?? ""), /timed out/i);
  } finally { await f.close(); }
});
