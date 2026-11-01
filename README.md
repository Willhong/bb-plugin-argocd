# bb-plugin-argocd

Browse Argo CD applications, sync state, deployed resources, and pod logs in
BB, then send them to agents.

Install it directly from this repository:

```sh
bb plugin install git:https://github.com/Willhong/bb-plugin-argocd.git@main
```

For development, install the checkout in place instead:

```sh
bb plugin install ./bb-plugin-argocd
```

BB reserves the plugin ID `argocd` for its bundled plugin, so this external
package installs as `argocd-external`. Use that ID with plugin management
commands.

## What it does

- **Sidebar panel**: every tracked application as a filterable table (search,
  Argo CD project, sync status, health status), backed by a local cache that
  refreshes every 60s.
- **Application detail**: sync/health, destination, source, deployed revision,
  the last sync operation, conditions, managed resources, and deployment
  history — read live from Argo CD, so it reflects the cluster and not the
  cache. Deep-linkable at `/plugins/argocd-external/argocd/app/<name>` (a
  namespace-qualified `ns/name` works too).
- **Pod logs**: read a bounded tail of application pod logs from the detail
  view, optionally narrowed by pod, namespace, container, time window, or the
  previously terminated container. Logs are fetched on demand and are never
  cached.
- **Send agent**: spawns a BB thread primed with the application's current
  state — which resources are out of sync or unhealthy, and where the manifests
  live — pointed at the repo rather than the cluster. The application then
  shows a ⚡ pill linking to the thread.
- **Agent tools**: `argocd_list_applications`, `argocd_get_application`, and
  `argocd_get_pod_logs`. If Argo CD is briefly unreachable,
  `argocd_get_application` answers from the cache and labels the result as
  stale.
- **Mentions**: `@` in any composer completes Argo CD applications; the
  selected application's current state is attached as agent context at send
  time.
- **`bb argocd` CLI**: `status`, `apps`, `app <name>`, `resources <name>`,
  `logs <name>`, `history <name>`, `refresh` — also discoverable by agents
  through the plugin-commands skill.

## Read-only, deliberately

Nothing in this plugin mutates Argo CD. Pod logs are read on demand; there is no
follow/stream mode. There is no sync, refresh, rollback, or delete:
`bb argocd refresh` and the panel's Refresh button refresh **BB's cache**, not
the cluster. Writes belong behind a confirmation flow that this plugin does not
have yet.

## Access

Two transports reach the same data, chosen by the `accessMode` setting:

- `api` — the Argo CD REST API, using `serverUrl` plus an `authToken`. Generate
  one under Argo CD Settings → Accounts → Generate token; a read-only account is
  enough. Nothing needs to be installed on the BB server machine.
- `cli` — whatever session the `argocd` CLI on the **BB server machine** is
  logged into (`argocd login <server>`). Note this is the server's session, not
  the session on the machine you are typing on.
- `auto` (default) — the API when a server URL and token are both set, the CLI
  otherwise.

A default Argo CD install ships a self-signed certificate; turn on
**Allow insecure TLS** if that is expected in your environment.

Reading application metadata and reading pod logs are separate Argo CD RBAC
permissions. The configured API token or CLI account needs `applications, get`
and `logs, get` for the relevant project/application. For example:

```csv
p, role:bb-readonly, applications, get, my-project/*, allow
p, role:bb-readonly, logs, get, my-project/*, allow
```

The plugin limits each request to at most 1,000 lines and returns at most the
newest 512KB. The CLI form is:

```sh
bb argocd logs guestbook --tail 200 --since-seconds 900
bb argocd logs guestbook --pod guestbook-abc --container web --previous
```

## Settings

| Setting            | What it does                                                              |
| ------------------ | ------------------------------------------------------------------------- |
| `serverUrl`        | e.g. `https://argocd.example.com`. Blank falls back to the `argocd` CLI.  |
| `authToken`        | Argo CD API token (stored as a secret).                                   |
| `accessMode`       | `auto`, `api`, or `cli`.                                                  |
| `allowInsecureTls` | Skip certificate verification.                                            |
| `projects`         | Comma-separated Argo CD projects to track. Blank tracks all visible ones. |
| `defaultProject`   | The BB project agent threads spawn into.                                  |

```
bb plugin config argocd-external set serverUrl "https://argocd.example.com"
bb plugin config argocd-external set projects "prod, staging"
bb plugin reload argocd-external
```

## Development

```sh
npm install
npm run typecheck
npm test
bb plugin build .
bb plugin install .
bb plugin dev .
```

The plugin uses published `@get-bb/plugin-sdk` for typechecking and tests.
Runtime loading uses the SDK provided by BB.
