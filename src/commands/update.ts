import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeEnvFile } from "../env.js";
import { banner, noteBox, prompts as p } from "../ui.js";
import { installerVersion } from "../version.js";
import { fetchStack, assertInstallerSupported } from "../stack.js";
import { fetchArtifacts } from "../artifacts.js";
import { writeState } from "../state.js";
import { pull, up, waitHealthy, healthServices, execIn, validateComposeConfig } from "../docker.js";
import { diffComponents, rewriteImagePins, ensureChatProfile, envHasChatDomain } from "../update.js";
import { effectiveChat } from "../chat.js";
import { resolveInstall } from "./_shared.js";

/**
 * Aborts BEFORE `update` does anything else — no network call, no prompt, no
 * backup — when chat is about to resolve on in domain mode with .env holding
 * no real `CHAT_DOMAIN`.
 *
 * `caddyTemplateFor` (artifacts.ts) picks `Caddyfile.chat.template` from the
 * chat flag ALONE. That template's `{$CHAT_DOMAIN}` left empty does not just
 * skip the chat site block — it makes Caddy refuse to adapt the ENTIRE
 * Caddyfile ("server block without any key is global configuration, and if
 * used, it must be first"), and Caddy is the only ingress in domain mode, so
 * the whole site goes down and caddy crash-loops. This used to be
 * structurally impossible (the compose guard was `${CHAT_DOMAIN:?}`);
 * relaxing it to `${CHAT_DOMAIN:-}`, so a chat-off install could omit it,
 * reopened the same variable for a chat-ON install that never set it — e.g.
 * an operator who uncomments `COMPOSE_PROFILES=chat` in .env and nothing
 * else.
 *
 * An abort is used rather than a warning: the failure it prevents is a site
 * outage, and there is nothing useful to continue doing once it is detected.
 */
export function assertChatDomainConfigured(
  envText: string,
  mode: "localhost" | "domain",
  chat: boolean
): void {
  if (!chat || mode !== "domain" || envHasChatDomain(envText)) return;
  throw new Error(
    "Cortex Chat resolves ON, but .env has no CHAT_DOMAIN — in domain mode that takes " +
      "the WHOLE site down, not just chat.\n\n" +
      "Caddy is the only ingress in domain mode. The chat Caddyfile's {$CHAT_DOMAIN} left " +
      "empty makes Caddy refuse to adapt the entire config rather than just the chat site " +
      "block, so caddy crash-loops and nothing is reachable.\n\n" +
      "A domain-mode chat enable needs all four of these in .env, not just COMPOSE_PROFILES=chat:\n" +
      "  1. Point a second A record at this host, then set CHAT_DOMAIN and CHAT_BASE_URL\n" +
      "  2. Add the chat origin to CORS_ALLOWED_ORIGINS\n" +
      "  3. cp Caddyfile.chat.template Caddyfile\n" +
      "  4. Re-run `npx @mocaos/cortex update` (or `restart`, once these are set)\n\n" +
      "Nothing has been written or pulled — fix .env first."
  );
}

/**
 * Restores the pre-write .env and aborts when the .env `update` just wrote
 * fails `docker compose config` — see the call site below for why this
 * generic backstop exists.
 */
