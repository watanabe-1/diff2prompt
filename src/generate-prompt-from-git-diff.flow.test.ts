import type { ChildProcess } from "child_process";
import * as util from "node:util";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
  files: new Map<string, { size: number; buf?: Buffer; err?: Error; symlink?: boolean }>(),
  writes: [] as Array<{ path: string; data: string; enc?: string }>,
  execCalls: [] as Array<{
    file: string;
    args: string[];
    opts?: { cwd?: string; maxBuffer?: number };
  }>,
  reset() {
    this.files.clear();
    this.writes.length = 0;
    this.execCalls.length = 0;
  },
}));

// ---- child_process mock ----
// New logic: git commands are dynamic (with pathspec), so dispatch by argv shape.
vi.mock("child_process", () => {
  type ExecCb = (error: Error | null, stdout?: string, stderr?: string) => void;

  function resolveKey(args: string[]): "ROOT" | "UNSTAGED" | "STAGED" | "UNTRACKED" | string {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return "ROOT";
    if (args[0] === "diff" && args[1] === "--cached" && args[2] === "--") return "STAGED";
    if (args[0] === "diff" && args[1] === "--") return "UNSTAGED";
    if (
      args[0] === "ls-files" &&
      args[1] === "-z" &&
      args[2] === "--others" &&
      args[3] === "--exclude-standard" &&
      args[4] === "--"
    ) {
      return "UNTRACKED";
    }

    return args.join(" "); // fallback (not expected)
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

  function parseExcludesFromArgs(args: string[]): string[] {
    const idx = args.indexOf("--");
    if (idx < 0) return [];

    return args
      .slice(idx + 1)
      .filter((t) => t.startsWith(":(exclude)"))
      .map((t) => t.slice(":(exclude)".length));
  }

  function filterListByExcludes(list: string, excludes: string[]): string {
    if (!list || excludes.length === 0) return list;
    const pats = excludes.map((p) => norm(p));
    const regexes = pats.map((p) => {
      if (p.endsWith("/")) return { type: "prefix" as const, p };
      if (/[*?]/.test(p) || p.includes("**")) return { type: "glob" as const, re: globToRegExp(p) };

      return { type: "prefix" as const, p };
    });

    const out = list
      .split("\0")
      .filter((path, idx, paths) => path !== "" || idx !== paths.length - 1)
      .filter((path) => {
        const np = norm(path);
        for (const r of regexes) {
          if (r.type === "prefix") {
            if (np.startsWith(r.p)) return false;
            if (np === r.p.replace(/\/$/, "")) return false;
            if (np.startsWith(r.p.replace(/\/$/, "") + "/")) return false;
          } else {
            if (r.re.test(np)) return false;
          }
        }

        return true;
      })
      .join("\0");

    return out.length > 0 ? `${out}\0` : "";
  }

  function coreExecBehavior(args: string[]): {
    cbError: Error | null;
    promiseReject: Error | string | null;
    stdout: string;
    stderr: string;
  } {
    const key = resolveKey(args);
    let out = gitMap.data.get(key) ?? "";

    if (key === "UNTRACKED") {
      const excludes = parseExcludesFromArgs(args);
      out = filterListByExcludes(out, excludes);
    }

    if (!out.startsWith("__ERR__:") && !out.startsWith("__REJECTSTR__:")) {
      return { cbError: null, promiseReject: null, stdout: out, stderr: "" };
    }

    if (out.startsWith("__ERR__:")) {
      const msg = out.slice("__ERR__:".length);

      return {
        cbError: new Error(msg),
        promiseReject: new Error(msg),
        stdout: "",
        stderr: "",
      };
    }

    const msg = out.slice("__REJECTSTR__:".length);

    return {
      cbError: new Error(msg),
      promiseReject: msg,
      stdout: "",
      stderr: "",
    };
  }

  function execFile(
    file: string,
    args: string[],
    optionsOrCb?: { cwd?: string; maxBuffer?: number } | ExecCb,
    maybeCb?: ExecCb,
  ): ChildProcess {
    const cb: ExecCb | undefined = typeof optionsOrCb === "function" ? optionsOrCb : maybeCb;
    if (typeof optionsOrCb !== "function") {
      fsState.execCalls.push({ file, args, opts: optionsOrCb });
    }

    const { cbError, stdout, stderr } = coreExecBehavior(args);
    cb?.(cbError, stdout, stderr);

    return {} as ChildProcess;
  }

  const custom = (file: string, args: string[], opts?: { cwd?: string; maxBuffer?: number }) =>
    new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      fsState.execCalls.push({ file, args, opts });
      const { promiseReject, stdout, stderr } = coreExecBehavior(args);
      if (promiseReject !== null) reject(promiseReject);
      else resolve({ stdout, stderr });
    });

  (execFile as any)[util.promisify.custom] = custom;

  return { execFile };
});

// ---- fs/promises mock ----
vi.mock("fs/promises", () => {
  const writeFile = vi.fn<(path: string, data: string, enc?: string) => Promise<void>>(
    async (path: string, data: string, enc?: string) => {
      fsState.writes.push({ path, data, enc });
    },
  );

  // NOTE: support both Buffer-return (no encoding) and string-return ("utf8")
  const readFile = vi.fn<(path: string, enc?: string) => Promise<unknown>>(
    async (path: string, enc?: string): Promise<unknown> => {
      const f = fsState.files.get(path) ?? fsState.files.get(path.replace(/\\/g, "/"));
      if (!f) throw new Error(`ENOENT: ${path}`);
      if (f.err) throw f.err;
      if (!f.buf) throw new Error("No buffer");

      return enc === "utf8" ? f.buf.toString("utf8") : f.buf;
    },
  );

  const lstat = vi.fn<(path: string) => Promise<{ size: number; isSymbolicLink: () => boolean }>>(
    async (path: string): Promise<{ size: number; isSymbolicLink: () => boolean }> => {
      const f = fsState.files.get(path) ?? fsState.files.get(path.replace(/\\/g, "/"));
      if (!f) throw new Error(`ENOENT: ${path}`);
      if (f.err) throw f.err;

      return { size: f.size, isSymbolicLink: () => f.symlink === true };
    },
  );

  return { writeFile, readFile, lstat };
});

