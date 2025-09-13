import { describe, it, expect } from "vitest";
import { mergeOptions, resolveDefaultOutputPath } from "./config";
import {
  parseArgs,
  looksBinary,
  generatePrompt,
  defaultOptions,
  Options,
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

describe("merge behavior (defaults -> file -> cli)", () => {
  it("uses default filename when neither file nor CLI set outputPath", () => {
    const repoRoot = "C:/repo";
    const merged = mergeOptions(defaultOptions, {}, {}, repoRoot, "C:/cwd");
    // defaultOptions.outputPath is "", so should be resolved
    expect(merged.outputPath.endsWith("generated-prompt.txt")).toBe(true);
  });

  it("file config supplies outputFile; CLI overrides with --out", () => {
    const fileCfg: Partial<Options> = { outputPath: "C:/repo/from-file.txt" };
    const cli = parseArgs(["node", "script", "--out=C:/tmp/cli.txt"]);
    const merged = mergeOptions(
      defaultOptions,
      fileCfg,
      cli,
      "C:/repo",
      "C:/cwd"
    );
    expect(merged.outputPath.replace(/\\/g, "/")).toBe(
      "C:/tmp/cli.txt".replace(/\\/g, "/")
    );
  });

  it("parseArgs parses other flags and keeps them intact", () => {
    const cli = parseArgs([
      "node",
      "script",
      "--lines=25",
      "--max-buffer=1048576",
      "--max-new-size=123",
      "--no-untracked",
    ]);
    expect(cli.maxConsoleLines).toBe(25);
    expect(cli.maxBuffer).toBe(1_048_576);
    expect(cli.maxNewFileSizeBytes).toBe(123);
    expect(cli.includeUntracked).toBe(false);
  });

  it("resolveDefaultOutputPath can use custom filename (internal helper)", () => {
    const p = resolveDefaultOutputPath("C:/repo", "C:/cwd", "my.txt");
    expect(p.replace(/\\/g, "/")).toBe("C:/repo/my.txt".replace(/\\/g, "/"));
  });
});
