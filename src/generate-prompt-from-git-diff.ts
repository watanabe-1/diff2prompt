<<<<<<< HEAD
import { exec as cpExec } from "child_process";
import { readFile, writeFile, stat } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
=======
import { readFile, writeFile, stat } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { promisify } from "util";
import { exec as cpExec } from "child_process";
>>>>>>> 43fbacc943666ec97c7c00587ab19dad8ff5aec7

const exec = promisify(cpExec);

const MAX_CONSOLE_LINES_DEFAULT = 10;
<<<<<<< HEAD
const MAX_NEWFILE_SIZE_BYTES = 1_000_000; // 1MB

const __DIRNAME_SAFE =
  typeof __dirname !== "undefined" ? __dirname : process.cwd();
=======
const MAX_NEWFILE_SIZE_BYTES = 1_000_000; // 1MB: skip huge new files to avoid giant prompts
const __dirname = dirname(fileURLToPath(import.meta.url));
>>>>>>> 43fbacc943666ec97c7c00587ab19dad8ff5aec7

type ExecResult = { stdout: string; stderr: string };

interface Options {
  maxConsoleLines: number;
  outputPath: string;
  includeUntracked: boolean;
  maxNewFileSizeBytes: number;
  maxBuffer: number;
}

const defaultOptions: Options = {
  maxConsoleLines:
    Number(process.env.MAX_CONSOLE_LINES) || MAX_CONSOLE_LINES_DEFAULT,
<<<<<<< HEAD
  outputPath: join(__DIRNAME_SAFE, "generated-prompt.txt"),
  includeUntracked: true,
  maxNewFileSizeBytes: MAX_NEWFILE_SIZE_BYTES,
  maxBuffer: 50 * 1024 * 1024,
};

function parseArgs(argv: string[]): Partial<Options> {
=======
  outputPath: join(__dirname, "generated-prompt.txt"),
  includeUntracked: true,
  maxNewFileSizeBytes: MAX_NEWFILE_SIZE_BYTES,
  maxBuffer: 50 * 1024 * 1024, // 50MB to tolerate large diffs
};

function parseArgs(argv: string[]): Partial<Options> {
  // Very light arg parsing (no deps):
  // --lines=20 --no-untracked --out=./prompt.txt --max-new-size=2000000 --max-buffer=104857600
>>>>>>> 43fbacc943666ec97c7c00587ab19dad8ff5aec7
  const out: Partial<Options> = {};
  for (const a of argv.slice(2)) {
    if (a.startsWith("--lines=")) out.maxConsoleLines = Number(a.split("=")[1]);
    else if (a === "--no-untracked") out.includeUntracked = false;
    else if (a.startsWith("--out=")) out.outputPath = a.split("=")[1]!;
    else if (a.startsWith("--max-new-size="))
      out.maxNewFileSizeBytes = Number(a.split("=")[1]);
    else if (a.startsWith("--max-buffer="))
      out.maxBuffer = Number(a.split("=")[1]);
  }
<<<<<<< HEAD

=======
>>>>>>> 43fbacc943666ec97c7c00587ab19dad8ff5aec7
  return out;
}

async function runGit(cmd: string, opt: Options): Promise<string> {
  const { stdout } = (await exec(cmd, {
    maxBuffer: opt.maxBuffer,
  })) as ExecResult;
<<<<<<< HEAD

=======
>>>>>>> 43fbacc943666ec97c7c00587ab19dad8ff5aec7
  return stdout;
}

function looksBinary(buf: Buffer): boolean {
<<<<<<< HEAD
=======
  // Simple heuristic: NUL byte present -> treat as binary
>>>>>>> 43fbacc943666ec97c7c00587ab19dad8ff5aec7
  return buf.includes(0);
}

