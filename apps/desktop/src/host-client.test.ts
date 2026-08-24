import { describe, expect, it, vi } from "vitest";
import { createHostClient, type HostTransport } from "./host-client";

describe("host client", () => {
  it("reports an unavailable host in browser or Node without loading Tauri", async () => {
    const loadTransport = vi.fn<() => Promise<HostTransport>>();
    const client = createHostClient({
      isNativeHost: () => false,
      loadTransport,
    });

    await expect(client.status()).resolves.toEqual({
      state: "unavailable",
      reason:
        "O host Tauri não está disponível nesta sessão; nenhum efeito foi executado.",
    });
    await expect(client.emitProbe()).resolves.toMatchObject({
      state: "unavailable",
    });
    expect(loadTransport).not.toHaveBeenCalled();
  });

  it("recognizes the Tauri v2 IPC bridge when the optional global API is disabled", async () => {
    const runtime = globalThis as typeof globalThis & {
      isTauri?: unknown;
      __TAURI_INTERNALS__?: unknown;
    };
    const originalIsTauri = runtime.isTauri;
    const originalInternals = runtime.__TAURI_INTERNALS__;
    const invoke = vi.fn<HostTransport["invoke"]>().mockResolvedValue({
      host: "tauri",
    });
    runtime.isTauri = undefined;
    runtime.__TAURI_INTERNALS__ = { invoke: () => undefined };

    try {
      const client = createHostClient({
        loadTransport: async () => ({ invoke }),
      });
      await expect(client.status()).resolves.toMatchObject({
        state: "available",
        value: { host: "tauri" },
      });
      expect(invoke).toHaveBeenCalledWith("host_status", undefined);
    } finally {
      runtime.isTauri = originalIsTauri;
      runtime.__TAURI_INTERNALS__ = originalInternals;
    }
  });

  it("uses only the allowlisted command and DTO when the native host is available", async () => {
    const invoke = vi.fn<HostTransport["invoke"]>().mockResolvedValue({
      id: "auction",
      title: "Leilão",
      intent: "Criar um leilão de posições",
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    const client = createHostClient({
      isNativeHost: () => true,
      loadTransport: async () => ({ invoke }),
    });

    await expect(
      client.createSemanticProject({
        projectId: "auction",
        title: "Leilão",
        intent: "Criar um leilão de posições",
      }),
    ).resolves.toMatchObject({ state: "available", value: { id: "auction" } });
    expect(invoke).toHaveBeenCalledWith("create_semantic_project", {
      input: {
        projectId: "auction",
        title: "Leilão",
        intent: "Criar um leilão de posições",
      },
    });
  });

  it("does not hide a native command failure behind a local result", async () => {
    const client = createHostClient({
      isNativeHost: () => true,
      loadTransport: async () => ({
        invoke: async () => {
          throw new Error("host database unavailable");
        },
      }),
    });

    await expect(client.agentCapabilityCard("claude")).resolves.toEqual({
      state: "failed",
      message: "host database unavailable",
    });
  });

  it("requests a native picker without passing a filesystem path through the renderer", async () => {
    const invoke = vi.fn<HostTransport["invoke"]>().mockResolvedValue(null);
    const client = createHostClient({
      isNativeHost: () => true,
      loadTransport: async () => ({ invoke }),
    });

    await expect(
      client.attachWorkspaceFromPicker("auction", "auction-local"),
    ).resolves.toEqual({
      state: "available",
      value: null,
    });
    expect(invoke).toHaveBeenCalledWith("attach_workspace_from_picker", {
      projectId: "auction",
      resourceId: "auction-local",
    });
  });

  it("reads only a relative file through the selected resource boundary", async () => {
    const invoke = vi
      .fn<HostTransport["invoke"]>()
      .mockResolvedValue({ relativePath: "src/app.ts", content: "export {};" });
    const client = createHostClient({
      isNativeHost: () => true,
      loadTransport: async () => ({ invoke }),
    });

    await expect(
      client.readWorkspaceFile("auction", "auction-local", "src/app.ts"),
    ).resolves.toMatchObject({
      state: "available",
      value: { relativePath: "src/app.ts" },
    });
    expect(invoke).toHaveBeenCalledWith("read_workspace_file", {
      projectId: "auction",
      resourceId: "auction-local",
      relativePath: "src/app.ts",
    });
  });

  it("controls only an opaque host-owned terminal session", async () => {
    const invoke = vi.fn<HostTransport["invoke"]>().mockResolvedValue({
      terminalId: "terminal-1",
      state: "running",
      detail: "host-owned shell",
    });
    const client = createHostClient({
      isNativeHost: () => true,
      loadTransport: async () => ({ invoke }),
    });

    await expect(
      client.startWorkspaceTerminal("auction", "auction-local"),
    ).resolves.toMatchObject({ state: "available" });
    await client.writeWorkspaceTerminal("terminal-1", "status\n");
    await client.resizeWorkspaceTerminal("terminal-1", 30, 100);
    await client.pollWorkspaceTerminal("terminal-1");

    expect(invoke).toHaveBeenNthCalledWith(1, "start_workspace_terminal", {
      projectId: "auction",
      resourceId: "auction-local",
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "write_workspace_terminal", {
      terminalId: "terminal-1",
      input: "status\n",
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "resize_workspace_terminal", {
      terminalId: "terminal-1",
      rows: 30,
      columns: 100,
    });
    expect(invoke).toHaveBeenNthCalledWith(4, "poll_workspace_terminal", {
      terminalId: "terminal-1",
    });
  });

  it("reopens persisted project resources through the typed host boundary", async () => {
    const invoke = vi.fn<HostTransport["invoke"]>().mockResolvedValue(null);
    const client = createHostClient({
      isNativeHost: () => true,
      loadTransport: async () => ({ invoke }),
    });

    await expect(client.openSemanticProject("auction")).resolves.toEqual({
      state: "available",
      value: null,
    });
    expect(invoke).toHaveBeenCalledWith("open_semantic_project", {
      projectId: "auction",
    });
  });

  it("starts the benchmark through the fixed local-preview command", async () => {
    const invoke = vi.fn<HostTransport["invoke"]>().mockResolvedValue({
      projectId: "auction",
      url: "http://127.0.0.1:4317",
      state: "healthy",
    });
    const client = createHostClient({
      isNativeHost: () => true,
      loadTransport: async () => ({ invoke }),
    });

    await expect(
      client.startBenchmarkPreview("auction"),
    ).resolves.toMatchObject({
      state: "available",
      value: { url: "http://127.0.0.1:4317" },
    });
    expect(invoke).toHaveBeenCalledWith("start_benchmark_preview", {
      projectId: "auction",
    });
  });

  it("captures a stopped preview only through its governed effect scope", async () => {
    const invoke = vi.fn<HostTransport["invoke"]>().mockResolvedValue({
      failure: {
        id: "preview-health:auction:1",
        previewId: "auction",
        evidenceId: "evidence:preview-health:auction:1",
        message: "health check failed",
        causalLinks: {
          effectIds: ["benchmark-plan-v1"],
          activityIds: ["activity:revision-1"],
          filePaths: ["benchmark.intent.md"],
        },
        observedAtMs: 1,
      },
      divergence: {
        id: "intent:auction::observation:1",
        intentId: "intent:auction",
        observationId: "observation:1",
        subject: "preview:auction",
        evidenceIds: ["evidence:preview-health:auction:1"],
      },
    });
    const client = createHostClient({
      isNativeHost: () => true,
      loadTransport: async () => ({ invoke }),
    });

    await expect(
      client.stopAndCaptureBenchmarkPreviewFailure(
        "auction",
        "auction-local",
        "benchmark-plan-v1",
      ),
    ).resolves.toMatchObject({
      state: "available",
      value: { failure: { previewId: "auction" } },
    });
    expect(invoke).toHaveBeenCalledWith(
      "stop_and_capture_benchmark_preview_failure",
      {
        projectId: "auction",
        resourceId: "auction-local",
        effectId: "benchmark-plan-v1",
      },
    );
  });

  it("keeps workspace effects typed through proposal and approval", async () => {
    const invoke = vi
      .fn<HostTransport["invoke"]>()
      .mockResolvedValue({ awaitingApproval: true });
    const client = createHostClient({
      isNativeHost: () => true,
      loadTransport: async () => ({ invoke }),
    });
    const request = {
      resourceId: "auction-local",
      effectId: "benchmark-plan-v1",
      relativePath: "benchmark.intent.md",
      content: "# Benchmark",
    };

    await expect(
      client.proposeWorkspaceWrite("auction", request),
    ).resolves.toMatchObject({
      state: "available",
      value: { awaitingApproval: true },
    });
    expect(invoke).toHaveBeenCalledWith("propose_workspace_write", {
      projectId: "auction",
      request,
    });
  });

  it("submits a prompt only to an opaque IDE-owned agent session", async () => {
    const invoke = vi.fn<HostTransport["invoke"]>().mockResolvedValue(7);
    const client = createHostClient({
      isNativeHost: () => true,
      loadTransport: async () => ({ invoke }),
    });

    await expect(
      client.submitAgentTask("session-opaque", "Revise a intenção", false),
    ).resolves.toEqual({
      state: "available",
      value: 7,
    });
    expect(invoke).toHaveBeenCalledWith("submit_agent_task", {
      request: {
        sessionId: "session-opaque",
        prompt: "Revise a intenção",
        codeChange: false,
      },
    });
  });

  it("passes explicit workspace-write consent to the selected agent session only", async () => {
    const invoke = vi.fn<HostTransport["invoke"]>().mockResolvedValue({
      sessionId: "agent-1",
      readOnly: false,
      policyNote: "external approval model",
    });
    const client = createHostClient({
      isNativeHost: () => true,
      loadTransport: async () => ({ invoke }),
    });

    await expect(
      client.startAgentSession("claude", "project-1", "resource-1", true),
    ).resolves.toMatchObject({ state: "available", value: { readOnly: false } });
    expect(invoke).toHaveBeenCalledWith("start_agent_session", {
      target: "claude",
      projectId: "project-1",
      resourceId: "resource-1",
      allowWorkspaceWrites: true,
    });
  });

  it("reads streamed agent events only through an opaque IDE-owned session", async () => {
    const invoke = vi.fn<HostTransport["invoke"]>().mockResolvedValue({
      MessageDelta: {
        task_id: 7,
        text: "A intenção ainda precisa de um critério.",
      },
    });
    const client = createHostClient({
      isNativeHost: () => true,
      loadTransport: async () => ({ invoke }),
    });

    await expect(client.nextAgentEvent("session-opaque")).resolves.toEqual({
      state: "available",
      value: {
        MessageDelta: {
          task_id: 7,
          text: "A intenção ainda precisa de um critério.",
        },
      },
    });
    expect(invoke).toHaveBeenCalledWith("next_agent_event", {
      sessionId: "session-opaque",
    });
  });

  it("requests rollback by opaque project, resource and effect identifiers", async () => {
    const invoke = vi
      .fn<HostTransport["invoke"]>()
      .mockResolvedValue(undefined);
    const client = createHostClient({
      isNativeHost: () => true,
      loadTransport: async () => ({ invoke }),
    });

    await expect(
      client.rollbackWorkspaceWrite(
        "auction",
        "auction-local",
        "benchmark-plan-v1",
      ),
    ).resolves.toEqual({ state: "available", value: undefined });
    expect(invoke).toHaveBeenCalledWith("rollback_workspace_write", {
      projectId: "auction",
      resourceId: "auction-local",
      effectId: "benchmark-plan-v1",
    });
  });
});
