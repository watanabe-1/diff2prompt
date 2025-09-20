// ===== src/generate-prompt-from-git-diff.ts =====
import { exec as cpExec } from "child_process";
import { readFile, writeFile, stat } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
import { getRepoRootSafe, loadUserConfig } from "./config";
import {
  MAX_CONSOLE_LINES_DEFAULT,
  MAX_NEWFILE_SIZE_BYTES,
  DEFAULT_MAX_BUFFER,
  TEMPLATE_PRESETS,
  ERROR_NO_CHANGES,
  FILE_LABEL,
  NEW_FILES_HEADER,
  PREVIEW_HEADER,
  TRUNCATED_LINE,
  DEFAULT_OUTPUT_FILENAME,
} from "./constants";
import { GIT_CMD_ROOT } from "./git-constants";
import { tooLargeSkipped, binarySkipped, readError } from "./strings";

const exec = promisify(cpExec);

const __DIRNAME_SAFE =
  /* c8 ignore next */
  typeof __dirname !== "undefined" ? __dirname : process.cwd();

export type ExecResult = { stdout: string; stderr: string };

export interface Options {
  maxConsoleLines: number;
  outputPath: string;
  includeUntracked: boolean;
  maxNewFileSizeBytes: number;
  maxBuffer: number;
  promptTemplate?: string; // inline template text
  promptTemplateFile?: string; // absolute path to a template file
  templatePreset?: "default" | "minimal" | "ja" | string; // future-proof
  /** Git pathspec-style excludes; e.g. ["dist", "*.lock", "node_modules/"] */
  exclude?: string[];
  /** A file that lists excludes (one per line). Absolute or relative to repo root. */
  excludeFile?: string;
}

export const defaultOptions: Options = {
  maxConsoleLines:
    Number(process.env.MAX_CONSOLE_LINES) || MAX_CONSOLE_LINES_DEFAULT,
  outputPath: "", // temporary, set in main()
  includeUntracked: true,
  maxNewFileSizeBytes: MAX_NEWFILE_SIZE_BYTES,
  maxBuffer: DEFAULT_MAX_BUFFER,
};

export function parseArgs(argv: string[]): Partial<Options> {
  const out: Partial<Options> = {};
  const excludes: string[] = [];

  for (const a of argv.slice(2)) {
    if (a.startsWith("--lines=")) out.maxConsoleLines = Number(a.split("=")[1]);
    else if (a === "--no-untracked") out.includeUntracked = false;
    else if (a.startsWith("--out=")) out.outputPath = a.split("=")[1]!;
    else if (a.startsWith("--max-new-size="))
      out.maxNewFileSizeBytes = Number(a.split("=")[1]);
    else if (a.startsWith("--max-buffer="))
      out.maxBuffer = Number(a.split("=")[1]);
    else if (a.startsWith("--template-file="))
      out.promptTemplateFile = a.split("=")[1]!;
    else if (a.startsWith("--template="))
      out.promptTemplate = a.slice("--template=".length);
    else if (a.startsWith("--template-preset="))
      out.templatePreset = a.split("=")[1]!;
    else if (a.startsWith("--exclude=")) {
      const v = a.slice("--exclude=".length).trim();
      if (v) excludes.push(v);
    } else if (a.startsWith("--exclude-file=")) {
      out.excludeFile = a.split("=")[1]!;
    }
  }
  if (excludes.length) out.exclude = excludes;

  return out;
}

export async function runGit(cmd: string, opt: Options): Promise<string> {
  const { stdout } = (await exec(cmd, {
    maxBuffer: opt.maxBuffer,
  })) as ExecResult;

  return stdout;
}

export function looksBinary(buf: Buffer): boolean {
  return buf.includes(0);
}

export async function readTextFileIfExists(
  path: string
): Promise<string | null> {
  try {
    const buf = await readFile(path, "utf8");

    return String(buf);
  } catch {
    return null;
  }
}

export function renderTemplate(
  tpl: string,
  data: Record<string, string>
): string {
  // Simple {{key}} replacement (raw substitution without escaping)
  return tpl.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, k) => {
    return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : "";
  });
}