export function handleComposeGuardFailure(envPath: string, envBefore: string, stderr: string): never {
  writeEnvFile(envPath, envBefore);
  const profileLines = envBefore.split("\n").filter((l) => /^\s*#?\s*COMPOSE_PROFILES\s*=/.test(l));
  throw new Error(
    "`docker compose config` rejected the .env this update just wrote. Your previous .env " +
      "has been restored — nothing else was touched.\n\n" +
      (profileLines.length
        ? `Your COMPOSE_PROFILES line${profileLines.length > 1 ? "s" : ""}:\n  ${profileLines.join("\n  ")}\n\n`
        : "") +
      `Compose said:\n${stderr.trim()}\n\n` +
      "This usually means this installer's own COMPOSE_PROFILES editing disagreed with " +
      "Compose's .env parser on the line above. Fix it by hand and re-run `cortex update`, " +
      "or report the line above in an issue."
  );
}

export async function run(ctx: { flags: Record<string, string | boolean> }): Promise<void> {
  const version = installerVersion();
  banner(version);
  const { dir, state } = resolveInstall(ctx.flags);

  const envPath = join(dir, ".env");
  const envBefore = readFileSync(envPath, "utf8");

  // effectiveChat (src/chat.ts) is the single reconciliation of cortex.json
  // against .env — see its doc comment for the full rule. Computed up front,
  // before any network call or prompt, so assertChatDomainConfigured can fail
  // fast on the one combination that must never reach a backup, a pull, or a
  // write — see that function's doc comment.
  const chat = effectiveChat(envBefore, state);
  assertChatDomainConfigured(envBefore, state.mode, chat);

  const s = p.spinner();
  s.start("Checking for a newer release");
  const latest = await fetchStack({ version: ctx.flags.stack ? String(ctx.flags.stack) : undefined });
  assertInstallerSupported(latest, version);
  s.stop(`Installed ${state.stack} · available ${latest.stack}`);

  const diff = diffComponents(state.components, latest.components);
  if (!diff.some((d) => d.changed)) {
    p.outro(`Already on ${state.stack}. Nothing to do.`);
    return;
  }

  noteBox("Changes", diff.map((d) =>
    d.changed ? `${d.name.padEnd(9)} ${d.from} → ${d.to}` : `${d.name.padEnd(9)} ${d.from} (unchanged)`
  ));

  if (!ctx.flags.yes) {
    const go = await p.confirm({ message: `Update to ${latest.stack}?`, initialValue: true });
    if (p.isCancel(go) || !go) { p.cancel("Cancelled. Nothing changed."); return; }

    const backup = await p.confirm({ message: "Run a backup first?", initialValue: true });
    if (!p.isCancel(backup) && backup) {
      s.start("Backing up");
      try {
        await execIn(dir, "backup", ["/backup.sh"]);
        s.stop("Backup complete");
      } catch (err) {
        s.stop("Backup failed");
        p.log.error(String((err as Error).message).slice(0, 400));
        const anyway = await p.confirm({ message: "Continue without a fresh backup?", initialValue: false });
        if (p.isCancel(anyway) || !anyway) { p.cancel("Cancelled."); return; }
      }
    }
  }

  if (state.chat === undefined) {
    p.log.info("Cortex Chat stays installed. It is optional for new installs from this release on.");
  } else if (state.chat === false && chat) {
    p.log.info("Cortex Chat is active in .env even though it was previously turned off — leaving it on.");
  } else if (state.chat === true && !chat) {
    p.log.info("Cortex Chat is commented out in .env even though it was previously on — turning it off.");
  }

  // Refresh compose files + ops/ from the new tag, then repin .env.
  s.start("Fetching release artifacts");
  await fetchArtifacts({ version: latest.stack, dir, chat });
  s.stop("Release artifacts updated");

  // Atomic: this file holds the only copy of NEO4J_PASSWORD, and a truncating
  // write that dies mid-flight makes the graph permanently unauthenticatable.
  // See writeEnvFile. The profile edit folds into this same write rather than
  // adding a second one, so a crash never gets a chance to land between them.
  writeEnvFile(envPath, ensureChatProfile(rewriteImagePins(envBefore, latest.components), chat));

  // Generic backstop for a future parser gap: this installer's own
  // COMPOSE_PROFILES editing has disagreed with Compose's real dotenv parser
  // three times in review already (quoting, inline comments, and which of two
  // duplicate lines wins — see ensureChatProfile's doc comment in update.ts).
  // That case space is unbounded, so rather than assume the last one was
  // found, validate the exact file `pull`/`up` below are about to read, and
  // restore the previous .env on failure instead of leaving every `docker
  // compose` command in this directory broken until a human hand-edits it.
  const validated = await validateComposeConfig(dir);
  if (!validated.ok) handleComposeGuardFailure(envPath, envBefore, validated.stderr);

  p.log.success("Repinned images in .env (your other settings untouched)");

  const pulled = new Set<string>();
  s.start("Pulling images");
  await pull(dir, ({ image, done }) => { if (done) { pulled.add(image); s.message(`Pulling — ${pulled.size} done`); } });
  s.stop(`Pulled ${pulled.size} images`);

  s.start("Recreating containers");
  await up(dir);
  s.stop("Containers recreated");

  s.start("Waiting for health");
  // state.mode decides whether caddy is part of the stack — see healthServices.
  // An update that leaves caddy crash-looping on the new version is exactly the
  // case this must not report as healthy.
  const ok = await waitHealthy(dir, healthServices(state.mode, chat));
  s.stop(ok ? "All services healthy" : "Timed out waiting for health");

  writeState(dir, {
    ...state,
    installer: version,
    stack: latest.stack,
    components: latest.components,
    chat,
    previous: { stack: state.stack, components: state.components },
  });

  if (!ok) {
    // `state` here is still the PRE-update state: writeState above wrote a new
    // object to disk but never reassigned this binding, so state.stack and
    // state.components are genuinely the previous release's.
    //
    // The five .env lines alone are not a rollback and never were. fetchArtifacts
    // has already replaced docker-compose.yml, the overlays, Caddyfile.template
    // and ops/ with the NEW release's copies, so repinning the images by hand
    // leaves old images running against new compose files — a combination that
    // was never tested. `cortex update --stack <previous>` re-fetches that
    // release's artifacts AND repins .env to match, which is the only sequence
    // that actually restores the previous install. The manual lines stay as a
    // fallback for when the release manifest itself is unreachable.
    const prev = state.components;
    p.log.error(
      `Health check timed out on ${latest.stack}. To go back to ${state.stack}:\n\n` +
        `  npx @mocaos/cortex update --stack ${state.stack}\n\n` +
        `That re-fetches ${state.stack}'s compose files and repins .env together — ` +
        `note that editing .env alone is NOT enough, because the compose files in ` +
        `this directory have already been replaced with ${latest.stack}'s.\n` +
        `If the manifest is unreachable, restore these pins by hand (also recorded ` +
        `as \`previous\` in cortex.json) and re-fetch ${state.stack}'s artifacts:\n` +
        `  CORTEX_BACKEND_IMAGE=ghcr.io/mocaos/cortex-backend:${prev.backend}\n` +
        `  CORTEX_FRONTEND_IMAGE=ghcr.io/mocaos/cortex-frontend:${prev.frontend}\n` +
        `  CORTEX_CHAT_IMAGE=ghcr.io/mocaos/cortex-chat:${prev.chat}\n` +
        `  NEO4J_VERSION=${prev.neo4j}\n` +
        `  CADDY_VERSION=${prev.caddy}`
    );
  }
  p.outro(ok ? `Now on Cortex ${latest.stack}.` : "Update finished with warnings.");
}
