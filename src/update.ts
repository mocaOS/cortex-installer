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
      const key = line.slice(0, eq);
      const build = IMAGE_LINES[key];
      return build ? `${key}=${build(components)}` : line;
    })
    .join("\n");
}
