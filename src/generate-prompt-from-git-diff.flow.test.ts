import * as util from "node:util";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChildProcess } from "child_process";

// === shared state for mocks (hoisted) ===
const gitMap = vi.hoisted(() => ({
  data: new Map<string, string>(),
  setRoot(v: string) {
    this.data.set("ROOT", v);
  },
  setUnstaged(v: string) {
    this.data.set("UNSTAGED", v);
  },
  setStaged(v: string) {
    this.data.set("STAGED", v);
  },
  setUntracked(v: string) {
    this.data.set("UNTRACKED", v);
  },
  reset() {
    this.data.clear();
  },
}));

const fsState = vi.hoisted(() => ({
  files: new Map<string, { size: number; buf?: Buffer; err?: Error }>(),
  writes: [] as Array<{ path: string; data: string; enc?: string }>,
  reset() {
    this.files.clear();
    this.writes.length = 0;
  },
}));

// ---- child_process mock ----
// New logic: git commands are dynamic (with pathspec), so dispatch by prefix match.
vi.mock("child_process", () => {
  type ExecCb = (error: Error | null, stdout?: string, stderr?: string) => void;

  function resolveKey(
    cmd: string
  ): "ROOT" | "UNSTAGED" | "STAGED" | "UNTRACKED" | string {
    if (cmd.startsWith("git rev-parse --show-toplevel")) return "ROOT";
    if (cmd.startsWith("git diff --cached -- ")) return "STAGED";
    if (cmd.startsWith("git diff -- ")) return "UNSTAGED";
    if (cmd.startsWith("git ls-files --others --exclude-standard -- "))
      return "UNTRACKED";

    return cmd; // fallback (not expected)
  }

  // --- pathspec helpers ----
  const norm = (p: string) => p.replace(/\\/g, "/");

  // very small glob -> RegExp: ** -> .*, * -> [^/]*, ? -> .
  function globToRegExp(glob: string): RegExp {
    let g = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&"); // escape regex specials
    g = g.replace(/\*\*/g, "§§DOUBLESTAR§§"); // temporal
    g = g.replace(/\*/g, "[^/]*");
    g = g.replace(/§§DOUBLESTAR§§/g, ".*");
    g = g.replace(/\?/g, ".");

    return new RegExp("^" + g + "$");
  }

  function parseExcludesFromCmd(cmd: string): string[] {
    const idx = cmd.indexOf(" -- ");
    if (idx < 0) return [];

    // keep quoted segments intact: "build dir/" -> one token
    const tail = cmd.slice(idx + 4).trim();

    const tokens: string[] = [];
    let cur = "";
    let inQ = false;

    for (let i = 0; i < tail.length; i++) {
      const ch = tail[i];

      if (ch === '"') {
        inQ = !inQ; // toggle quote state
        continue; // drop the quote char itself
      }

      if (!inQ && /\s/.test(ch)) {
        if (cur.length) {
          tokens.push(cur);
          cur = "";
        }
        continue;
      }
      cur += ch;
    }
    if (cur.length) tokens.push(cur);

    // tokens like ".", ":(exclude)dist", ":(exclude)build dir/", ...
    return tokens
      .filter((t) => t.startsWith(":(exclude)"))
      .map((t) => t.slice(":(exclude)".length));
  }

  function filterListByExcludes(list: string, excludes: string[]): string {
    if (!list || excludes.length === 0) return list;
    const pats = excludes.map((p) => norm(p));
    const regexes = pats.map((p) => {
      // Heuristic: if it ends with '/', do a prefix match; if it contains * or ?, use a glob; otherwise treat as a simple prefix.
      if (p.endsWith("/")) {
        return { type: "prefix" as const, p };
      }
      if (/[*?]/.test(p) || p.includes("**")) {
        return { type: "glob" as const, re: globToRegExp(p) };
      }

      return { type: "prefix" as const, p }; // simple prefix (like "dist" or "logs")
    });

    const out = list
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((path) => {
        const np = norm(path);
        for (const r of regexes) {
          if (r.type === "prefix") {
            if (np.startsWith(r.p)) return false;
            // Also allow directory-boundary match: "dist" should drop "dist/a.js"
            if (np === r.p.replace(/\/$/, "")) return false;
            if (np.startsWith(r.p.replace(/\/$/, "") + "/")) return false;
          } else {
            if (r.re.test(np)) return false;
          }
        }

        return true;
      })
      .join("\n");

    return out;
  }

  function coreExecBehavior(cmd: string): {
    cbError: Error | null;
    promiseReject: Error | string | null;
    stdout: string;
    stderr: string;
  } {
    const key = resolveKey(cmd);
    let out = gitMap.data.get(key) ?? "";

    // 1) Apply pathspec excludes for UNTRACKED (and keep diff outputs as-is)
    if (key === "UNTRACKED") {
      const excludes = parseExcludesFromCmd(cmd);
      out = filterListByExcludes(out, excludes);
    }

    // 2) Normal success
    if (!out.startsWith("__ERR__:") && !out.startsWith("__REJECTSTR__:")) {
      return { cbError: null, promiseReject: null, stdout: out, stderr: "" };
    }

    // 3) Fail with Error
    if (out.startsWith("__ERR__:")) {
      const msg = out.slice("__ERR__:".length);

      return {
        cbError: new Error(msg),
        promiseReject: new Error(msg),
        stdout: "",
        stderr: "",
      };
    }

    // 4) Fail with string
    const msg = out.slice("__REJECTSTR__:".length);

    return {
      cbError: new Error(msg),
      promiseReject: msg,
      stdout: "",
      stderr: "",
    };
  }

  // Callback-style exec
  function exec(
    cmd: string,
    optionsOrCb?: { maxBuffer?: number } | ExecCb,
    maybeCb?: ExecCb
  ): ChildProcess {
    const cb: ExecCb | undefined =
      typeof optionsOrCb === "function" ? optionsOrCb : maybeCb;

    const { cbError, stdout, stderr } = coreExecBehavior(cmd);
    cb?.(cbError, stdout, stderr);

    return {} as ChildProcess;
  }

  // promisify.custom variant of exec
  const custom = (cmd: string, _opts?: { maxBuffer?: number }) =>
    new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const { promiseReject, stdout, stderr } = coreExecBehavior(cmd);
      if (promiseReject !== null) reject(promiseReject);
      else resolve({ stdout, stderr });
    });

  exec[util.promisify.custom] = custom;

  return { exec };
});

