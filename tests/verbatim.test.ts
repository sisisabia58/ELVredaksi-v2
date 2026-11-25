import { describe, expect, it } from "vitest";
import { VERBATIM_MAX_WORDS, longestSharedRun } from "../src/agents/verbatim";

describe("longestSharedRun", () => {
  it("counts the longest run of consecutive shared words", () => {
    expect(longestSharedRun("a b c d e f", "x b c d e y")).toBe(4);
  });
  it("ignores case and punctuation", () => {
    expect(longestSharedRun("Halo, Dunia! Ini tes.", "halo dunia ini TES")).toBe(4);
  });
  it("is zero for disjoint text and for empty input", () => {
    expect(longestSharedRun("a b c", "x y z")).toBe(0);
    expect(longestSharedRun("", "x y z")).toBe(0);
  });
  it("exposes the 10 word limit", () => {
    expect(VERBATIM_MAX_WORDS).toBe(10);
  });
});
