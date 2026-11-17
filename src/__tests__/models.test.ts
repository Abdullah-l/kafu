import { describe, test, expect } from "bun:test";
import { FAST_MODEL, MODELS, choiceLabel, latestModel, modelLabel } from "../models";

describe("models", () => {
  test("the picker offers family aliases so runs always get the newest model", () => {
    expect(MODELS.map((m) => m.id)).toEqual(["fable", "opus", "sonnet", "haiku"]);
    expect(FAST_MODEL).toBe("haiku");
  });

  test("old pinned picker ids follow their family's latest model", () => {
    expect(latestModel("claude-fable-5-1")).toBe("fable");
    expect(latestModel("claude-opus-5-5")).toBe("opus");
    expect(latestModel("claude-haiku-4-5-20251001")).toBe("haiku");
    expect(latestModel("opus")).toBe("opus");
    expect(latestModel("")).toBe("");
    expect(latestModel("my-custom-model")).toBe("my-custom-model");
  });

  test("labels show the real version for full ids and latest for aliases", () => {
    expect(modelLabel("claude-fable-5-2")).toBe("Fable 5.2");
    expect(modelLabel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(modelLabel("claude-opus-6")).toBe("Opus 6");
    expect(modelLabel("fable")).toBe("Fable (latest)");
    expect(modelLabel("my-custom-model")).toBe("my-custom-model");
    expect(choiceLabel("claude-opus-5-5")).toBe("Opus (latest)");
  });
});
