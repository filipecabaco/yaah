# Fonts and sizes (Settings → General → Appearance → Fonts)

Browser mock (`pnpm dev --port 1443`), checked with vitro at 1440 × 900. The mock's font list is a sample
(`SAMPLE_FONTS` in `app/src/dev/mock/settings.ts`); families the browser doesn't have (Fira Code,
JetBrains Mono here) preview in the fallback, as they would in the app.

| File                                             | What                                                                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `01-settings-fonts-default.png`                  | The Fonts section on the defaults: System default for both, 14 px interface, code 12 px following the interface, Reset disabled |
| `02-code-font-picker.png`                        | The Code picker: searchable, monospace families first, each item in its own font                                                |
| `03-settings-georgia-menlo-20px.png`             | Georgia / Menlo at the largest interface size (20 px): the whole dialog scales, code follows at 17 px                           |
| `04-chat-map-georgia-20px-light.png`             | A chat at 20 px Georgia: transcript, agent UI, Leaflet labels and attribution in the interface font                             |
| `05-chat-terminal-georgia-menlo-20px-light.png`  | Chat beside a terminal pane: the Markdown code block and xterm.js both in Menlo, 17.1 px                                        |
| `06-chat-terminal-georgia-menlo-20px-dark.png`   | The same, dark                                                                                                                  |
| `07-settings-avenir-courier-12px-dark.png`       | Avenir Next / Courier New at the smallest interface size (12 px), dark                                                          |
| `08-chat-terminal-avenir-courier-12px-dark.png`  | Chat and terminal at 12 px, dark: the terminal re-applied Courier New at 10.3 px and re-fitted                                  |
| `09-chat-terminal-avenir-courier-12px-light.png` | The same, light                                                                                                                 |
| `10-diff-courier-12px.png`                       | The diff dialog at 12 px: windowed rows measure 17.14 px each and the box is 61 × 17.14 px, so rows and the windowing agree     |

Not following the setting: Leaflet's zoom buttons (`+`/`−`, set in px by leaflet.css as glyphs), xterm's
hidden accessibility tree and scrollbar arrows, and Mermaid diagrams already drawn (they're measured at
render time and pick the new font up the next time they render). The sidebar width (288 px, saved) and
pane minimums (280 × 160 px) stay in px; at 20 px the sidebar truncates the account email, nothing overlaps.
The macOS traffic-light gutter couldn't be checked in the browser mock.
