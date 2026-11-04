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
// The fonts and sizes of the last run (src/lib/fonts.ts), so text doesn't jump when the settings arrive.
(function () {
  try {
    var saved = JSON.parse(localStorage.getItem("yaah:fonts") || "null");
    if (!saved || typeof saved !== "object") return;
    // Only what Rust builds (settings.rs `fonts_for_ui`): a quoted family and a plain stack, or a number.
    var family = /^"[^"\\]+"(, ("[A-Za-z0-9 -]+"|[A-Za-z0-9-]+))+$/;
    var number = /^\d{1,2}(\.\d{1,4})?$/;
    var shape = { "--font-ui": family, "--font-code": family, "--font-ui-scale": number, "--font-code-scale": number };
    for (var k in shape) if (typeof saved[k] === "string" && shape[k].test(saved[k])) document.documentElement.style.setProperty(k, saved[k]);
  } catch (e) {
    // No storage: the default fonts until the settings arrive.
  }
})();
