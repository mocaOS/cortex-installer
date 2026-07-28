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

    // Discover the archive's top-level directory instead of globbing for it.
    // GNU tar (every Linux install — the primary target) REFUSES wildcards in
    // member names without --wildcards, which bsdtar does not accept, so a
    // glob that works on macOS extracts nothing on Linux:
    //   tar: Pattern matching characters used in file names
    //   tar: mocaOS-cortex-app-*/selfhost: Not found in archive
    // Literal paths need no wildcard support and behave identically on both.
    //
    // maxBuffer: the real v1.0.0 listing is ~35 KB for 581 entries — comfortably
    // under Node's 1 MB default — but a silently-truncated listing would fail
    // obscurely ("stdout maxBuffer exceeded") on some future, much larger
    // release, so this is sized with generous headroom rather than left at
    // the default.
    const { stdout: listing } = await exec("tar", ["-tzf", tgz], { maxBuffer: 16 * 1024 * 1024 });
    const prefix = listing.split("\n")[0]?.split("/")[0];
    if (!prefix) {
      throw new Error(`release v${opts.version} tarball is empty or unreadable`);
    }

    await exec("tar", [
      "-xzf", tgz,
      "-C", work,
      "--strip-components=1",
      `${prefix}/selfhost`,
      `${prefix}/ops`,
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
