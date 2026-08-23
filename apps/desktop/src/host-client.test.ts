import { describe, expect, it, vi } from "vitest";
import { createHostClient, type HostTransport } from "./host-client";

describe("host client", () => {
  it("reports an unavailable host in browser or Node without loading Tauri", async () => {
    const loadTransport = vi.fn<() => Promise<HostTransport>>();
    const client = createHostClient({ isNativeHost: () => false, loadTransport });

    await expect(client.status()).resolves.toEqual({
      state: "unavailable",
      reason: "O host Tauri não está disponível nesta sessão; nenhum efeito foi executado.",
    });
    await expect(client.emitProbe()).resolves.toMatchObject({ state: "unavailable" });
    expect(loadTransport).not.toHaveBeenCalled();
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

    await expect(client.attachWorkspaceFromPicker("auction", "auction-local")).resolves.toEqual({
      state: "available",
      value: null,
    });
    expect(invoke).toHaveBeenCalledWith("attach_workspace_from_picker", {
      projectId: "auction",
      resourceId: "auction-local",
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

    await expect(client.startBenchmarkPreview("auction")).resolves.toMatchObject({
      state: "available",
      value: { url: "http://127.0.0.1:4317" },
    });
    expect(invoke).toHaveBeenCalledWith("start_benchmark_preview", { projectId: "auction" });
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
      divergence: { id: "intent:auction::observation:1", intentId: "intent:auction", observationId: "observation:1", subject: "preview:auction", evidenceIds: ["evidence:preview-health:auction:1"] },
    });
    const client = createHostClient({
      isNativeHost: () => true,
      loadTransport: async () => ({ invoke }),
    });

    await expect(
      client.stopAndCaptureBenchmarkPreviewFailure("auction", "auction-local", "benchmark-plan-v1"),
    ).resolves.toMatchObject({ state: "available", value: { failure: { previewId: "auction" } } });
    expect(invoke).toHaveBeenCalledWith("stop_and_capture_benchmark_preview_failure", {
      projectId: "auction",
      resourceId: "auction-local",
      effectId: "benchmark-plan-v1",
    });
  });

  it("keeps workspace effects typed through proposal and approval", async () => {
    const invoke = vi.fn<HostTransport["invoke"]>().mockResolvedValue({ awaitingApproval: true });
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

    await expect(client.proposeWorkspaceWrite("auction", request)).resolves.toMatchObject({
      state: "available",
      value: { awaitingApproval: true },
    });
    expect(invoke).toHaveBeenCalledWith("propose_workspace_write", { projectId: "auction", request });
  });
});
