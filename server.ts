// bb-plugin-argocd — the backend.
//
// A read-only Argo CD browser. Two transports reach the same data and are
// normalized into one shape: the REST API (server URL + API token) and the
// `argocd` CLI (whatever session the server machine is already logged into).
// `accessMode` picks between them; "auto" prefers the API when it is
// configured because it needs nothing installed on the host.
//
// Nothing here mutates Argo CD. There is deliberately no sync, refresh,
// rollback, or delete: `bb argocd refresh` refreshes BB's own cache, not the
// cluster. Writes belong behind a confirmation flow that this plugin does
// not have yet.
import { execFile } from "node:child_process";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const SYNC_INTERVAL_MS = 60_000;
const API_TIMEOUT_MS = 20_000;
const CLI_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const DETAIL_CACHE_MS = 10_000;
const DEFAULT_LOG_TAIL_LINES = 200;
const MAX_LOG_TAIL_LINES = 1_000;
const MAX_LOG_SINCE_SECONDS = 7 * 24 * 60 * 60;
const MAX_LOG_OUTPUT_BYTES = 512 * 1024;

const CONFIG_HINT =
  "Set the server URL and an API token in the Argo CD plugin settings, or run `argocd login <server>` on the machine running the BB server, then reload the plugin.";

// ---------------------------------------------------------------------------
// Normalized domain types. Every field is required: the Argo CD boundary is
// parsed leniently below, then defaults are filled in exactly once so nothing
// downstream has to re-handle a missing field.
// ---------------------------------------------------------------------------

const applicationSchema = z
  .object({
    name: z.string(),
    namespace: z.string(),
    project: z.string(),
    syncStatus: z.string(),
    healthStatus: z.string(),
    healthMessage: z.string(),
    revision: z.string(),
    repoUrl: z.string(),
    path: z.string(),
    targetRevision: z.string(),
    destinationServer: z.string(),
    destinationNamespace: z.string(),
    operationPhase: z.string(),
    operationMessage: z.string(),
    operationFinishedAt: z.string(),
    createdAt: z.string(),
  })
  .strict();

const resourceSchema = z
  .object({
    group: z.string(),
    kind: z.string(),
    namespace: z.string(),
    name: z.string(),
    syncStatus: z.string(),
    healthStatus: z.string(),
    healthMessage: z.string(),
  })
  .strict();

const historyEntrySchema = z
  .object({
    id: z.number(),
    revision: z.string(),
    deployedAt: z.string(),
  })
  .strict();

const conditionSchema = z
  .object({
    type: z.string(),
    message: z.string(),
    lastTransitionTime: z.string(),
  })
  .strict();

const threadLinkSchema = z
  .object({
    application: z.string(),
    threadId: z.string(),
    createdAt: z.string(),
  })
  .strict();

const podLogEntrySchema = z
  .object({
    podName: z.string(),
    timestamp: z.string(),
    content: z.string(),
  })
  .strict();

const DNS_LABEL_PATTERN = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
const DNS_SUBDOMAIN_PATTERN =
  /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$/;

const optionalPodNameSchema = z
  .string()
  .max(253)
  .refine(
    (value) => value.length === 0 || DNS_SUBDOMAIN_PATTERN.test(value),
    "Must be blank or a valid Kubernetes pod name.",
  );

const optionalDnsLabelSchema = z
  .string()
  .max(63)
  .refine(
    (value) => value.length === 0 || DNS_LABEL_PATTERN.test(value),
    "Must be blank or a valid Kubernetes DNS label.",
  );

const podLogInputSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .describe(
        "The Argo CD application name, optionally namespace-qualified as ns/name.",
      ),
    namespace: optionalDnsLabelSchema
      .default("")
      .describe("Filter pods by Kubernetes namespace. Blank searches all."),
    podName: optionalPodNameSchema
      .default("")
      .describe("Read one exact pod. Blank reads matching application pods."),
    container: optionalDnsLabelSchema
      .default("")
      .describe("Read one container. Blank uses the pod's default container."),
    tailLines: z
      .number()
      .int()
      .min(1)
      .max(MAX_LOG_TAIL_LINES)
      .default(DEFAULT_LOG_TAIL_LINES)
      .describe("Lines to read from the end, from 1 to 1000."),
    sinceSeconds: z
      .number()
      .int()
      .min(0)
      .max(MAX_LOG_SINCE_SECONDS)
      .default(0)
      .describe("Only logs this many seconds old or newer. Zero disables it."),
    previous: z
      .boolean()
      .default(false)
      .describe("Read the previously terminated container instance."),
  })
  .strict();

const podLogResultSchema = z
  .object({
    transport: z.enum(["api", "cli"]),
    entries: z.array(podLogEntrySchema),
    truncated: z.boolean(),
  })
  .strict();

// The row types are exported so app.tsx can name them in its table props
// without redeclaring the shape; the import is type-only and erased, so
// nothing from this module reaches the frontend bundle.
export type ArgoApplication = z.infer<typeof applicationSchema>;
export type ArgoResource = z.infer<typeof resourceSchema>;
export type ArgoPodLogEntry = z.infer<typeof podLogEntrySchema>;
type ArgoHistoryEntry = z.infer<typeof historyEntrySchema>;
type ArgoCondition = z.infer<typeof conditionSchema>;
type ThreadLink = z.infer<typeof threadLinkSchema>;

interface ApplicationDetail {
  application: ArgoApplication;
  resources: ArgoResource[];
  history: ArgoHistoryEntry[];
  conditions: ArgoCondition[];
}

interface BbProjectSummary {
  id: string;
}

interface SpawnedThreadSummary {
  id: string;
}

// ---------------------------------------------------------------------------
// The Argo CD wire boundary. Argo CD serves the raw Kubernetes Application
// object and its field set shifts between versions, so every leaf is optional
// here and normalized immediately afterwards.
// ---------------------------------------------------------------------------

const rawHealthSchema = z.object({
  status: z.string().optional(),
  message: z.string().optional(),
});

const rawSourceSchema = z.object({
  repoURL: z.string().optional(),
  path: z.string().optional(),
  chart: z.string().optional(),
  targetRevision: z.string().optional(),
});

