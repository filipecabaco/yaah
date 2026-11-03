// Display helpers for tracker items (GitHub and GitLab issues, Linear issues
// and projects). Rust fetches, resolves and starts; these only label and route.
import type { ProjectLink, WorkItem, WorkService } from "@/lib/api";

export const SERVICES: Record<WorkService, { label: string; /** Its connection in Settings → Integrations. */ integration: string }> = {
  github: { label: "GitHub", integration: "github" },
  linear: { label: "Linear", integration: "linear" },
  "linear-project": { label: "Linear project", integration: "linear" },
  gitlab: { label: "GitLab", integration: "gitlab" },
};

/** The services work items come from, as Settings → Integrations lists them. */
export const TRACKER_INTEGRATIONS = ["github", "linear", "gitlab"];

export type RelationFilter = "all" | "assigned" | "created";

/** Assigned includes projects you lead; created is what you opened. Projects you're only a member of show under all. */
export function hasRelation(item: WorkItem, filter: RelationFilter): boolean {
  if (filter === "all") return true;
  if (filter === "assigned") return item.relation === "assigned" || item.relation === "lead";
  return item.relation === "created";
}

/**
 * Text that is worth asking Rust to resolve: a URL, `owner/repo#12`, or a
 * Linear key such as `ENG-142`. Rust decides what it is and says what it expected.
 */
export function looksLikeRef(text: string): boolean {
  const t = text.trim();
  return /^https?:\/\/\S+$/i.test(t) || /^[\w.-]+(\/[\w.-]+)+#\d+$/.test(t) || /^[a-z][a-z0-9]*-\d+$/i.test(t);
}

/** What the fuzzy search reads: "service id title". */
export const searchText = (item: WorkItem) => `${SERVICES[item.service].label} ${item.id} ${item.title}`;

/** The same item (one service, one id). */
export const sameItem = (a: { service: WorkService; id: string }, b: { service: WorkService; id: string }) =>
  a.service === b.service && a.id === b.id;

/** The yaah pack component that shows a linked item live, and its props. */
export function liveComponentFor(link: Pick<ProjectLink, "service" | "id">): { name: string; props: Record<string, unknown> } | null {
  if (link.service === "linear") return { name: "linear-issue", props: { id: link.id } };
  if (link.service === "linear-project") return { name: "linear-project", props: { id: link.id } };
  // `owner/repo#12` and `group/sub/project#7`.
  const at = link.id.lastIndexOf("#");
  const n = Number(link.id.slice(at + 1));
  if (at <= 0 || !Number.isInteger(n)) return null;
  const path = link.id.slice(0, at);
  return link.service === "github"
    ? { name: "github-issue", props: { repo: path, number: n } }
    : { name: "gitlab-issue", props: { project: path, iid: n } };
}
