import * as util from "node:util";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChildProcess } from "child_process";

// === shared state for mocks (hoisted) ===
const gitMap = vi.hoisted(() => ({
  data: new Map<string, string>(),
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
vi.mock("child_process", () => {
  type ExecCb = (error: Error | null, stdout?: string, stderr?: string) => void;

  function coreExecBehavior(cmd: string): {
    cbError: Error | null;
    promiseReject: Error | string | null;
    stdout: string;
    stderr: string;
  } {
    const out = gitMap.data.get(cmd) ?? "";

    // 1) Normal success
    if (!out.startsWith("__ERR__:") && !out.startsWith("__REJECTSTR__:")) {
      return { cbError: null, promiseReject: null, stdout: out, stderr: "" };
    }

    // 2) Fail with Error
    if (out.startsWith("__ERR__:")) {
      const msg = out.slice("__ERR__:".length);

      return {
        cbError: new Error(msg),
        promiseReject: new Error(msg),
        stdout: "",
        stderr: "",
      };
    }

    // 3) Fail with string
    const msg = out.slice("__REJECTSTR__:".length);

    return {
      cbError: new Error(msg), // Callback variant passes an Error (for compatibility)
      promiseReject: msg, // promisify.custom rejects with a string
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
    gitMap.data.set("git rev-parse --show-toplevel", "/repo\n");
    gitMap.data.set("git diff && git diff --cached", diff);
    gitMap.data.set(
      "git ls-files --others --exclude-standard",
      ["a.txt", "b.bin", "huge.txt", "err.txt"].join("\n")
    );

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
    gitMap.data.set("git rev-parse --show-toplevel", "/repo\n");
    gitMap.data.set("git diff && git diff --cached", "diff --git a/y b/y\n");
    gitMap.data.set("git ls-files --others --exclude-standard", "a.txt\n");

    const { collectDiff, defaultOptions } = await importSut();
    const s = await collectDiff({ ...defaultOptions, includeUntracked: false });
    expect(s).toContain("diff --git a/y b/y");
    expect(s).not.toContain("New files (contents)");
  });

  it("collectDiff(): --max-new-size forces skip", async () => {
    gitMap.data.set("git diff && git diff --cached", "");
    gitMap.data.set("git ls-files --others --exclude-standard", "tiny.txt\n");
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
    gitMap.data.set(
      "git rev-parse --show-toplevel",
      "__ERR__:fatal: not a git repo"
    );
    const { main } = await importSut();
    await expect(main()).rejects.toThrow("process.exit(1)");
    const errOut = errSpy.mock.calls.flat().join("\n");
    expect(errOut).toMatch(/^Error: /);
  });

  it("main(): exits(1) when no diff and no new files", async () => {
    gitMap.data.set("git rev-parse --show-toplevel", "/repo\n");
    gitMap.data.set("git diff && git diff --cached", "");
    gitMap.data.set("git ls-files --others --exclude-standard", "");
    const { main } = await importSut();
    await expect(main()).rejects.toThrow("process.exit(1)");
    const errOut = errSpy.mock.calls.flat().join("\n");
    expect(errOut).toContain("No changes found: neither diffs nor new files.");
  });

  it("printPreview(): does not print truncation when lines <= maxLines", async () => {
    const { printPreview } = await importSut();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const prompt = ["line1", "line2"].join("\n");
      printPreview(prompt, /* maxLines*/ 5); // 2 <= 5 → non-truncation
      const logs = logSpy.mock.calls.flat().join("\n");
      expect(logs).toContain("--- Prompt for ChatGPT (preview) ---");
      expect(logs).toContain("line1");
      expect(logs).toContain("line2");
      expect(logs).not.toContain("... (truncated) ...");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("collectDiff(): captures non-Error thrown by readFile/stat (String(e) branch)", async () => {
    // Diff is empty, but an untracked file exists → 'full' becomes non-empty
    gitMap.data.set("git diff && git diff --cached", "");
    gitMap.data.set("git ls-files --others --exclude-standard", "weird.txt\n");

    // The fs mock throws f.err as-is, so store a string to cause a non-Error to be thrown
    fsState.files.set("weird.txt", {
      size: 123,
      err: "BOOM_STRING_ERROR" as unknown as Error,
    });

    const { collectDiff, defaultOptions } = await importSut();
    const s = await collectDiff({ ...defaultOptions, includeUntracked: true });
    // String(e) is used, resulting in <read error: BOOM_STRING_ERROR>
    expect(s).toContain("File: weird.txt");
    expect(s).toContain("<read error: BOOM_STRING_ERROR>");
  });

  it("main(): handles non-Error rejection from runGit (String(err) branch)", async () => {
    // git rev-parse rejects "with a string"
    gitMap.data.set(
      "git rev-parse --show-toplevel",
      "__REJECTSTR__:STRINGY_FAIL"
    );
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
    gitMap.data.set("git rev-parse --show-toplevel", "/repo\n");
    gitMap.data.set("git diff && git diff --cached", "DIFF\n");
    gitMap.data.set("git ls-files --others --exclude-standard", "");

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
    gitMap.data.set("git rev-parse --show-toplevel", "/ignored\n"); // hard check inside main
    gitMap.data.set("git diff && git diff --cached", "DIFF\n");
    gitMap.data.set("git ls-files --others --exclude-standard", "");

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
    // Git environment
    gitMap.data.set("git rev-parse --show-toplevel", "/repo\n");
    gitMap.data.set("git diff && git diff --cached", "DIFF-A\n");
    gitMap.data.set("git ls-files --others --exclude-standard", "");

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
    // Ensure it's not the baked-in default paragraph (rough negative check)
    expect(out.data).not.toContain("Please generate **all** of the following");
  });

  it("main(): template precedence CLI inline > file > preset > default", async () => {
    // Git env
    gitMap.data.set("git rev-parse --show-toplevel", "/repo\n");
    gitMap.data.set("git diff && git diff --cached", "XYZ\n");
    gitMap.data.set("git ls-files --others --exclude-standard", "");

    // Config provides file & preset, but CLI will override with inline
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
    // Not the default verbose template
    expect(out.data).not.toContain("Please generate **all** of the following");
  });

  it("main(): falls back to preset when no file/inline provided", async () => {
    gitMap.data.set("git rev-parse --show-toplevel", "/repo\n");
    gitMap.data.set("git diff && git diff --cached", "ABC\n");
    gitMap.data.set("git ls-files --others --exclude-standard", "");

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
    // minimal preset is intentionally short; check that diff is present and default marker absent
    expect(out.data).toContain("ABC");
    expect(out.data).not.toContain("Please generate **all** of the following");
  });
});
