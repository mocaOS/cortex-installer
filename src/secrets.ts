import { randomBytes, randomInt } from "node:crypto";

export interface GeneratedSecrets {
  neo4jPassword: string;
  adminPassword: string;
  adminApiKey: string;
  sessionSecret: string;
  chatEncryptionKey: string;
}

/**
 * Mirrors the backend's production validator (backend/app/config.py). Keeping
 * this list in sync means a bad custom secret is rejected at the prompt rather
 * than by a container that refuses to boot 90 seconds later.
 */
export const WEAK_VALUES: ReadonlySet<string> = new Set([
  "",
  "secret",
  "password123",
  "your-pass",
  "another-pass",
  "custom-api-keyyy",
  "your-secure-admin-password",
  "cortex_admin_your-secure-api-key-here",
  "your-session-secret-key-at-least-32-characters-long",
  "default-secret-key-min-32-characters-long",
]);

/** Unambiguous alphabet: no 0/O/1/l/I, which get mistyped when transcribed. */
const READABLE = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

function readableGroup(len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += READABLE[randomInt(READABLE.length)];
  return s;
}

export function generateSecrets(): GeneratedSecrets {
  return {
    // base64url of 32 bytes, stripped to an alnum-safe subset: Compose
    // interpolates `$` inside .env values, so avoid it entirely.
    neo4jPassword: randomBytes(32).toString("base64url").replace(/[^A-Za-z0-9]/g, "").slice(0, 40),
    // 4 groups of 4 from a 57-symbol alphabet — transcribable over the phone, ~93 bits.
    adminPassword: [0, 1, 2, 3].map(() => readableGroup(4)).join("-"),
    adminApiKey: `cortex_admin_${randomBytes(32).toString("hex")}`,
    sessionSecret: randomBytes(48).toString("hex"),
    chatEncryptionKey: randomBytes(32).toString("base64"),
  };
}

function isPlaceholder(v: string): boolean {
  return WEAK_VALUES.has(v) || v.startsWith("CHANGE_ME");
}

export function validateSecret(kind: keyof GeneratedSecrets, value: string): string | null {
  if (value.length === 0) return "must not be empty";
  if (isPlaceholder(value)) {
    return "is a known placeholder the backend refuses in production — pick another";
  }
  if (value.includes("$")) {
    return "must not contain `$` — Docker Compose interpolates it inside .env values";
  }
  if (kind === "sessionSecret" && value.length < 32) {
    return "must be at least 32 characters";
  }
  if (kind === "chatEncryptionKey") {
    // Buffer.from(..., "base64") never throws — it decodes leniently — so a
    // length check is the only meaningful validation, and a try/catch here
    // would be dead code implying a failure mode that cannot occur.
    if (Buffer.from(value, "base64").length !== 32) {
      return "must be exactly 32 bytes, base64 encoded (openssl rand -base64 32)";
    }
  }
  return null;
}
