import { resolve4 } from "node:dns/promises";
import { prompts as p } from "./ui.js";
import { PROVIDERS, providerById } from "./providers.js";
import { generateSecrets, validateSecret, type GeneratedSecrets } from "./secrets.js";
import { listModels, probeChat, probeEmbedding } from "./validate.js";
import { checkPort, existingProjectVolumes } from "./preflight.js";
import type { InstallConfig } from "./env.js";
import type { Stack } from "./stack.js";

const DEFAULT_PORTS = { app: 3000, chat: 3001, api: 8000, neo4jHttp: 7474, neo4jBolt: 7687 };

function bail(msg: string): never {
  p.cancel(msg);
  process.exit(1);
}

/**
 * Spec: "offer alternatives on conflict". A taken port would otherwise surface
 * as a `docker compose up` failure after a 1.4 GB pull, so resolve it here.
 */
async function resolvePorts(): Promise<InstallConfig["ports"]> {
  const ports = { ...DEFAULT_PORTS };
  const labels: Array<[keyof typeof ports, string]> = [
    ["app", "Cortex"],
    ["chat", "Cortex Chat"],
    ["api", "backend API"],
    ["neo4jHttp", "Neo4j browser"],
    ["neo4jBolt", "Neo4j bolt"],
  ];

  for (const [key, label] of labels) {
    while (!(await checkPort(ports[key]))) {
      p.log.warn(`Port ${ports[key]} (${label}) is already in use.`);
      const next = await p.text({
        message: `Port for ${label}`,
        initialValue: String(ports[key] + 1000),
        validate: (v) => {
          const n = Number(v);
          if (!Number.isInteger(n) || n < 1 || n > 65535) return "Enter a port between 1 and 65535";
          if (Object.values(ports).includes(n)) return "Already used by another Cortex service";
          return undefined;
        },
      });
      if (p.isCancel(next)) bail("Cancelled.");
      ports[key] = Number(next);
    }
  }
  return ports;
}

/** --yes path. Throws with EVERY missing value, not just the first. */
export function buildConfigNonInteractive(
  env: Record<string, string | undefined>,
  stack: Stack,
  dir: string
): InstallConfig {
  const mode = (env.CORTEX_MODE ?? "localhost") as InstallConfig["mode"];
  if (mode !== "localhost" && mode !== "domain") {
    throw new Error(`CORTEX_MODE must be "localhost" or "domain", got "${mode}"`);
  }

  const missing: string[] = [];
  const need = (k: string): string => {
    const v = env[k];
    if (!v) { missing.push(k); return ""; }
    return v;
  };

  const adminEmail = need("CORTEX_ADMIN_EMAIL");
  const apiKey = need("CORTEX_OPENAI_API_KEY");
  const chatModel = need("CORTEX_OPENAI_MODEL");
  const embeddingModel = need("CORTEX_EMBEDDING_MODEL");
  const embeddingDimension = Number(need("CORTEX_EMBEDDING_DIMENSION"));

  let domains: InstallConfig["domains"];
  if (mode === "domain") {
    const app = need("CORTEX_APP_DOMAIN");
    const chat = need("CORTEX_CHAT_DOMAIN");
    const acmeEmail = need("CORTEX_ACME_EMAIL");
    domains = { app, chat, acmeEmail };
  }

  if (missing.length) {
    throw new Error(
      `Non-interactive install is missing required values:\n  - ${missing.join("\n  - ")}\n` +
        `Set them in the environment, or drop --yes to use the wizard.`
    );
  }

  // Supplied secrets override generated ones, and are validated the same way.
  const generated = generateSecrets();
  const overrides: Array<[keyof GeneratedSecrets, string | undefined]> = [
    ["neo4jPassword", env.CORTEX_NEO4J_PASSWORD],
    ["adminPassword", env.CORTEX_ADMIN_PASSWORD],
    ["adminApiKey", env.CORTEX_ADMIN_API_KEY],
    ["sessionSecret", env.CORTEX_SESSION_SECRET],
    ["chatEncryptionKey", env.CORTEX_CHAT_ENCRYPTION_KEY],
  ];
  const secrets = { ...generated };
  for (const [key, value] of overrides) {
    if (value === undefined) continue;
    const err = validateSecret(key, value);
    if (err) throw new Error(`${key} ${err}`);
    secrets[key] = value;
  }

  const provider = providerById(env.CORTEX_PROVIDER ?? "other");
  return {
    mode,
    dir,
    projectName: env.CORTEX_PROJECT_NAME ?? "cortex",
    stack,
    secrets,
    adminEmail,
    llm: {
      providerId: provider?.id ?? "other",
      baseUrl: env.CORTEX_OPENAI_API_BASE ?? provider?.baseUrl ?? "https://api.openai.com/v1",
      apiKey,
      chatModel,
      embeddingModel,
      embeddingDimension,
      embeddingSendDimensions: env.CORTEX_EMBEDDING_SEND_DIMENSIONS !== "false",
    },
    ports: {
      app: Number(env.CORTEX_APP_PORT ?? DEFAULT_PORTS.app),
      chat: Number(env.CORTEX_CHAT_PORT ?? DEFAULT_PORTS.chat),
      api: Number(env.CORTEX_API_PORT ?? DEFAULT_PORTS.api),
      neo4jHttp: Number(env.CORTEX_NEO4J_HTTP_PORT ?? DEFAULT_PORTS.neo4jHttp),
      neo4jBolt: Number(env.CORTEX_NEO4J_BOLT_PORT ?? DEFAULT_PORTS.neo4jBolt),
    },
    domains,
    errorReporting: env.CORTEX_ERROR_REPORTING === "true",
  };
}

