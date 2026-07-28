import { execFile } from "node:child_process";
import { mkdtempSync, cpSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

const REPO = "mocaOS/cortex-app";

/** Files that must exist in the install directory after a fetch. */
export const ARTIFACT_FILES = [
  "docker-compose.yml",
  "docker-compose.ports.yml",
  "docker-compose.caddy.yml",
  "Caddyfile.template",
  ".env.example",
] as const;

/**
 * Downloads the release tarball for `version` and lays the self-host artifacts
 * into `dir`. `ops/` must land beside the compose files because the backup
 * service builds from ./ops/backup, relative to the compose file. The release
 * attaches only stack.json, so the tarball is the supply route.
 */
export async function fetchArtifacts(opts: { version: string; dir: string }): Promise<void> {
  const url = `https://api.github.com/repos/${REPO}/tarball/v${opts.version}`;
  const work = mkdtempSync(join(tmpdir(), "cortex-art-"));
  const tgz = join(work, "src.tar.gz");

  try {
    // curl over fetch: follows redirects to codeload and streams to disk
    // without buffering a 6 MB body in memory.
    await exec("curl", ["-fsSL", url, "-o", tgz]);

    await exec("tar", [
      "-xzf", tgz,
      "-C", work,
      "--strip-components=1",
      `mocaOS-cortex-app-*/selfhost/`,
      `mocaOS-cortex-app-*/ops/`,
    ]);

    const src = join(work, "selfhost");
    if (!existsSync(src)) {
      throw new Error(`release v${opts.version} contains no selfhost/ directory`);
    }
    cpSync(src, opts.dir, { recursive: true });
    cpSync(join(work, "ops"), join(opts.dir, "ops"), { recursive: true });

    // The caddy overlay bind-mounts ./Caddyfile. If it is missing Docker
    // creates a root-owned DIRECTORY with that name and Caddy crash-loops on
    // "is a directory" with nothing pointing at the cause.
    cpSync(join(opts.dir, "Caddyfile.template"), join(opts.dir, "Caddyfile"));

    for (const f of ARTIFACT_FILES) {
      if (!existsSync(join(opts.dir, f))) {
        throw new Error(`release v${opts.version} is missing selfhost/${f}`);
      }
    }
  } catch (err: any) {
    const msg = String(err?.stderr ?? err?.message ?? err);
    if (/404/.test(msg)) {
      throw new Error(`No release found for v${opts.version} (HTTP 404)`);
    }
    throw new Error(`Could not fetch release artifacts for v${opts.version}: ${msg}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
