import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "../server.js";

let server, base, file, dir, port;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "finhealth-"));
  file = path.join(dir, "data.json");
  await fs.copyFile(new URL("../public/example.json", import.meta.url), file);
  server = createServer({ file, port: 0 });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
  // createServer checks Host against its port; rebuild with the real port
  server.close();
  server = createServer({ file, port });
  await new Promise(r => server.listen(port, "127.0.0.1", r));
  base = `http://127.0.0.1:${port}`;
});
after(async () => { server.close(); await fs.rm(dir, { recursive: true, force: true }); });

const post = (p, body, headers = {}) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

test("GET /api/data returns the file and marks file mode", async () => {
  const r = await fetch(base + "/api/data");
  assert.equal(r.headers.get("x-finhealth-mode"), "file");
  const j = await r.json();
  assert.equal(j.exists, true);
  assert.equal(j.data.income.take_home_monthly, 6200);
});

test("GET /api/export.md has no amounts header and the health table", async () => {
  const t = await (await fetch(base + "/api/export.md")).text();
  assert.match(t, /\| Check \| Status \|/);
  assert.doesNotMatch(t, /6,?200/);
});

test("POST /api/analyze does not write", async () => {
  const before = await fs.readFile(file, "utf8");
  const j = await (await post("/api/analyze", { income: { take_home_monthly: 1 } })).json();
  assert.equal(j.amounts.take_home_monthly, 1);
  assert.equal(await fs.readFile(file, "utf8"), before);
});

test("POST /api/data validates, saves, keeps .bak", async () => {
  const bad = await post("/api/data", { accounts: [{ name: "x", type: "nope" }] });
  assert.equal(bad.status, 400);
  const ok = await post("/api/data", { income: { take_home_monthly: 5000 } });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).income.take_home_monthly, 5000);
  assert.equal(JSON.parse(await fs.readFile(file + ".bak", "utf8")).income.take_home_monthly, 6200);
});

test("index.html is marked as file mode when served by Node", async () => {
  const t = await (await fetch(base + "/")).text();
  assert.match(t, /<meta name="finhealth-mode" content="file">/);
});

test("rejects foreign Host, foreign Origin, non-JSON POST, path traversal", async () => {
  const http = await import("node:http");
  const raw = (opts, body) => new Promise(res => {
    const req = http.request({ host: "127.0.0.1", port, ...opts }, r => res(r.statusCode));
    req.end(body);
  });
  assert.equal(await raw({ path: "/api/data", headers: { Host: "evil.example" } }), 403);
  assert.equal((await post("/api/data", {}, { Origin: "http://evil.example" })).status, 403);
  assert.equal((await fetch(base + "/api/data", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" })).status, 403);
  // traversal attempts never reach files outside public/ (403 from the prefix check, or 404 after URL normalization)
  for (const p of ["/../server.js", "/%2e%2e/server.js", "/..%2fserver.js", "/vendor/../../server.js"])
    assert.ok([403, 404].includes(await raw({ path: p })), p);
});