// SUT import AFTER mocks
const importSut = async () => await import("./generate-prompt-from-git-diff");

// ---- helpers ----
function mockExit() {
  const original = process.exit;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as (code?: number) => never;

  return { restore: () => void (process.exit = original) };
}

async function mockConfig(overrides: Record<string, unknown>) {
  await vi.doMock("./config", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./config")>();

    return { ...actual, ...overrides };
  });
}

function nulList(...paths: string[]): string {
  return paths.length > 0 ? `${paths.join("\0")}\0` : "";
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

  it("parseArgs(): keeps '=' inside flag values", async () => {
    const { parseArgs } = await importSut();

    const parsed = parseArgs([
      "node",
      "script",
      "--lines=10",
      "--out=tmp/a=b.txt",
      "--max-new-size=123",
      "--max-buffer=456",
      "--template-file=.github/prompt=a.tpl.md",
      "--pr-template-file=.github/pr=a.tpl.md",
      "--template-preset=custom=a",
      "--exclude-file=.d2p=a.txt",
    ]);

    expect(parsed.maxConsoleLines).toBe(10);
    expect(parsed.outputPath).toBe("tmp/a=b.txt");
    expect(parsed.maxNewFileSizeBytes).toBe(123);
    expect(parsed.maxBuffer).toBe(456);
    expect(parsed.promptTemplateFile).toBe(".github/prompt=a.tpl.md");
    expect(parsed.prTemplateFile).toBe(".github/pr=a.tpl.md");
    expect(parsed.templatePreset).toBe("custom=a");
    expect(parsed.excludeFile).toBe(".d2p=a.txt");
  });

  it("main(): valid numeric flags are applied", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("");
    gitMap.setStaged("");
    gitMap.setUntracked(nulList("tiny.txt"));
    fsState.files.set("/repo/tiny.txt", { size: 10, buf: Buffer.from("0123456789") });

    const { main } = await importSut();
    process.argv = [
      "node",
      "script",
      "--lines=2",
      "--max-new-size=5",
      "--max-buffer=456",
      "--out=/repo/OUT.txt",
    ];
    await main();

    const out = fsState.writes.at(-1)!;
    expect(out.data).toMatch(/File: tiny\.txt/);
    expect(out.data).toMatch(/skipped: too large \(10 bytes\)/);
    const runGitCalls = fsState.execCalls.filter(({ opts }) => opts !== undefined);
    expect(runGitCalls.every(({ opts }) => opts?.maxBuffer === 456)).toBe(true);

    const logs = logSpy.mock.calls.flat().join("\n");
    expect(logs).toContain("... (truncated) ...");
  });

  it.each([
    ["--lines=abc", "Invalid value for --lines: expected a positive integer"],
    ["--max-new-size=-1", "Invalid value for --max-new-size: expected a positive integer"],
    ["--max-buffer=0", "Invalid value for --max-buffer: expected a positive integer"],
  ])("main(): rejects invalid numeric flag %s", async (flag, message) => {
    const { main } = await importSut();
    process.argv = ["node", "script", flag];

    await expect(main()).rejects.toThrow("process.exit(1)");

    const errOut = errSpy.mock.calls.flat().join("\n");
    expect(errOut).toContain(`Error: ${message}`);
    expect(fsState.execCalls).toEqual([]);
  });

  it("main(): uses the default preview line count when MAX_CONSOLE_LINES is unset", async () => {
    delete process.env.MAX_CONSOLE_LINES;
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged(Array.from({ length: 12 }, (_, i) => `line-${i + 1}`).join("\n"));
    gitMap.setStaged("");
    gitMap.setUntracked("");

    const { main } = await importSut();
    process.argv = ["node", "script", "--out=/repo/OUT.txt", "--template={{diff}}"];
    await main();

    const logs = logSpy.mock.calls.flat().join("\n");
    expect(logs).toContain("line-10");
    expect(logs).not.toContain("line-11");
    expect(logs).toContain("... (truncated) ...");
  });

  it("main(): uses MAX_CONSOLE_LINES when it is a positive integer", async () => {
    process.env.MAX_CONSOLE_LINES = "20";
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged(Array.from({ length: 12 }, (_, i) => `line-${i + 1}`).join("\n"));
    gitMap.setStaged("");
    gitMap.setUntracked("");

    const { main } = await importSut();
    process.argv = ["node", "script", "--out=/repo/OUT.txt", "--template={{diff}}"];
    await main();

    const logs = logSpy.mock.calls.flat().join("\n");
    expect(logs).toContain("line-12");
    expect(logs).not.toContain("... (truncated) ...");
  });

  it.each(["-1", "0", "abc", "", "1.5"])(
    "main(): rejects invalid MAX_CONSOLE_LINES=%j",
    async (value) => {
      process.env.MAX_CONSOLE_LINES = value;

      const { main, parseArgs } = await importSut();
      expect(parseArgs(["node", "script", "--lines=5"]).maxConsoleLines).toBe(5);
      process.argv = ["node", "script", "--lines=5", "--out=/repo/OUT.txt"];

      await expect(main()).rejects.toThrow("process.exit(1)");

      const errOut = errSpy.mock.calls.flat().join("\n");
      expect(errOut).toContain(
        "Error: Invalid value for MAX_CONSOLE_LINES: expected a positive integer",
      );
      expect(fsState.execCalls).toEqual([]);
    },
  );

  it("main(): lets --lines override a valid MAX_CONSOLE_LINES value", async () => {
    process.env.MAX_CONSOLE_LINES = "20";
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged(Array.from({ length: 12 }, (_, i) => `line-${i + 1}`).join("\n"));
    gitMap.setStaged("");
    gitMap.setUntracked("");

    const { main } = await importSut();
    process.argv = ["node", "script", "--lines=5", "--out=/repo/OUT.txt", "--template={{diff}}"];
    await main();

    const logs = logSpy.mock.calls.flat().join("\n");
    expect(logs).toContain("line-5");
    expect(logs).not.toContain("line-6");
    expect(logs).toContain("... (truncated) ...");
  });

  it("main(): diff + untracked (text/binary/huge/error), truncated preview, writes file", async () => {
    const diff = "diff --git a/x b/x\n@@\n-1\n+2\n";
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged(diff);
    gitMap.setStaged(""); // only unstaged changes
    gitMap.setUntracked(nulList("a.txt", "b.bin", "huge.txt", "err.txt"));

    fsState.files.set("/repo/a.txt", { size: 5, buf: Buffer.from("hello") });
    fsState.files.set("/repo/b.bin", { size: 5, buf: Buffer.from([0x00, 0x10]) }); // binary
    fsState.files.set("/repo/huge.txt", { size: 1_000_001, buf: Buffer.from("x") });
    fsState.files.set("/repo/err.txt", {
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
    expect(out.data).toMatch(/File: err\.txt[\s\S]*<read error: Permission denied>/);

    const logs = logSpy.mock.calls.flat().join("\n");
    expect(logs).toContain("--- Prompt (preview) ---");
    expect(logs).toContain("... (truncated) ...");
    expect(logs).toContain("Prompt written to: OUT.txt");
  });

  it("collectDiff(): skips untracked symlinks without reading their targets", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("");
    gitMap.setStaged("");
    gitMap.setUntracked(nulList("link.txt", "normal.txt"));

    fsState.files.set("/repo/link.txt", {
      size: 27,
      buf: Buffer.from("EXTERNAL_SECRET_CONTENT", "utf8"),
      symlink: true,
    });
    fsState.files.set("/repo/normal.txt", {
      size: 13,
      buf: Buffer.from("normal file", "utf8"),
    });

    const { collectDiff, defaultOptions } = await importSut();
    const s = await collectDiff({ ...defaultOptions, includeUntracked: true });

    expect(s).toContain("File: link.txt");
    expect(s).toContain("<symlink skipped>");
    expect(s).not.toContain("EXTERNAL_SECRET_CONTENT");
    expect(s).toContain("File: normal.txt");
    expect(s).toContain("normal file");

    const fsmod = await import("fs/promises");
    const readFileMock = fsmod.readFile as unknown as ReturnType<typeof vi.fn>;
    const readPaths = readFileMock.mock.calls.map((call) => String(call[0]).replace(/\\/g, "/"));
    expect(readPaths).not.toContain("/repo/link.txt");
    expect(readPaths).toContain("/repo/normal.txt");
  });

  it("collectDiff(): respects --no-untracked", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("diff --git a/y b/y\n");
    gitMap.setStaged("");
    gitMap.setUntracked(nulList("a.txt"));

    const { collectDiff, defaultOptions } = await importSut();
    const s = await collectDiff({ ...defaultOptions, includeUntracked: false });
    expect(s).toContain("diff --git a/y b/y");
    expect(s).not.toContain("New files (contents)");
  });

  it("collectDiff(): runs git from repo root and reads untracked files relative to repo root", async () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("C:/repo/packages/app");
    gitMap.setRoot("C:/repo\n");
    gitMap.setUnstaged("");
    gitMap.setStaged("");
    gitMap.setUntracked(nulList("src/new.txt"));
    fsState.files.set("C:/repo/src/new.txt", {
      size: 7,
      buf: Buffer.from("created", "utf8"),
    });

    try {
      const { collectDiff, defaultOptions } = await importSut();
      const s = await collectDiff({ ...defaultOptions, includeUntracked: true });

      expect(s).toContain("File: src/new.txt");
      expect(s).toContain("created");

      const collectGitCalls = fsState.execCalls.filter(
        ({ file, args }) =>
          file === "git" &&
          ((args[0] === "diff" && args[1] === "--") ||
            (args[0] === "diff" && args[1] === "--cached" && args[2] === "--") ||
            (args[0] === "ls-files" &&
              args[1] === "-z" &&
              args[2] === "--others" &&
              args[3] === "--exclude-standard" &&
              args[4] === "--")),
      );
      expect(collectGitCalls.map(({ opts }) => opts?.cwd)).toEqual([
        "C:/repo",
        "C:/repo",
        "C:/repo",
      ]);

      const fsmod = await import("fs/promises");
      const lstatMock = fsmod.lstat as unknown as ReturnType<typeof vi.fn>;
      const readFileMock = fsmod.readFile as unknown as ReturnType<typeof vi.fn>;
      const normalize = (path: string) => path.replace(/\\/g, "/");

      expect(normalize(lstatMock.mock.calls.at(-1)?.[0] as string)).toBe("C:/repo/src/new.txt");
      expect(normalize(readFileMock.mock.calls.at(-1)?.[0] as string)).toBe("C:/repo/src/new.txt");
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it("collectDiff(): preserves special untracked file names from NUL-delimited git output", async () => {
    gitMap.setRoot("C:/repo\n");
    gitMap.setUnstaged("");
    gitMap.setStaged("");

    const files = [" leading.txt", "trailing.txt ", "unicodé/日本語.txt", "line\nbreak.txt"];
    gitMap.setUntracked(nulList(...files));

    fsState.files.set("C:/repo/ leading.txt", {
      size: 7,
      buf: Buffer.from("leading", "utf8"),
    });
    fsState.files.set("C:/repo/trailing.txt ", {
      size: 8,
      buf: Buffer.from("trailing", "utf8"),
    });
    fsState.files.set("C:/repo/unicodé/日本語.txt", {
      size: 7,
      buf: Buffer.from("unicode", "utf8"),
    });
    fsState.files.set("C:/repo/line\nbreak.txt", {
      size: 7,
      buf: Buffer.from("newline", "utf8"),
    });

    const { collectDiff, defaultOptions } = await importSut();
    const s = await collectDiff({ ...defaultOptions, includeUntracked: true });

    expect(s).toContain("File:  leading.txt");
    expect(s).toContain("File: trailing.txt ");
    expect(s).toContain("File: unicodé/日本語.txt");
    expect(s).toContain("File: line\nbreak.txt");
    expect(s).toContain("leading");
    expect(s).toContain("trailing");
    expect(s).toContain("unicode");
    expect(s).toContain("newline");
    expect(s).not.toContain("<read error:");

    const untrackedCall = fsState.execCalls.find(
      ({ file, args }) =>
        file === "git" &&
        args[0] === "ls-files" &&
        args[1] === "-z" &&
        args[2] === "--others" &&
        args[3] === "--exclude-standard" &&
        args[4] === "--",
    );
    expect(untrackedCall?.args).toEqual([
      "ls-files",
      "-z",
      "--others",
      "--exclude-standard",
      "--",
      ".",
    ]);
  });

  it("collectDiff(): rejects with --no-untracked when staged and unstaged diffs are empty", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("");
    gitMap.setStaged("");
    gitMap.setUntracked(nulList("a.txt"));

    const { collectDiff, defaultOptions } = await importSut();
    await expect(collectDiff({ ...defaultOptions, includeUntracked: false })).rejects.toThrow(
      "No changes found: neither diffs nor new files.",
    );
  });

  it("collectDiff(): --max-new-size forces skip", async () => {
    gitMap.setUnstaged("");
    gitMap.setStaged("");
    gitMap.setUntracked(nulList("tiny.txt"));
    gitMap.setRoot("/repo\n");
    fsState.files.set("/repo/tiny.txt", { size: 10, buf: Buffer.from("0123456789") });

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
      expect(logs).toContain("--- Prompt (preview) ---");
      expect(logs).toContain("line1");
      expect(logs).toContain("line2");
      expect(logs).not.toContain("... (truncated) ...");
    } finally {
      logSpy2.mockRestore();
    }
  });

  it("collectDiff(): captures non-Error thrown by readFile/stat (String(e) branch)", async () => {
    gitMap.setUnstaged("");
    gitMap.setStaged("");
    gitMap.setUntracked(nulList("weird.txt"));
    gitMap.setRoot("/repo\n");

    fsState.files.set("/repo/weird.txt", {
      size: 123,
      // @ts-expect-error force non-Error
      err: "BOOM_STRING_ERROR",
    });

    const { collectDiff, defaultOptions } = await importSut();
    const s = await collectDiff({ ...defaultOptions, includeUntracked: true });
    expect(s).toContain("File: weird.txt");
    expect(s).toContain("<read error: BOOM_STRING_ERROR>");
  });

  it("main(): handles non-Error rejection from runGit (String(err) branch)", async () => {
    gitMap.setRoot("__REJECTSTR__:STRINGY_FAIL");
    const { main } = await importSut();
    await expect(main()).rejects.toThrow("process.exit(1)");
    const errOut = errSpy.mock.calls.flat().join("\n");
    expect(errOut).toContain("Error: STRINGY_FAIL");
  });

  it("main(): default output uses repoRoot when provided (LHS of ||)", async () => {
    vi.resetModules();

    gitMap.reset();
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("DIFF\n");
    gitMap.setStaged("");
    gitMap.setUntracked("");

    await mockConfig({
      getRepoRootSafe: vi.fn<() => Promise<string>>().mockResolvedValue("/repo"),
      loadUserConfig: vi.fn<() => Promise<Record<string, unknown>>>().mockResolvedValue({}),
    });

    const joinSpy: any = vi.fn<(a: string, b: string) => string>(
      (a: string, b: string) => `${a}/${b}`,
    );
    await vi.doMock("path", async () => {
      const real = await vi.importActual("path");

      return { ...real, join: (...args: string[]) => joinSpy(...args) };
    });

    const { main } = await importSut();
    process.argv = ["node", "script"]; // no --out
    await main();

    expect(joinSpy).toHaveBeenCalledWith("/repo", "generated-prompt.txt");
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
    await mockConfig({
      getRepoRootSafe: vi.fn<() => Promise<string>>().mockResolvedValue(""),
      loadUserConfig: vi.fn<() => Promise<Record<string, unknown>>>().mockResolvedValue({}),
    });

    // Spy join to inspect calls; mock keeps signature join(a, b)
    const joinSpy: any = vi.fn<(a: string, b: string) => string>(
      (a: string, b: string) => `${a}/${b}`,
    );
    await vi.doMock("path", async () => {
      const real = await vi.importActual<any>("path");

      return { ...real, join: (...args: string[]) => joinSpy(...args) };
    });

    const { main } = await importSut();
    process.argv = ["node", "script"]; // no --out
    await main();

    // Confirm that there was a "join call for the output file name"
    // (does not rely on the last call)
    const outputJoinCall = (joinSpy.mock.calls as unknown as unknown[][]).find(
      (a: unknown[]): a is [string, string] =>
        Array.isArray(a) &&
        typeof a[0] === "string" &&
        typeof a[1] === "string" &&
        a[1] === "generated-prompt.txt",
    );
    expect(outputJoinCall).toBeTruthy();

    const [firstArg, secondArg] = outputJoinCall!;
    expect(secondArg).toBe("generated-prompt.txt");
    // Since repoRoot is "", __DIRNAME_SAFE should be used
    // (not an empty string or /repo)
    expect(firstArg).not.toBe("");
    expect(firstArg).not.toBe("/repo");

    // Also check the actually written path
    const lastWrite = fsState.writes.at(-1)!;

    expect(lastWrite.path.endsWith("generated-prompt.txt")).toBe(true);
  });

  it("main(): whitespace-only --out falls back to default output path", async () => {
    vi.resetModules();

    gitMap.reset();
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("DIFF\n");
    gitMap.setStaged("");
    gitMap.setUntracked("");

    await mockConfig({
      getRepoRootSafe: vi.fn<() => Promise<string>>().mockResolvedValue("/repo"),
      loadUserConfig: vi.fn<() => Promise<Record<string, unknown>>>().mockResolvedValue({}),
    });

    const { main } = await importSut();
    process.argv = ["node", "script", "--out=   "];
    await main();

    const lastWrite = fsState.writes.at(-1)!;
    expect(lastWrite.path.replace(/\\/g, "/")).toBe("/repo/generated-prompt.txt");
  });

  it("main(): whitespace-only config outputPath falls back to default output path", async () => {
    vi.resetModules();

    gitMap.reset();
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("DIFF\n");
    gitMap.setStaged("");
    gitMap.setUntracked("");

    await mockConfig({
      getRepoRootSafe: vi.fn<() => Promise<string>>().mockResolvedValue("/repo"),
      loadUserConfig: vi.fn<() => Promise<Record<string, unknown>>>().mockResolvedValue({
        outputPath: "   ",
      }),
    });

    const { main } = await importSut();
    process.argv = ["node", "script"];
    await main();

    const lastWrite = fsState.writes.at(-1)!;
    expect(lastWrite.path.replace(/\\/g, "/")).toBe("/repo/generated-prompt.txt");
  });

  it("main(): uses promptTemplateFile and replaces {{diff}}, {{now}}, {{repoRoot}}", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("DIFF-A\n");
    gitMap.setStaged("");
    gitMap.setUntracked("");

    await mockConfig({
      getRepoRootSafe: vi.fn<() => Promise<string>>().mockResolvedValue("/repo"),
      loadUserConfig: vi.fn<() => Promise<Record<string, unknown>>>().mockResolvedValue({
        promptTemplateFile: "/repo/.github/prompt.tpl.md",
      }),
    });

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
    expect(out.data).toMatch(/\bNow:\s+\d{4}-\d{2}-\d{2}T/);
    expect(out.data).not.toContain("Please generate **all** of the following");
  });

  it("main(): resolves CLI --template-file relative to repo root when cwd is nested", async () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/repo/packages/app");
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("DIFF-CLI\n");
    gitMap.setStaged("");
    gitMap.setUntracked("");

    await mockConfig({
      getRepoRootSafe: vi.fn<() => Promise<string>>().mockResolvedValue("/repo"),
      loadUserConfig: vi.fn<() => Promise<Record<string, unknown>>>().mockResolvedValue({}),
    });

    const tpl = "CLI-FILE {{diff}} {{repoRoot}}";
    fsState.files.set("/repo/.github/prompt.tpl.md", {
      size: tpl.length,
      buf: Buffer.from(tpl, "utf8"),
    });

    try {
      const { main } = await importSut();
      process.argv = [
        "node",
        "script",
        "--template-file=.github/prompt.tpl.md",
        "--out=/repo/OUT.txt",
      ];
      await main();

      const fsmod = await import("fs/promises");
      const readFileMock = fsmod.readFile as unknown as ReturnType<typeof vi.fn>;
      const readPaths = readFileMock.mock.calls.map((call) => String(call[0]).replace(/\\/g, "/"));
      expect(readPaths).toContain("/repo/.github/prompt.tpl.md");
      expect(readPaths).not.toContain(".github/prompt.tpl.md");

      const out = fsState.writes.at(-1)!;
      expect(out.data).toContain("CLI-FILE DIFF-CLI /repo");
      expect(out.data).not.toContain("Please generate **all** of the following");
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it("main(): exits(1) when explicit --template-file is missing", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("DIFF-MISSING-TEMPLATE\n");
    gitMap.setStaged("");
    gitMap.setUntracked("");

    const { main } = await importSut();
    process.argv = ["node", "script", "--template-file=missing.md", "--out=/repo/OUT.txt"];

    await expect(main()).rejects.toThrow("process.exit(1)");

    const errOut = errSpy.mock.calls.flat().join("\n");
    expect(errOut).toContain("missing.md");
    expect(fsState.writes).toEqual([]);
  });

  it("main(): exits(1) when explicit --template-file is blank", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("DIFF-BLANK-TEMPLATE\n");
    gitMap.setStaged("");
    gitMap.setUntracked("");

    fsState.files.set("/repo/empty.md", {
      size: 4,
      buf: Buffer.from(" \n\t ", "utf8"),
    });

    const { main } = await importSut();
    process.argv = ["node", "script", "--template-file=empty.md", "--out=/repo/OUT.txt"];

    await expect(main()).rejects.toThrow("process.exit(1)");

    const errOut = errSpy.mock.calls.flat().join("\n");
    expect(errOut).toContain("empty.md");
    expect(fsState.writes).toEqual([]);
  });

  it("main(): template precedence CLI inline > file > preset > default", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("XYZ\n");
    gitMap.setStaged("");
    gitMap.setUntracked("");

    await mockConfig({
      getRepoRootSafe: vi.fn<() => Promise<string>>().mockResolvedValue("/repo"),
      loadUserConfig: vi.fn<() => Promise<Record<string, unknown>>>().mockResolvedValue({
        promptTemplateFile: "/repo/tpl.md",
        templatePreset: "minimal",
      }),
    });

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

  it("main(): inline --template wins over a broken config promptTemplateFile", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("INLINE-DIFF\n");
    gitMap.setStaged("");
    gitMap.setUntracked("");

    await mockConfig({
      getRepoRootSafe: vi.fn<() => Promise<string>>().mockResolvedValue("/repo"),
      loadUserConfig: vi.fn<() => Promise<Record<string, unknown>>>().mockResolvedValue({
        promptTemplateFile: "/repo/broken-template.md",
      }),
    });

    const { main } = await importSut();
    const fsmod = await import("fs/promises");
    const readFileMock = fsmod.readFile as unknown as ReturnType<typeof vi.fn>;
    readFileMock.mockClear();

    process.argv = [
      "node",
      "script",
      "--template=INLINE-TPL {{diff}} {{repoRoot}}",
      "--out=/repo/O.txt",
    ];
    await main();

    const out = fsState.writes.at(-1)!;
    expect(out.data).toContain("INLINE-TPL INLINE-DIFF /repo");

    const readPaths = readFileMock.mock.calls.map((call) => String(call[0]).replace(/\\/g, "/"));
    expect(readPaths).not.toContain("/repo/broken-template.md");
  });

  it("main(): falls back to preset when no file/inline provided", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("ABC\n");
    gitMap.setStaged("");
    gitMap.setUntracked("");

    await mockConfig({
      getRepoRootSafe: vi.fn<() => Promise<string>>().mockResolvedValue("/repo"),
      loadUserConfig: vi.fn<() => Promise<Record<string, unknown>>>().mockResolvedValue({
        templatePreset: "minimal",
      }),
    });

    const { main } = await importSut();
    process.argv = ["node", "script", "--out=/repo/PRESET.txt"];
    await main();

    const out = fsState.writes.at(-1)!;
    expect(out.data).toContain("ABC");
    expect(out.data).not.toContain("Please generate **all** of the following");
  });

  it("main(): auto-discovers PR template and embeds it (default preset adds section and editable area note)", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("D\n");
    gitMap.setStaged("");
    gitMap.setUntracked("");

    // default preset via empty config; PR template auto-discovery
    await mockConfig({
      getRepoRootSafe: vi.fn<() => Promise<string>>().mockResolvedValue("/repo"),
      loadUserConfig: vi.fn<() => Promise<Record<string, unknown>>>().mockResolvedValue({}),
    });

    const pr = ["# Pull Request Template", "", "## 📝 Overview", "- What was done"].join("\n");

    // auto-discovery candidate
    fsState.files.set("/repo/.github/pull_request_template.md", {
      size: pr.length,
      buf: Buffer.from(pr, "utf8"),
    });

    const { main } = await importSut();
    process.argv = ["node", "script", "--out=/repo/OUT.txt", "--lines=50"];
    await main();

    const out = fsState.writes.at(-1)!;
    expect(out.data).toContain("### Pull Request Template");
    // Includes the note (canvas/editable area)
    expect(out.data).toMatch(/editable area|キャンバス|編集可能なエリア/i);
    expect(out.data).toContain("# Pull Request Template"); // The body is embedded
  });

  it("main(): --pr-template-file uses the given file and embeds its content", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("E\n");
    gitMap.setStaged("");
    gitMap.setUntracked("");

    await mockConfig({
      getRepoRootSafe: vi.fn<() => Promise<string>>().mockResolvedValue("/repo"),
      loadUserConfig: vi
        .fn<() => Promise<Record<string, unknown>>>()
        .mockResolvedValue({ templatePreset: "default" }),
    });

    const pr = "## Custom PR\n- item";
    fsState.files.set("/repo/PR.md", {
      size: pr.length,
      buf: Buffer.from(pr, "utf8"),
    });

    const { main } = await importSut();
    process.argv = [
      "node",
      "script",
      "--out=/repo/OUT.txt",
      "--pr-template-file=PR.md",
      "--lines=50",
    ];
    await main();

    const out = fsState.writes.at(-1)!;
    expect(out.data).toContain("### Pull Request Template");
    expect(out.data).toContain("## Custom PR");
    expect(out.data).toContain("- item");
  });

  it("main(): exits(1) when explicit --pr-template-file is missing", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("DIFF-MISSING-PR-TEMPLATE\n");
    gitMap.setStaged("");
    gitMap.setUntracked("");

    const { main } = await importSut();
    process.argv = ["node", "script", "--out=/repo/OUT.txt", "--pr-template-file=missing.md"];

    await expect(main()).rejects.toThrow("process.exit(1)");

    const errOut = errSpy.mock.calls.flat().join("\n");
    expect(errOut).toContain("missing.md");
    expect(fsState.writes).toEqual([]);
  });

  it("main(): exits(1) when explicit --pr-template-file is blank", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("DIFF-BLANK-PR-TEMPLATE\n");
    gitMap.setStaged("");
    gitMap.setUntracked("");

    fsState.files.set("/repo/empty.md", {
      size: 4,
      buf: Buffer.from(" \n\t ", "utf8"),
    });

    const { main } = await importSut();
    process.argv = ["node", "script", "--out=/repo/OUT.txt", "--pr-template-file=empty.md"];

    await expect(main()).rejects.toThrow("process.exit(1)");

    const errOut = errSpy.mock.calls.flat().join("\n");
    expect(errOut).toContain("empty.md");
    expect(fsState.writes).toEqual([]);
  });

  it("main(): succeeds when auto-discovered PR template candidates are missing", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("DIFF-NO-AUTO-PR\n");
    gitMap.setStaged("");
    gitMap.setUntracked("");

    const { main } = await importSut();
    process.argv = ["node", "script", "--out=/repo/OUT.txt", "--lines=50"];
    await main();

    const out = fsState.writes.at(-1)!;
    expect(out.path).toBe("/repo/OUT.txt");
    expect(out.data).toContain("DIFF-NO-AUTO-PR");
  });

  it("main(): --no-pr-template disables embedding even if template exists", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("F\n");
    gitMap.setStaged("");
    gitMap.setUntracked("");

    await mockConfig({
      getRepoRootSafe: vi.fn<() => Promise<string>>().mockResolvedValue("/repo"),
      loadUserConfig: vi
        .fn<() => Promise<Record<string, unknown>>>()
        .mockResolvedValue({ templatePreset: "default" }),
    });

    const pr = "PR CONTENT";
    fsState.files.set("/repo/.github/pull_request_template.md", {
      size: pr.length,
      buf: Buffer.from(pr, "utf8"),
    });

    const { main } = await importSut();
    process.argv = ["node", "script", "--out=/repo/OUT.txt", "--no-pr-template", "--lines=50"];
    await main();

    const out = fsState.writes.at(-1)!;
    expect(out.data).not.toContain("PR CONTENT");
    // Since the default preset may output the section itself but leave its contents empty,
    // strongly assert that the content is absent
    expect(out.data).not.toMatch(/### Pull Request Template[\s\S]*PR CONTENT/);
  });

  it("main(): --no-pr-template does not read a missing --pr-template-file", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("F-MISSING-PR-SKIPPED\n");
    gitMap.setStaged("");
    gitMap.setUntracked("");

    const { main } = await importSut();
    const fsmod = await import("fs/promises");
    const readFileMock = fsmod.readFile as unknown as ReturnType<typeof vi.fn>;
    readFileMock.mockClear();

    process.argv = [
      "node",
      "script",
      "--out=/repo/OUT.txt",
      "--no-pr-template",
      "--pr-template-file=missing.md",
      "--lines=50",
    ];
    await main();

    const out = fsState.writes.at(-1)!;
    expect(out.data).toContain("F-MISSING-PR-SKIPPED");

    const readPaths = readFileMock.mock.calls.map((call) => String(call[0]).replace(/\\/g, "/"));
    expect(readPaths).not.toContain("/repo/missing.md");
  });

  it("main(): includePrTemplate false in config disables default PR template embedding", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("F2\n");
    gitMap.setStaged("");
    gitMap.setUntracked("");

    await mockConfig({
      getRepoRootSafe: vi.fn<() => Promise<string>>().mockResolvedValue("/repo"),
      loadUserConfig: vi.fn<() => Promise<Record<string, unknown>>>().mockResolvedValue({
        includePrTemplate: false,
        templatePreset: "default",
      }),
    });

    fsState.files.set("/repo/.github/pull_request_template.md", {
      size: 10,
      buf: Buffer.from("PR CONFIG", "utf8"),
    });

    const { main } = await importSut();
    process.argv = ["node", "script", "--out=/repo/OUT.txt", "--lines=50"];
    await main();

    const out = fsState.writes.at(-1)!;
    expect(out.data).not.toContain("PR CONFIG");
    expect(out.data).not.toMatch(/### Pull Request Template[\s\S]*PR CONFIG/);
  });

  it("main(): minimal preset should not add PR template section title automatically", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("G\n");
    gitMap.setStaged("");
    gitMap.setUntracked("");

    await mockConfig({
      getRepoRootSafe: vi.fn<() => Promise<string>>().mockResolvedValue("/repo"),
      loadUserConfig: vi
        .fn<() => Promise<Record<string, unknown>>>()
        .mockResolvedValue({ templatePreset: "minimal" }),
    });

    // Even if a PR template exists, the minimal preset does not include a section heading
    fsState.files.set("/repo/.github/pull_request_template.md", {
      size: 10,
      buf: Buffer.from("PRX", "utf8"),
    });

    const { main } = await importSut();
    process.argv = ["node", "script", "--out=/repo/OUT.txt", "--lines=50"];
    await main();

    const out = fsState.writes.at(-1)!;
    expect(out.data).not.toContain("### Pull Request Template");
  });

  // === exclude flags and exclude-file handling (existing) ===
  it("collectDiff(): --exclude filters untracked files (pathspec)", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("");
    gitMap.setStaged("");
    gitMap.setUntracked(nulList("dist/a.txt", "src/b.txt", "node_modules/x.js"));

    fsState.files.set("/repo/src/b.txt", { size: 3, buf: Buffer.from("hey") });

    const { collectDiff, defaultOptions } = await importSut();
    const s = await collectDiff({
      ...defaultOptions,
      includeUntracked: true,
      exclude: ["dist", "node_modules/"],
    });

    expect(s).toContain("File: src/b.txt");
    expect(s).toContain("hey");
    expect(s).not.toContain("File: dist/a.txt");
    expect(s).not.toContain("File: node_modules/x.js");
  });

  it("main(): excludes the default output file from untracked files", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("");
    gitMap.setStaged("");
    gitMap.setUntracked(nulList("generated-prompt.txt", "notes.txt"));

    fsState.files.set("/repo/notes.txt", { size: 4, buf: Buffer.from("keep") });

    const { main } = await importSut();
    process.argv = ["node", "script", "--lines=50"];
    await main();

    const out = fsState.writes.at(-1)!;
    expect(out.path.replace(/\\/g, "/")).toBe("/repo/generated-prompt.txt");
    expect(out.data).toContain("File: notes.txt");
    expect(out.data).toContain("keep");
    expect(out.data).not.toContain("File: generated-prompt.txt");

    const untrackedCall = fsState.execCalls.find(
      ({ file, args }) =>
        file === "git" &&
        args[0] === "ls-files" &&
        args[1] === "-z" &&
        args[2] === "--others" &&
        args[3] === "--exclude-standard",
    );
    expect(untrackedCall?.args).toContain(":(exclude)generated-prompt.txt");
  });

  it("collectDiff(): excludes an explicit repo-root output file from untracked files", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("");
    gitMap.setStaged("");
    gitMap.setUntracked(nulList("custom.txt", "src/keep.txt"));

    fsState.files.set("/repo/src/keep.txt", { size: 2, buf: Buffer.from("ok") });

    const { collectDiff, defaultOptions } = await importSut();
    const s = await collectDiff({
      ...defaultOptions,
      includeUntracked: true,
      outputPath: "/repo/custom.txt",
    });

    expect(s).toContain("File: src/keep.txt");
    expect(s).toContain("ok");
    expect(s).not.toContain("File: custom.txt");

    const untrackedCall = fsState.execCalls.find(
      ({ file, args }) =>
        file === "git" &&
        args[0] === "ls-files" &&
        args[1] === "-z" &&
        args[2] === "--others" &&
        args[3] === "--exclude-standard",
    );
    expect(untrackedCall?.args).toContain(":(exclude)custom.txt");
  });

  it("main(): excludes a config outputFile from untracked files", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("");
    gitMap.setStaged("");
    gitMap.setUntracked(nulList("from-config.txt", "src/keep.txt"));

    await mockConfig({
      getRepoRootSafe: vi.fn<() => Promise<string>>().mockResolvedValue("/repo"),
      loadUserConfig: vi.fn<() => Promise<Record<string, unknown>>>().mockResolvedValue({
        outputPath: "/repo/from-config.txt",
      }),
    });

    fsState.files.set("/repo/src/keep.txt", { size: 2, buf: Buffer.from("ok") });

    const { main } = await importSut();
    process.argv = ["node", "script", "--lines=50"];
    await main();

    const out = fsState.writes.at(-1)!;
    expect(out.path).toBe("/repo/from-config.txt");
    expect(out.data).toContain("File: src/keep.txt");
    expect(out.data).not.toContain("File: from-config.txt");

    const untrackedCall = fsState.execCalls.find(
      ({ file, args }) =>
        file === "git" &&
        args[0] === "ls-files" &&
        args[1] === "-z" &&
        args[2] === "--others" &&
        args[3] === "--exclude-standard",
    );
    expect(untrackedCall?.args).toContain(":(exclude)from-config.txt");
  });

  it("collectDiff(): does not add a pathspec exclude for output outside repo root", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("");
    gitMap.setStaged("");
    gitMap.setUntracked(nulList("keep.txt"));

    fsState.files.set("/repo/keep.txt", { size: 4, buf: Buffer.from("keep") });

    const { collectDiff, defaultOptions } = await importSut();
    const s = await collectDiff({
      ...defaultOptions,
      includeUntracked: true,
      outputPath: "/tmp/generated-prompt.txt",
    });

    expect(s).toContain("File: keep.txt");
    expect(s).toContain("keep");

    const untrackedCall = fsState.execCalls.find(
      ({ file, args }) =>
        file === "git" &&
        args[0] === "ls-files" &&
        args[1] === "-z" &&
        args[2] === "--others" &&
        args[3] === "--exclude-standard",
    );
    expect(untrackedCall?.args).toEqual([
      "ls-files",
      "-z",
      "--others",
      "--exclude-standard",
      "--",
      ".",
    ]);
  });

  it("main(): --exclude and --exclude-file together (integration)", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("DIFF\n");
    gitMap.setStaged("");
    gitMap.setUntracked(nulList("build/a.js", "logs/app.log", "src/ok.txt"));

    fsState.files.set("/repo/.d2p-ex.txt", {
      size: 100,
      buf: Buffer.from(
        ["logs", "*.tmp   # ignored", "# comment", "   # indented comment", ""].join("\n"),
        "utf8",
      ),
    });

    fsState.files.set("/repo/src/ok.txt", { size: 2, buf: Buffer.from("ok") });

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
    expect(out.data).toContain("File: src/ok.txt");
    expect(out.data).toContain("ok");
    expect(out.data).not.toContain("File: build/a.js");
    expect(out.data).not.toContain("File: logs/app.log");

    const untrackedCall = fsState.execCalls.find(
      ({ file, args }) =>
        file === "git" &&
        args[0] === "ls-files" &&
        args[1] === "-z" &&
        args[2] === "--others" &&
        args[3] === "--exclude-standard",
    );
    expect(untrackedCall?.args).toContain(":(exclude)logs");
    expect(untrackedCall?.args).toContain(":(exclude)*.tmp");
    expect(untrackedCall?.args).not.toContain(":(exclude)# comment");
    expect(untrackedCall?.args).not.toContain(":(exclude)# indented comment");
  });

  it("collectDiff(): excludeFile (relative) missing -> readLinesIfExists returns [] and no filtering (patterns.size===0)", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("");
    gitMap.setStaged("");
    gitMap.setUntracked(nulList("keep.txt"));
    fsState.files.set("/repo/keep.txt", { size: 4, buf: Buffer.from("keep") });

    const { collectDiff, defaultOptions } = await importSut();
    const s = await collectDiff({
      ...defaultOptions,
      includeUntracked: true,
      excludeFile: ".missing.txt",
    });

    expect(s).toContain("File: keep.txt");
  });

  it("collectDiff(): excludeFile (absolute) is honored (logs/* filtered)", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("");
    gitMap.setStaged("");
    gitMap.setUntracked(nulList("logs/a.log", "src/ok.txt"));

    fsState.files.set("/abs/excludes.txt", {
      size: 16,
      buf: Buffer.from("logs\n", "utf8"),
    });
    fsState.files.set("/repo/src/ok.txt", { size: 2, buf: Buffer.from("ok") });

    const { collectDiff, defaultOptions } = await importSut();
    const s = await collectDiff({
      ...defaultOptions,
      includeUntracked: true,
      excludeFile: "/abs/excludes.txt",
    });

    expect(s).toContain("File: src/ok.txt");
    expect(s).toContain("ok");
    expect(s).not.toContain("File: logs/a.log");
  });

  it("collectDiff(): --exclude supports patterns with spaces", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("");
    gitMap.setStaged("");
    gitMap.setUntracked(nulList("build dir/a.js", "src/ok.txt"));

    fsState.files.set("/repo/src/ok.txt", { size: 2, buf: Buffer.from("ok") });

    const { collectDiff, defaultOptions } = await importSut();
    const s = await collectDiff({
      ...defaultOptions,
      includeUntracked: true,
      exclude: ["build dir/"],
    });

    expect(s).toContain("File: src/ok.txt");
    expect(s).toContain("ok");
    expect(s).not.toContain("File: build dir/a.js");
  });

  it("collectDiff(): passes shell-looking excludes as a single git argv item", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("DIFF\n");
    gitMap.setStaged("");
    gitMap.setUntracked("");

    const { collectDiff, defaultOptions } = await importSut();
    await collectDiff({
      ...defaultOptions,
      includeUntracked: false,
      exclude: ["$(touch injected)"],
    });

    const diffCall = fsState.execCalls.find(
      ({ file, args }) => file === "git" && args[0] === "diff" && args[1] === "--",
    );
    expect(diffCall?.args).toEqual(["diff", "--", ".", ":(exclude)$(touch injected)"]);
  });
});
