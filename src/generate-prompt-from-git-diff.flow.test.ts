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
    const tail = cmd.slice(idx + 4).trim();

    const tokens: string[] = [];
    let cur = "";
    let inQ = false;

    for (let i = 0; i < tail.length; i++) {
      const ch = tail[i];

      if (ch === '"') {
        inQ = !inQ;
        continue;
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

    return tokens
      .filter((t) => t.startsWith(":(exclude)"))
      .map((t) => t.slice(":(exclude)".length));
  }

  function filterListByExcludes(list: string, excludes: string[]): string {
    if (!list || excludes.length === 0) return list;
    const pats = excludes.map((p) => norm(p));
    const regexes = pats.map((p) => {
      if (p.endsWith("/")) return { type: "prefix" as const, p };
      if (/[*?]/.test(p) || p.includes("**"))
        return { type: "glob" as const, re: globToRegExp(p) };

      return { type: "prefix" as const, p };
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

    if (key === "UNTRACKED") {
      const excludes = parseExcludesFromCmd(cmd);
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

  const custom = (cmd: string, _opts?: { maxBuffer?: number }) =>
    new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const { promiseReject, stdout, stderr } = coreExecBehavior(cmd);
      if (promiseReject !== null) reject(promiseReject);
      else resolve({ stdout, stderr });
    });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (exec as any)[util.promisify.custom] = custom;

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

  return { restore: () => void (process.exit = original) };
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
    expect(logs).toContain("--- Prompt (preview) ---");
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
    gitMap.setUntracked("weird.txt\n");

    fsState.files.set("weird.txt", {
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

    await vi.doMock("./config", () => ({
      getRepoRootSafe: vi.fn().mockResolvedValue("/repo"),
      loadUserConfig: vi.fn().mockResolvedValue({}),
    }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const joinSpy: any = vi.fn((a: string, b: string) => `${a}/${b}`);
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
    await vi.doMock("./config", () => ({
      getRepoRootSafe: vi.fn().mockResolvedValue(""),
      loadUserConfig: vi.fn().mockResolvedValue({}),
    }));

    // Spy join to inspect calls; mock keeps signature join(a, b)
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

    // 「出力ファイル名の join 呼び出し」があったことを確認（最後の呼び出しに依存しない）
    const outputJoinCall = (joinSpy.mock.calls as unknown as unknown[][]).find(
      (a: unknown[]): a is [string, string] =>
        Array.isArray(a) &&
        typeof a[0] === "string" &&
        typeof a[1] === "string" &&
        a[1] === "generated-prompt.txt"
    );
    expect(outputJoinCall).toBeTruthy();

    const [firstArg, secondArg] = outputJoinCall!;
    expect(secondArg).toBe("generated-prompt.txt");
    // repoRoot は "" なので、 __DIRNAME_SAFE が使われる（空文字や /repo ではない）
    expect(firstArg).not.toBe("");
    expect(firstArg).not.toBe("/repo");

    // 実際に書き出されたパスも確認
    const lastWrite = fsState.writes.at(-1)!;
    expect(lastWrite.path.endsWith("generated-prompt.txt")).toBe(true);
  });

  it("main(): uses promptTemplateFile and replaces {{diff}}, {{now}}, {{repoRoot}}", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("DIFF-A\n");
    gitMap.setStaged("");
    gitMap.setUntracked("");

    await vi.doMock("./config", () => ({
      getRepoRootSafe: vi.fn().mockResolvedValue("/repo"),
      loadUserConfig: vi.fn().mockResolvedValue({
        promptTemplateFile: "/repo/.github/prompt.tpl.md",
      }),
    }));

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

  it("main(): auto-discovers PR template and embeds it (default preset adds section and editable area note)", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("D\n");
    gitMap.setStaged("");
    gitMap.setUntracked("");

    // default preset via empty config; PR template auto-discovery
    await vi.doMock("./config", () => ({
      getRepoRootSafe: vi.fn().mockResolvedValue("/repo"),
      loadUserConfig: vi.fn().mockResolvedValue({}),
    }));

    const pr = [
      "# Pull Request Template",
      "",
      "## 📝 Overview",
      "- What was done",
    ].join("\n");

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
    // 注意書き（キャンバス/編集可能エリア）を含む
    expect(out.data).toMatch(/editable area|キャンバス|編集可能なエリア/i);
    expect(out.data).toContain("# Pull Request Template"); // 本文が埋め込まれている
  });

  it("main(): --pr-template-file uses the given file and embeds its content", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("E\n");
    gitMap.setStaged("");
    gitMap.setUntracked("");

    await vi.doMock("./config", () => ({
      getRepoRootSafe: vi.fn().mockResolvedValue("/repo"),
      loadUserConfig: vi.fn().mockResolvedValue({ templatePreset: "default" }),
    }));

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

  it("main(): --no-pr-template disables embedding even if template exists", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("F\n");
    gitMap.setStaged("");
    gitMap.setUntracked("");

    await vi.doMock("./config", () => ({
      getRepoRootSafe: vi.fn().mockResolvedValue("/repo"),
      loadUserConfig: vi.fn().mockResolvedValue({ templatePreset: "default" }),
    }));

    const pr = "PR CONTENT";
    fsState.files.set("/repo/.github/pull_request_template.md", {
      size: pr.length,
      buf: Buffer.from(pr, "utf8"),
    });

    const { main } = await importSut();
    process.argv = [
      "node",
      "script",
      "--out=/repo/OUT.txt",
      "--no-pr-template",
      "--lines=50",
    ];
    await main();

    const out = fsState.writes.at(-1)!;
    expect(out.data).not.toContain("PR CONTENT");
    // default presetはセクション自体が出るが中身は空文字になる可能性があるため、強めに不在を確認
    expect(out.data).not.toMatch(/### Pull Request Template[\s\S]*PR CONTENT/);
  });

  it("main(): minimal preset should not add PR template section title automatically", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("G\n");
    gitMap.setStaged("");
    gitMap.setUntracked("");

    await vi.doMock("./config", () => ({
      getRepoRootSafe: vi.fn().mockResolvedValue("/repo"),
      loadUserConfig: vi.fn().mockResolvedValue({ templatePreset: "minimal" }),
    }));

    // PR テンプレートが存在しても minimal にはセクション見出しが無い
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
    gitMap.setUntracked(
      ["dist/a.txt", "src/b.txt", "node_modules/x.js"].join("\n")
    );

    fsState.files.set("src/b.txt", { size: 3, buf: Buffer.from("hey") });

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

  it("main(): --exclude and --exclude-file together (integration)", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("DIFF\n");
    gitMap.setStaged("");
    gitMap.setUntracked(
      ["build/a.js", "logs/app.log", "src/ok.txt"].join("\n")
    );

    fsState.files.set("/repo/.d2p-ex.txt", {
      size: 100,
      buf: Buffer.from(
        ["logs", "*.tmp   # ignored", "   # comment", ""].join("\n"),
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
    expect(out.data).toContain("File: src/ok.txt");
    expect(out.data).toContain("ok");
    expect(out.data).not.toContain("File: build/a.js");
    expect(out.data).not.toContain("File: logs/app.log");
  });

  it("collectDiff(): excludeFile (relative) missing -> readLinesIfExists returns [] and no filtering (patterns.size===0)", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("");
    gitMap.setStaged("");
    gitMap.setUntracked("keep.txt\n");

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
    gitMap.setUntracked(["logs/a.log", "src/ok.txt"].join("\n"));

    fsState.files.set("/abs/excludes.txt", {
      size: 16,
      buf: Buffer.from("logs\n", "utf8"),
    });
    fsState.files.set("src/ok.txt", { size: 2, buf: Buffer.from("ok") });

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

  it("collectDiff(): --exclude supports patterns with spaces (shellQuote path)", async () => {
    gitMap.setRoot("/repo\n");
    gitMap.setUnstaged("");
    gitMap.setStaged("");
    gitMap.setUntracked(["build dir/a.js", "src/ok.txt"].join("\n"));

    fsState.files.set("src/ok.txt", { size: 2, buf: Buffer.from("ok") });

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
});
