import type { Stack } from "./stack.js";

type Components = Stack["components"];

const IMAGE_LINES: Record<string, (c: Components) => string> = {
  CORTEX_BACKEND_IMAGE: (c) => `ghcr.io/mocaos/cortex-backend:${c.backend}`,
  CORTEX_FRONTEND_IMAGE: (c) => `ghcr.io/mocaos/cortex-frontend:${c.frontend}`,
  CORTEX_CHAT_IMAGE: (c) => `ghcr.io/mocaos/cortex-chat:${c.chat}`,
  NEO4J_VERSION: (c) => c.neo4j,
  CADDY_VERSION: (c) => c.caddy,
};

export function diffComponents(
  from: Components,
  to: Components
): Array<{ name: string; from: string; to: string; changed: boolean }> {
  return (Object.keys(from) as Array<keyof Components>).map((name) => ({
    name,
    from: from[name],
    to: to[name],
    changed: from[name] !== to[name],
  }));
}

/**
 * Surgically replaces only the pin lines. The rest of .env — comments, custom
 * additions, secrets — is preserved byte for byte, so an update never clobbers
 * the user's edits.
 */
export function rewriteImagePins(envText: string, components: Components): string {
  return envText
    .split("\n")
    .map((line) => {
      const eq = line.indexOf("=");
      if (eq <= 0 || line.trimStart().startsWith("#")) return line;
      // Trim the key so an indented pin line is still matched rather than
      // silently skipped, and preserve a CRLF terminator so an update does not
      // leave LF pin lines mixed into an otherwise CRLF file.
      const key = line.slice(0, eq).trim();
      const build = IMAGE_LINES[key];
      if (!build) return line;
      const eol = line.endsWith("\r") ? "\r" : "";
      return `${key}=${build(components)}${eol}`;
    })
    .join("\n");
}

/**
 * Normalizes a raw COMPOSE_PROFILES value the way Compose's own .env parser
 * does, so membership checks here agree with what Compose actually sees.
 *
 * A value wrapped in one matching pair of quotes (single or double) is taken
 * literally — quotes stripped, nothing else touched, and in particular a `#`
 * inside it is part of the value, not a comment. An unquoted value has a
 * trailing `#…` comment removed, because that IS how Compose reads it.
 * Getting this backwards is exactly the bug this function exists to fix:
 * splitting the raw text let `"chat,myextra"` parse as two bogus entries
 * (`"chat` and `myextra"`) and let `chat # note` parse as the single entry
 * `chat # note` — both hide a `chat` that Compose can see, or fabricate one
 * it can't.
 */
function normalizeProfilesValue(raw: string): string {
  const trimmed = raw.trim();
  const quote = trimmed[0];
  if (trimmed.length >= 2 && (quote === '"' || quote === "'") && trimmed[trimmed.length - 1] === quote) {
    return trimmed.slice(1, -1);
  }
  const hash = trimmed.indexOf("#");
  return hash === -1 ? trimmed : trimmed.slice(0, hash).trim();
}

