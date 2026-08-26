import { describe, expect, expectTypeOf, it } from "vitest";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import type { PluginRpcClient, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  argocdRpcContract,
  isApplicationName,
  limitPodLogEntries,
  normalizeApplication,
  normalizeDetail,
  normalizeServerUrl,
  parseAppsFlags,
  parseNameList,
  parsePodLogArgs,
  parsePodLogStream,
  validateArgocdCliArgs,
} from "./server";

type ArgocdRpcHandlers = PluginRpcHandlers<typeof argocdRpcContract>;

function assertArgocdFrontendInference(
  client: PluginRpcClient<typeof argocdRpcContract>,
) {
  expectTypeOf(client.call("status")).toEqualTypeOf<
    Promise<{
      mode: "api" | "cli" | "unconfigured";
      serverUrl: string;
      username: string;
      ready: boolean;
      error: string | null;
      lastSyncedAt: string | null;
      applicationCount: number;
    }>
  >();

  // @ts-expect-error the filter is a fixed set of string fields.
  void client.call("listApplications", { cluster: "prod" });
  // @ts-expect-error getApplication addresses one application by name.
  void client.call("getApplication", { name: 42 });
}

describe("Argo CD server URL normalization", () => {
  it("defaults to https and strips trailing path noise", () => {
    expect(normalizeServerUrl("argocd.example.com")).toBe(
      "https://argocd.example.com",
    );
    expect(normalizeServerUrl("  https://argocd.example.com/  ")).toBe(
      "https://argocd.example.com",
    );
    expect(normalizeServerUrl("http://localhost:8080")).toBe(
      "http://localhost:8080",
    );
  });

  it("rejects blanks and non-http schemes", () => {
    expect(normalizeServerUrl("")).toBeNull();
    expect(normalizeServerUrl("   ")).toBeNull();
    // A scheme-prefixed value is parsed as-is rather than getting https:// glued on.
    expect(normalizeServerUrl("ftp://argocd.example.com")).toBeNull();
  });
});

describe("application name validation", () => {
  it("accepts bare and namespace-qualified Kubernetes names", () => {
    expect(isApplicationName("guestbook")).toBe(true);
    expect(isApplicationName("argocd/guestbook")).toBe(true);
    expect(isApplicationName("web-app.v2")).toBe(true);
  });

  it("rejects anything that could escape a URL path or argv slot", () => {
    // These reach `/api/v1/applications/<name>` and `argocd app get <name>`.
    expect(isApplicationName("../secrets")).toBe(false);
    expect(isApplicationName("app;rm -rf /")).toBe(false);
    expect(isApplicationName("ns/sub/app")).toBe(false);
    expect(isApplicationName("UPPER")).toBe(false);
    expect(isApplicationName("")).toBe(false);
    expect(isApplicationName("-leading-dash")).toBe(false);
  });
});

