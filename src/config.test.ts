import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Hoisted mocks (user preference)
const mockFiles = vi.hoisted(() => {
  // virtual filesystem map
  return new Map<string, string>();
});

const mockRepoRoot = vi.hoisted(() => ({ value: "C:/repo" }));

const norm = (p: string) => p.replace(/\\/g, "/");

vi.mock("fs/promises", () => {
  return {
    readFile: vi.fn((p: string) => {
      const key = norm(String(p));
      const v = mockFiles.get(key);
      if (v === null) return Promise.reject(new Error("ENOENT"));
      if (v === undefined) return Promise.reject(new Error(`ENOENT: ${key}`));

      return Promise.resolve(v);
    }),
    writeFile: vi.fn(),
    stat: vi.fn(),
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const execState = ((globalThis as any).__execState__ ??= {
  stdout: "C:/repo\n",
  throws: false,
});

vi.mock("child_process", async () => {
  const { promisify } = await import("util");

  // Extend the existing execState (add the 'shape' discriminator)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const execState = ((globalThis as any).__execState__ ??= {
    stdout: "C:/repo\n",
    throws: false,
    shape: "string" as "string" | "array" | "object",
  });

  function rawExec(
    _cmd: string,
    cb?: (err: unknown, stdout: string, stderr: string) => void
  ) {
    if (execState.throws) {
      const err = new Error("fail");
      cb?.(err, "", "");
      throw err;
    }
    cb?.(null, execState.stdout, "");

    // Return value is a compatibility dummy
    return { stdout: execState.stdout, stderr: "" } as unknown;
  }

  // Key point: switch the return "shape" via promisify.custom
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (rawExec as any)[promisify.custom] = (_: string) => {
    if (execState.throws) {
      return Promise.reject(new Error("fail"));
    }
    switch (execState.shape) {
      case "array":
        return Promise.resolve([execState.stdout, ""]);
      case "object":
        return Promise.resolve({ stdout: execState.stdout, stderr: "" });
      default: // "string"
        return Promise.resolve(execState.stdout);
    }
  };

  return { exec: rawExec };
});

vi.mock("path", async (orig) => {
  // Use real path module; Windows-like paths are fine for tests
  return await orig();
});

import {
  loadUserConfig,
  normalizeUserConfig,
  resolveDefaultOutputPath,
  mergeOptions,
  isAbsolutePath,
  getRepoRootSafe,
} from "./config";
import type { Options } from "./generate-prompt-from-git-diff";

const defaults: Options = {
  maxConsoleLines: 10,
  outputPath: "",
  includeUntracked: true,
  maxNewFileSizeBytes: 1_000_000,
  maxBuffer: 50 * 1024 * 1024,
};

function putFile(path: string, json: unknown) {
  mockFiles.set(norm(path), JSON.stringify(json));
}

function rec(v: unknown): Record<string, unknown> {
  return v as Record<string, unknown>;
}

describe("config loader & merge", () => {
  beforeEach(() => {
    mockFiles.clear();
    delete process.env.DIFF2PROMPT_CONFIG;
    mockRepoRoot.value = "C:/repo";
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes outputPath relative to baseDir", () => {
    const cfg = normalizeUserConfig({ outputPath: "out/p.txt" }, "C:/repo");
    expect(cfg.outputPath?.replace(/\\/g, "/")).toBe(
      "C:/repo/out/p.txt".replace(/\\/g, "/")
    );
  });

  it("falls back to outputFile when outputPath is absent", () => {
    const cfg = normalizeUserConfig({ outputFile: "p.md" }, "C:/repo");
    expect(cfg.outputPath?.replace(/\\/g, "/")).toBe(
      "C:/repo/p.md".replace(/\\/g, "/")
    );
  });

  it("accepts absolute paths as-is", () => {
    const abs = "C:/tmp/p.txt";
    const cfg = normalizeUserConfig({ outputPath: abs }, "C:/repo");
    expect(cfg.outputPath?.replace(/\\/g, "/")).toBe(abs.replace(/\\/g, "/"));
    expect(isAbsolutePath(abs)).toBe(true);
  });

  it("loadUserConfig: env path has highest priority among files", async () => {
    // Lower-priority files present
    putFile("C:/repo/diff2prompt.config.json", { outputFile: "low.txt" });
    putFile("C:/repo/package.json", { diff2prompt: { outputFile: "pkg.txt" } });

    // Env points to a custom config
    process.env.DIFF2PROMPT_CONFIG = "C:/custom/cfg.json";
    putFile("C:/custom/cfg.json", { outputPath: "env.json.txt" });

    const cfg = await loadUserConfig("C:/repo");
    expect(cfg.outputPath?.endsWith("env.json.txt")).toBe(true);
  });

  it("loadUserConfig: falls through to diff2prompt.config.json, then .diff2promptrc, then package.json", async () => {
    // Only package.json exists at first
    putFile("C:/repo/package.json", { diff2prompt: { outputFile: "pkg.txt" } });
    let cfg = await loadUserConfig("C:/repo");
    expect(cfg.outputPath?.endsWith("pkg.txt")).toBe(true);

    // Add .diff2promptrc
    putFile("C:/repo/.diff2promptrc", { outputFile: "rc.txt" });
    cfg = await loadUserConfig("C:/repo");
    expect(cfg.outputPath?.endsWith("rc.txt")).toBe(true);

    // Add diff2prompt.config.json (highest among default files)
    putFile("C:/repo/diff2prompt.config.json", { outputFile: "conf.txt" });
    cfg = await loadUserConfig("C:/repo");
    expect(cfg.outputPath?.endsWith("conf.txt")).toBe(true);
  });

  it("mergeOptions: CLI overrides file config", () => {
    const fileCfg = normalizeUserConfig({ outputFile: "file.txt" }, "C:/repo");
    const cli: Partial<Options> = { outputPath: "C:/cli/over.txt" };
    const merged = mergeOptions(
      defaults,
      fileCfg,
      cli,
      "C:/repo",
      "C:/fallback"
    );
    expect(merged.outputPath.replace(/\\/g, "/")).toBe(
      "C:/cli/over.txt".replace(/\\/g, "/")
    );
  });

  it("resolveDefaultOutputPath: uses repoRoot when available, else fallback", () => {
    const p1 = resolveDefaultOutputPath("C:/repo", "C:/cwd");
    expect(p1.replace(/\\/g, "/")).toBe(
      "C:/repo/generated-prompt.txt".replace(/\\/g, "/")
    );
    const p2 = resolveDefaultOutputPath(null, "C:/cwd");
    expect(p2.replace(/\\/g, "/")).toBe(
      "C:/cwd/generated-prompt.txt".replace(/\\/g, "/")
    );
  });
});

describe("getRepoRootSafe – full branch coverage", () => {
  beforeEach(() => {
    execState.stdout = "C:/repo\n";
    execState.throws = false;
    execState.shape = "string";
  });

  it("handles string result", async () => {
    execState.shape = "string";
    execState.stdout = "C:/repo\n";
    const root = await getRepoRootSafe();
    expect(root).toBe("C:/repo");
  });

  it("handles array result [stdout, stderr]", async () => {
    execState.shape = "array";
    execState.stdout = "C:/repo-array\n";
    const root = await getRepoRootSafe();
    expect(root).toBe("C:/repo-array");
  });

  it("handles array non string result [stdout, stderr]", async () => {
    execState.shape = "array";
    execState.stdout = 1 as unknown as string;
    const root = await getRepoRootSafe();
    expect(root).toBeNull();
  });

  it("handles object result { stdout, stderr }", async () => {
    execState.shape = "object";
    execState.stdout = "C:/repo-obj\n";
    const root = await getRepoRootSafe();
    expect(root).toBe("C:/repo-obj");
  });

  it("handles object non string result { stdout, stderr }", async () => {
    execState.shape = "object";
    execState.stdout = 1 as unknown as string;
    const root = await getRepoRootSafe();
    expect(root).toBeNull();
  });

  it("returns null on empty stdout", async () => {
    execState.shape = "string"; // any shape is fine here
    execState.stdout = "\n";
    const root = await getRepoRootSafe();
    expect(root).toBeNull();
  });

  it("returns null when exec throws", async () => {
    execState.throws = true;
    const root = await getRepoRootSafe();
    expect(root).toBeNull();
  });
});

describe("normalizeUserConfig", () => {
  it("returns {} when not record", () => {
    expect(normalizeUserConfig(null, "C:/repo")).toEqual({});
    expect(normalizeUserConfig(123, "C:/repo")).toEqual({});
  });

  it("resolves relative outputPath", () => {
    const cfg = normalizeUserConfig(rec({ outputPath: "out.txt" }), "C:/repo");
    expect(cfg.outputPath?.replace(/\\/g, "/")).toBe("C:/repo/out.txt");
  });

  it("resolves absolute outputPath", () => {
    const cfg = normalizeUserConfig(
      rec({ outputPath: "C:/abs/out.txt" }),
      "C:/repo"
    );
    expect(cfg.outputPath?.replace(/\\/g, "/")).toBe("C:/abs/out.txt");
  });

  it("resolves relative outputFile", () => {
    const cfg = normalizeUserConfig(rec({ outputFile: "file.md" }), "C:/repo");
    expect(cfg.outputPath?.replace(/\\/g, "/")).toBe("C:/repo/file.md");
  });

  it("resolves absolute outputFile", () => {
    const cfg = normalizeUserConfig(
      rec({ outputFile: "C:/abs/file.md" }),
      "C:/repo"
    );
    expect(cfg.outputPath?.replace(/\\/g, "/")).toBe("C:/abs/file.md");
  });

  it("handles numbers, booleans, buffer size", () => {
    const cfg = normalizeUserConfig(
      rec({
        maxConsoleLines: 20,
        includeUntracked: false,
        maxNewFileSizeBytes: 123,
        maxBuffer: 456,
      }),
      "C:/repo"
    );
    expect(cfg.maxConsoleLines).toBe(20);
    expect(cfg.includeUntracked).toBe(false);
    expect(cfg.maxNewFileSizeBytes).toBe(123);
    expect(cfg.maxBuffer).toBe(456);
  });

  it("ignores wrong types", () => {
    const cfg = normalizeUserConfig(
      rec({
        maxConsoleLines: "oops",
        includeUntracked: "no",
        maxNewFileSizeBytes: "big",
        maxBuffer: "xx",
      }),
      "C:/repo"
    );
    expect(cfg).toEqual({});
  });

  it("normalizes exclude array and excludeFile (relative -> absolute)", () => {
    const cfg = normalizeUserConfig(
      rec({
        exclude: ["dist", "*.lock", "node_modules/"],
        excludeFile: ".d2p-excludes",
      }),
      "C:/repo"
    );
    expect(cfg.exclude).toEqual(["dist", "*.lock", "node_modules/"]);
    expect(cfg.excludeFile?.replace(/\\/g, "/")).toBe("C:/repo/.d2p-excludes");
  });

  it("accepts absolute excludeFile as-is", () => {
    const cfg = normalizeUserConfig(
      rec({
        excludeFile: "C:/abs/ex.txt",
      }),
      "C:/repo"
    );
    expect(cfg.excludeFile?.replace(/\\/g, "/")).toBe("C:/abs/ex.txt");
  });

  it("loadUserConfig picks exclude fields from files", async () => {
    putFile("C:/repo/diff2prompt.config.json", {
      exclude: ["dist", "*.snap"],
      excludeFile: ".git/ex.txt",
    });
    const cfg = await loadUserConfig("C:/repo");
    expect(cfg.exclude).toEqual(["dist", "*.snap"]);
    expect(cfg.excludeFile?.replace(/\\/g, "/")).toBe("C:/repo/.git/ex.txt");
  });

  it("env override also works for exclude fields", async () => {
    putFile("C:/repo/diff2prompt.config.json", {
      exclude: ["dist"],
    });
    process.env.DIFF2PROMPT_CONFIG = "C:/custom/cfg.json";
    putFile("C:/custom/cfg.json", {
      exclude: ["build"],
      excludeFile: "C:/abs/custom.txt",
    });
    const cfg = await loadUserConfig("C:/repo");
    expect(cfg.exclude).toEqual(["build"]);
    expect(cfg.excludeFile?.replace(/\\/g, "/")).toBe("C:/abs/custom.txt");
  });
});

describe("isAbsolutePath", () => {
  it("detects absolute Windows path", () => {
    expect(isAbsolutePath("C:/repo")).toBe(true);
    expect(isAbsolutePath("C:\\repo")).toBe(true);
  });
  it("detects UNC path", () => {
    expect(isAbsolutePath("\\\\server\\share")).toBe(true);
  });
  it("detects posix absolute path", () => {
    expect(isAbsolutePath("/usr/bin")).toBe(true);
  });
  it("detects relative path", () => {
    expect(isAbsolutePath("out/file.txt")).toBe(false);
  });
});

describe("normalizeUserConfig (template fields)", () => {
  it("keeps inline promptTemplate as-is", () => {
    const cfg = normalizeUserConfig(
      rec({ promptTemplate: "Hello {{diff}}" }),
      "C:/repo"
    );
    expect(cfg.promptTemplate).toBe("Hello {{diff}}");
  });

  it("resolves relative promptTemplateFile against baseDir", () => {
    const cfg = normalizeUserConfig(
      rec({ promptTemplateFile: ".github/tpl.md" }),
      "C:/repo"
    );
    expect(cfg.promptTemplateFile?.replace(/\\/g, "/")).toBe(
      "C:/repo/.github/tpl.md"
    );
  });

  it("accepts absolute promptTemplateFile as-is", () => {
    const abs = "C:/abs/tpl.md";
    const cfg = normalizeUserConfig(
      rec({ promptTemplateFile: abs }),
      "C:/repo"
    );
    expect(cfg.promptTemplateFile?.replace(/\\/g, "/")).toBe(
      abs.replace(/\\/g, "/")
    );
  });

  it("captures templatePreset string", () => {
    const cfg = normalizeUserConfig(
      rec({ templatePreset: "minimal" }),
      "C:/repo"
    );
    expect(cfg.templatePreset).toBe("minimal");
  });
});

describe("loadUserConfig (template fields precedence across sources)", () => {
  beforeEach(() => {
    mockFiles.clear();
    delete process.env.DIFF2PROMPT_CONFIG;
  });

  it("env config wins (has promptTemplateFile)", async () => {
    putFile("C:/repo/diff2prompt.config.json", { promptTemplate: "LOW" });
    putFile("C:/repo/package.json", {
      diff2prompt: { templatePreset: "minimal" },
    });

    process.env.DIFF2PROMPT_CONFIG = "C:/custom/cfg.json";
    putFile("C:/custom/cfg.json", { promptTemplateFile: "T.tpl.md" });

    const cfg = await loadUserConfig("C:/repo");
    expect(cfg.promptTemplateFile?.endsWith("T.tpl.md")).toBe(true);
    expect(cfg.promptTemplate).toBeUndefined();
    expect(cfg.templatePreset).toBeUndefined();
  });
});