/**
 * The --yes counterpart of the wizard's own project-name-collision loop (see
 * the "project name" block inside runWizard). buildConfigNonInteractive is a
 * plain synchronous function and cannot itself await the Docker call that
 * lists volumes, so callers fetch the listing (existingProjectVolumes, in
 * preflight.ts) and pass it in here — which also means this function is
 * fully testable without touching this machine's real volumes.
 *
 * --yes cannot prompt, so unlike the wizard, a collision under a NAME THE
 * CALLER DID NOT EXPLICITLY CHOOSE is a hard failure (aggregate-then-throw,
 * matching the missing-required-value check above: list every colliding
 * volume and both remedies in one message, not one at a time). A collision
 * under an explicitly set CORTEX_PROJECT_NAME is treated as deliberate reuse
 * instead, mirroring the wizard's own "reuse" choice — this returns a
 * warning for the caller to display rather than throwing, since printing is
 * install.ts's job, not this function's.
 */
export function checkProjectVolumeCollision(
  projectName: string,
  existingVolumes: string[],
  explicit: boolean
): string | undefined {
  if (existingVolumes.length === 0) return undefined;

  if (!explicit) {
    throw new Error(
      `Project name "${projectName}" already has existing data volumes on this machine:\n` +
        existingVolumes.map((v) => `  - ${v}`).join("\n") +
        `\nSet CORTEX_PROJECT_NAME to a different name (recommended — leaves that data ` +
        `untouched), or remove those volumes yourself if you are certain they are not needed.`
    );
  }

  return (
    `Reusing project "${projectName}" and its existing data (CORTEX_PROJECT_NAME was set ` +
    `explicitly). If Neo4j rejects the generated password, that volume already belongs to ` +
    `different credentials: restore the ORIGINAL NEO4J_PASSWORD for this data into .env, ` +
    `then run \`cortex restart\`.`
  );
}