describe("bb argocd CLI argument validation", () => {
  it("requires a valid application name for the per-application subcommands", () => {
    expect(validateArgocdCliArgs(["app", "guestbook"])).toBeNull();
    expect(validateArgocdCliArgs(["resources", "argocd/guestbook"])).toBeNull();
    expect(validateArgocdCliArgs(["history", "guestbook"])).toBeNull();
    expect(validateArgocdCliArgs(["logs", "guestbook"])).toBeNull();
    expect(validateArgocdCliArgs(["app"])).toContain(
      "requires an application name",
    );
    expect(validateArgocdCliArgs(["app", "../etc"])).toContain(
      "Invalid application name",
    );
    expect(validateArgocdCliArgs(["app", "guestbook", "extra"])).toContain(
      "Unexpected argument",
    );
  });

  it("rejects arguments on the argument-free subcommands", () => {
    expect(validateArgocdCliArgs(["status"])).toBeNull();
    expect(validateArgocdCliArgs(["refresh"])).toBeNull();
    expect(validateArgocdCliArgs(["status", "--json"])).toContain(
      "does not accept arguments",
    );
  });

  it("only accepts known apps flags, each with a value", () => {
    expect(
      validateArgocdCliArgs([
        "apps",
        "--project",
        "prod",
        "--sync",
        "OutOfSync",
      ]),
    ).toBeNull();
    expect(validateArgocdCliArgs(["apps", "--cluster", "prod"])).toContain(
      'Unknown flag "--cluster"',
    );
    expect(validateArgocdCliArgs(["apps", "--project"])).toContain(
      "requires a value",
    );
    expect(validateArgocdCliArgs(["deploy", "guestbook"])).toContain(
      "Unknown subcommand",
    );
  });

  it("maps validated apps flags onto the filter fields", () => {
    expect(
      parseAppsFlags(["--project", "prod", "--health", "Degraded"]),
    ).toEqual({
      search: "",
      project: "prod",
      syncStatus: "",
      healthStatus: "Degraded",
    });
  });

  it("parses bounded pod log filters into an explicit request", () => {
    expect(
      parsePodLogArgs([
        "argocd/guestbook",
        "--pod",
        "web-7d9f",
        "--namespace",
        "prod",
        "--container",
        "web",
        "--tail",
        "500",
        "--since-seconds",
        "900",
        "--previous",
      ]),
    ).toEqual({
      ok: true,
      value: {
        name: "argocd/guestbook",
        namespace: "prod",
        podName: "web-7d9f",
        container: "web",
        tailLines: 500,
        sinceSeconds: 900,
        previous: true,
      },
    });
  });

  it("rejects unsafe or unbounded pod log filters", () => {
    expect(parsePodLogArgs(["guestbook", "--pod", "../pod"])).toMatchObject({
      ok: false,
      error: expect.stringContaining("Invalid Kubernetes name"),
    });
    expect(parsePodLogArgs(["guestbook", "--tail", "1001"])).toMatchObject({
      ok: false,
      error: expect.stringContaining("between 1 and 1000"),
    });
    expect(parsePodLogArgs(["guestbook", "--follow"])).toMatchObject({
      ok: false,
      error: expect.stringContaining("Unknown flag"),
    });
  });
});

describe("settings list parsing", () => {
  it("splits on commas and whitespace and drops duplicates", () => {
    expect(parseNameList(" prod, staging  prod,, dev ")).toEqual([
      "prod",
      "staging",
      "dev",
    ]);
    expect(parseNameList("")).toEqual([]);
  });
});

describe("Argo CD boundary normalization", () => {
  it("fills every field in when the Application carries almost nothing", () => {
    expect(normalizeApplication({ metadata: { name: "guestbook" } })).toEqual({
      name: "guestbook",
      namespace: "",
      project: "default",
      syncStatus: "Unknown",
      healthStatus: "Unknown",
      healthMessage: "",
      revision: "",
      repoUrl: "",
      path: "",
      targetRevision: "",
      destinationServer: "",
      destinationNamespace: "",
      operationPhase: "",
      operationMessage: "",
      operationFinishedAt: "",
      createdAt: "",
    });
  });

  it("reads a Helm application's chart as its path and falls back to sources[0]", () => {
    const application = normalizeApplication({
      metadata: { name: "redis" },
      spec: {
        sources: [
          {
            repoURL: "https://charts.example.com",
            chart: "redis",
            targetRevision: "18.1.2",
          },
        ],
        destination: { name: "in-cluster", namespace: "cache" },
      },
    });

    expect(application).toMatchObject({
      repoUrl: "https://charts.example.com",
      path: "redis",
      targetRevision: "18.1.2",
      // `destination.name` stands in when the manifest names the cluster
      // instead of addressing its API server.
      destinationServer: "in-cluster",
      destinationNamespace: "cache",
    });
  });

  it("defaults resource sync status but leaves an absent health blank", () => {
    const detail = normalizeDetail({
      metadata: { name: "guestbook" },
      status: {
        resources: [
          { kind: "Deployment", name: "web" },
          {
            kind: "Service",
            name: "web",
            status: "Synced",
            health: { status: "Healthy" },
          },
        ],
        history: [{ revision: "abc" }],
        conditions: [{ type: "ComparisonError" }],
      },
    });

    expect(detail.resources).toEqual([
      {
        group: "",
        kind: "Deployment",
        namespace: "",
        name: "web",
        syncStatus: "Unknown",
        // Blank, not "Unknown": Argo CD omits health for resources it does not
        // health-check, and the UI renders that as "—" rather than a chip.
        healthStatus: "",
        healthMessage: "",
      },
      {
        group: "",
        kind: "Service",
        namespace: "",
        name: "web",
        syncStatus: "Synced",
        healthStatus: "Healthy",
        healthMessage: "",
      },
    ]);
    expect(detail.history).toEqual([
      { id: 0, revision: "abc", deployedAt: "" },
    ]);
    expect(detail.conditions).toEqual([
      { type: "ComparisonError", message: "", lastTransitionTime: "" },
    ]);
  });
});