/** Splits a COMPOSE_PROFILES value into its comma-separated entries, trimmed and with empty entries dropped. */
function splitProfiles(value: string): string[] {
  return normalizeProfilesValue(value)
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Whether an active (uncommented) `COMPOSE_PROFILES` line in .env text already
 * lists `chat` among its comma-separated values.
 *
 * Exported and disk-free so the reconciliation in `commands/update.ts` is
 * unit-testable: `state.chat` can go stale relative to .env in either
 * direction, because the installer's own documented route for declining chat
 * (see the "NOT installed" blocks in `renderEnv`, env.ts) tells the operator
 * to uncomment one line and restart, and never touches cortex.json. Trusting
 * cortex.json alone would silently undo exactly what that instruction told
 * the operator to do. Goes through the same quote/comment normalization as
 * `ensureChatProfile`, so a hand-edited `COMPOSE_PROFILES="chat"` is
 * recognized too, not just the unquoted form.
 */
export function envHasChatProfile(envText: string): boolean {
  const line = envText.split("\n").find((l) => /^\s*COMPOSE_PROFILES\s*=/.test(l));
  return line !== undefined && splitProfiles(line.slice(line.indexOf("=") + 1)).includes("chat");
}

/**
 * Sets or clears `chat` within .env's `COMPOSE_PROFILES` list, leaving every
 * other line — and every other profile already sharing that line — byte
 * identical.
 *
 * The value is treated as a comma-separated list rather than assumed to be
 * `chat` alone: the installer's own file header blesses
 * docker-compose.override.yml for an operator's own profile-gated add-ons (see
 * env.ts), and those commonly share COMPOSE_PROFILES with chat. Assigning the
 * literal string "chat" here would silently drop whatever service the
 * operator's own profile gates on the next `up` — the same class of silent
 * loss this whole function exists to prevent, just aimed at the operator
 * instead of us.
 *
 * The list is read through `splitProfiles`, which normalizes quoting and
 * inline comments the way Compose's own parser does — see
 * `normalizeProfilesValue`. Whenever an active line is actually rewritten, the
 * output is always the plain unquoted form the installer itself writes: this
 * function does not try to preserve an operator's quoting or inline comment,
 * because doing so is what let a quoted or commented value disagree with what
 * Compose reads from it in the first place. A line already in that canonical
 * form and already correct is left completely untouched (compared by value,
 * not just re-derived), so this is still a byte-for-byte no-op whenever there
 * is truly nothing to do.
 *
 * Enabling prefers uncommenting the commented form the installer writes, so the
 * surrounding explanatory comment stays where it is and the line does not
 * appear twice. Disabling removes only the `chat` entry and keeps every other
 * one in place and in order; it comments the line out — rather than leaving a
 * bare `COMPOSE_PROFILES=` — only once removing `chat` would empty the list,
 * and it leaves the line untouched entirely if `chat` was never in it.
 */
export function ensureChatProfile(envText: string, enabled: boolean): string {
  const lines = envText.split("\n");
  const active = lines.findIndex((l) => /^\s*COMPOSE_PROFILES\s*=/.test(l));
  const commented = lines.findIndex((l) => /^\s*#\s*COMPOSE_PROFILES\s*=\s*chat\s*$/.test(l));

  if (enabled) {
    if (active !== -1) {
      const profiles = splitProfiles(lines[active].slice(lines[active].indexOf("=") + 1));
      const target = profiles.includes("chat") ? profiles : [...profiles, "chat"];
      const canonical = `COMPOSE_PROFILES=${target.join(",")}`;
      if (lines[active] !== canonical) lines[active] = canonical;
    } else if (commented !== -1) {
      lines[commented] = "COMPOSE_PROFILES=chat";
    } else {
      // Append rather than prepend: Compose is last-wins on a duplicate key, so
      // an appended line reliably beats one this function failed to recognize
      // (e.g. an `export COMPOSE_PROFILES=` form) — a prepended line would
      // silently lose to it instead. Insert before a trailing blank element
      // rather than after it, so a file that already ends in a newline still
      // does, instead of gaining a stray blank line in the middle.
      if (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.splice(lines.length - 1, 0, "COMPOSE_PROFILES=chat");
      } else {
        lines.push("COMPOSE_PROFILES=chat");
      }
    }
    return lines.join("\n");
  }

  if (active !== -1) {
    const profiles = splitProfiles(lines[active].slice(lines[active].indexOf("=") + 1));
    if (profiles.includes("chat")) {
      const rest = profiles.filter((p) => p !== "chat");
      const canonical = rest.length > 0 ? `COMPOSE_PROFILES=${rest.join(",")}` : "# COMPOSE_PROFILES=chat";
      if (lines[active] !== canonical) lines[active] = canonical;
    }
  }
  return lines.join("\n");
}
