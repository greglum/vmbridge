import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { Fleet } from "../src/fleet.ts";
import { Secrets, Settings } from "../src/settings.ts";
import { Store } from "../src/store.ts";
import type { Traffic } from "../src/traffic.ts";

function setup() {
  const db = openDatabase(":memory:");
  const settings = new Settings(db);
  settings.set("providers", ["boxd", "railway"]);
  settings.set("defaultProvider", "boxd");
  settings.set("vmSize", "medium");
  const fleet = new Fleet(new Store(db), settings, new Secrets(db), { record: () => {} } as unknown as Traffic, {} as never, {} as never);
  return { settings, fleet };
}

describe("where a new VM goes", () => {
  test("a repository rule picks the provider and size, matching any spelling of the repository", () => {
    const { settings, fleet } = setup();
    settings.set("repoRules", [{ repo: "Acme/API", provider: "railway", size: "large" }]);
    expect(fleet.placement("https://github.com/acme/api.git")).toEqual({ provider: "railway", size: "large" });
    expect(fleet.placement("https://github.com/acme/web.git")).toEqual({ provider: "boxd", size: "medium" });
  });

  test("an unset rule field, or a provider removed since, falls back to the defaults", () => {
    const { settings, fleet } = setup();
    settings.set("repoRules", [{ repo: "acme/api", provider: "railway", size: null }]);
    settings.set("providers", ["boxd"]);
    expect(fleet.placement("https://github.com/acme/api.git")).toEqual({ provider: "boxd", size: "medium" });
  });

  test("a VM can only be created on an added provider", async () => {
    const { fleet } = setup();
    await expect(fleet.create({ provider: "daytona" })).rejects.toThrow("Add Daytona in Setup first.");
  });
});
