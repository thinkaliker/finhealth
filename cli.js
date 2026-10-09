#!/usr/bin/env node
// finhealth CLI. Same calculation module as the web page.
//
//   node cli.js serve  data.json [--port 8765] [--open]   web page + API on 127.0.0.1
//                      [--allow-host name:port ...]        also accept this Host (reverse proxy); no auth
//   node cli.js export data.json [--json]                  amount-free summary for an LLM
//   node cli.js report data.json                           full local report, with amounts
//   node cli.js init   data.json                           copy the example data file
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { analyze, exportJSON, exportMarkdown, reportText, normalize } from "./public/finhealth.js";
import { createServer, readData } from "./server.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const USAGE = `usage: node cli.js <serve|export|report|init> <data.json> [--port N] [--open] [--json] [--allow-host name:port]`;

function parseArgs(argv) {
  const [cmd, file, ...rest] = argv;
  const opts = { port: 8765, open: false, json: false, hosts: [] };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--port") opts.port = Number(rest[++i]);
    else if (rest[i] === "--allow-host") {
      const h = rest[++i];
      if (!/^[a-z0-9.-]+:\d+$/i.test(h ?? "")) throw new Error("--allow-host takes name:port, e.g. vm.tailnet.ts.net:8100");
      opts.hosts.push(h.toLowerCase());
    }
    else if (rest[i] === "--open") opts.open = true;
    else if (rest[i] === "--json") opts.json = true;
    else throw new Error(`unknown option ${rest[i]}\n${USAGE}`);
  }
  if (!cmd || !file) throw new Error(USAGE);
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) throw new Error("--port must be 1-65535");
  return { cmd, file: path.resolve(file), opts };
}

function openBrowser(url) {
  const [bin, args] = process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  spawn(bin, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

async function main() {
  const { cmd, file, opts } = parseArgs(process.argv.slice(2));
  if (cmd === "init") {
    try { await fs.access(file); throw new Error(`${file} already exists`); } catch (e) { if (e.code !== "ENOENT") throw e; }
    await fs.copyFile(path.join(HERE, "public", "example.json"), file);
    console.log(`wrote ${file}; edit it, then run: node cli.js serve ${path.relative(process.cwd(), file)} --open`);
    return;
  }
  if (cmd === "serve") {
    const server = createServer({ file, port: opts.port, hosts: opts.hosts });
    server.listen(opts.port, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${opts.port}/`;
      console.log(`finhealth: ${url}  (data file: ${file})`);
      if (opts.open) openBrowser(url);
    });
    return;
  }
  const data = await readData(file);
  if (data === null) throw new Error(`${file} not found; create it with: node cli.js init ${file}`);
  const A = analyze(normalize(data));
  if (cmd === "export") process.stdout.write(opts.json ? JSON.stringify(exportJSON(A), null, 2) + "\n" : exportMarkdown(A));
  else if (cmd === "report") process.stdout.write(reportText(A));
  else throw new Error(USAGE);
}

main().catch(e => { console.error(e.message); process.exit(1); });
