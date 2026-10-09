// Light / dark / auto theme, stored per browser. A classic script in <head> (the CSP allows same-origin scripts), so the
// saved choice applies before first paint; app.js uses window.finhealthTheme for the header toggle.
(() => {
  const KEY = "finhealth-theme", root = document.documentElement;
  const apply = t => { if (t === "light" || t === "dark") root.dataset.theme = t; else delete root.dataset.theme; };
  let current = "auto";
  try { current = localStorage.getItem(KEY) || "auto"; } catch { /* storage blocked: follow the system */ }
  apply(current);
  window.finhealthTheme = {
    get: () => current,
    set: t => {
      current = t; apply(t);
      try { if (t === "auto") localStorage.removeItem(KEY); else localStorage.setItem(KEY, t); } catch { /* not saved */ }
    },
  };
})();
