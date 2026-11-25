/** Pages that were merged into others, mapped to where their content lives now. */
const moved: Record<string, { view: string; tab?: string }> = {
  costs: { view: "usage", tab: "costs" },
  analytics: { view: "usage", tab: "activity" },
  // Its tabs kept their ids, so an old tab still opens.
  setup: { view: "accounts" },
  devices: { view: "settings", tab: "devices" },
};

/** The query string an old dashboard link should use instead, or null when it needs no change. */
export function movedLink(search: string) {
  const query = new URLSearchParams(search);
  const target = moved[query.get("view") ?? ""];
  if (!target) return null;
  query.set("view", target.view);
  if (target.tab) query.set("tab", target.tab);
  return `?${query}`;
}
