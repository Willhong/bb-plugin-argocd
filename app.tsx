// bb-plugin-argocd — the frontend bundle.
//
// A read-only Argo CD browser: a filterable application table backed by the
// server's SQLite cache, and a per-application detail view that reads Argo CD
// live (managed resources, deploy history, conditions). "Send agent" spawns a
// BB thread primed with the application's current state; the resulting threads
// show up as pills on the application.
//
// Nothing here can sync, refresh, roll back, or delete an application — the
// Refresh button refreshes BB's cache, not the cluster. Keep it that way until
// there is a confirmation flow behind the write.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRpc,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import type {
  ArgoApplication,
  ArgoResource,
  ArgocdApplicationDetail,
  ArgocdApplicationList,
  ArgocdPodLogs,
  ArgocdStatus,
  argocdRpcContract,
} from "./server.js";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/empty-state";
import { PageBody } from "@/components/page-body";
import { parseSubPath, routeToSubPath, type Route } from "./routes.js";

const PANEL_PATH = "argocd";
const SEARCH_DEBOUNCE_MS = 200;

// A Select cannot hold "" as a value, so "any" stands in for "no filter" and is
// translated back at the contract boundary.
const ANY = "any";

interface Filter {
  search: string;
  project: string;
  syncStatus: string;
  healthStatus: string;
}

const NO_FILTER: Filter = {
  search: "",
  project: "",
  syncStatus: "",
  healthStatus: "",
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, (Date.now() - then) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function shortRevision(revision: string): string {
  // Git SHAs are abbreviated; a Helm chart version or a tag is left intact.
  return /^[0-9a-f]{40}$/i.test(revision) ? revision.slice(0, 7) : revision;
}

// ---------------------------------------------------------------------------
// Status chips. Argo CD's vocabulary is open-ended (custom health checks can
// report anything), so unknown values fall through to a neutral chip rather
// than being forced into a good/bad bucket.
// ---------------------------------------------------------------------------

type Tone = "good" | "bad" | "busy" | "neutral";

const TONE_CLASS: Record<Tone, string> = {
  good: "bg-success/10 text-success",
  bad: "bg-destructive/10 text-destructive",
  busy: "bg-warning/10 text-warning-text",
  neutral: "bg-muted text-muted-foreground",
};

function syncTone(status: string): Tone {
  if (status === "Synced") return "good";
  if (status === "OutOfSync") return "bad";
  return "neutral";
}

function healthTone(status: string): Tone {
  if (status === "Healthy") return "good";
  if (status === "Degraded" || status === "Missing") return "bad";
  if (status === "Progressing") return "busy";
  return "neutral";
}

function StatusChip({
  tone,
  label,
  title,
}: {
  tone: Tone;
  label: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium",
        TONE_CLASS[tone],
      )}
    >
      {label}
    </span>
  );
}

function useRoute(subPath: string): [Route, (route: Route) => void] {
  const bbNavigate = useBbNavigate();
  const route = useMemo(() => parseSubPath(subPath), [subPath]);
  const navigate = useCallback(
    (next: Route) => {
      bbNavigate.toPluginPanel(PANEL_PATH, { subPath: routeToSubPath(next) });
    },
    [bbNavigate],
  );
  return [route, navigate];
}

// ---------------------------------------------------------------------------
// Data hooks.
// ---------------------------------------------------------------------------

