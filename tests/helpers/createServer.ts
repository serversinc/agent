import { Hono } from "hono";

export function createServer(app: Hono) {
  const http = require("http");

  const server = http.createServer((req: any, res: any) => {
    (async () => {
      try {
        const url = `http://127.0.0.1${req.url}`;
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers || {})) {
          if (v === undefined) continue;
          if (Array.isArray(v)) headers.set(k, v.join(","));
          else headers.set(k, String(v));
        }

        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.from(chunk));
        }
        const rawBody = chunks.length ? Buffer.concat(chunks) : null;

        const fetchReq = new Request(url, { method: req.method, headers, body: rawBody });

        const response: Response = await app.fetch(fetchReq as any);
        const buffer = Buffer.from(await response.arrayBuffer());
        const headersObj: Record<string, string> = {};
        response.headers.forEach((v, k) => (headersObj[k] = v));
        res.writeHead(response.status, headersObj);
        res.end(buffer);
      } catch (err: any) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(err?.message || String(err));
      }
    })();
  });

  return {
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        try {
          // if server isn't listening, resolving immediately avoids "Server is not running" errors
          if (!server.listening) return resolve();
          server.close((err: any) => (err ? reject(err) : resolve()));
        } catch (err) {
          // some Node versions may throw when closing an unused server; ignore and resolve
          resolve();
        }
      }),
  };
}
