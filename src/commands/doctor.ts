import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { banner, noteBox, prompts as p } from "../ui.js";
import { installerVersion } from "../version.js";
import { runPreflight } from "../preflight.js";
import { ps, execIn } from "../docker.js";
import { probeChat } from "../validate.js";
import { fetchStack } from "../stack.js";
import { resolveInstall, formatStatusTable, redactSecret } from "./_shared.js";

function readEnv(dir: string): Record<string, string> {
  const p = join(dir, ".env");
  if (!existsSync(p)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq > 0) out[t.slice(0, eq)] = t.slice(eq + 1);
  }
  return out;
}

export async function run(ctx: { flags: Record<string, string | boolean> }): Promise<void> {
  banner(installerVersion());
  const { dir, state } = resolveInstall(ctx.flags);
  const env = readEnv(dir);
  const lines: string[] = [];

  // Every section is individually guarded. A diagnostic tool that aborts on its
  // first failure is useless precisely when it is needed: `docker compose ps`
  // rejects when the daemon is down, which is the most likely reason someone
  // runs `doctor` at all — and an unguarded throw would discard the preflight
  // lines that already explain the problem.
  try {
    const pre = await runPreflight({ dir });
    for (const c of pre.checks) lines.push(`${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);
  } catch {
    lines.push("warn could not run environment checks");
  }

  try {
    const rows = await ps(dir);
    lines.push(
      "",
      ...(rows.length
        ? formatStatusTable(rows, state)
        : ["no containers — run `cortex start`"])
    );
  } catch {
    lines.push("", "warn could not query container status — is Docker running?");
  }

  // LLM key still valid?
  if (env.OPENAI_API_KEY && env.OPENAI_API_BASE && env.OPENAI_MODEL) {
    const r = await probeChat({
      baseUrl: env.OPENAI_API_BASE,
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL,
      timeoutMs: 15_000,
    });
    // Redact the key before showing a provider's response body: this block is
    // explicitly meant to be pasted when asking for help, and an arbitrary
    // OpenAI-compatible gateway may echo request or auth detail back in a
    // verbose error.
    lines.push(
      "",
      r.ok
        ? `ok   LLM reachable (${r.ms} ms)`
        : `FAIL LLM: ${r.status ?? ""} ${redactSecret(r.body ?? "", env.OPENAI_API_KEY)}`
    );
  }

  // Backup freshness
  try {
    const out = await execIn(dir, "backup", ["sh", "-c", "cat /backups/LAST_SUCCESS 2>/dev/null || true"]);
    const ts = Number(out.trim());
    lines.push(
      Number.isFinite(ts) && ts > 0
        ? `ok   last verified backup ${new Date(ts * 1000).toISOString()}`
        : "warn no verified backup yet (first run is delayed)"
    );
  } catch {
    lines.push("warn backup sidecar not reachable");
  }

  // Newer release available?
  try {
    const latest = await fetchStack();
    lines.push(
      latest.stack === state.stack
        ? `ok   up to date (${state.stack})`
        : `note Cortex ${latest.stack} available — run \`cortex update\``
    );
  } catch {
    lines.push("warn could not check for updates");
  }

  noteBox("Diagnostics", lines);
  p.outro("Paste this block when asking for help.");
}