function useStatus(): ArgocdStatus | null {
  const rpc = useRpc<typeof argocdRpcContract>();
  const [status, setStatus] = useState<ArgocdStatus | null>(null);
  const refetch = useCallback(() => {
    rpc.call("status", null).then(setStatus, () => {});
  }, [rpc]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime("data-changed", refetch);
  return status;
}

function useApplications(filter: Filter): {
  list: ArgocdApplicationList | null;
  error: string | null;
} {
  const rpc = useRpc<typeof argocdRpcContract>();
  const [state, setState] = useState<{
    list: ArgocdApplicationList | null;
    error: string | null;
  }>({ list: null, error: null });
  const { search, project, syncStatus, healthStatus } = filter;
  const refetch = useCallback(() => {
    rpc
      .call("listApplications", { search, project, syncStatus, healthStatus })
      .then(
        (list) => setState({ list, error: null }),
        (error: unknown) => setState({ list: null, error: errorText(error) }),
      );
  }, [rpc, search, project, syncStatus, healthStatus]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime("data-changed", refetch);
  return state;
}

function useApplicationDetail(name: string): {
  detail: ArgocdApplicationDetail | null;
  error: string | null;
} {
  const rpc = useRpc<typeof argocdRpcContract>();
  const [state, setState] = useState<{
    detail: ArgocdApplicationDetail | null;
    error: string | null;
  }>({ detail: null, error: null });
  const refetch = useCallback(() => {
    rpc.call("getApplication", { name }).then(
      (detail) => setState({ detail, error: null }),
      (error: unknown) => setState({ detail: null, error: errorText(error) }),
    );
  }, [rpc, name]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime("data-changed", refetch);
  useRealtime("links-changed", refetch);
  return state;
}

function useSpawn(): { spawn: (name: string) => void; spawning: boolean } {
  const rpc = useRpc<typeof argocdRpcContract>();
  const navigate = useBbNavigate();
  const [spawning, setSpawning] = useState(false);
  const spawn = useCallback(
    (name: string) => {
      setSpawning(true);
      rpc
        .call("spawnThread", { name })
        .then(({ threadId }) => navigate.toThread(threadId))
        .catch((error: unknown) => toast.error(errorText(error)))
        .finally(() => setSpawning(false));
    },
    [rpc, navigate],
  );
  return { spawn, spawning };
}

// ---------------------------------------------------------------------------
// Header — transport state plus the cache refresh.
// ---------------------------------------------------------------------------

function PanelHeader() {
  const rpc = useRpc<typeof argocdRpcContract>();
  const status = useStatus();
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(() => {
    setRefreshing(true);
    rpc
      .call("refreshCache", null)
      .then(({ applications }) =>
        toast.success(`Cached ${applications} application(s) from Argo CD.`),
      )
      .catch((error: unknown) => toast.error(errorText(error)))
      .finally(() => setRefreshing(false));
  }, [rpc]);

  return (
    <>
      <span className="text-xs text-muted-foreground">
        {status === null
          ? "Loading…"
          : !status.ready
            ? "Not connected"
            : `${status.mode === "api" ? "REST API" : "argocd CLI"} · ${
                status.applicationCount
              } app${status.applicationCount === 1 ? "" : "s"} · refreshed ${
                status.lastSyncedAt !== null
                  ? relativeTime(status.lastSyncedAt)
                  : "never"
              }`}
      </span>
      {/* "Refresh cache", not "Refresh": BB's Button drops native `title`, and
          an unqualified label reads like Argo CD's own refresh action. */}
      <Button
        size="sm"
        variant="outline"
        disabled={refreshing}
        onClick={refresh}
      >
        {refreshing ? "Refreshing…" : "Refresh cache"}
      </Button>
    </>
  );
}

function ConnectionError({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
    >
      <p className="font-medium text-destructive">Argo CD is not reachable</p>
      <p className="mt-1 text-muted-foreground">{message}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// List view.
// ---------------------------------------------------------------------------

function FilterBar({
  filter,
  setFilter,
  list,
}: {
  filter: Filter;
  setFilter: (filter: Filter) => void;
  list: ArgocdApplicationList | null;
}) {
  // The search box is local so typing stays responsive; the committed value is
  // debounced into the filter, which is what round-trips to the server.
  const [search, setSearch] = useState(filter.search);
  useEffect(() => {
    if (search === filter.search) return;
    const timer = setTimeout(
      () => setFilter({ ...filter, search }),
      SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [search, filter, setFilter]);

  const selects: Array<{
    key: "project" | "syncStatus" | "healthStatus";
    label: string;
    options: string[];
  }> = [
    { key: "project", label: "All projects", options: list?.projects ?? [] },
    { key: "syncStatus", label: "Any sync", options: list?.syncStatuses ?? [] },
    {
      key: "healthStatus",
      label: "Any health",
      options: list?.healthStatuses ?? [],
    },
  ];

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        aria-label="Search applications"
        placeholder="Search name, namespace, repo, or path"
        className="h-9 max-w-xs flex-1"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {selects.map(({ key, label, options }) => (
        <Select
          key={key}
          value={filter[key].length > 0 ? filter[key] : ANY}
          onValueChange={(value) =>
            setFilter({ ...filter, [key]: value === ANY ? "" : value })
          }
        >
          <SelectTrigger className="h-9 w-40" aria-label={label}>
            <SelectValue placeholder={label} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>{label}</SelectItem>
            {options.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ))}
      {filter.search.length > 0 ||
      filter.project.length > 0 ||
      filter.syncStatus.length > 0 ||
      filter.healthStatus.length > 0 ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setSearch("");
            setFilter(NO_FILTER);
          }}
        >
          Clear
        </Button>
      ) : null}
    </div>
  );
}

function ApplicationsTable({
  applications,
  onOpen,
}: {
  applications: ArgoApplication[];
  onOpen: (name: string) => void;
}) {
  return (
    // A list, not a table: this also renders in the thread side panel, where a
    // fixed five-column table (480px of fixed widths alone) collapses the name
    // column and overlaps. @container drops the optional columns by the width
    // this list actually gets rather than by the viewport.
    <div className="@container overflow-hidden rounded-md border border-border">
      <ul className="divide-y divide-border text-sm">
        {applications.map((app) => (
          <li key={app.name}>
            <div
              tabIndex={0}
              role="button"
              className="flex cursor-pointer items-center gap-2 px-3 py-2 hover:bg-muted/30 focus:bg-muted/30 focus:outline-none"
              onClick={() => onOpen(app.name)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onOpen(app.name);
                }
              }}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-foreground">
                  {app.name}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {app.project}
                  {app.path.length > 0 ? ` · ${app.path}` : ""}
                </span>
              </span>
              <span className="shrink-0">
                <StatusChip
                  tone={syncTone(app.syncStatus)}
                  label={app.syncStatus}
                />
              </span>
              <span className="shrink-0">
                <StatusChip
                  tone={healthTone(app.healthStatus)}
                  label={app.healthStatus}
                  title={
                    app.healthMessage.length > 0 ? app.healthMessage : undefined
                  }
                />
              </span>
              <span className="hidden shrink-0 max-w-40 truncate text-xs text-muted-foreground @md:inline">
                {app.destinationNamespace.length > 0
                  ? app.destinationNamespace
                  : "—"}
              </span>
              <span className="hidden shrink-0 font-mono text-xs text-muted-foreground @lg:inline">
                {app.revision.length > 0 ? shortRevision(app.revision) : "—"}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ListView({
  filter,
  setFilter,
  onOpen,
}: {
  filter: Filter;
  setFilter: (filter: Filter) => void;
  onOpen: (name: string) => void;
}) {
  const { list, error } = useApplications(filter);
  const hasFilter =
    filter.search.length > 0 ||
    filter.project.length > 0 ||
    filter.syncStatus.length > 0 ||
    filter.healthStatus.length > 0;

  return (
    <div className="space-y-3">
      <FilterBar filter={filter} setFilter={setFilter} list={list} />
      {error !== null ? <ConnectionError message={error} /> : null}
      {list !== null && list.error !== null ? (
        <ConnectionError message={list.error} />
      ) : null}
      {list === null && error === null ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((row) => (
            <Skeleton key={row} className="h-12 w-full" />
          ))}
        </div>
      ) : list === null ? null : list.applications.length === 0 ? (
        <EmptyState
          message={
            hasFilter
              ? "No applications matched these filters."
              : "No applications cached yet. Check the plugin settings, then hit Refresh."
          }
        />
      ) : (
        <ApplicationsTable applications={list.applications} onOpen={onOpen} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail view.
// ---------------------------------------------------------------------------

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="truncate text-sm text-foreground" title={value}>
        {value.length > 0 ? value : "—"}
      </div>
    </div>
  );
}

function ResourcesTable({ resources }: { resources: ArgoResource[] }) {
  return (
    <div className="@container overflow-hidden rounded-md border border-border">
      <ul className="divide-y divide-border text-sm">
        {resources.map((resource) => (
          <li
            key={`${resource.group}/${resource.kind}/${resource.namespace}/${resource.name}`}
            className="flex items-center gap-2 px-3 py-2"
          >
            <span className="min-w-0 flex-1 truncate text-foreground">
              <span className="text-muted-foreground">{resource.kind}/</span>
              {resource.name}
            </span>
            <span className="hidden shrink-0 max-w-32 truncate text-xs text-muted-foreground @md:inline">
              {resource.namespace.length > 0 ? resource.namespace : "—"}
            </span>
            <span className="shrink-0">
              <StatusChip
                tone={syncTone(resource.syncStatus)}
                label={resource.syncStatus}
              />
            </span>
            <span className="shrink-0">
              {resource.healthStatus.length > 0 ? (
                <StatusChip
                  tone={healthTone(resource.healthStatus)}
                  label={resource.healthStatus}
                  title={
                    resource.healthMessage.length > 0
                      ? resource.healthMessage
                      : undefined
                  }
                />
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const LOG_TAIL_OPTIONS = [100, 200, 500, 1_000] as const;
const LOG_SINCE_OPTIONS = [
  { value: 0, label: "Any time" },
  { value: 300, label: "Last 5 minutes" },
  { value: 900, label: "Last 15 minutes" },
  { value: 3_600, label: "Last hour" },
  { value: 21_600, label: "Last 6 hours" },
] as const;

function PodLogsView({ application }: { application: ArgoApplication }) {
  const rpc = useRpc<typeof argocdRpcContract>();
  const requestSequence = useRef(0);
  const [namespace, setNamespace] = useState("");
  const [podName, setPodName] = useState("");
  const [container, setContainer] = useState("");
  const [tailLines, setTailLines] = useState("200");
  const [sinceSeconds, setSinceSeconds] = useState("0");
  const [previous, setPrevious] = useState(false);
  const [loading, setLoading] = useState(false);
  const [state, setState] = useState<{
    logs: ArgocdPodLogs | null;
    error: string | null;
  }>({ logs: null, error: null });

  const load = useCallback(() => {
    const sequence = requestSequence.current + 1;
    requestSequence.current = sequence;
    setLoading(true);
    setState((current) => ({ ...current, error: null }));
    rpc
      .call("getPodLogs", {
        name: application.name,
        namespace: namespace.trim(),
        podName: podName.trim(),
        container: container.trim(),
        tailLines: Number(tailLines),
        sinceSeconds: Number(sinceSeconds),
        previous,
      })
      .then(
        (logs) => {
          if (requestSequence.current === sequence) {
            setState({ logs, error: null });
          }
        },
        (error: unknown) => {
          if (requestSequence.current === sequence) {
            setState({ logs: null, error: errorText(error) });
          }
        },
      )
      .finally(() => {
        if (requestSequence.current === sequence) setLoading(false);
      });
  }, [
    rpc,
    application.name,
    namespace,
    podName,
    container,
    tailLines,
    sinceSeconds,
    previous,
  ]);

  const renderedLogs = useMemo(() => {
    if (state.logs === null) return "";
    return state.logs.entries
      .map((entry) => {
        const timestamp =
          entry.timestamp.length > 0 ? `${entry.timestamp} ` : "";
        const pod = entry.podName.length > 0 ? `[${entry.podName}] ` : "";
        return `${timestamp}${pod}${entry.content}`;
      })
      .join("\n");
  }, [state.logs]);

  return (
    <div className="@container space-y-3">
      <div>
        <h3 className="text-sm font-medium text-foreground">Pod logs</h3>
        <p className="text-xs text-muted-foreground">
          Read-only. Leave pod and container blank to read matching logs across
          the application.
        </p>
      </div>
      <div className="grid gap-2 @md:grid-cols-2">
        <Input
          aria-label="Pod namespace"
          placeholder={
            application.destinationNamespace.length > 0
              ? `Namespace (all; destination is ${application.destinationNamespace})`
              : "Namespace (all)"
          }
          value={namespace}
          onChange={(event) => setNamespace(event.target.value)}
        />
        <Input
          aria-label="Pod name"
          placeholder="Pod name (all pods)"
          value={podName}
          onChange={(event) => setPodName(event.target.value)}
        />
        <Input
          aria-label="Container name"
          placeholder="Container (default)"
          value={container}
          onChange={(event) => setContainer(event.target.value)}
        />
        <div className="flex gap-2">
          <Select value={tailLines} onValueChange={setTailLines}>
            <SelectTrigger
              aria-label="Log line count"
              className="min-w-0 flex-1"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LOG_TAIL_OPTIONS.map((count) => (
                <SelectItem key={count} value={String(count)}>
                  Last {count} lines
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={sinceSeconds} onValueChange={setSinceSeconds}>
            <SelectTrigger
              aria-label="Log time range"
              className="min-w-0 flex-1"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LOG_SINCE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={String(option.value)}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={previous}
            onChange={(event) => setPrevious(event.target.checked)}
          />
          Previous container
        </label>
        <Button size="sm" disabled={loading} onClick={load}>
          {loading ? "Loading logs…" : "Load logs"}
        </Button>
        {state.logs !== null ? (
          <span className="text-xs text-muted-foreground">
            via {state.logs.transport === "api" ? "REST API" : "argocd CLI"}
          </span>
        ) : null}
      </div>
      {state.error !== null ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {state.error}
        </p>
      ) : null}
      {state.logs !== null && state.logs.entries.length === 0 ? (
        <EmptyState message="No pod log lines matched this request." />
      ) : null}
      {state.logs !== null && state.logs.entries.length > 0 ? (
        <div className="space-y-2">
          {state.logs.truncated ? (
            <p className="text-xs text-warning-text">
              BB limited this response to the newest 512KB.
            </p>
          ) : null}
          <pre className="max-h-96 overflow-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-xs leading-5 text-foreground">
            {renderedLogs}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

function DetailView({ name, onBack }: { name: string; onBack: () => void }) {
  const { detail, error } = useApplicationDetail(name);
  const { spawn, spawning } = useSpawn();
  const navigate = useBbNavigate();

  if (error !== null) {
    return (
      <div className="space-y-3">
        <Button size="sm" variant="ghost" onClick={onBack}>
          ← Applications
        </Button>
        <ConnectionError message={error} />
      </div>
    );
  }
  if (detail === null) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  const { application: app } = detail;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onBack}>
          ← Applications
        </Button>
        <div className="flex-1" />
        <Button size="sm" disabled={spawning} onClick={() => spawn(app.name)}>
          {spawning ? "Starting…" : "Send agent"}
        </Button>
      </div>

      <div className="space-y-3 rounded-md border border-border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-medium text-foreground">{app.name}</h2>
          <StatusChip tone={syncTone(app.syncStatus)} label={app.syncStatus} />
          <StatusChip
            tone={healthTone(app.healthStatus)}
            label={app.healthStatus}
          />
          <Badge variant="outline">{app.project}</Badge>
        </div>
        {app.healthMessage.length > 0 ? (
          <p className="text-sm text-muted-foreground">{app.healthMessage}</p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field
            label="Destination"
            value={
              app.destinationNamespace.length > 0
                ? `${app.destinationNamespace} @ ${app.destinationServer}`
                : app.destinationServer
            }
          />
          <Field
            label="Source"
            value={
              app.path.length > 0 ? `${app.repoUrl} (${app.path})` : app.repoUrl
            }
          />
          <Field
            label="Target revision"
            value={app.targetRevision.length > 0 ? app.targetRevision : "HEAD"}
          />
          <Field
            label="Deployed revision"
            value={shortRevision(app.revision)}
          />
          <Field
            label="Last operation"
            value={
              app.operationPhase.length > 0
                ? `${app.operationPhase}${
                    app.operationFinishedAt.length > 0
                      ? ` · ${relativeTime(app.operationFinishedAt)}`
                      : ""
                  }`
                : ""
            }
          />
          <Field label="Created" value={app.createdAt} />
        </div>
        {app.operationMessage.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            {app.operationMessage}
          </p>
        ) : null}
      </div>

      {detail.links.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Agent threads</span>
          {detail.links.map((link) => (
            <Button
              key={link.threadId}
              size="sm"
              variant="outline"
              onClick={() => navigate.toThread(link.threadId)}
            >
              ⚡ {relativeTime(link.createdAt)}
            </Button>
          ))}
        </div>
      ) : null}

      {detail.conditions.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-foreground">Conditions</h3>
          <ul className="space-y-1">
            {detail.conditions.map((condition) => (
              <li
                key={`${condition.type}/${condition.lastTransitionTime}`}
                className="rounded-md border border-border px-3 py-2 text-sm"
              >
                <span className="font-medium text-foreground">
                  {condition.type}
                </span>
                <span className="text-muted-foreground">
                  {" "}
                  — {condition.message}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="space-y-2">
        <h3 className="text-sm font-medium text-foreground">
          Resources ({detail.resources.length})
        </h3>
        {detail.resources.length === 0 ? (
          <EmptyState message="This application manages no resources." />
        ) : (
          <ResourcesTable resources={detail.resources} />
        )}
      </div>

      <PodLogsView key={app.name} application={app} />

      {detail.history.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-foreground">
            Deployment history
          </h3>
          <ul className="divide-y divide-border overflow-hidden rounded-md border border-border text-sm">
            {detail.history.map((entry) => (
              <li key={entry.id} className="flex items-center gap-3 px-3 py-2">
                <span className="shrink-0 text-muted-foreground">
                  {entry.id}
                </span>
                <span
                  className="min-w-0 flex-1 truncate font-mono text-xs text-foreground"
                  title={entry.revision}
                >
                  {shortRevision(entry.revision)}
                </span>
                <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                  {entry.deployedAt.length > 0
                    ? relativeTime(entry.deployedAt)
                    : "—"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ArgocdPanel({ subPath }: PluginNavPanelProps) {
  const [route, navigate] = useRoute(subPath);
  const status = useStatus();
  const [filter, setFilter] = useState<Filter>(NO_FILTER);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-5">
      <PageBody>
        {status !== null && !status.ready && status.error !== null ? (
          <ConnectionError message={status.error} />
        ) : null}
        {route.view === "app" ? (
          <DetailView
            name={route.name}
            onBack={() => navigate({ view: "list" })}
          />
        ) : (
          <ListView
            filter={filter}
            setFilter={setFilter}
            onOpen={(name) => navigate({ view: "app", name })}
          />
        )}
      </PageBody>
    </div>
  );
}

/**
 * The same browser, in a thread's right-hand panel.
 *
 * Deliberately independent of whichever BB project the thread belongs to: the
 * plugin is configured once per BB server, so this shows every application the
 * Argo CD account can see. Do not filter it by the thread's project — seeing
 * the whole cluster from any thread is the point.
 *
 * A panel tab has no route of its own (there is no `subPath` here), so the
 * list/detail navigation lives in component state instead of the URL.
 */
function ArgocdSidePanel(_props: { threadId: string }) {
  const status = useStatus();
  const [filter, setFilter] = useState<Filter>(NO_FILTER);
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <PanelHeader />
      </div>
      {status !== null && !status.ready && status.error !== null ? (
        <ConnectionError message={status.error} />
      ) : null}
      {selected !== null ? (
        <DetailView name={selected} onBack={() => setSelected(null)} />
      ) : (
        <ListView filter={filter} setFilter={setFilter} onOpen={setSelected} />
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "argocd",
    title: "Argo CD",
    icon: "Container",
    path: PANEL_PATH,
    component: ArgocdPanel,
    headerContent: PanelHeader,
  });
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "action",
    id: "applications",
    title: "Argo CD",
    icon: "Container",
    component: ArgocdSidePanel,
  });
});
