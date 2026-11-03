# Website screenshots and checks (2026-11-03)

Screenshots for the website in `site/`, and the visual checks of the site itself.

**App screenshots** (`raw/`): taken with vitro from the browser mock (`pnpm dev` in `app/`,
http://localhost:1420) at 1440×900 and device scale factor 2, in light and dark (the app follows the
system appearance). The mock replays recorded agent sessions (`app/src/dev/fixtures/`), so the agent
UI is what real agents rendered. Prompts were typed to match the mock's replay routes; they are short
versions of the recorded prompts. The site uses WebP crops of these in `site/public/shots/` (cropped
to the chat column or the dialog, 1000–1600 px wide).

| File (`raw/<name>-light.png`, `-dark.png`) | What it shows | Where on the site |
|---|---|---|
| `pack-system-monitor` | `system-monitor` from the yaah pack in a quick chat: CPU, memory, load, swap, chart, processes | Hero |
| `library-pr-view` | Component library page, `pr-view` selected: a GitHub PR with checks and the diff viewer | UI built from data |
| `ask-form` | `ui_ask` form: language, hours slider, project kinds, ranked priorities ("waiting for you") | Forms you fill in together |
| `pack-docker` | `docker-dashboard`: containers table, CPU and memory chart and table | Live sources |
| `settings-components` | Settings → Components: yaah library, my components, an installed git library, add a library | Component libraries |
| `settings-agents` | Settings → Agents (ACP): your agents, presets to add, the default Claude agent | Any ACP agent |
| `project-linked` | A project started from Linear issue ENG-142: live `linear-issue`, chats, repos | Projects and quick chats |
| `project-from-issue` | ⌘K → New project from an issue: the queue, filters, GitLab's revoked-token error | Start a project from an issue |
| `settings-integrations` | Settings → Integrations: GitHub connected, key fallback | Integrations |
| `permission` | A permission request for `node --test --test-reporter=spec` | Permissions and security |
| `palette` | ⌘K command palette | Keyboard first |
| `settings-agents-told` | Settings → Chat → Show what agents are told: routes per agent, guide and skills | How agents learn yaah's UI |
| `pack-test-report` | `test-report`: 1 failed, 2 passed, the failure first | Example: test results |
| `pack-db-query` | `db-query` on the `shop` connection: revenue by category, chart and table | Example: database |
| `pack-form` | The `bug` form, every field filled by the agent with `ui_set_values` | Example: bug report |
| `scenarios-map` | `marker-map`, a component the agent saved, on a world map | Example: saved component |
| `theme-rose-pine-dawn.png` (one file) | The same app in the Rosé Pine Dawn VS Code theme, with an agent's review panel | Any VS Code theme |
| `settings-keyboard-light.png` (light only) | Settings → Keyboard | Not used (the page lists the shortcuts as a table) |

**Site checks** (`verify/`): the built site (`pnpm build`, `pnpm preview`) captured full-page with
vitro, images forced to load. No horizontal overflow at any width; the theme switch swaps the class
and the screenshots and is saved; focus rings show on Tab; the mark's loader plays twice and settles.

| File | Width | Theme |
|---|---|---|
| `verify/site-1440-light-full.jpg` | 1440 | light |
| `verify/site-1440-dark-full.jpg` | 1440 | dark |
| `verify/site-1024-light-full.jpg` | 1024 | light |
| `verify/site-1024-dark-full.jpg` | 1024 | dark |
| `verify/site-375-light-full.jpg` | 375 (captured at 2×, saved at 1×) | light |
| `verify/site-375-dark-full.jpg` | 375 (captured at 2×, saved at 1×) | dark |

Notes:

- While capturing, other edits to `app/` made Vite reload the mock a few times, which reset its state;
  the affected shots were retaken.
- The mock's preset list in Settings → Agents is shorter than `agents.rs`; the site lists the presets
  from `agents.rs`.
