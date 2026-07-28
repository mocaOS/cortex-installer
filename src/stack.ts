import semver from "semver";

export interface Stack {
  stack: string;
  components: {
    backend: string;
    frontend: string;
    chat: string;
    neo4j: string;
    caddy: string;
  };
  minInstaller: string;
  notes?: string;
}

const REPO = "mocaOS/cortex-app";
const COMPONENTS = ["backend", "frontend", "chat", "neo4j", "caddy"] as const;

function isNonEmptyString(val: unknown): boolean {
  return typeof val === "string" && val.trim().length > 0;
}

export function parseStack(raw: unknown): Stack {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("stack.json is not an object — the release manifest is malformed");
  }
  const o = raw as Record<string, any>;

  if (!isNonEmptyString(o.stack)) throw new Error("stack.json is missing `stack`");
  if (!isNonEmptyString(o.minInstaller)) throw new Error("stack.json is missing `minInstaller`");
  if (!semver.valid(o.stack)) {
    throw new Error(`stack.json has an invalid \`stack\` version: "${o.stack}"`);
  }
  if (!semver.valid(o.minInstaller)) {
    throw new Error(`stack.json has an invalid \`minInstaller\` version: "${o.minInstaller}"`);
  }
  if (typeof o.components !== "object" || o.components === null) {
    throw new Error("stack.json is missing `components`");
  }
  for (const c of COMPONENTS) {
    if (!isNonEmptyString(o.components[c])) {
      throw new Error(`stack.json is missing components.${c}`);
    }
  }
  return o as Stack;
}

export function assertInstallerSupported(stack: Stack, installer: string): void {
  // Component pins like "5.26-community" are not semver, but stack/minInstaller
  // are always validated as valid semver in parseStack, so direct comparison is safe.
  if (semver.lt(installer, stack.minInstaller)) {
    throw new Error(
      `Cortex ${stack.stack} needs installer >= ${stack.minInstaller}, but this is ${installer}.\n` +
        `Run \`npx @mocaos/cortex@latest\` to get the newer installer.`
    );
  }
}

export function imageRefs(stack: Stack): { backend: string; frontend: string; chat: string } {
  return {
    backend: `ghcr.io/mocaos/cortex-backend:${stack.components.backend}`,
    frontend: `ghcr.io/mocaos/cortex-frontend:${stack.components.frontend}`,
    chat: `ghcr.io/mocaos/cortex-chat:${stack.components.chat}`,
  };
}

export function stackUrl(version?: string): string {
  return version
    ? `https://github.com/${REPO}/releases/download/v${version}/stack.json`
    : `https://github.com/${REPO}/releases/latest/download/stack.json`;
}

export async function fetchStack(opts?: {
  version?: string;
  fetchImpl?: typeof fetch;
}): Promise<Stack> {
  const f = opts?.fetchImpl ?? fetch;
  const url = stackUrl(opts?.version);
  const res = await f(url, { redirect: "follow" } as RequestInit);
  if (!res.ok) {
    throw new Error(`Could not fetch ${url} (HTTP ${res.status})`);
  }
  return parseStack(await res.json());
}
