// Runs before the app's code (a plain script in <head>): puts up the theme the app
// last showed, saved by src/lib/theme.ts, so a start never flashes the wrong colours.
// A file of its own rather than an inline script, so the CSP's `script-src 'self'`
// covers it with no hash to keep in step.
(function () {
  try {
    var saved = JSON.parse(localStorage.getItem("yaah:theme") || "null");
    if (!saved || typeof saved !== "object") return;
    var root = document.documentElement;
    var name = /^--[a-z0-9-]+$/;
    // Only plain colours, as theme.ts writes them.
    var colour = /^rgb\(\d{1,3} \d{1,3} \d{1,3}\)$/;
    var tokens = saved.tokens || {};
    for (var k in tokens)
      if (Object.prototype.hasOwnProperty.call(tokens, k) && name.test(k) && colour.test(tokens[k])) root.style.setProperty(k, tokens[k]);
    var dark = saved.dark === true;
    root.classList.toggle("dark", dark);
    root.style.colorScheme = dark ? "dark" : "light";
    root.dataset.theme = dark ? "dark" : "light";
  } catch (e) {
    // No storage, or a value from something else: the OS setting decides, as on a first start.
  }
})();
