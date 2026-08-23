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
});
