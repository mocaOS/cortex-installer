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
 * Sets or clears `COMPOSE_PROFILES=chat` in .env text, leaving every other line
 * byte-identical.
 *
 * Enabling prefers uncommenting the commented form the installer writes, so the
 * surrounding explanatory comment stays where it is and the line does not appear
 * twice. Disabling comments the line rather than deleting it, so the operator can
 * see what was turned off.
 */
export function ensureChatProfile(envText: string, enabled: boolean): string {
  const lines = envText.split("\n");
  const active = lines.findIndex((l) => /^\s*COMPOSE_PROFILES\s*=/.test(l));
  const commented = lines.findIndex((l) => /^\s*#\s*COMPOSE_PROFILES\s*=\s*chat\s*$/.test(l));

  if (enabled) {
    if (active !== -1) {
      lines[active] = "COMPOSE_PROFILES=chat";
    } else if (commented !== -1) {
      lines[commented] = "COMPOSE_PROFILES=chat";
    } else {
      // Prepend rather than append: COMPOSE_* belongs with the mode block, and a
      // trailing line after the secrets reads like an afterthought.
      lines.unshift("COMPOSE_PROFILES=chat");
    }
    return lines.join("\n");
  }

  if (active !== -1) lines[active] = "# COMPOSE_PROFILES=chat";
  return lines.join("\n");
}
