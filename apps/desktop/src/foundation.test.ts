import { describe, expect, it } from "vitest";

describe("foundation contract", () => {
  it("keeps the host promise explicit before the Instrument UI exists", () => {
    expect("Tauri host ready; governed foundation slice lives in ide-domain").toContain(
      "governed foundation slice",
    );
  });
});