const rawApplicationSchema = z.object({
  metadata: z.object({
    name: z.string(),
    namespace: z.string().optional(),
    creationTimestamp: z.string().optional(),
  }),
  spec: z
    .object({
      project: z.string().optional(),
      source: rawSourceSchema.optional(),
      sources: z.array(rawSourceSchema).optional(),
      destination: z
        .object({
          server: z.string().optional(),
          name: z.string().optional(),
          namespace: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  status: z
    .object({
      sync: z
        .object({
          status: z.string().optional(),
          revision: z.string().optional(),
        })
        .optional(),
      health: rawHealthSchema.optional(),
      resources: z
        .array(
          z.object({
            group: z.string().optional(),
            kind: z.string().optional(),
            namespace: z.string().optional(),
            name: z.string().optional(),
            status: z.string().optional(),
            health: rawHealthSchema.optional(),
          }),
        )
        .optional(),
      operationState: z
        .object({
          phase: z.string().optional(),
          message: z.string().optional(),
          finishedAt: z.string().optional(),
        })
        .optional(),
      history: z
        .array(
          z.object({
            id: z.number().optional(),
            revision: z.string().optional(),
            deployedAt: z.string().optional(),
          }),
        )
        .optional(),
      conditions: z
        .array(
          z.object({
            type: z.string().optional(),
            message: z.string().optional(),
            lastTransitionTime: z.string().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});

const applicationListSchema = z.object({
  items: z.array(rawApplicationSchema).nullable().optional(),
});

const userInfoSchema = z.object({
  loggedIn: z.boolean().optional(),
  username: z.string().optional(),
});

const rawPodLogFrameSchema = z
  .object({
    result: z
      .object({
        podName: z.string().optional(),
        content: z.string().optional(),
        timeStampStr: z.string().optional(),
        last: z.boolean().optional(),
      })
      .optional(),
    error: z
      .object({
        message: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// rpc contract
// ---------------------------------------------------------------------------

const filterInputSchema = z
  .object({
    search: z.string().default(""),
    project: z.string().default(""),
    syncStatus: z.string().default(""),
    healthStatus: z.string().default(""),
  })
  .strict();

const statusResultSchema = z
  .object({
    mode: z.enum(["api", "cli", "unconfigured"]),
    serverUrl: z.string(),
    username: z.string(),
    ready: z.boolean(),
    error: z.string().nullable(),
    lastSyncedAt: z.string().nullable(),
    applicationCount: z.number(),
  })
  .strict();

const listResultSchema = z
  .object({
    applications: z.array(applicationSchema),
    projects: z.array(z.string()),
    syncStatuses: z.array(z.string()),
    healthStatuses: z.array(z.string()),
    lastSyncedAt: z.string().nullable(),
    error: z.string().nullable(),
  })
  .strict();

const detailResultSchema = z
  .object({
    application: applicationSchema,
    resources: z.array(resourceSchema),
    history: z.array(historyEntrySchema),
    conditions: z.array(conditionSchema),
    links: z.array(threadLinkSchema),
  })
  .strict();

export type ArgocdStatus = z.infer<typeof statusResultSchema>;
export type ArgocdApplicationList = z.infer<typeof listResultSchema>;
export type ArgocdApplicationDetail = z.infer<typeof detailResultSchema>;
export type ArgocdPodLogs = z.infer<typeof podLogResultSchema>;

export const argocdRpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: statusResultSchema,
  },
  listApplications: {
    input: filterInputSchema,
    output: listResultSchema,
  },
  getApplication: {
    input: z.object({ name: z.string().min(1) }).strict(),
    output: detailResultSchema,
  },
  getPodLogs: {
    input: podLogInputSchema,
    output: podLogResultSchema,
  },
  /** Refreshes BB's cache from Argo CD. Does not sync anything in the cluster. */
  refreshCache: {
    input: z.null(),
    output: z.object({ applications: z.number() }).strict(),
  },
  spawnThread: {
    input: z.object({ name: z.string().min(1) }).strict(),
    output: z.object({ threadId: z.string() }).strict(),
  },
});

const USAGE = [
  "Usage:",
  "  bb argocd status                    Show the configured transport and cache state",
  "  bb argocd apps [--project P] [--sync S] [--health H] [--search Q]",
  "  bb argocd app <name>                Show one application with its resources",
  "  bb argocd resources <name>          List the resources an application manages",
  "  bb argocd history <name>            List an application's deployment history",
  "  bb argocd logs <name> [--pod POD] [--namespace NS] [--container C]",
  "                         [--tail N] [--since-seconds N] [--previous]",
  "  bb argocd refresh                   Refresh BB's cache from Argo CD (read-only)",
].join("\n");

// ---------------------------------------------------------------------------
// Pure helpers — exported so they are unit-testable without a plugin host.
// ---------------------------------------------------------------------------

export function needsConfiguration(message: string): Error {
  return Object.assign(new Error(message), {
    name: "NeedsConfigurationError",
  });
}

/** Trims a user-typed server URL into an origin, defaulting to https. */
export function normalizeServerUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) return null;
  const scheme = trimmed
    .match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1]
    ?.toLowerCase();
  // Reject a foreign scheme outright rather than prefixing it: "ftp://host"
  // would otherwise become "https://ftp//host", which parses to the host "ftp".
  if (scheme !== undefined && scheme !== "http" && scheme !== "https")
    return null;
  const withScheme = scheme === undefined ? `https://${trimmed}` : trimmed;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/** Splits a comma/whitespace separated settings list into distinct entries. */
export function parseNameList(raw: string): string[] {
  const seen = new Set<string>();
  for (const entry of raw.split(/[\s,]+/)) {
    const name = entry.trim();
    if (name.length > 0) seen.add(name);
  }
  return [...seen];
}

/**
 * Argo CD application names are a Kubernetes resource name, optionally
 * qualified by the namespace holding the Application CR (`ns/name`). Rejecting
 * anything else keeps user input out of URL paths and CLI argv.
 */
export function isApplicationName(value: string): boolean {
  return /^(?:[a-z0-9][a-z0-9.-]{0,62}\/)?[a-z0-9][a-z0-9.-]{0,62}$/.test(
    value,
  );
}

export function normalizeApplication(
  raw: z.infer<typeof rawApplicationSchema>,
): ArgoApplication {
  const source = raw.spec?.source ?? raw.spec?.sources?.[0];
  const destination = raw.spec?.destination;
  const operation = raw.status?.operationState;
  return {
    name: raw.metadata.name,
    namespace: raw.metadata.namespace ?? "",
    project: raw.spec?.project ?? "default",
    syncStatus: raw.status?.sync?.status ?? "Unknown",
    healthStatus: raw.status?.health?.status ?? "Unknown",
    healthMessage: raw.status?.health?.message ?? "",
    revision: raw.status?.sync?.revision ?? "",
    // A Helm application carries `chart` where a directory app carries `path`.
    repoUrl: source?.repoURL ?? "",
    path: source?.path ?? source?.chart ?? "",
    targetRevision: source?.targetRevision ?? "",
    destinationServer: destination?.server ?? destination?.name ?? "",
    destinationNamespace: destination?.namespace ?? "",
    operationPhase: operation?.phase ?? "",
    operationMessage: operation?.message ?? "",
    operationFinishedAt: operation?.finishedAt ?? "",
    createdAt: raw.metadata.creationTimestamp ?? "",
  };
}

export function normalizeDetail(
  raw: z.infer<typeof rawApplicationSchema>,
): ApplicationDetail {
  return {
    application: normalizeApplication(raw),
    resources: (raw.status?.resources ?? []).map((resource) => ({
      group: resource.group ?? "",
      kind: resource.kind ?? "",
      namespace: resource.namespace ?? "",
      name: resource.name ?? "",
      syncStatus: resource.status ?? "Unknown",
      healthStatus: resource.health?.status ?? "",
      healthMessage: resource.health?.message ?? "",
    })),
    history: (raw.status?.history ?? []).map((entry) => ({
      id: entry.id ?? 0,
      revision: entry.revision ?? "",
      deployedAt: entry.deployedAt ?? "",
    })),
    conditions: (raw.status?.conditions ?? []).map((condition) => ({
      type: condition.type ?? "",
      message: condition.message ?? "",
      lastTransitionTime: condition.lastTransitionTime ?? "",
    })),
  };
}

export function validateArgocdCliArgs(argv: string[]): string | null {
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === "help" || sub === "--help") {
    return rest.length === 0 ? null : `Unexpected argument "${rest[0]}".`;
  }
  if (sub === "status" || sub === "refresh") {
    return rest.length === 0
      ? null
      : `Subcommand "${sub}" does not accept arguments.`;
  }
  if (sub === "app" || sub === "resources" || sub === "history") {
    const [name, ...extra] = rest;
    if (name === undefined)
      return `Subcommand "${sub}" requires an application name.`;
    if (extra.length > 0) return `Unexpected argument "${extra[0]}".`;
    return isApplicationName(name)
      ? null
      : `Invalid application name "${name}".`;
  }
  if (sub === "logs") {
    const parsed = parsePodLogArgs(rest);
    return parsed.ok ? null : parsed.error;
  }
  if (sub === "apps") {
    const flags = new Set(["--project", "--sync", "--health", "--search"]);
    for (let index = 0; index < rest.length; index += 2) {
      const flag = rest[index];
      if (flag === undefined || !flags.has(flag)) {
        return `Unknown flag "${flag ?? ""}" for "apps".`;
      }
      if (rest[index + 1] === undefined)
        return `Flag "${flag}" requires a value.`;
    }
    return null;
  }
  return `Unknown subcommand "${sub}".`;
}

export function parseAppsFlags(rest: string[]): {
  search: string;
  project: string;
  syncStatus: string;
  healthStatus: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (flag !== undefined && value !== undefined) values.set(flag, value);
  }
  return {
    search: values.get("--search") ?? "",
    project: values.get("--project") ?? "",
    syncStatus: values.get("--sync") ?? "",
    healthStatus: values.get("--health") ?? "",
  };
}

export interface PodLogRequest {
  name: string;
  namespace: string;
  podName: string;
  container: string;
  tailLines: number;
  sinceSeconds: number;
  previous: boolean;
}

export type ParsedPodLogArgs =
  | { ok: true; value: PodLogRequest }
  | { ok: false; error: string };

/** Parses the `bb argocd logs` arguments into the same explicit RPC shape. */
export function parsePodLogArgs(rest: string[]): ParsedPodLogArgs {
  const [name, ...flags] = rest;
  if (name === undefined) {
    return {
      ok: false,
      error: 'Subcommand "logs" requires an application name.',
    };
  }
  if (!isApplicationName(name)) {
    return { ok: false, error: `Invalid application name "${name}".` };
  }

  const value: PodLogRequest = {
    name,
    namespace: "",
    podName: "",
    container: "",
    tailLines: DEFAULT_LOG_TAIL_LINES,
    sinceSeconds: 0,
    previous: false,
  };
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (flag === "--previous") {
      value.previous = true;
      continue;
    }
    if (
      flag !== "--pod" &&
      flag !== "--namespace" &&
      flag !== "--container" &&
      flag !== "--tail" &&
      flag !== "--since-seconds"
    ) {
      return {
        ok: false,
        error: `Unknown flag "${flag ?? ""}" for "logs".`,
      };
    }
    const raw = flags[index + 1];
    if (raw === undefined || raw.startsWith("--")) {
      return { ok: false, error: `Flag "${flag}" requires a value.` };
    }
    index += 1;
    if (flag === "--tail" || flag === "--since-seconds") {
      if (!/^\d+$/.test(raw)) {
        return { ok: false, error: `Flag "${flag}" requires an integer.` };
      }
      const parsed = Number(raw);
      const maximum =
        flag === "--tail" ? MAX_LOG_TAIL_LINES : MAX_LOG_SINCE_SECONDS;
      const minimum = flag === "--tail" ? 1 : 0;
      if (parsed < minimum || parsed > maximum) {
        return {
          ok: false,
          error: `Flag "${flag}" must be between ${minimum} and ${maximum}.`,
        };
      }
      if (flag === "--tail") value.tailLines = parsed;
      else value.sinceSeconds = parsed;
      continue;
    }
    const selectorSchema =
      flag === "--pod" ? optionalPodNameSchema : optionalDnsLabelSchema;
    if (!selectorSchema.safeParse(raw).success) {
      return {
        ok: false,
        error: `Invalid Kubernetes name "${raw}" for "${flag}".`,
      };
    }
    if (flag === "--pod") value.podName = raw;
    else if (flag === "--namespace") value.namespace = raw;
    else value.container = raw;
  }
  return { ok: true, value };
}

/** Parses grpc-gateway's newline-delimited server-streaming response. */
export function parsePodLogStream(body: string): ArgoPodLogEntry[] {
  const entries: ArgoPodLogEntry[] = [];
  for (const [index, line] of body.split(/\r?\n/).entries()) {
    if (line.trim().length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(
        `Argo CD returned an invalid log frame at line ${index + 1}.`,
      );
    }
    const frame = rawPodLogFrameSchema.parse(raw);
    if (frame.error?.message !== undefined) {
      throw new Error(`Argo CD log request failed: ${frame.error.message}`);
    }
    const result = frame.result;
    if (result === undefined || result.last === true) continue;
    entries.push({
      podName: result.podName ?? "",
      timestamp: result.timeStampStr ?? "",
      content: result.content ?? "",
    });
  }
  return entries;
}

function utf8Tail(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximumBytes) return value;
  let start = bytes.length - maximumBytes;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}

/** Keeps the newest complete log entries within BB's bounded output budget. */
export function limitPodLogEntries(
  entries: ArgoPodLogEntry[],
  maximumBytes = MAX_LOG_OUTPUT_BYTES,
): { entries: ArgoPodLogEntry[]; truncated: boolean } {
  let remaining = maximumBytes;
  const kept: ArgoPodLogEntry[] = [];
  let truncated = false;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    const metadataBytes = Buffer.byteLength(
      `${entry.podName}${entry.timestamp}\n`,
      "utf8",
    );
    const contentBytes = Buffer.byteLength(entry.content, "utf8");
    if (metadataBytes + contentBytes <= remaining) {
      kept.push(entry);
      remaining -= metadataBytes + contentBytes;
      continue;
    }
    truncated = true;
    if (kept.length === 0 && remaining > metadataBytes) {
      kept.push({
        ...entry,
        content: utf8Tail(entry.content, remaining - metadataBytes),
      });
    }
    break;
  }
  if (kept.length < entries.length) truncated = true;
  kept.reverse();
  return { entries: kept, truncated };
}

/**
 * `signal` is what lets the poll service actually stop. Without it a reload
 * has to wait out the CLI's own timeout — up to 30s per call, and longer when
 * the binary probe walks several candidate paths — which trips the host's stop
 * deadline and leaves the plugin degraded.
 */
function run(
  file: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, signal },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `${file} ${args.slice(0, 3).join(" ")} failed: ${
                stderr.trim() || error.message
              }`,
            ),
          );
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
  });
}

