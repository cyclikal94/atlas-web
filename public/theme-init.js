/*
 * Pre-paint theme, loaded as an external classic script (the content security policy forbids inline script).
 * It mirrors src/design/theme.ts: keep them in step; tests/design/theme-init.test.ts proves parity.
 * It only reads the device-local appearance choice. It never touches account data.
 */
(() => {
  var stored = null;
  var preference;
  var root;
  var prefersLight = false;
  var resolved;
  var metas;
  var meta;
  var i;
  try {
    try {
      stored = window.localStorage.getItem("atlas.appearance.v1");
    } catch {
      stored = null;
    }
    preference = stored === "light" || stored === "dark" ? stored : "auto";
    root = document.documentElement;
    if (preference === "auto") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", preference);
    try {
      prefersLight = window.matchMedia("(prefers-color-scheme: light)").matches;
    } catch {
      prefersLight = false;
    }
    resolved =
      preference === "auto" ? (prefersLight ? "light" : "dark") : preference;
    metas = document.querySelectorAll('meta[name="theme-color"]');
    meta = metas[0];
    for (i = 1; i < metas.length; i += 1)
      metas[i].parentNode.removeChild(metas[i]);
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "theme-color");
      document.head.appendChild(meta);
    }
    meta.removeAttribute("media");
    meta.setAttribute("content", resolved === "light" ? "#F7F7FA" : "#0C0C10");
  } catch {
    /* The stylesheet's dark default (or the device setting for Auto) still applies. */
  }
})();