export async function runWizard(opts: { stack: Stack; dir: string }): Promise<InstallConfig> {
  const mode = (await p.select({
    message: "How will you reach Cortex?",
    options: [
      { value: "localhost", label: "Localhost", hint: "http://localhost:3000" },
      { value: "domain", label: "Public domain", hint: "automatic HTTPS via Caddy" },
    ],
  })) as InstallConfig["mode"];
  if (p.isCancel(mode)) bail("Cancelled.");

  let domains: InstallConfig["domains"];
  if (mode === "domain") {
    const app = await p.text({
      message: "Domain for Cortex",
      placeholder: "cortex.example.com",
      validate: (v) => (v && v.includes(".") ? undefined : "Enter a fully-qualified domain"),
    });
    if (p.isCancel(app)) bail("Cancelled.");
    const chat = await p.text({
      message: "Domain for Cortex Chat",
      placeholder: "chat.example.com",
      validate: (v) => (v && v.includes(".") ? undefined : "Enter a fully-qualified domain"),
    });
    if (p.isCancel(chat)) bail("Cancelled.");
    const acmeEmail = await p.text({
      message: "Email for Let's Encrypt",
      validate: (v) => (v && v.includes("@") ? undefined : "Enter an email address"),
    });
    if (p.isCancel(acmeEmail)) bail("Cancelled.");
    domains = { app: String(app), chat: String(chat), acmeEmail: String(acmeEmail) };

    // Spec: resolve each domain and warn. Let's Encrypt validates over HTTP, so
    // a domain that does not resolve at all cannot possibly get a certificate —
    // catching it here beats a Caddy crash-loop after the images are pulled.
    for (const host of [domains.app, domains.chat]) {
      try {
        const addrs = await resolve4(host);
        p.log.success(`${host} resolves to ${addrs.join(", ")}`);
      } catch {
        p.log.warn(
          `${host} does not resolve. Certificate issuance will fail until its ` +
            `A record points at this host.`
        );
      }
    }
    const dnsOk = await p.confirm({
      message: "Continue? Both domains must point at this host before Caddy starts.",
      initialValue: true,
    });
    if (p.isCancel(dnsOk) || !dnsOk) bail("Cancelled. Nothing was written.");
  }

  // --- project name: must not collide with an existing data volume --------
  // Docker volumes are named `<project>_<name>` and are global to the daemon,
  // not scoped to this install directory — `docker volume ls` sees volumes
  // from every install anyone has ever run here. Neo4j only applies
  // NEO4J_PASSWORD the first time its volume is created, so silently reusing
  // a project name that already owns a `<project>_neo4j_data` volume would
  // write a freshly generated password that Neo4j never adopts — the backend
  // would then retry the old volume's real credentials until Neo4j rate-limits
  // it (a confusing `AuthenticationRateLimit` with no obvious cause). This is
  // resolved here, before secrets are even generated, and it only ever asks —
  // it never deletes or touches an existing volume.
  let projectName = "cortex";
  for (;;) {
    const existing = await existingProjectVolumes(projectName);
    if (existing.length === 0) break;

    p.log.warn(
      `Project name "${projectName}" already has existing data on this machine:\n` +
        existing.map((v) => `  - ${v}`).join("\n")
    );
    const choice = await p.select({
      message: "How do you want to handle this?",
      options: [
        {
          value: "rename",
          label: "Use a different project name",
          hint: "recommended — leaves that existing data untouched",
        },
        {
          value: "reuse",
          label: `Reuse "${projectName}" and its existing data`,
          hint: "advanced — only if you know this data is yours",
        },
        { value: "abort", label: "Abort" },
      ],
    });
    if (p.isCancel(choice)) bail("Cancelled.");
    if (choice === "abort") bail("Cancelled. Nothing was written.");

    if (choice === "reuse") {
      p.log.warn(
        `Continuing with "${projectName}". If Neo4j rejects the freshly generated ` +
          `password, that volume already belongs to different credentials: restore ` +
          `the ORIGINAL NEO4J_PASSWORD for this data into .env, then run ` +
          `\`cortex restart\`.`
      );
      break;
    }

    // choice === "rename" — loop back and re-check the new candidate too.
    const next = await p.text({
      message: "New project name",
      placeholder: "cortex-2",
      initialValue: projectName,
      validate: (v) =>
        v && /^[a-z0-9][a-z0-9_-]*$/.test(v)
          ? undefined
          : "Lowercase letters, digits, - and _ only, starting with a letter or digit",
    });
    if (p.isCancel(next)) bail("Cancelled.");
    projectName = String(next);
  }

  const depth = await p.select({
    message: "Setup depth",
    options: [
      { value: "quick", label: "Quick", hint: "one provider, sensible defaults" },
      { value: "advanced", label: "Advanced", hint: "per-task models, resources, SMTP" },
    ],
  });
  if (p.isCancel(depth)) bail("Cancelled.");

  // --- LLM provider -------------------------------------------------------
  const providerId = await p.select({
    message: "LLM provider",
    options: PROVIDERS.map((pr) => ({ value: pr.id, label: pr.label, hint: pr.hint })),
  });
  if (p.isCancel(providerId)) bail("Cancelled.");
  const provider = providerById(String(providerId))!;

  let baseUrl = provider.baseUrl;
  if (!baseUrl) {
    const entered = await p.text({
      message: "OpenAI-compatible base URL",
      placeholder: "https://llm.example.com/v1",
      validate: (v) => (v?.startsWith("http") ? undefined : "Must start with http:// or https://"),
    });
    if (p.isCancel(entered)) bail("Cancelled.");
    baseUrl = String(entered);
  }

  let apiKey = "";
  if (provider.needsKey) {
    const entered = await p.password({
      message: "API key",
      validate: (v) => (v ? undefined : "Required"),
    });
    if (p.isCancel(entered)) bail("Cancelled.");
    apiKey = String(entered);
  }

  // --- model selection, from the real list when available -----------------
  const s = p.spinner();
  s.start("Fetching available models");
  const models = await listModels({ baseUrl, apiKey, model: "" });
  s.stop(models.length ? `${models.length} models from ${new URL(baseUrl).host}` : "Model list unavailable — enter names manually");

  /**
   * Falls back to free text in TWO cases, both real: the endpoint has no
   * /v1/models at all, and the endpoint lists models but none match the filter.
   * The second case is not hypothetical — OpenRouter serves embeddings happily
   * but lists zero embedding models, so filtering its 341 entries for /embed/
   * yields nothing. Showing the unfiltered list there would ask the user to
   * pick an embedding model from 341 chat models, none of which is valid.
   */
  const pickModel = async (
    message: string,
    filter: (m: string) => boolean,
    placeholder: string
  ): Promise<string> => {
    const matches = models.filter(filter);
    if (matches.length) {
      const v = await p.select({
        message,
        options: matches.map((m) => ({ value: m, label: m })),
      });
      if (p.isCancel(v)) bail("Cancelled.");
      return String(v);
    }
    if (models.length) {
      p.log.info(
        `This endpoint lists ${models.length} models but none look like a match ` +
          `for "${message.toLowerCase()}" — enter the name yourself.`
      );
    }
    const v = await p.text({
      message,
      placeholder,
      validate: (x) => (x ? undefined : "Required"),
    });
    if (p.isCancel(v)) bail("Cancelled.");
    return String(v);
  };

  const chatModel = await pickModel(
    "Chat model",
    (m) => !/embed/i.test(m),
    "gpt-5.2"
  );
  const embeddingModel = await pickModel(
    "Embedding model",
    (m) => /embed/i.test(m),
    "text-embedding-3-small"
  );

  // --- probes: nothing is written until these pass -------------------------
  s.start("Testing chat completion");
  const chatProbe = await probeChat({ baseUrl, apiKey, model: chatModel });
  if (!chatProbe.ok) {
    s.stop("Chat probe failed");
    p.log.error(
      `${chatProbe.status ? `HTTP ${chatProbe.status}` : "Request failed"}: ${chatProbe.body ?? ""}`
    );
    bail("The LLM endpoint did not answer. Nothing was written.");
  }
  s.stop(`Chat completion OK (${chatProbe.ms} ms)`);

  s.start("Testing embeddings");
  const embedProbe = await probeEmbedding({ baseUrl, apiKey, model: embeddingModel });
  if (!embedProbe.ok) {
    s.stop("Embedding probe failed");
    p.log.error(
      `${embedProbe.status ? `HTTP ${embedProbe.status}` : "Request failed"}: ${embedProbe.body ?? ""}`
    );
    bail("The embedding endpoint did not answer. Nothing was written.");
  }
  s.stop(`Embeddings OK — ${embedProbe.dimension} dimensions detected`);
  p.log.info(
    "This dimension is baked into the Neo4j vector index. Changing it later " +
      "requires re-embedding everything."
  );

  // --- identity + secrets --------------------------------------------------
  const adminEmail = await p.text({
    message: "Admin email",
    placeholder: "you@example.com",
    validate: (v) => (v?.includes("@") ? undefined : "Enter an email address"),
  });
  if (p.isCancel(adminEmail)) bail("Cancelled.");

  const secretChoice = await p.select({
    message: "Secrets",
    options: [
      { value: "generate", label: "Generate all five automatically" },
      { value: "custom", label: "Let me set them" },
    ],
  });
  if (p.isCancel(secretChoice)) bail("Cancelled.");

  let secrets = generateSecrets();
  if (secretChoice === "custom") {
    const keys: Array<[keyof GeneratedSecrets, string]> = [
      ["adminPassword", "Admin password"],
      ["neo4jPassword", "Neo4j password"],
      ["adminApiKey", "Admin API key"],
      ["sessionSecret", "Session secret (>= 32 chars)"],
      ["chatEncryptionKey", "Chat encryption key (32 bytes base64)"],
    ];
    for (const [key, label] of keys) {
      const v = await p.password({
        message: label,
        validate: (x) => validateSecret(key, String(x ?? "")) ?? undefined,
      });
      if (p.isCancel(v)) bail("Cancelled.");
      secrets = { ...secrets, [key]: String(v) };
    }
  }

  const errorReporting = await p.confirm({
    message: "Send anonymous crash reports to the Cortex maintainers?",
    initialValue: false,
  });
  if (p.isCancel(errorReporting)) bail("Cancelled.");

  let advanced: InstallConfig["advanced"];
  let smtp: InstallConfig["smtp"];
  if (depth === "advanced") {
    const gx = await p.text({ message: "Graph extraction model (blank to inherit)", defaultValue: "" });
    if (p.isCancel(gx)) bail("Cancelled.");
    const vm = await p.text({ message: "Vision model (blank to inherit)", defaultValue: "" });
    if (p.isCancel(vm)) bail("Cancelled.");
    advanced = {
      graphExtractionModel: String(gx) || undefined,
      visionModel: String(vm) || undefined,
    };

    const wantSmtp = await p.confirm({ message: "Configure SMTP for chat password reset?", initialValue: false });
    if (p.isCancel(wantSmtp)) bail("Cancelled.");
    if (wantSmtp) {
      const host = await p.text({ message: "SMTP host", validate: (v) => (v ? undefined : "Required") });
      if (p.isCancel(host)) bail("Cancelled.");
      const from = await p.text({ message: "From address", validate: (v) => (v?.includes("@") ? undefined : "Required") });
      if (p.isCancel(from)) bail("Cancelled.");
      smtp = { host: String(host), port: 587, secure: false, from: String(from) };
    }
  }

  return {
    mode,
    dir: opts.dir,
    projectName,
    stack: opts.stack,
    secrets,
    adminEmail: String(adminEmail),
    llm: {
      providerId: provider.id,
      baseUrl,
      apiKey,
      chatModel,
      embeddingModel,
      embeddingDimension: embedProbe.dimension,
      embeddingSendDimensions: embedProbe.sendDimensions,
    },
    // Only localhost mode publishes ports, so only it needs conflict resolution.
    ports: mode === "localhost" ? await resolvePorts() : DEFAULT_PORTS,
    domains,
    smtp,
    errorReporting: Boolean(errorReporting),
    advanced,
  };
}
