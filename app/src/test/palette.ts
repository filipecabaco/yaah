import { fireEvent, screen } from "@testing-library/react";
import { isMac } from "@/lib/shortcuts";

/** Open the ⌘K palette (Ctrl+K on Linux) once the app has drawn its sidebar. */
export async function openPalette() {
  await screen.findByRole("button", { name: "Hide the sidebar" });
  fireEvent.keyDown(document.activeElement ?? window, { key: "k", code: "KeyK", metaKey: isMac, ctrlKey: !isMac, bubbles: true });
}
