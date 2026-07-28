export interface ProbeConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs?: number;
}

export type ProbeFail = { ok: false; status?: number; body?: string };
export type ChatOk = { ok: true; ms: number };
export type EmbedOk = { ok: true; dimension: number; sendDimensions: boolean };

const DEFAULT_TIMEOUT = 20_000;

function headers(apiKey?: string): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) h.authorization = `Bearer ${apiKey}`;
  return h;
}

function url(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

async function call(
  cfg: ProbeConfig,
  path: string,
  init?: RequestInit
): Promise<{ res: Response; text: string } | { error: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.timeoutMs ?? DEFAULT_TIMEOUT);
  try {
    const res = await fetch(url(cfg.baseUrl, path), {
      ...init,
      headers: headers(cfg.apiKey),
      signal: ac.signal,
    });
    return { res, text: await res.text() };
  } catch (err: any) {
    return { error: err?.name === "AbortError" ? "request timed out" : String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Model ids, or [] when the endpoint does not implement /v1/models. */
export async function listModels(cfg: ProbeConfig): Promise<string[]> {
  const r = await call(cfg, "/models", { method: "GET" });
  if ("error" in r || !r.res.ok) return [];
  try {
    const j = JSON.parse(r.text);
    return Array.isArray(j?.data)
      ? j.data.map((m: any) => String(m?.id)).filter((s: string) => s && s !== "undefined")
      : [];
  } catch {
    return [];
  }
}

export async function probeChat(cfg: ProbeConfig): Promise<ChatOk | ProbeFail> {
  const started = Date.now();
  const r = await call(cfg, "/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
    }),
  });
  if ("error" in r) return { ok: false, body: r.error };
  if (!r.res.ok) return { ok: false, status: r.res.status, body: r.text.slice(0, 300) };
  return { ok: true, ms: Date.now() - started };
}

/**
 * Two calls, deliberately: the first learns the model's natural dimension, the
 * second asks whether it accepts an explicit `dimensions` parameter. Empirical
 * beats a hardcoded per-model table, which goes stale.
 */
export async function probeEmbedding(cfg: ProbeConfig): Promise<EmbedOk | ProbeFail> {
  const first = await call(cfg, "/embeddings", {
    method: "POST",
    body: JSON.stringify({ model: cfg.model, input: "cortex" }),
  });
  if ("error" in first) return { ok: false, body: first.error };
  if (!first.res.ok) return { ok: false, status: first.res.status, body: first.text.slice(0, 300) };

  let dimension: number;
  try {
    dimension = JSON.parse(first.text)?.data?.[0]?.embedding?.length ?? 0;
  } catch {
    return { ok: false, body: "embedding response was not JSON" };
  }
  if (!dimension) return { ok: false, body: "embedding response contained no vector" };

  const second = await call(cfg, "/embeddings", {
    method: "POST",
    body: JSON.stringify({ model: cfg.model, input: "cortex", dimensions: dimension }),
  });
  const sendDimensions = !("error" in second) && second.res.ok;

  return { ok: true, dimension, sendDimensions };
}