function generatePrompt(patchContent: string): string {
  return `
I made changes to the following code. Here is the diff of the modifications:

${patchContent}

Please generate **all** of the following based on the diff:

1) **Commit message** (single line), using one of:
   - feat: Adding a new feature
   - fix: Bug fix
   - refactor: Code refactoring
   - update: Improvements or updates to existing functionality
   - docs: Documentation changes
   - chore: Build-related or tool configuration changes
   - test: Adding or modifying tests

   Use Conventional Commits format with an **optional scope**:
   Format: <type>(<optional-scope>): <message>
   - Keep message concise (≤ 72 chars if possible), sentence case.
   - Prefer scopes when clear from the diff. Examples:
<<<<<<< HEAD
     - deps / deps-dev
     - ci
     - docs
     - test
     - build
     - perf, security, etc.

2) **PR title**: mirror the commit message exactly.

3) **Branch name**:
   - Lowercase kebab-case, ASCII [a–z0–9-] only.
   - Prefix "<type>/" and include "/<scope>" if used.
   - ≤ 40 chars after the prefix.

**Output format:**
=======
     - deps / deps-dev (package.json, lockfiles; dev-only -> deps-dev)
     - ci (.github/workflows, CI config)
     - docs (README, docs/)
     - test (test files)
     - build (bundler/tsconfig)
     - perf, security, etc. when appropriate.

2) **PR title**:
   - **Mirror the commit message exactly** (same type/scope/message, same casing).
   - No extra punctuation at the end.

3) **Branch name**:
   - Lowercase kebab-case, ASCII [a–z0–9-] only.
   - Prefix with "<type>/" and include "/<scope>" if a scope is used.
     Examples: "chore/deps/...", "fix/ci/...", "feat/...".
   - Derive from the commit message; drop stop words; keep ≤ 40 chars after the prefix.
   - Example derivation: "chore(deps): bump bun group versions"
     -> branch: "chore/deps/bump-bun-group-versions"

**Output exactly in the format below (no extra text):**
>>>>>>> 43fbacc943666ec97c7c00587ab19dad8ff5aec7

Commit message: <type>(<optional-scope>): <message>
PR title: <type>(<optional-scope>): <message>
Branch: <type>[/<scope>]/<short-kebab-slug>
  `.trim();
}

async function collectDiff(opt: Options): Promise<string> {
<<<<<<< HEAD
  const diff = await runGit("git diff && git diff --cached", opt);
  let full = diff.trim();

=======
  // 1) staged + unstaged diffs
  const diff = await runGit("git diff && git diff --cached", opt);

  let full = diff.trim();

  // 2) untracked files (optional)
>>>>>>> 43fbacc943666ec97c7c00587ab19dad8ff5aec7
  if (opt.includeUntracked) {
    const filesStdout = await runGit(
      "git ls-files --others --exclude-standard",
      opt
    );
    const files = filesStdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    if (files.length > 0) {
      full += "\n\n--- New files (contents) ---\n";
      for (const file of files) {
        try {
          const st = await stat(file);
          if (st.size > opt.maxNewFileSizeBytes) {
            full += `\nFile: ${file}\n<skipped: too large (${st.size} bytes)>\n`;
            continue;
          }
          const buf = await readFile(file);
          if (looksBinary(buf)) {
            full += `\nFile: ${file}\n<binary content skipped (${st.size} bytes)>\n`;
          } else {
            full += `\nFile: ${file}\n${buf.toString("utf8")}\n`;
          }
<<<<<<< HEAD
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          full += `\nFile: ${file}\n<read error: ${msg}>\n`;
=======
        } catch (e: any) {
          full += `\nFile: ${file}\n<read error: ${e?.message ?? e}>\n`;
>>>>>>> 43fbacc943666ec97c7c00587ab19dad8ff5aec7
        }
      }
    }

<<<<<<< HEAD
=======
    // If nothing changed at all, surface a friendly error
>>>>>>> 43fbacc943666ec97c7c00587ab19dad8ff5aec7
    if (!full.trim()) {
      throw new Error("No changes found: neither diffs nor new files.");
    }
  }

  return full;
}

function printPreview(prompt: string, maxLines: number) {
  console.log("\n--- Prompt for ChatGPT (preview) ---\n");
  const lines = prompt.split("\n");
  for (const line of lines.slice(0, Math.max(0, maxLines))) {
    console.log(line);
  }
<<<<<<< HEAD
  if (lines.length > maxLines) console.log("... (truncated) ...");
=======
  if (lines.length > maxLines) {
    console.log("... (truncated) ...");
  }
>>>>>>> 43fbacc943666ec97c7c00587ab19dad8ff5aec7
}

export async function main() {
  const opt: Options = { ...defaultOptions, ...parseArgs(process.argv) };

  try {
<<<<<<< HEAD
    await runGit("git rev-parse --show-toplevel", opt);
    const patchContent = await collectDiff(opt);
    const prompt = generatePrompt(patchContent);
    printPreview(prompt, opt.maxConsoleLines);
    await writeFile(opt.outputPath, prompt, "utf8");
    console.log(`\nPrompt written to: ${opt.outputPath}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
=======
    // Ensure we are inside a git repo (will throw if not)
    await runGit("git rev-parse --show-toplevel", opt);

    const patchContent = await collectDiff(opt);
    const prompt = generatePrompt(patchContent);

    printPreview(prompt, opt.maxConsoleLines);

    await writeFile(opt.outputPath, prompt, "utf8");
    console.log(`\nPrompt written to: ${opt.outputPath}`);
  } catch (err: any) {
    console.error(`Error: ${err?.message ?? err}`);
>>>>>>> 43fbacc943666ec97c7c00587ab19dad8ff5aec7
    process.exit(1);
  }
}
