import { expect, test } from "bun:test";
import { movedLink } from "./moved-links.ts";

test("links to merged pages open the same place on the new page", () => {
  expect(movedLink("?view=costs")).toBe("?view=usage&tab=costs");
  expect(movedLink("?view=analytics")).toBe("?view=usage&tab=activity");
  expect(movedLink("?view=setup&tab=github")).toBe("?view=accounts&tab=github");
  expect(movedLink("?view=setup")).toBe("?view=accounts");
  expect(movedLink("?view=devices")).toBe("?view=settings&tab=devices");
});

test("current links are left alone", () => {
  expect(movedLink("")).toBeNull();
  expect(movedLink("?view=settings&tab=env")).toBeNull();
  expect(movedLink("?view=usage&tab=activity")).toBeNull();
});