// ---- fs/promises mock ----
vi.mock("fs/promises", () => {
  const writeFile = vi.fn(async (path: string, data: string, enc?: string) => {
    fsState.writes.push({ path, data, enc });
  });

  // NOTE: support both Buffer-return (no encoding) and string-return ("utf8")
  const readFile = vi.fn(
    async (path: string, enc?: string): Promise<unknown> => {
      const f = fsState.files.get(path);
      if (!f) throw new Error(`ENOENT: ${path}`);
      if (f.err) throw f.err;
      if (!f.buf) throw new Error("No buffer");

      return enc === "utf8" ? f.buf.toString("utf8") : f.buf;
    }
  );

  const stat = vi.fn(async (path: string): Promise<{ size: number }> => {
    const f = fsState.files.get(path);
    if (!f) throw new Error(`ENOENT: ${path}`);
    if (f.err) throw f.err;

    return { size: f.size };
  });

  return { writeFile, readFile, stat };
});

// SUT import AFTER mocks
const importSut = async () => await import("./generate-prompt-from-git-diff");

// ---- helpers ----
function mockExit() {
  const original = process.exit;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as (code?: number) => never;

  return {
    restore: () => {
      process.exit = original;
    },
  };
}

describe("generate.ts flow", () => {
  const origArgv = process.argv.slice();
  const origEnv = { ...process.env };
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitCtl: { restore: () => void };

  beforeEach(() => {
    gitMap.reset();
    fsState.reset();
    process.argv = ["node", "script"];
    process.env = { ...origEnv };
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitCtl = mockExit();
  });

  afterEach(() => {
    vi.resetModules();
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitCtl.restore();
    process.argv = origArgv.slice();
    process.env = { ...origEnv };
  });

  it("main(): diff + untracked (text/binary/huge/error), truncated preview, writes file", async () => {
    const diff = "diff --git a/x b/x\n@@\n-1\n+2\n";
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged(diff);
    gitMap.setStaged(""); // only unstaged changes
    gitMap.setUntracked(["a.txt", "b.bin", "huge.txt", "err.txt"].join("\n"));

    fsState.files.set("a.txt", { size: 5, buf: Buffer.from("hello") });
    fsState.files.set("b.bin", { size: 5, buf: Buffer.from([0x00, 0x10]) }); // binary
    fsState.files.set("huge.txt", { size: 1_000_001, buf: Buffer.from("x") });
    fsState.files.set("err.txt", {
      size: 10,
      err: new Error("Permission denied"),
    });

    process.argv.push("--lines=3", "--out=OUT.txt");
    const { main } = await importSut();
    await main();

    const out = fsState.writes.at(-1)!;
    expect(out.path.endsWith("OUT.txt")).toBe(true);
    expect(out.data).toContain(diff);
    expect(out.data).toContain("--- New files (contents) ---");
    expect(out.data).toMatch(/File: a\.txt[\s\S]*hello/);
    expect(out.data).toMatch(/File: b\.bin[\s\S]*binary content skipped/);
    expect(out.data).toMatch(/File: huge\.txt[\s\S]*skipped: too large/);
    expect(out.data).toMatch(
      /File: err\.txt[\s\S]*<read error: Permission denied>/
    );

    const logs = logSpy.mock.calls.flat().join("\n");
    expect(logs).toContain("--- Prompt for ChatGPT (preview) ---");
    expect(logs).toContain("... (truncated) ...");
    expect(logs).toContain("Prompt written to: OUT.txt");
  });

  it("collectDiff(): respects --no-untracked", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("diff --git a/y b/y\n");
    gitMap.setStaged("");
    gitMap.setUntracked("a.txt\n");

    const { collectDiff, defaultOptions } = await importSut();
    const s = await collectDiff({ ...defaultOptions, includeUntracked: false });
    expect(s).toContain("diff --git a/y b/y");
    expect(s).not.toContain("New files (contents)");
  });

  it("collectDiff(): --max-new-size forces skip", async () => {
    gitMap.setUnstaged("");
    gitMap.setStaged("");
    gitMap.setUntracked("tiny.txt\n");
    fsState.files.set("tiny.txt", { size: 10, buf: Buffer.from("0123456789") });

    const { collectDiff, defaultOptions } = await importSut();
    const s = await collectDiff({
      ...defaultOptions,
      maxNewFileSizeBytes: 5,
      includeUntracked: true,
    });
    expect(s).toMatch(/File: tiny\.txt/);
    expect(s).toMatch(/skipped: too large \(10 bytes\)/);
  });

  it("main(): prints error and exits(1) when git root check fails", async () => {
    gitMap.setRoot("__ERR__:fatal: not a git repo");
    const { main } = await importSut();
    await expect(main()).rejects.toThrow("process.exit(1)");
    const errOut = errSpy.mock.calls.flat().join("\n");
    expect(errOut).toMatch(/^Error: /);
  });

  it("main(): exits(1) when no diff and no new files", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("");
    gitMap.setStaged("");
    gitMap.setUntracked("");
    const { main } = await importSut();
    await expect(main()).rejects.toThrow("process.exit(1)");
    const errOut = errSpy.mock.calls.flat().join("\n");
    expect(errOut).toContain("No changes found: neither diffs nor new files.");
  });

  it("printPreview(): does not print truncation when lines <= maxLines", async () => {
    const { printPreview } = await importSut();
    const logSpy2 = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const prompt = ["line1", "line2"].join("\n");
      printPreview(prompt, /* maxLines*/ 5); // 2 <= 5 → non-truncation
      const logs = logSpy2.mock.calls.flat().join("\n");
      expect(logs).toContain("--- Prompt for ChatGPT (preview) ---");
      expect(logs).toContain("line1");
      expect(logs).toContain("line2");
      expect(logs).not.toContain("... (truncated) ...");
    } finally {
      logSpy2.mockRestore();
    }
  });

  it("collectDiff(): captures non-Error thrown by readFile/stat (String(e) branch)", async () => {
    // Diff is empty, but an untracked file exists → 'full' becomes non-empty
    gitMap.setUnstaged("");
    gitMap.setStaged("");
    gitMap.setUntracked("weird.txt\n");

    // The fs mock throws f.err as-is, so store a string to cause a non-Error to be thrown
    fsState.files.set("weird.txt", {
      size: 123,
      // @ts-expect-error force non-Error
      err: "BOOM_STRING_ERROR",
    });

    const { collectDiff, defaultOptions } = await importSut();
    const s = await collectDiff({ ...defaultOptions, includeUntracked: true });
    // String(e) is used, resulting in <read error: BOOM_STRING_ERROR>
    expect(s).toContain("File: weird.txt");
    expect(s).toContain("<read error: BOOM_STRING_ERROR>");
  });

  it("main(): handles non-Error rejection from runGit (String(err) branch)", async () => {
    // git rev-parse rejects "with a string"
    gitMap.setRoot("__REJECTSTR__:STRINGY_FAIL");
    const { main } = await importSut();
    await expect(main()).rejects.toThrow("process.exit(1)");
    const errOut = errSpy.mock.calls.flat().join("\n");
    // In catch, String(err) → "STRINGY_FAIL" is printed
    expect(errOut).toContain("Error: STRINGY_FAIL");
  });

  it("main(): default output uses repoRoot when provided (LHS of ||)", async () => {
    vi.resetModules();

    // child_process git commands succeed
    gitMap.reset();
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("DIFF\n");
    gitMap.setStaged("");
    gitMap.setUntracked("");

    // Mock repoRoot (/repo)
    await vi.doMock("./config", () => ({
      getRepoRootSafe: vi.fn().mockResolvedValue("/repo"),
      loadUserConfig: vi.fn().mockResolvedValue({}),
    }));

    // Spy on path.join to assert arguments
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const joinSpy: any = vi.fn((a: string, b: string) => `${a}/${b}`);
    await vi.doMock("path", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const real = await vi.importActual<any>("path");

      return { ...real, join: (...args: string[]) => joinSpy(...args) };
    });

    // Load SUT then run main (no --out → goes through default output-path branch)
    const { main } = await importSut();
    process.argv = ["node", "script"]; // no --out
    await main();

    // repoRoot is used as the 1st arg to join
    expect(joinSpy).toHaveBeenCalledWith("/repo", "generated-prompt.txt");
    // The actual write path also originates from /repo
    const lastWrite = fsState.writes.at(-1)!;
    expect(lastWrite.path).toContain("/repo/");
    expect(lastWrite.path.endsWith("generated-prompt.txt")).toBe(true);
  });

  it("main(): default output falls back to __DIRNAME_SAFE when repoRoot is empty string (RHS of ||)", async () => {
    vi.resetModules();

    // git commands succeed
    gitMap.reset();
    gitMap.setRoot("/ignored\n"); // not used because config mock returns ""
    gitMap.setUnstaged("DIFF\n");
    gitMap.setStaged("");
    gitMap.setUntracked("");

    // Return an empty string for repoRoot → falsy → falls back to __DIRNAME_SAFE
    await vi.doMock("./config", () => ({
      getRepoRootSafe: vi.fn().mockResolvedValue(""),
      loadUserConfig: vi.fn().mockResolvedValue({}),
    }));

    // Spy join to inspect its first argument
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const joinSpy: any = vi.fn((a: string, b: string) => `${a}/${b}`);
    await vi.doMock("path", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const real = await vi.importActual<any>("path");

      return { ...real, join: (...args: string[]) => joinSpy(...args) };
    });

    const { main } = await importSut();
    process.argv = ["node", "script"]; // no --out
    await main();

    // The 1st arg to join is neither "" nor "/repo" → comes from __DIRNAME_SAFE
    const [firstArg, secondArg] = joinSpy.mock.calls.at(-1)!;
    expect(secondArg).toBe("generated-prompt.txt");
    expect(firstArg).not.toBe("");
    expect(firstArg).not.toBe("/repo");

    // The actual write path is generated from __DIRNAME_SAFE, not repoRoot
    const lastWrite = fsState.writes.at(-1)!;
    expect(lastWrite.path.endsWith("generated-prompt.txt")).toBe(true);
    expect(lastWrite.path.includes("/repo/")).toBe(false);
  });

  it("main(): uses promptTemplateFile and replaces {{diff}}, {{now}}, {{repoRoot}}", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("DIFF-A\n");
    gitMap.setStaged("");
    gitMap.setUntracked("");

    // Provide a template file in config
    await vi.doMock("./config", () => ({
      getRepoRootSafe: vi.fn().mockResolvedValue("/repo"),
      loadUserConfig: vi.fn().mockResolvedValue({
        promptTemplateFile: "/repo/.github/prompt.tpl.md",
      }),
    }));

    // Template file content (utf8 string will be returned by our mock)
    const tpl = [
      "# Custom Prompt",
      "Now: {{now}}",
      "Root: {{repoRoot}}",
      "",
      "=== DIFF ===",
      "{{diff}}",
      "=== END ===",
    ].join("\n");
    fsState.files.set("/repo/.github/prompt.tpl.md", {
      size: tpl.length,
      buf: Buffer.from(tpl, "utf8"),
    });

    const { main } = await importSut();
    process.argv = ["node", "script", "--lines=100", "--out=/repo/OUT.txt"];
    await main();

    const out = fsState.writes.at(-1)!;
    expect(out.path).toBe("/repo/OUT.txt");
    expect(out.data).toContain("# Custom Prompt");
    expect(out.data).toContain("Root: /repo");
    expect(out.data).toContain("=== DIFF ===");
    expect(out.data).toContain("DIFF-A");
    expect(out.data).toMatch(/\bNow:\s+\d{4}-\d{2}-\d{2}T/); // ISO-ish timestamp present
    expect(out.data).not.toContain("Please generate **all** of the following");
  });

  it("main(): template precedence CLI inline > file > preset > default", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("XYZ\n");
    gitMap.setStaged("");
    gitMap.setUntracked("");

    await vi.doMock("./config", () => ({
      getRepoRootSafe: vi.fn().mockResolvedValue("/repo"),
      loadUserConfig: vi.fn().mockResolvedValue({
        promptTemplateFile: "/repo/tpl.md",
        templatePreset: "minimal",
      }),
    }));

    // File exists but should be ignored due to CLI inline
    const fileTpl = "FILE-TPL {{diff}}";
    fsState.files.set("/repo/tpl.md", {
      size: fileTpl.length,
      buf: Buffer.from(fileTpl, "utf8"),
    });

    const { main } = await importSut();
    process.argv = [
      "node",
      "script",
      "--template=INLINE-TPL {{diff}} {{repoRoot}}",
      "--out=/repo/O.txt",
    ];
    await main();

    const out = fsState.writes.at(-1)!;
    expect(out.data).toContain("INLINE-TPL XYZ /repo");
    expect(out.data).not.toContain("FILE-TPL");
    expect(out.data).not.toContain("Please generate **all** of the following");
  });

  it("main(): falls back to preset when no file/inline provided", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("ABC\n");
    gitMap.setStaged("");
    gitMap.setUntracked("");

    await vi.doMock("./config", () => ({
      getRepoRootSafe: vi.fn().mockResolvedValue("/repo"),
      loadUserConfig: vi.fn().mockResolvedValue({
        templatePreset: "minimal",
      }),
    }));

    const { main } = await importSut();
    process.argv = ["node", "script", "--out=/repo/PRESET.txt"];
    await main();

    const out = fsState.writes.at(-1)!;
    expect(out.data).toContain("ABC");
    expect(out.data).not.toContain("Please generate **all** of the following");
  });

  // === NEW: exclude flags and exclude-file handling ===
  it("collectDiff(): --exclude filters untracked files (pathspec)", async () => {
    gitMap.setRoot("/repo\n");
    // No diffs, only untracked
    gitMap.setUnstaged("");
    gitMap.setStaged("");
    gitMap.setUntracked(
      ["dist/a.txt", "src/b.txt", "node_modules/x.js"].join("\n")
    );

    // Both files exist
    fsState.files.set("src/b.txt", { size: 3, buf: Buffer.from("hey") });

    const { collectDiff, defaultOptions } = await importSut();
    const s = await collectDiff({
      ...defaultOptions,
      includeUntracked: true,
      exclude: ["dist", "node_modules/"], // should hide dist/* and node_modules/*
    });

    expect(s).toContain("File: src/b.txt");
    expect(s).toContain("hey");
    expect(s).not.toContain("File: dist/a.txt");
    expect(s).not.toContain("File: node_modules/x.js");
  });

  it("main(): --exclude and --exclude-file together (integration)", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("DIFF\n");
    gitMap.setStaged("");
    gitMap.setUntracked(
      ["build/a.js", "logs/app.log", "src/ok.txt"].join("\n")
    );

    // exclude-file content
    fsState.files.set("/repo/.d2p-ex.txt", {
      size: 100,
      buf: Buffer.from(
        [
          "logs", // drop logs/*
          "*.tmp   # ignored in this sample (no match)",
          "   # comment line",
          "",
        ].join("\n"),
        "utf8"
      ),
    });

    fsState.files.set("src/ok.txt", { size: 2, buf: Buffer.from("ok") });

    const { main } = await importSut();
    process.argv = [
      "node",
      "script",
      "--out=/repo/OUT.txt",
      "--exclude=build",
      "--exclude-file=.d2p-ex.txt",
      "--lines=50",
    ];
    await main();

    const out = fsState.writes.at(-1)!;
    // Kept
    expect(out.data).toContain("File: src/ok.txt");
    expect(out.data).toContain("ok");
    // Dropped by --exclude=build
    expect(out.data).not.toContain("File: build/a.js");
    // Dropped by exclude-file ("logs")
    expect(out.data).not.toContain("File: logs/app.log");
  });

  it("collectDiff(): excludeFile (relative) missing -> readLinesIfExists returns [] and no filtering (patterns.size===0)", async () => {
    // repo & git
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("");
    gitMap.setStaged("");
    // only one untracked file; should be kept because excludeFile is missing
    gitMap.setUntracked("keep.txt\n");

    // NOTE: Do not add /repo/.missing.txt to fsState.files → readFile will throw.
    // readTextFileIfExists → null → readLinesIfExists(!txt) → []
    const { collectDiff, defaultOptions } = await importSut();
    const s = await collectDiff({
      ...defaultOptions,
      includeUntracked: true,
      // Non-existent relative path (resolved against repoRoot)
      excludeFile: ".missing.txt",
    });

    // It should remain unfiltered
    expect(s).toContain("File: keep.txt");
  });

  it("collectDiff(): excludeFile (absolute) is honored (logs/* filtered)", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("");
    gitMap.setStaged("");
    gitMap.setUntracked(["logs/a.log", "src/ok.txt"].join("\n"));

    // Absolute-path excludeFile. Its content is one pattern per line.
    fsState.files.set("/abs/excludes.txt", {
      size: 16,
      buf: Buffer.from("logs\n", "utf8"),
    });
    // keep file
    fsState.files.set("src/ok.txt", { size: 2, buf: Buffer.from("ok") });

    const { collectDiff, defaultOptions } = await importSut();
    const s = await collectDiff({
      ...defaultOptions,
      includeUntracked: true,
      excludeFile: "/abs/excludes.txt", // isAbsolutePathLike(true) branch
    });

    expect(s).toContain("File: src/ok.txt");
    expect(s).toContain("ok");
    // logs/* should be excluded
    expect(s).not.toContain("File: logs/a.log");
  });

  it("collectDiff(): --exclude supports patterns with spaces (shellQuote path)", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("");
    gitMap.setStaged("");
    gitMap.setUntracked(["build dir/a.js", "src/ok.txt"].join("\n"));

    // keep file
    fsState.files.set("src/ok.txt", { size: 2, buf: Buffer.from("ok") });

    const { collectDiff, defaultOptions } = await importSut();
    const s = await collectDiff({
      ...defaultOptions,
      includeUntracked: true,
      // Pattern contains spaces → ensures buildPathspec triggers shellQuote
      exclude: ["build dir/"],
    });

    expect(s).toContain("File: src/ok.txt");
    expect(s).toContain("ok");
    expect(s).not.toContain("File: build dir/a.js");
  });
});
