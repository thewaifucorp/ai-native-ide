import { describe, expect, it } from "vitest";
import { analyzeIntent, nextStepFor } from "./instrument";

describe("intent instrument", () => {
  it("surfaces the concurrency risk for the benchmark vocabulary", () => {
    expect(analyzeIntent("Quero um leilão de posições com lances").map((signal) => signal.id)).toContain(
      "concurrency",
    );
  });

  it("keeps an empty intent useful without inventing a project", () => {
    const signals = analyzeIntent("");
    expect(signals).toHaveLength(2);
    expect(nextStepFor("", signals)).toContain("Descreva");
  });
});
