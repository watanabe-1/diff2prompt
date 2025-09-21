import { describe, it, expect, vi } from "vitest";
import { mergeOptions, resolveDefaultOutputPath } from "./config";
import {
  parseArgs,
  looksBinary,
  defaultOptions,
  Options,
  renderTemplate,
  readTextFileIfExists,
} from "../src/generate-prompt-from-git-diff";

vi.mock("fs/promises", () => {
  return {
    readFile: vi.fn(async (path: string, enc?: string) => {
      if (path === "ok.txt")
        return enc === "utf8"
          ? "HELLO TEMPLATE"
          : Buffer.from("HELLO TEMPLATE", "utf8");
      if (path === "ex.txt")
        return enc === "utf8"
          ? ["dist", "*.lock"].join("\n")
          : Buffer.from("dist\n*.lock\n", "utf8");
      throw new Error("fail");
    }),
  };
});

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

  it("parses --template, --template-file, --template-preset", () => {
    const p = parseArgs([
      "node",
      "script",
      "--template=INLINE {{diff}}",
      "--template-file=tpl.md",
      "--template-preset=minimal",
    ]);
    expect(p.promptTemplate).toBe("INLINE {{diff}}");
    expect(p.promptTemplateFile).toBe("tpl.md");
    expect(p.templatePreset).toBe("minimal");
  });

  it("parses multiple --exclude and --exclude-file", () => {
    const p = parseArgs([
      "node",
      "script",
      "--exclude=dist",
      "--exclude=node_modules/",
      "--exclude=*.lock",
      "--exclude-file=ex.txt",
    ]);
    expect(p.exclude).toEqual(["dist", "node_modules/", "*.lock"]);
    expect(p.excludeFile).toBe("ex.txt");
  });

  // --- NEW ---
  it("parses --no-pr-template and --pr-template-file", () => {
    const p = parseArgs([
      "node",
      "script",
      "--no-pr-template",
      "--pr-template-file=.github/PR.md",
    ]);
    expect(p.includePrTemplate).toBe(false);
    expect(p.prTemplateFile).toBe(".github/PR.md");
  });
});

describe("looksBinary", () => {
  it("detects binary when buffer includes NUL", () => {
    expect(looksBinary(Buffer.from([0x01, 0x00, 0x02]))).toBe(true);
    expect(looksBinary(Buffer.from("hello", "utf8"))).toBe(false);
  });
});

describe("merge behavior (defaults -> file -> cli)", () => {
  it("uses default filename when neither file nor CLI set outputPath", () => {
    const repoRoot = "C:/repo";
    const merged = mergeOptions(defaultOptions, {}, {}, repoRoot, "C:/cwd");
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

describe("readTextFileIfExists", () => {
  it("returns file contents when readFile succeeds", async () => {
    const txt = await readTextFileIfExists("ok.txt");
    expect(txt).toBe("HELLO TEMPLATE");
  });

  it("returns null when readFile throws", async () => {
    const txt = await readTextFileIfExists("missing.txt");
    expect(txt).toBeNull();
  });
});

describe("renderTemplate", () => {
  it("replaces existing keys and falls back to empty string for missing keys", () => {
    const tpl = "A={{a}}, B={{b}}, C={{c}}";
    const out = renderTemplate(tpl, { a: "X", c: "Z" });
    expect(out).toBe("A=X, B=, C=Z");
  });

  it("injects prTemplate when provided", () => {
    const tpl = "HEAD\n{{prTemplate}}\nTAIL";
    const out = renderTemplate(tpl, { prTemplate: "## PR\n- a\n- b" });
    expect(out).toContain("## PR");
    expect(out).toContain("- a");
    expect(out).toContain("- b");
  });
});

describe("loadPrTemplateText (absolute/relative path branches)", () => {
  it("returns template text when prTemplateFile is an absolute path", async () => {
    // モックされた fs の readFile を一時的にこのテスト用の戻り値にする
    const fsmod = await import("fs/promises");
    const readFileMock = fsmod.readFile as unknown as ReturnType<typeof vi.fn>;

    // loadPrTemplateText 内では 1回だけ readFile('utf8') が呼ばれる想定
    readFileMock.mockResolvedValueOnce("ABS TEMPLATE");

    const mod = await import("../src/generate-prompt-from-git-diff");
    const txt = await mod.loadPrTemplateText("C:/repo", {
      prTemplateFile: "C:/abs/pull_request_template.md", // 絶対パス → isAbsolutePathLike === true 分岐
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    expect(txt).toBe("ABS TEMPLATE");
  });

  it("returns template text when prTemplateFile is a relative path (joined with repoRoot)", async () => {
    const fsmod = await import("fs/promises");
    const readFileMock = fsmod.readFile as unknown as ReturnType<typeof vi.fn>;

    readFileMock.mockResolvedValueOnce("REL TEMPLATE");

    const mod = await import("../src/generate-prompt-from-git-diff");
    const txt = await mod.loadPrTemplateText("C:/repo", {
      prTemplateFile: ".github/pull_request_template.md", // 相対パス → join(repoRoot, ...) 分岐
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    expect(txt).toBe("REL TEMPLATE");
  });
});