/**
 * A GET against the Argo CD REST API. Uses node:http(s) rather than fetch so
 * `rejectUnauthorized` can be turned off for the self-signed certificates a
 * default Argo CD install ships with.
 */
function requestBody(args: {
  url: string;
  token: string;
  rejectUnauthorized: boolean;
  timeoutMs: number;
  maximumBytes?: number;
  /** Aborts an in-flight request so the poll service can stop promptly. */
  signal?: AbortSignal;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(args.url);
    } catch {
      reject(new Error(`Invalid Argo CD URL: ${args.url}`));
      return;
    }
    const isHttps = target.protocol === "https:";
    const send = isHttps ? httpsRequest : httpRequest;
    const request = send(
      target,
      {
        method: "GET",
        signal: args.signal,
        headers: {
          authorization: `Bearer ${args.token}`,
          accept: "application/json",
        },
        timeout: args.timeoutMs,
        ...(isHttps ? { rejectUnauthorized: args.rejectUnauthorized } : {}),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const maximumBytes = args.maximumBytes ?? MAX_RESPONSE_BYTES;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maximumBytes) {
            request.destroy(
              new Error(
                `Argo CD response exceeded ${Math.floor(maximumBytes / 1024)}KB`,
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          const body = Buffer.concat(chunks).toString("utf8");
          if (status === 401) {
            reject(
              needsConfiguration(
                `Argo CD rejected the API token (HTTP 401). ${CONFIG_HINT}`,
              ),
            );
            return;
          }
          if (status === 403) {
            reject(
              new Error(
                `Argo CD denied this request (HTTP 403). Check the account's Argo CD RBAC permissions: ${body.slice(0, 300)}`,
              ),
            );
            return;
          }
          if (status < 200 || status >= 300) {
            reject(
              new Error(`Argo CD responded ${status}: ${body.slice(0, 300)}`),
            );
            return;
          }
          resolve(body);
        });
      },
    );
    request.on("timeout", () => {
      request.destroy(
        new Error(`Argo CD request timed out after ${args.timeoutMs}ms`),
      );
    });
    request.on("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
          error.code === "SELF_SIGNED_CERT_IN_CHAIN" ||
          error.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
          ? needsConfiguration(
              `Argo CD is using a certificate this machine does not trust (${error.code}). Enable "Allow insecure TLS" in the plugin settings if that is expected.`,
            )
          : error,
      );
    });
    request.end();
  });
}

