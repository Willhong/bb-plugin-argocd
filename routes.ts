// Panel routing, kept out of app.tsx so it is testable without a DOM.
//
// The nav panel owns /plugins/argocd-external/argocd/*: "" lists applications and
// "app/<name>" opens one. An Argo CD application name may itself be
// namespace-qualified (`ns/name`), so the remainder after "app/" is taken
// whole instead of being split on the next slash.

export type Route = { view: "list" } | { view: "app"; name: string };

export function parseSubPath(subPath: string): Route {
  const parts = subPath.split("/").filter((part) => part.length > 0);
  if (parts[0] === "app" && parts.length > 1) {
    return { view: "app", name: parts.slice(1).join("/") };
  }
  return { view: "list" };
}

export function routeToSubPath(route: Route): string {
  return route.view === "app" ? `app/${route.name}` : "";
}
