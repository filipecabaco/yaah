import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

import { followTheme, setAppearance, setThemes, settingsUnavailable } from "./lib/theme";
import { api } from "./lib/api";
import { setCardRules } from "./lib/tool-cards";

// The OS light/dark setting, unless Settings → General picked one.
followTheme();

const root = () => ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

async function start() {
  // In a plain browser during development, answer Rust commands with fixtures.
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    (await import("./dev/browser-mock")).installBrowserMock();
    // #playground renders agent UI trees by hand (src/dev/playground.tsx).
    if (location.hash === "#playground") {
      const { Playground } = await import("./dev/playground");
      root().render(<Playground />);
      return;
    }
  }
  // Saved appearance, themes and tool-card rules. Until they arrive the app shows the theme of the
  // last run (public/theme-boot.js), or follows the OS in yaah's colours on a first start.
  api.generalSettings().then(
    (s) => {
      setThemes(s.theme);
      setAppearance(s.appearance);
      setCardRules(s.toolCards.rules);
    },
    (e: unknown) => {
      console.error("could not read settings", e);
      settingsUnavailable();
    },
  );
  root().render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

start().catch((e: unknown) => console.error("yaah failed to start", e));
