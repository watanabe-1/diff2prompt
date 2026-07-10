import { readFileSync } from "fs";
import { join } from "path";
import { describe, it, expect, vi } from "vitest";

import {
  parseArgs,
  looksBinary,
  defaultOptions,
  Options,
  renderTemplate,
  readTextFileIfExists,
} from "../src/generate-prompt-from-git-diff";
import { mergeOptions, resolveDefaultOutputPath } from "./config";

vi.mock("fs/promises", () => {
  return {
    readFile: vi.fn<(path: string, enc?: string) => Promise<string | Buffer>>(
      async (path: string, enc?: string) => {
        if (path === "ok.txt")
          return enc === "utf8" ? "HELLO TEMPLATE" : Buffer.from("HELLO TEMPLATE", "utf8");
        if (path === "ex.txt")
          return enc === "utf8"
            ? ["dist", "*.lock"].join("\n")
            : Buffer.from("dist\n*.lock\n", "utf8");
        throw new Error("fail");
      },
    ),
  };
});

describe("parseArgs", () => {
  it("keeps PR template embedding enabled by default", () => {
    expect(defaultOptions.includePrTemplate).toBe(true);
    expect(parseArgs(["node", "script"])).not.toHaveProperty("includePrTemplate");
  });

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

  it("rejects invalid numeric flags", () => {
    expect(() => parseArgs(["node", "script", "--lines=abc"])).toThrow(
      "Invalid value for --lines: expected a positive integer",
    );
    expect(() => parseArgs(["node", "script", "--max-new-size=-1"])).toThrow(
      "Invalid value for --max-new-size: expected a positive integer",
    );
    expect(() => parseArgs(["node", "script", "--max-buffer=0"])).toThrow(
      "Invalid value for --max-buffer: expected a positive integer",
    );
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

  it("parses multiple --exclude, --exclude-file, and --gitignore-file", () => {
    const p = parseArgs([
      "node",
      "script",
      "--exclude=dist",
      "--exclude=node_modules/",
      "--exclude=*.lock",
      "--exclude-file=ex.txt",
      "--gitignore-file=.gitignore",
    ]);
    expect(p.exclude).toEqual(["dist", "node_modules/", "*.lock"]);
    expect(p.excludeFile).toBe("ex.txt");
    expect(p.gitignoreFile).toBe(".gitignore");
  });

  it("parses --no-pr-template and --pr-template-file", () => {
    const p = parseArgs(["node", "script", "--no-pr-template", "--pr-template-file=.github/PR.md"]);
    expect(p.includePrTemplate).toBe(false);
    expect(p.prTemplateFile).toBe(".github/PR.md");
  });

  it("throws for unknown flags", () => {
    expect(() => parseArgs(["node", "script", "--include-pr-template"])).toThrow(
      "Unknown option: --include-pr-template",
    );
    expect(() => parseArgs(["node", "script", "--excludeFile=.gitignore"])).toThrow(
      "Unknown option: --excludeFile=.gitignore",
    );
  });

  it("package diff2prompt script uses the supported exclude-file flag", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const script = pkg.scripts?.diff2prompt ?? "";

    expect(script).toContain("--exclude-file=.gitignore");
    expect(script).not.toContain("--excludeFile=");

    const parsed = parseArgs(["node", "script", ...script.split(/\s+/).slice(3)]);
    expect(parsed.excludeFile).toBe(".gitignore");
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

  it("uses default filename when outputPath is whitespace only", () => {
    const mergedFromConfig = mergeOptions(
      defaultOptions,
      { outputPath: "   " },
      {},
      "C:/repo",
      "C:/cwd",
    );
    const mergedFromCli = mergeOptions(
      defaultOptions,
      { outputPath: "C:/repo/from-file.txt" },
      { outputPath: "   " },
      "C:/repo",
      "C:/cwd",
    );

    expect(mergedFromConfig.outputPath.replace(/\\/g, "/")).toBe("C:/repo/generated-prompt.txt");
    expect(mergedFromCli.outputPath.replace(/\\/g, "/")).toBe("C:/repo/generated-prompt.txt");
  });

  it("file config supplies outputFile; CLI overrides with --out", () => {
    const fileCfg: Partial<Options> = { outputPath: "C:/repo/from-file.txt" };
    const cli = parseArgs(["node", "script", "--out=C:/tmp/cli.txt"]);
    const merged = mergeOptions(defaultOptions, fileCfg, cli, "C:/repo", "C:/cwd");
    expect(merged.outputPath.replace(/\\/g, "/")).toBe("C:/tmp/cli.txt".replace(/\\/g, "/"));
  });

  it("CLI gitignoreFile overrides file config", () => {
    const cli = parseArgs(["node", "script", "--gitignore-file=cli.ignore"]);
    const merged = mergeOptions(
      defaultOptions,
      { gitignoreFile: "C:/repo/config.ignore" },
      cli,
      "C:/repo",
      "C:/cwd",
    );
    expect(merged.gitignoreFile).toBe("cli.ignore");
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
    // Temporarily set the mocked fs.readFile to return this test value
    const fsmod = await import("fs/promises");
    const readFileMock = fsmod.readFile as unknown as ReturnType<typeof vi.fn>;

    // In loadPrTemplateText, readFile('utf8') is expected to be called exactly once
    readFileMock.mockResolvedValueOnce("ABS TEMPLATE");

    const mod = await import("../src/generate-prompt-from-git-diff");
    const txt = await mod.loadPrTemplateText("C:/repo", {
      prTemplateFile: "C:/abs/pull_request_template.md", // Absolute path → branch where isAbsolutePathLike === true
    } as any);

    expect(txt).toBe("ABS TEMPLATE");
  });

  it("returns template text when prTemplateFile is a relative path (joined with repoRoot)", async () => {
    const fsmod = await import("fs/promises");
    const readFileMock = fsmod.readFile as unknown as ReturnType<typeof vi.fn>;

    readFileMock.mockResolvedValueOnce("REL TEMPLATE");

    const mod = await import("../src/generate-prompt-from-git-diff");
    const txt = await mod.loadPrTemplateText("C:/repo", {
      prTemplateFile: ".github/pull_request_template.md", // Relative path → branch that uses join(repoRoot, ...)
    } as any);

    expect(txt).toBe("REL TEMPLATE");
  });
});
