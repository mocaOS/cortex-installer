import { createServer, type Server } from "node:http";

export interface FakeOpts {
  /** Omit /v1/models entirely (some gateways do). */
  noModelsEndpoint?: boolean;
  /** Reject every request with 401. */
  unauthorized?: boolean;
  /** Natural embedding dimension. */
  dimension?: number;
  /** Reject requests that carry a `dimensions` parameter. */
  rejectDimensions?: boolean;
  /** Never respond, to exercise timeouts. */
  hang?: boolean;
}

export async function startFakeOpenAI(opts: FakeOpts = {}): Promise<{ url: string; close: () => Promise<void>; server: Server }> {
  const dim = opts.dimension ?? 1536;

  const server = createServer((req, res) => {
    if (opts.hang) return;
    if (opts.unauthorized) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "invalid api key" } }));
    }

    const url = req.url ?? "";
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (url.startsWith("/v1/models")) {
      if (opts.noModelsEndpoint) return send(404, { error: { message: "not found" } });
      return send(200, { data: [{ id: "gpt-test" }, { id: "text-embedding-test" }] });
    }

    if (url.startsWith("/v1/chat/completions")) {
      return send(200, { choices: [{ message: { role: "assistant", content: "ok" } }] });
    }

    if (url.startsWith("/v1/embeddings")) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let parsed: any = {};
        try { parsed = JSON.parse(raw); } catch { /* ignore */ }
        if (opts.rejectDimensions && parsed.dimensions !== undefined) {
          return send(400, { error: { message: "dimensions is not supported by this model" } });
        }
        const size = parsed.dimensions ?? dim;
        return send(200, { data: [{ embedding: new Array(size).fill(0) }] });
      });
      return;
    }

    send(404, { error: { message: "unknown route" } });
  });

  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    server,
    close: () => new Promise<void>((res) => server.close(() => res())),
  };
}
