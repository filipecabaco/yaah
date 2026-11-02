// Renders the real App against the browser mock (src/dev/browser-mock.ts), the
// same Tauri IPC fake `pnpm dev` uses, with its artificial waits turned off.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect } from "vitest";
import App from "@/App";
import { installBrowserMock, type BrowserMockOptions } from "@/dev/browser-mock";
import { setCardRules } from "@/lib/tool-cards";

export function renderApp(options: BrowserMockOptions = {}) {
  installBrowserMock({ delay: 0, ...options });
  setCardRules({});
  const user = userEvent.setup();
  const view = render(<App />);
  return { user, ...view };
}

/** Start a quick chat from the empty screen and send `text`. */
export async function sendInQuickChat(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.click(await screen.findByRole("button", { name: /^quick chat\b(?!s)/i }));
  const composer = await screen.findByRole("combobox", { name: "Message" });
  await user.type(composer, `${text}{Enter}`);
  // The user's own message is the first thing in the transcript.
  const log = screen.getByRole("log", { name: "Conversation" });
  await within(log).findByText(text);
  return log;
}

/** Answer every pending permission with `option` until `done` holds. */
export async function answerPermissionsUntil(
  user: ReturnType<typeof userEvent.setup>,
  log: HTMLElement,
  option: string,
  done: () => boolean,
  timeout = 15_000,
) {
  await waitFor(
    async () => {
      for (const group of within(log).queryAllByRole("group", { name: "Permission requested" })) {
        const button = within(group).queryByRole("button", { name: option });
        if (button && !button.hasAttribute("disabled")) await user.click(button);
      }
      expect(done()).toBe(true);
    },
    { timeout, interval: 50 },
  );
}
