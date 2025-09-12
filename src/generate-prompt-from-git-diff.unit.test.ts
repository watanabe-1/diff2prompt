import { describe, it, expect } from "vitest";
import {
  parseArgs,
  looksBinary,
  generatePrompt,
} from "../src/generate-prompt-from-git-diff";

describe("parseArgs", () => {
  it("parses flags correctly", () => {
    const argv = [
      "node",
      "script",
      "--lines=5",
      "--no-untracked",
      "--out=out.txt",
      "--max-new-size=1234",
      "--max-buffer=999",
    ];
    const p = parseArgs(argv);
    expect(p.maxConsoleLines).toBe(5);
    expect(p.includeUntracked).toBe(false);
    expect(p.outputPath).toBe("out.txt");
    expect(p.maxNewFileSizeBytes).toBe(1234);
    expect(p.maxBuffer).toBe(999);
  });

  it("returns empty when no flags", () => {
    const p = parseArgs(["node", "script"]);
    expect(p).toEqual({});
  });
});

describe("looksBinary", () => {
  it("detects binary when buffer includes NUL", () => {
    expect(looksBinary(Buffer.from([0x01, 0x00, 0x02]))).toBe(true);
    expect(looksBinary(Buffer.from("hello", "utf8"))).toBe(false);
  });
});

describe("generatePrompt", () => {
  it("includes given diff and output headings", () => {
    const s = generatePrompt("diff --git a/x b/x");
    expect(s).toContain("Here is the diff of the modifications:");
    expect(s).toContain("diff --git a/x b/x");
    expect(s).toContain("Commit message:");
    expect(s).toContain("PR title:");
    expect(s).toContain("Branch:");
  });
});
