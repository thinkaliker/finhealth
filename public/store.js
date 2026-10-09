// Storage backends with one interface: { mode, label, load(), save(data), clear?() }.
// "file": the page is served by `node cli.js serve`; data lives in a JSON file via the local API.
// "browser": static hosting (e.g. GitHub Pages); data lives in this browser's localStorage only.

const KEY = "finhealth:data:v1";

async function postJSON(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

function fileStore(initial) {
  return {
    mode: "file",
    label: initial.file,
    initial: initial.data,
    async load() {
      const r = await fetch("api/data", { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      return j.data;
    },
    async save(data) { await postJSON("api/data", data); },
  };
}

function browserStore() {
  return {
    mode: "browser",
    label: "this browser",
    initial: undefined,
    async load() {
      let raw;
      try { raw = localStorage.getItem(KEY); }
      catch { throw new Error("Browser storage is blocked (private window or site data disabled). Use Export to keep a copy."); }
      if (raw == null) return null;
      try { return JSON.parse(raw); } catch { throw new Error("Stored data is corrupted. Import a saved file to restore."); }
    },
    async save(data) {
      try { localStorage.setItem(KEY, JSON.stringify(data)); }
      catch (e) { throw new Error(e?.name === "QuotaExceededError" ? "Browser storage is full." : "Browser storage is blocked; use Export to keep a copy."); }
    },
    async clear() { try { localStorage.removeItem(KEY); } catch { /* nothing stored */ } },
  };
}

/**
 * The local server rewrites <meta name="finhealth-mode"> to "file" when it serves the page.
 * Static hosting serves the file untouched ("browser"), so no API request is made there.
 */
export async function detectStore() {
  if (document.querySelector('meta[name="finhealth-mode"]')?.content !== "file") return browserStore();
  try {
    const r = await fetch("api/data", { cache: "no-store", headers: { Accept: "application/json" } });
    if (r.ok && r.headers.get("X-Finhealth-Mode") === "file") {
      const j = await r.json();
      const s = fileStore(j);
      s.initial = j.data;
      return s;
    }
  } catch { /* no server: static hosting or offline */ }
  return browserStore();
}