async function requestJson(args: {
  url: string;
  token: string;
  rejectUnauthorized: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<unknown> {
  const body = await requestBody(args);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Argo CD returned a non-JSON response");
  }
}

// ---------------------------------------------------------------------------

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    serverUrl: {
      type: "string",
      label: "Argo CD server URL",
      description:
        "e.g. https://argocd.example.com. Leave blank to use the `argocd` CLI session on the BB server machine.",
      default: "",
    },
    authToken: {
      type: "string",
      label: "API token",
      description:
        "Argo CD API token (Settings → Accounts → Generate token). Pod logs also require the Argo CD `logs, get` RBAC permission.",
      secret: true,
    },
    accessMode: {
      type: "select",
      label: "Access mode",
      options: ["auto", "api", "cli"],
      description:
        "auto uses the REST API when a server URL and token are set, and the `argocd` CLI otherwise.",
      default: "auto",
    },
    allowInsecureTls: {
      type: "boolean",
      label: "Allow insecure TLS",
      description:
        "Skip certificate verification. Needed for the self-signed certificate a default Argo CD install ships with.",
      default: false,
    },
    projects: {
      type: "string",
      label: "Argo CD projects",
      description:
        "Comma-separated Argo CD project names to track. Blank tracks every project the account can see.",
      default: "",
    },
    defaultProject: {
      type: "project",
      label: "Default BB project",
      description: "Where agent threads spawn from the Argo CD panel.",
    },
  });

  // ------------------------------------------------------------------
  // Transport resolution. The server process may have a trimmed PATH, so
  // probe the usual argocd install locations once and remember the winner.
  // ------------------------------------------------------------------
  type Access =
    | {
        kind: "api";
        serverUrl: string;
        token: string;
        rejectUnauthorized: boolean;
      }
    | { kind: "cli"; binary: string; insecure: boolean };

  let argocdPath: string | null = null;

  async function resolveArgocdBinary(signal?: AbortSignal): Promise<string> {
    if (argocdPath !== null) return argocdPath;
    const candidates = [
      "argocd",
      "/opt/homebrew/bin/argocd",
      "/usr/local/bin/argocd",
    ];
    for (const candidate of candidates) {
      try {
        await run(candidate, ["version", "--client", "--short"], 5_000, signal);
        argocdPath = candidate;
        return candidate;
      } catch {
        // try the next location
      }
    }
    throw needsConfiguration(`The argocd CLI was not found. ${CONFIG_HINT}`);
  }

  async function resolveAccess(signal?: AbortSignal): Promise<Access> {
    const { serverUrl, authToken, accessMode, allowInsecureTls } =
      await settings.get();
    const normalizedUrl = normalizeServerUrl(serverUrl);
    const token = authToken?.trim() ?? "";
    const hasApiConfig = normalizedUrl !== null && token.length > 0;

    if (accessMode === "api" || (accessMode === "auto" && hasApiConfig)) {
      if (normalizedUrl === null) {
        throw needsConfiguration(
          `No Argo CD server URL is set. ${CONFIG_HINT}`,
        );
      }
      if (token.length === 0) {
        throw needsConfiguration(`No Argo CD API token is set. ${CONFIG_HINT}`);
      }
      return {
        kind: "api",
        serverUrl: normalizedUrl,
        token,
        rejectUnauthorized: !allowInsecureTls,
      };
    }
    return {
      kind: "cli",
      binary: await resolveArgocdBinary(signal),
      insecure: allowInsecureTls,
    };
  }

  function cliArgs(
    access: Extract<Access, { kind: "cli" }>,
    args: string[],
  ): string[] {
    return access.insecure ? ["--insecure", ...args] : args;
  }

  async function fetchApplications(
    signal?: AbortSignal,
  ): Promise<ArgoApplication[]> {
    const access = await resolveAccess(signal);
    const projects = parseNameList((await settings.get()).projects);
    let raw: unknown;
    if (access.kind === "api") {
      const query = projects
        .map((p) => `projects=${encodeURIComponent(p)}`)
        .join("&");
      raw = await requestJson({
        url: `${access.serverUrl}/api/v1/applications${query.length > 0 ? `?${query}` : ""}`,
        token: access.token,
        rejectUnauthorized: access.rejectUnauthorized,
        timeoutMs: API_TIMEOUT_MS,
        signal,
      });
      const parsed = applicationListSchema.parse(raw);
      return (parsed.items ?? []).map(normalizeApplication);
    }
    const projectArgs = projects.flatMap((project) => ["--project", project]);
    const { stdout } = await run(
      access.binary,
      cliArgs(access, ["app", "list", "-o", "json", ...projectArgs]),
      CLI_TIMEOUT_MS,
      signal,
    );
    // `argocd app list -o json` prints a bare array, unlike the REST list.
    const parsed = z.array(rawApplicationSchema).parse(JSON.parse(stdout));
    return parsed.map(normalizeApplication);
  }

  async function fetchApplicationDetail(
    name: string,
  ): Promise<ApplicationDetail> {
    if (!isApplicationName(name)) {
      throw new Error(`Invalid application name "${name}".`);
    }
    const access = await resolveAccess();
    if (access.kind === "api") {
      // `ns/name` addresses an Application CR outside the Argo CD namespace.
      const [head, tail] = name.split("/");
      const path =
        tail === undefined
          ? `/api/v1/applications/${encodeURIComponent(head ?? name)}`
          : `/api/v1/applications/${encodeURIComponent(tail)}?appNamespace=${encodeURIComponent(head ?? "")}`;
      const raw = await requestJson({
        url: `${access.serverUrl}${path}`,
        token: access.token,
        rejectUnauthorized: access.rejectUnauthorized,
        timeoutMs: API_TIMEOUT_MS,
      });
      return normalizeDetail(rawApplicationSchema.parse(raw));
    }
    const { stdout } = await run(
      access.binary,
      cliArgs(access, ["app", "get", name, "-o", "json"]),
      CLI_TIMEOUT_MS,
    );
    return normalizeDetail(rawApplicationSchema.parse(JSON.parse(stdout)));
  }

  async function fetchPodLogs(
    query: PodLogRequest,
    signal?: AbortSignal,
  ): Promise<ArgocdPodLogs> {
    if (!isApplicationName(query.name)) {
      throw new Error(`Invalid application name "${query.name}".`);
    }
    const parsedQuery = podLogInputSchema.parse(query);
    const access = await resolveAccess(signal);
    if (access.kind === "api") {
      const [head, tail] = parsedQuery.name.split("/");
      const applicationName = tail ?? head ?? parsedQuery.name;
      const applicationNamespace = tail === undefined ? "" : (head ?? "");
      const endpoint =
        parsedQuery.podName.length > 0
          ? `/api/v1/applications/${encodeURIComponent(applicationName)}/pods/${encodeURIComponent(parsedQuery.podName)}/logs`
          : `/api/v1/applications/${encodeURIComponent(applicationName)}/logs`;
      const params = new URLSearchParams({
        tailLines: String(parsedQuery.tailLines),
        follow: "false",
      });
      if (applicationNamespace.length > 0) {
        params.set("appNamespace", applicationNamespace);
      }
      if (parsedQuery.namespace.length > 0) {
        params.set("namespace", parsedQuery.namespace);
      }
      if (parsedQuery.container.length > 0) {
        params.set("container", parsedQuery.container);
      }
      if (parsedQuery.sinceSeconds > 0) {
        params.set("sinceSeconds", String(parsedQuery.sinceSeconds));
      }
      if (parsedQuery.previous) params.set("previous", "true");
      const body = await requestBody({
        url: `${access.serverUrl}${endpoint}?${params.toString()}`,
        token: access.token,
        rejectUnauthorized: access.rejectUnauthorized,
        timeoutMs: CLI_TIMEOUT_MS,
        maximumBytes: MAX_RESPONSE_BYTES,
        signal,
      });
      return {
        transport: "api",
        ...limitPodLogEntries(parsePodLogStream(body)),
      };
    }

    const args = [
      "app",
      "logs",
      parsedQuery.name,
      "--tail",
      String(parsedQuery.tailLines),
    ];
    if (parsedQuery.podName.length > 0) {
      args.push("--kind", "Pod", "--name", parsedQuery.podName);
    }
    if (parsedQuery.namespace.length > 0) {
      args.push("--namespace", parsedQuery.namespace);
    }
    if (parsedQuery.container.length > 0) {
      args.push("--container", parsedQuery.container);
    }
    if (parsedQuery.sinceSeconds > 0) {
      args.push("--since-seconds", String(parsedQuery.sinceSeconds));
    }
    if (parsedQuery.previous) args.push("--previous");
    const { stdout } = await run(
      access.binary,
      cliArgs(access, args),
      CLI_TIMEOUT_MS,
      signal,
    );
    const normalized = stdout.replace(/\r\n/g, "\n").replace(/\n$/, "");
    const entries =
      normalized.length === 0
        ? []
        : normalized.split("\n").map((content) => ({
            podName: parsedQuery.podName,
            timestamp: "",
            content,
          }));
    return { transport: "cli", ...limitPodLogEntries(entries) };
  }

  async function checkAccess(): Promise<{
    mode: "api" | "cli";
    username: string;
  }> {
    const access = await resolveAccess();
    if (access.kind === "api") {
      const raw = await requestJson({
        url: `${access.serverUrl}/api/v1/session/userinfo`,
        token: access.token,
        rejectUnauthorized: access.rejectUnauthorized,
        timeoutMs: 10_000,
      });
      const info = userInfoSchema.parse(raw);
      if (info.loggedIn !== true) {
        throw needsConfiguration(
          `The Argo CD API token is not accepted as a logged-in session. ${CONFIG_HINT}`,
        );
      }
      return { mode: "api", username: info.username ?? "" };
    }
    try {
      const { stdout } = await run(
        access.binary,
        cliArgs(access, ["account", "get-user-info", "-o", "json"]),
        10_000,
      );
      const info = userInfoSchema.parse(JSON.parse(stdout));
      if (info.loggedIn !== true) {
        throw needsConfiguration(
          `The argocd CLI is not logged in. Run \`argocd login <server>\` on the BB server machine, then reload the plugin.`,
        );
      }
      return { mode: "cli", username: info.username ?? "" };
    } catch (error) {
      if (error instanceof Error && error.name === "NeedsConfigurationError")
        throw error;
      throw needsConfiguration(
        `The argocd CLI could not reach Argo CD: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // ------------------------------------------------------------------
  // SQLite cache of the application list. Detail views are fetched live
  // (with a short memo) because resources and history change per sync.
  // ------------------------------------------------------------------
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS applications (
       name TEXT PRIMARY KEY,
       namespace TEXT NOT NULL,
       project TEXT NOT NULL,
       sync_status TEXT NOT NULL,
       health_status TEXT NOT NULL,
       health_message TEXT NOT NULL,
       revision TEXT NOT NULL,
       repo_url TEXT NOT NULL,
       path TEXT NOT NULL,
       target_revision TEXT NOT NULL,
       destination_server TEXT NOT NULL,
       destination_namespace TEXT NOT NULL,
       operation_phase TEXT NOT NULL,
       operation_message TEXT NOT NULL,
       operation_finished_at TEXT NOT NULL,
       created_at TEXT NOT NULL
     )`,
  ]);

  function rowToApplication(row: Record<string, unknown>): ArgoApplication {
    return {
      name: String(row.name),
      namespace: String(row.namespace),
      project: String(row.project),
      syncStatus: String(row.sync_status),
      healthStatus: String(row.health_status),
      healthMessage: String(row.health_message),
      revision: String(row.revision),
      repoUrl: String(row.repo_url),
      path: String(row.path),
      targetRevision: String(row.target_revision),
      destinationServer: String(row.destination_server),
      destinationNamespace: String(row.destination_namespace),
      operationPhase: String(row.operation_phase),
      operationMessage: String(row.operation_message),
      operationFinishedAt: String(row.operation_finished_at),
      createdAt: String(row.created_at),
    };
  }

  function listCachedApplications(filter: {
    search: string;
    project: string;
    syncStatus: string;
    healthStatus: string;
  }): ArgoApplication[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.project.length > 0) {
      clauses.push("project = ?");
      params.push(filter.project);
    }
    if (filter.syncStatus.length > 0) {
      clauses.push("sync_status = ?");
      params.push(filter.syncStatus);
    }
    if (filter.healthStatus.length > 0) {
      clauses.push("health_status = ?");
      params.push(filter.healthStatus);
    }
    const search = filter.search.trim();
    if (search.length > 0) {
      clauses.push(
        "(name LIKE ? OR destination_namespace LIKE ? OR repo_url LIKE ? OR path LIKE ?)",
      );
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db
      .prepare(`SELECT * FROM applications ${where} ORDER BY name`)
      .all(...params) as Record<string, unknown>[];
    return rows.map(rowToApplication);
  }

  function distinctValues(
    column: "project" | "sync_status" | "health_status",
  ): string[] {
    const rows = db
      .prepare(
        `SELECT DISTINCT ${column} AS value FROM applications WHERE ${column} != '' ORDER BY value`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((row) => String(row.value));
  }

  function getCachedApplication(name: string): ArgoApplication | null {
    const row = db
      .prepare("SELECT * FROM applications WHERE name = ?")
      .get(name) as Record<string, unknown> | undefined;
    return row === undefined ? null : rowToApplication(row);
  }

  // ------------------------------------------------------------------
  // Cache refresh. `lastError` is surfaced in the panel rather than thrown at
  // it, so a temporarily unreachable Argo CD leaves the last known state
  // readable instead of blanking the UI.
  // ------------------------------------------------------------------
  let lastError: string | null = null;

  async function refreshCache(signal?: AbortSignal): Promise<number> {
    const applications = await fetchApplications(signal);
    const before = JSON.stringify(
      db
        .prepare(
          "SELECT name, sync_status, health_status, revision, operation_phase FROM applications ORDER BY name",
        )
        .all(),
    );
    const replaceAll = db.transaction((rows: ArgoApplication[]) => {
      db.prepare("DELETE FROM applications").run();
      const insert = db.prepare(
        `INSERT INTO applications (
           name, namespace, project, sync_status, health_status, health_message,
           revision, repo_url, path, target_revision, destination_server,
           destination_namespace, operation_phase, operation_message,
           operation_finished_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const app of rows) {
        insert.run(
          app.name,
          app.namespace,
          app.project,
          app.syncStatus,
          app.healthStatus,
          app.healthMessage,
          app.revision,
          app.repoUrl,
          app.path,
          app.targetRevision,
          app.destinationServer,
          app.destinationNamespace,
          app.operationPhase,
          app.operationMessage,
          app.operationFinishedAt,
          app.createdAt,
        );
      }
    });
    replaceAll(applications);
    const after = JSON.stringify(
      db
        .prepare(
          "SELECT name, sync_status, health_status, revision, operation_phase FROM applications ORDER BY name",
        )
        .all(),
    );
    await bb.storage.kv.set("cache-cursor", {
      lastSyncedAt: new Date().toISOString(),
      applications: applications.length,
    });
    lastError = null;
    if (before !== after) {
      bb.realtime.publish("data-changed", {
        applications: applications.length,
      });
    }
    return applications.length;
  }

  async function readCursor(): Promise<{
    lastSyncedAt: string | null;
    applications: number;
  }> {
    const cursor = await bb.storage.kv.get<{
      lastSyncedAt: string;
      applications: number;
    }>("cache-cursor");
    return {
      lastSyncedAt: cursor?.lastSyncedAt ?? null,
      applications: cursor?.applications ?? 0,
    };
  }

  bb.background.service("poll", {
    async start(signal) {
      while (!signal.aborted) {
        try {
          await refreshCache(signal);
        } catch (error) {
          // A stop request cancels the in-flight request; that is not a
          // refresh failure and must not be reported as one.
          if (signal.aborted) break;
          // A NeedsConfigurationError propagates so the host flips the plugin
          // to needs-configuration instead of restart-looping this service.
          if (
            error instanceof Error &&
            error.name === "NeedsConfigurationError"
          )
            throw error;
          lastError = error instanceof Error ? error.message : String(error);
          bb.log.warn(`Argo CD refresh failed: ${lastError}`);
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, SYNC_INTERVAL_MS);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
    },
  });

  // Report an unconfigured install immediately rather than waiting for the
  // poll service's first failure.
  let identity = "";
  try {
    identity = (await checkAccess()).username;
  } catch (error) {
    bb.status.needsConfiguration(
      error instanceof Error ? error.message : String(error),
    );
  }

  // ------------------------------------------------------------------
  // Live detail reads, memoized briefly so a panel render and its agent
  // button don't each hit Argo CD.
  // ------------------------------------------------------------------
  const detailCache = new Map<
    string,
    { detail: ApplicationDetail; fetchedAt: number }
  >();

  async function getDetail(name: string): Promise<ApplicationDetail> {
    const cached = detailCache.get(name);
    if (
      cached !== undefined &&
      Date.now() - cached.fetchedAt < DETAIL_CACHE_MS
    ) {
      return cached.detail;
    }
    const detail = await fetchApplicationDetail(name);
    detailCache.set(name, { detail, fetchedAt: Date.now() });
    return detail;
  }

  // ------------------------------------------------------------------
  // Application ↔ thread links (the pills in the UI).
  // kv: "link:<application>" → ThreadLink[]
  // ------------------------------------------------------------------
  async function listLinks(application: string): Promise<ThreadLink[]> {
    return (await bb.storage.kv.get<ThreadLink[]>(`link:${application}`)) ?? [];
  }

  async function addLink(link: ThreadLink): Promise<void> {
    const key = `link:${link.application}`;
    await bb.storage.kv.set(key, [
      ...(await listLinks(link.application)),
      link,
    ]);
    bb.realtime.publish("links-changed", { application: link.application });
  }

  function describeApplication(detail: ApplicationDetail): string {
    const app = detail.application;
    const unhealthy = detail.resources.filter(
      (resource) =>
        resource.healthStatus !== "" &&
        resource.healthStatus !== "Healthy" &&
        resource.healthStatus !== "Suspended",
    );
    const outOfSync = detail.resources.filter(
      (resource) => resource.syncStatus !== "Synced",
    );
    return [
      `Application: ${app.name}`,
      `Argo CD project: ${app.project}`,
      `Sync: ${app.syncStatus}  Health: ${app.healthStatus}${
        app.healthMessage.length > 0 ? ` — ${app.healthMessage}` : ""
      }`,
      `Destination: ${app.destinationServer} / ${app.destinationNamespace}`,
      `Source: ${app.repoUrl}${app.path.length > 0 ? ` (${app.path})` : ""} @ ${
        app.targetRevision.length > 0 ? app.targetRevision : "HEAD"
      }`,
      `Deployed revision: ${app.revision.length > 0 ? app.revision : "unknown"}`,
      app.operationPhase.length > 0
        ? `Last operation: ${app.operationPhase}${
            app.operationMessage.length > 0 ? ` — ${app.operationMessage}` : ""
          }${app.operationFinishedAt.length > 0 ? ` (${app.operationFinishedAt})` : ""}`
        : "Last operation: none recorded",
      "",
      `Resources: ${detail.resources.length} total, ${outOfSync.length} out of sync, ${unhealthy.length} not healthy`,
      ...(unhealthy.length > 0
        ? [
            "",
            "Not healthy:",
            ...unhealthy.map(
              (resource) =>
                `  ${resource.kind}/${resource.name} (${resource.namespace}) — ${resource.healthStatus}${
                  resource.healthMessage.length > 0
                    ? `: ${resource.healthMessage}`
                    : ""
                }`,
            ),
          ]
        : []),
      ...(outOfSync.length > 0
        ? [
            "",
            "Out of sync:",
            ...outOfSync.map(
              (resource) =>
                `  ${resource.kind}/${resource.name} (${resource.namespace}) — ${resource.syncStatus}`,
            ),
          ]
        : []),
      ...(detail.conditions.length > 0
        ? [
            "",
            "Conditions:",
            ...detail.conditions.map(
              (condition) => `  ${condition.type}: ${condition.message}`,
            ),
          ]
        : []),
    ].join("\n");
  }

  function formatApplicationRows(applications: ArgoApplication[]): string {
    return applications
      .map(
        (app) =>
          `${app.name}\t${app.project}\t${app.syncStatus}\t${app.healthStatus}\t${app.destinationNamespace}`,
      )
      .join("\n");
  }

  function formatPodLogs(logs: ArgocdPodLogs): string {
    if (logs.entries.length === 0) {
      return "No pod log lines matched this request.";
    }
    const showPodName =
      new Set(
        logs.entries
          .map((entry) => entry.podName)
          .filter((name) => name.length > 0),
      ).size > 1;
    const lines = logs.entries.map((entry) => {
      const timestamp = entry.timestamp.length > 0 ? `${entry.timestamp} ` : "";
      const pod = showPodName ? `[${entry.podName}] ` : "";
      return `${timestamp}${pod}${entry.content}`;
    });
    if (logs.truncated) {
      lines.unshift(
        `[BB limited this response to the newest ${Math.floor(MAX_LOG_OUTPUT_BYTES / 1024)}KB.]`,
      );
    }
    return lines.join("\n");
  }

  async function spawnThreadForApplication(name: string): Promise<string> {
    const detail = await getDetail(name);
    const { defaultProject } = await settings.get();
    let projectId = defaultProject ?? "";
    if (projectId.length === 0) {
      const projects =
        (await bb.sdk.projects.list()) as unknown as BbProjectSummary[];
      const first = projects[0];
      if (first === undefined) {
        throw new Error(
          "No BB project is available. Set a default BB project in the Argo CD plugin settings.",
        );
      }
      projectId = first.id;
    }
    const prompt = [
      `Investigate the Argo CD application "${detail.application.name}".`,
      "",
      describeApplication(detail),
      "",
      "Find the cause in this checkout: compare the manifests or chart values at " +
        `${detail.application.path.length > 0 ? detail.application.path : "the application source path"} ` +
        "against what Argo CD reports above. Summarize what changed and what you would " +
        "fix. Do not sync, roll back, or otherwise modify the cluster.",
    ].join("\n");
    const thread = (await bb.sdk.threads.spawn({
      projectId,
      environment: { type: "project-default" },
      title: `Argo CD: ${detail.application.name}`.slice(0, 120),
      prompt,
    })) as unknown as SpawnedThreadSummary;
    await addLink({
      application: detail.application.name,
      threadId: thread.id,
      createdAt: new Date().toISOString(),
    });
    bb.log.info(`spawned thread ${thread.id} for Argo CD application ${name}`);
    return thread.id;
  }

  // ------------------------------------------------------------------
  // rpc — the frontend data plane.
  // ------------------------------------------------------------------
  bb.rpc.register(argocdRpcContract, {
    async status() {
      const cursor = await readCursor();
      const { serverUrl, accessMode } = await settings.get();
      try {
        const access = await checkAccess();
        identity = access.username;
        return {
          mode: access.mode,
          serverUrl: normalizeServerUrl(serverUrl) ?? "",
          username: access.username,
          ready: true,
          error: lastError,
          lastSyncedAt: cursor.lastSyncedAt,
          applicationCount: cursor.applications,
        };
      } catch (error) {
        return {
          mode:
            accessMode === "cli" ? ("cli" as const) : ("unconfigured" as const),
          serverUrl: normalizeServerUrl(serverUrl) ?? "",
          username: identity,
          ready: false,
          error: error instanceof Error ? error.message : String(error),
          lastSyncedAt: cursor.lastSyncedAt,
          applicationCount: cursor.applications,
        };
      }
    },

    async listApplications(filter) {
      const cursor = await readCursor();
      return {
        applications: listCachedApplications(filter),
        projects: distinctValues("project"),
        syncStatuses: distinctValues("sync_status"),
        healthStatuses: distinctValues("health_status"),
        lastSyncedAt: cursor.lastSyncedAt,
        error: lastError,
      };
    },

    async getApplication({ name }) {
      const detail = await getDetail(name);
      return { ...detail, links: await listLinks(name) };
    },

    async getPodLogs(query) {
      return fetchPodLogs(query);
    },

    async refreshCache() {
      return { applications: await refreshCache() };
    },

    async spawnThread({ name }) {
      return { threadId: await spawnThreadForApplication(name) };
    },
  });

  // ------------------------------------------------------------------
  // Agent surfaces.
  // ------------------------------------------------------------------
  bb.agents.registerTool({
    name: "argocd_list_applications",
    description:
      "List Argo CD applications with their sync and health status. Read-only; it never syncs or modifies the cluster.",
    instructions:
      "Use argocd_list_applications to find which deployed applications are OutOfSync or Degraded before guessing from the repo.",
    presentation: {
      label: {
        pending: "Listing Argo CD applications",
        completed: "Listed Argo CD applications",
      },
    },
    parameters: z.object({
      project: z
        .string()
        .default("")
        .describe("Filter by Argo CD project name."),
      syncStatus: z
        .string()
        .default("")
        .describe("Filter by sync status, e.g. Synced or OutOfSync."),
      healthStatus: z
        .string()
        .default("")
        .describe(
          "Filter by health status, e.g. Healthy, Degraded, or Progressing.",
        ),
      search: z
        .string()
        .default("")
        .describe("Substring match on name, namespace, repo URL, or path."),
    }),
    async execute(filter) {
      const applications = listCachedApplications(filter);
      if (applications.length === 0) {
        const cursor = await readCursor();
        return cursor.lastSyncedAt === null
          ? "No Argo CD data has been cached yet. The plugin may still be starting or unconfigured."
          : "No Argo CD applications matched that filter.";
      }
      return [
        "NAME\tPROJECT\tSYNC\tHEALTH\tNAMESPACE",
        formatApplicationRows(applications),
      ].join("\n");
    },
  });

  bb.agents.registerTool({
    name: "argocd_get_application",
    description:
      "Read one Argo CD application in detail: sync and health status, managed resources, conditions, and the last sync operation. Read-only.",
    presentation: {
      label: {
        pending: "Reading Argo CD application",
        completed: "Read Argo CD application",
      },
    },
    parameters: z.object({
      name: z
        .string()
        .min(1)
        .describe(
          "The Argo CD application name, optionally namespace-qualified as ns/name.",
        ),
    }),
    async execute({ name }) {
      try {
        return describeApplication(await getDetail(name));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Argo CD being briefly unreachable should still answer with the last
        // known summary rather than nothing — flagged as stale so the agent
        // does not treat it as live state.
        const cached = getCachedApplication(name);
        if (cached === null) {
          return {
            content: [{ type: "text" as const, text: message }],
            isError: true,
          };
        }
        return [
          `Argo CD is currently unreachable (${message}).`,
          `Reporting the cached summary from ${(await readCursor()).lastSyncedAt ?? "an earlier refresh"}:`,
          "",
          `Application: ${cached.name}`,
          `Argo CD project: ${cached.project}`,
          `Sync: ${cached.syncStatus}  Health: ${cached.healthStatus}${
            cached.healthMessage.length > 0 ? ` — ${cached.healthMessage}` : ""
          }`,
          `Destination: ${cached.destinationServer} / ${cached.destinationNamespace}`,
          `Deployed revision: ${cached.revision.length > 0 ? cached.revision : "unknown"}`,
        ].join("\n");
      }
    },
  });

  bb.agents.registerTool({
    name: "argocd_get_pod_logs",
    description:
      "Read recent pod logs for an Argo CD application. Optionally narrow to a pod, namespace, or container. Read-only; it never modifies the cluster.",
    instructions:
      "Use a bounded tail and a recent sinceSeconds window. Narrow to a pod or container when the application has many workloads.",
    presentation: {
      label: {
        pending: "Reading Argo CD pod logs",
        completed: "Read Argo CD pod logs",
      },
    },
    parameters: podLogInputSchema,
    async execute(query, { signal }) {
      try {
        return formatPodLogs(await fetchPodLogs(query, signal));
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: error instanceof Error ? error.message : String(error),
            },
          ],
          isError: true,
        };
      }
    },
  });

  bb.ui.registerMentionProvider({
    id: "argocd-application",
    label: "Argo CD applications",
    search({ query }) {
      return listCachedApplications({
        search: query,
        project: "",
        syncStatus: "",
        healthStatus: "",
      })
        .slice(0, 20)
        .map((app) => ({
          id: app.name,
          title: app.name,
          subtitle: `${app.syncStatus} · ${app.healthStatus} · ${app.project}`,
        }));
    },
    async resolve(itemId) {
      return { context: describeApplication(await getDetail(itemId)) };
    },
  });

  // ------------------------------------------------------------------
  // CLI. Note that `run` executes on the BB server, so the argocd CLI and
  // its session are the server machine's, not the invoking machine's.
  // ------------------------------------------------------------------
  bb.cli.register({
    name: "argocd",
    summary:
      "Browse Argo CD applications, resources, pod logs, and deploy history (read-only)",
    commands: [
      {
        name: "status",
        summary: "Show the configured transport and cache state",
        usage: "bb argocd status",
      },
      {
        name: "apps",
        summary: "List cached applications",
        usage:
          "bb argocd apps [--project P] [--sync S] [--health H] [--search Q]",
      },
      {
        name: "app",
        summary: "Show one application with its resources and conditions",
        usage: "bb argocd app <name>",
      },
      {
        name: "resources",
        summary: "List the resources an application manages",
        usage: "bb argocd resources <name>",
      },
      {
        name: "history",
        summary: "List an application's deployment history",
        usage: "bb argocd history <name>",
      },
      {
        name: "logs",
        summary: "Read recent application pod logs",
        usage:
          "bb argocd logs <name> [--pod POD] [--namespace NS] [--container C] [--tail N] [--since-seconds N] [--previous]",
      },
      {
        name: "refresh",
        summary: "Refresh BB's cache from Argo CD (does not sync the cluster)",
        usage: "bb argocd refresh",
      },
    ],
    async run(argv, ctx) {
      const [sub, ...rest] = argv;
      try {
        const validationError = validateArgocdCliArgs(argv);
        if (validationError !== null) {
          return { exitCode: 1, stderr: `${validationError}\n${USAGE}` };
        }
        if (sub === undefined || sub === "help" || sub === "--help") {
          return { exitCode: 0, stdout: USAGE };
        }
        if (sub === "status") {
          const cursor = await readCursor();
          const access = await checkAccess();
          return {
            exitCode: 0,
            stdout: [
              `transport: ${access.mode}`,
              `account: ${access.username.length > 0 ? access.username : "(unknown)"}`,
              `cached applications: ${cursor.applications}`,
              `last refreshed: ${cursor.lastSyncedAt ?? "never"}`,
              `last error: ${lastError ?? "none"}`,
            ].join("\n"),
          };
        }
        if (sub === "apps") {
          const applications = listCachedApplications(parseAppsFlags(rest));
          if (applications.length === 0) {
            return {
              exitCode: 0,
              stdout: "No applications matched. Run `bb argocd refresh` first.",
            };
          }
          return { exitCode: 0, stdout: formatApplicationRows(applications) };
        }
        if (sub === "logs") {
          const parsed = parsePodLogArgs(rest);
          if (!parsed.ok) {
            return { exitCode: 1, stderr: `${parsed.error}\n${USAGE}` };
          }
          return {
            exitCode: 0,
            stdout: formatPodLogs(await fetchPodLogs(parsed.value, ctx.signal)),
          };
        }
        const name = rest[0];
        if (sub === "app" && name !== undefined) {
          return {
            exitCode: 0,
            stdout: describeApplication(await getDetail(name)),
          };
        }
        if (sub === "resources" && name !== undefined) {
          const { resources } = await getDetail(name);
          if (resources.length === 0) {
            return { exitCode: 0, stdout: `${name} manages no resources.` };
          }
          return {
            exitCode: 0,
            stdout: resources
              .map(
                (resource) =>
                  `${resource.kind}/${resource.name}\t${resource.namespace}\t${resource.syncStatus}\t${resource.healthStatus}`,
              )
              .join("\n"),
          };
        }
        if (sub === "history" && name !== undefined) {
          const { history } = await getDetail(name);
          if (history.length === 0) {
            return {
              exitCode: 0,
              stdout: `${name} has no deployment history.`,
            };
          }
          return {
            exitCode: 0,
            stdout: history
              .map(
                (entry) =>
                  `${entry.id}\t${entry.revision}\t${entry.deployedAt}`,
              )
              .join("\n"),
          };
        }
        if (sub === "refresh") {
          const applications = await refreshCache();
          return {
            exitCode: 0,
            stdout: `Cached ${applications} application(s) from Argo CD.`,
          };
        }
        return {
          exitCode: 1,
          stderr: `Unknown subcommand "${sub}".\n${USAGE}`,
        };
      } catch (error) {
        return {
          exitCode: 1,
          stderr: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });

  // Settings edits do not reload a healthy plugin, so drop transport state
  // that a new URL, token, or mode would invalidate.
  settings.onChange(() => {
    argocdPath = null;
    detailCache.clear();
  });

  bb.onDispose(() => {
    detailCache.clear();
  });
}