describe("Argo CD pod log boundary", () => {
  it("parses grpc-gateway stream frames and ignores the terminal marker", () => {
    const body = [
      JSON.stringify({
        result: {
          podName: "web-abc",
          timeStampStr: "2026-08-10T01:02:03Z",
          content: "ready",
          last: false,
        },
      }),
      JSON.stringify({
        result: { podName: "", content: "", last: true },
      }),
      "",
    ].join("\n");

    expect(parsePodLogStream(body)).toEqual([
      {
        podName: "web-abc",
        timestamp: "2026-08-10T01:02:03Z",
        content: "ready",
      },
    ]);
  });

  it("surfaces errors carried inside a stream frame", () => {
    expect(() =>
      parsePodLogStream(
        JSON.stringify({ error: { message: "logs, get denied" } }),
      ),
    ).toThrow("logs, get denied");
  });

  it("keeps the newest UTF-8 log content within the output budget", () => {
    const result = limitPodLogEntries(
      [
        { podName: "old", timestamp: "", content: "old line" },
        { podName: "new", timestamp: "", content: "가나다라마바사" },
      ],
      20,
    );

    expect(result.truncated).toBe(true);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.podName).toBe("new");
    expect(result.entries[0]?.content).not.toContain("�");
  });
});

describe("Argo CD RPC contract", () => {
  it("infers parsed handler inputs and frontend results", () => {
    expectTypeOf<
      Parameters<ArgocdRpcHandlers["listApplications"]>[0]
    >().toEqualTypeOf<{
      search: string;
      project: string;
      syncStatus: string;
      healthStatus: string;
    }>();
    expectTypeOf(assertArgocdFrontendInference).toBeFunction();
  });

  it("rejects invalid method inputs and outputs at runtime", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "argocd-contract",
    });
    const contract = defineRpcContract({
      spawnThread: argocdRpcContract.spawnThread,
    });
    bb.rpc.register(contract, {
      spawnThread() {
        return { threadId: 7 } as unknown as { threadId: string };
      },
    });

    await expect(
      harness.callRpc("spawnThread", { name: "" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      harness.callRpc("spawnThread", { name: "guestbook" }),
    ).rejects.toMatchObject({ code: "invalid_output" });
  });

  it("fills the filter defaults in at the boundary so handlers see every field", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "argocd-filter" });
    let received: unknown = null;
    const contract = defineRpcContract({
      listApplications: argocdRpcContract.listApplications,
    });
    bb.rpc.register(contract, {
      listApplications(filter) {
        received = filter;
        return {
          applications: [],
          projects: [],
          syncStatuses: [],
          healthStatuses: [],
          lastSyncedAt: null,
          error: null,
        };
      },
    });

    await harness.callRpc("listApplications", { project: "prod" });

    expect(received).toEqual({
      search: "",
      project: "prod",
      syncStatus: "",
      healthStatus: "",
    });
  });

  it("fills bounded pod log defaults at the RPC boundary", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "argocd-logs" });
    let received: unknown = null;
    const contract = defineRpcContract({
      getPodLogs: argocdRpcContract.getPodLogs,
    });
    bb.rpc.register(contract, {
      getPodLogs(query) {
        received = query;
        const transport: "api" = "api";
        return { transport, entries: [], truncated: false };
      },
    });

    await harness.callRpc("getPodLogs", { name: "guestbook" });

    expect(received).toEqual({
      name: "guestbook",
      namespace: "",
      podName: "",
      container: "",
      tailLines: 200,
      sinceSeconds: 0,
      previous: false,
    });
    await expect(
      harness.callRpc("getPodLogs", { name: "guestbook", tailLines: 1_001 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
