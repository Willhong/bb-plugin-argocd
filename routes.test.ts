import { describe, expect, it } from "vitest";
import { parseSubPath, routeToSubPath, type Route } from "./routes";

describe("panel sub-path routing", () => {
  it("round-trips a namespace-qualified application name", () => {
    // `argocd/guestbook` is one application name, not a two-segment path — the
    // slash inside it must survive both directions.
    const route: Route = { view: "app", name: "argocd/guestbook" };
    expect(routeToSubPath(route)).toBe("app/argocd/guestbook");
    expect(parseSubPath("app/argocd/guestbook")).toEqual(route);
  });

  it("round-trips a bare application name and the list root", () => {
    expect(parseSubPath("app/guestbook")).toEqual({
      view: "app",
      name: "guestbook",
    });
    expect(routeToSubPath({ view: "list" })).toBe("");
    expect(parseSubPath("")).toEqual({ view: "list" });
  });

  it("falls back to the list for anything it does not recognize", () => {
    // "app" with no name would otherwise render a detail view for "".
    expect(parseSubPath("app")).toEqual({ view: "list" });
    expect(parseSubPath("app/")).toEqual({ view: "list" });
    expect(parseSubPath("/settings/")).toEqual({ view: "list" });
  });
});
