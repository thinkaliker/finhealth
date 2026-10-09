// Local server: serves the web page from ./public and a JSON API backed by one data file.
// Uses the same calculation module as the browser (public/finhealth.js). No dependencies.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalize, analyze, exportJSON, exportMarkdown } from "./public/finhealth.js";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const MAX_BODY = 1_000_000;
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8",
};

export async function readData(file) {
  try {
    return normalize(JSON.parse(await fs.readFile(file, "utf8")));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    if (e instanceof SyntaxError) throw new Error(`${file} is not valid JSON: ${e.message}`);
    throw e;
  }
}

/** Write atomically, keeping the previous version as <file>.bak. */
export async function writeData(file, data) {
  const text = JSON.stringify({ version: 1, ...data }, null, 2) + "\n";
  try { await fs.copyFile(file, file + ".bak"); } catch (e) { if (e.code !== "ENOENT") throw e; }
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, text);
  await fs.rename(tmp, file);
}

/** `hosts`: extra Host values to accept ("name:port"), e.g. a tailscale serve name. Those clients get full API access. */
export function createServer({ file, port, hosts = [] }) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, ...hosts]);

  const send = (res, code, body, type = "application/json; charset=utf-8", extra = {}) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    res.writeHead(code, { "Content-Type": type, "Content-Length": buf.length, "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff", "X-Finhealth-Mode": "file", ...extra });
    res.end(buf);
  };

  const readBody = req => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error("body too large"), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

  const analysisOf = data => {
    const A = analyze(data ?? normalize({}));
    return { ...A, export_md: exportMarkdown(A) };
  };

  return http.createServer(async (req, res) => {
    // Blocks DNS rebinding: a page on another domain that resolves to 127.0.0.1 still sends its own Host header.
    if (!allowedHosts.has(req.headers.host ?? "")) return send(res, 403, { error: "bad host" });
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (req.method === "GET") {
        switch (url.pathname) {
          case "/api/data": {
            const data = await readData(file);
            return send(res, 200, { file, exists: data !== null, data });
          }
          case "/api/analysis": return send(res, 200, analysisOf(await readData(file)));
          case "/api/export": return send(res, 200, exportJSON(analyze((await readData(file)) ?? normalize({}))));
          case "/api/export.md": return send(res, 200, exportMarkdown(analyze((await readData(file)) ?? normalize({}))), TYPES[".md"]);
          case "/api": return send(res, 200, { routes: ["GET /api/data", "POST /api/data", "POST /api/analyze", "GET /api/analysis", "GET /api/export", "GET /api/export.md"] });
        }
        return serveStatic(url.pathname, res, send);
      }
      if (req.method === "POST") {
        // JSON content type forces a CORS preflight for cross-origin pages, which this server never approves;
        // the Origin check covers browsers that send Origin on simple requests.
        const origin = req.headers.origin;
        if (!(req.headers["content-type"] ?? "").includes("application/json") || (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ""))))
          return send(res, 403, { error: "rejected: local JSON requests only" });
        let body;
        try { body = JSON.parse((await readBody(req)) || "{}"); } catch (e) { return send(res, e.status ?? 400, { error: e.status ? e.message : "invalid JSON" }); }
        const data = normalize(body);
        if (url.pathname === "/api/analyze") return send(res, 200, analysisOf(data));
        if (url.pathname === "/api/data") {
          await writeData(file, data);
          return send(res, 200, { saved: file, ...analysisOf(data) });
        }
        return send(res, 404, { error: "not found" });
      }
      send(res, 405, { error: "method not allowed" });
    } catch (e) {
      send(res, 400, { error: e.message });
    }
  });
}

async function serveStatic(pathname, res, send) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return send(res, 400, { error: "bad path" }); }
  if (rel.endsWith("/")) rel += "index.html";
  const full = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, { error: "forbidden" });
  try {
    let body = await fs.readFile(full);
    if (full === path.join(PUBLIC_DIR, "index.html"))
      body = Buffer.from(body.toString("utf8").replace('<meta name="finhealth-mode" content="browser">', '<meta name="finhealth-mode" content="file">'));
    send(res, 200, body, TYPES[path.extname(full)] ?? "application/octet-stream");
  } catch {
    send(res, 404, { error: "not found" });
  }
}
