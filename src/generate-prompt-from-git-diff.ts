import { exec as cpExec } from "child_process";
import { readFile, writeFile, stat } from "fs/promises";
import { join } from "path";
import { promisify } from "util";

const exec = promisify(cpExec);

const MAX_CONSOLE_LINES_DEFAULT = 10;
const MAX_NEWFILE_SIZE_BYTES = 1_000_000; // 1MB

const __DIRNAME_SAFE =
  typeof __dirname !== "undefined" ? __dirname : process.cwd();

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
  outputPath: join(__DIRNAME_SAFE, "generated-prompt.txt"),
  includeUntracked: true,
  maxNewFileSizeBytes: MAX_NEWFILE_SIZE_BYTES,
  maxBuffer: 50 * 1024 * 1024,
};

function parseArgs(argv: string[]): Partial<Options> {
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

  return out;
}

async function runGit(cmd: string, opt: Options): Promise<string> {
  const { stdout } = (await exec(cmd, {
    maxBuffer: opt.maxBuffer,
  })) as ExecResult;

  return stdout;
}

function looksBinary(buf: Buffer): boolean {
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

Commit message: <type>(<optional-scope>): <message>
PR title: <type>(<optional-scope>): <message>
Branch: <type>[/<scope>]/<short-kebab-slug>
  `.trim();
}

async function collectDiff(opt: Options): Promise<string> {
  const diff = await runGit("git diff && git diff --cached", opt);
  let full = diff.trim();

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
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          full += `\nFile: ${file}\n<read error: ${msg}>\n`;
        }
      }
    }

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
  if (lines.length > maxLines) console.log("... (truncated) ...");
}

export async function main() {
  const opt: Options = { ...defaultOptions, ...parseArgs(process.argv) };

  try {
    await runGit("git rev-parse --show-toplevel", opt);
    const patchContent = await collectDiff(opt);
    const prompt = generatePrompt(patchContent);
    printPreview(prompt, opt.maxConsoleLines);
    await writeFile(opt.outputPath, prompt, "utf8");
    console.log(`\nPrompt written to: ${opt.outputPath}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    process.exit(1);
  }
}