/** Read lines from a file, trim, drop comments (# ...) and blanks. */
async function readLinesIfExists(path: string): Promise<string[]> {
  const txt = await readTextFileIfExists(path);
  if (!txt) return [];

  return txt
    .split(/\r?\n/g)
    .map((s) => s.replace(/\s+#.*$/, "").trim())
    .filter(Boolean);
}

function isAbsolutePathLike(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("/");
}
function toGitSlash(p: string): string {
  return p.replace(/\\/g, "/");
}
function shellQuote(s: string): string {
  // double-quote and escape embedded quotes for cmd/sh
  return `"${s.replace(/"/g, '\\"')}"`;
}

/** Build git pathspec array: [".", ":(exclude)foo", ":(exclude)bar"] */
async function buildPathspec(
  repoRoot: string,
  opt: Options
): Promise<string[]> {
  const patterns = new Set<string>();
  for (const p of opt.exclude ?? []) patterns.add(p);
  if (opt.excludeFile) {
    const abs = isAbsolutePathLike(opt.excludeFile)
      ? opt.excludeFile
      : join(repoRoot, opt.excludeFile);
    for (const line of await readLinesIfExists(abs)) patterns.add(line);
  }
  if (patterns.size === 0) return ["."];

  return ["."].concat([...patterns].map((p) => `:(exclude)${toGitSlash(p)}`));
}

async function buildDiffCommands(
  repoRoot: string,
  opt: Options
): Promise<string[]> {
  const ps = await buildPathspec(repoRoot, opt);
  const psQuoted = ps.map(shellQuote).join(" ");

  return [`git diff -- ${psQuoted}`, `git diff --cached -- ${psQuoted}`];
}

async function buildUntrackedCommand(
  repoRoot: string,
  opt: Options
): Promise<string> {
  const ps = await buildPathspec(repoRoot, opt);
  const psQuoted = ps.map(shellQuote).join(" ");

  return `git ls-files --others --exclude-standard -- ${psQuoted}`;
}

export async function collectDiff(opt: Options): Promise<string> {
  // Resolve repo root for pathspec resolution and exclude-file
  const repoRoot = (await getRepoRootSafe()) ?? process.cwd();

  const [diffCmd, diffCachedCmd] = await buildDiffCommands(repoRoot, opt);
  const unstaged = await runGit(diffCmd, opt);
  const staged = await runGit(diffCachedCmd, opt);
  let full = (unstaged + staged).trim();

  if (opt.includeUntracked) {
    const untrackedCmd = await buildUntrackedCommand(repoRoot, opt);
    const filesStdout = await runGit(untrackedCmd, opt);
    const files = filesStdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    if (files.length > 0) {
      full += NEW_FILES_HEADER;
      for (const file of files) {
        try {
          const st = await stat(file);
          if (st.size > opt.maxNewFileSizeBytes) {
            full += `\n${FILE_LABEL}${file}\n${tooLargeSkipped(st.size)}\n`;
            continue;
          }
          const buf = await readFile(file);
          if (looksBinary(buf)) {
            full += `\n${FILE_LABEL}${file}\n${binarySkipped(st.size)}\n`;
          } else {
            full += `\n${FILE_LABEL}${file}\n${buf.toString("utf8")}\n`;
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          full += `\n${FILE_LABEL}${file}\n${readError(msg)}\n`;
        }
      }
    }

    if (!full.trim()) {
      throw new Error(ERROR_NO_CHANGES);
    }
  }

  return full;
}

export function printPreview(prompt: string, maxLines: number) {
  console.log(PREVIEW_HEADER);
  const lines = prompt.split("\n");
  for (const line of lines.slice(0, Math.max(0, maxLines))) {
    console.log(line);
  }
  if (lines.length > maxLines) console.log(TRUNCATED_LINE);
}

export async function main() {
  const repoRoot = (await getRepoRootSafe()) ?? process.cwd();
  const fileCfg = await loadUserConfig(repoRoot);
  const cli = parseArgs(process.argv);

  const merged: Options = {
    ...defaultOptions,
    ...fileCfg,
    ...cli,
  };

  if (!merged.outputPath) {
    merged.outputPath = join(
      repoRoot || __DIRNAME_SAFE,
      DEFAULT_OUTPUT_FILENAME
    );
  }

  try {
    // Validate git repo (leave constant in use)
    await runGit(GIT_CMD_ROOT, merged);

    const patchContent = await collectDiff(merged);

    // === Priority: inline > file > preset > default ===
    let templateText: string | undefined;

    // 1) Inline CLI/config template has the highest priority
    if (merged.promptTemplate && merged.promptTemplate.trim()) {
      templateText = merged.promptTemplate.trim();
    } else if (merged.promptTemplateFile) {
      // 2) Template file
      const txt = await readTextFileIfExists(merged.promptTemplateFile);
      templateText = txt?.trim();
    }

    // 3) Preset or 4) Default
    if (!templateText || templateText.length === 0) {
      if (merged.templatePreset && TEMPLATE_PRESETS[merged.templatePreset]) {
        templateText = TEMPLATE_PRESETS[merged.templatePreset];
      } else {
        templateText = TEMPLATE_PRESETS.default;
      }
    }

    const nowIso = new Date().toISOString();
    const prompt = renderTemplate(templateText, {
      diff: patchContent,
      now: nowIso,
      repoRoot: repoRoot,
    });

    printPreview(prompt, merged.maxConsoleLines);
    await writeFile(merged.outputPath, prompt, "utf8");
    console.log(`\nPrompt written to: ${merged.outputPath}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    process.exit(1);
  }
}
