import { execFile as cpExecFile } from "child_process";
import { lstat, readFile, writeFile } from "fs/promises";
import { isAbsolute, join, relative, resolve } from "path";
import { promisify } from "util";

import { getRepoRootSafe, loadUserConfig, mergeOptions } from "./config";
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
} from "./constants";
import { parseCliPositiveInteger, parseEnvPositiveInteger } from "./number-options";
import { tooLargeSkipped, binarySkipped, readError, symlinkSkipped } from "./strings";

const execFile = promisify(cpExecFile);

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
  includePrTemplate?: boolean; // default true
  prTemplateFile?: string; // absolute or repo-root relative
  templatePreset?: "default" | "minimal" | "ja" | string; // future-proof
  /** Git pathspec-style excludes; e.g. ["dist", "*.lock", "node_modules/"] */
  exclude?: string[];
  /** A file that lists excludes (one per line). Absolute or relative to repo root. */
  excludeFile?: string;
}

export const defaultOptions: Options = {
  maxConsoleLines: MAX_CONSOLE_LINES_DEFAULT,
  outputPath: "", // temporary, set in main()
  includeUntracked: true,
  maxNewFileSizeBytes: MAX_NEWFILE_SIZE_BYTES,
  maxBuffer: DEFAULT_MAX_BUFFER,
  includePrTemplate: true,
};

export function parseArgs(argv: string[]): Partial<Options> {
  const out: Partial<Options> = {};
  const excludes: string[] = [];

  for (const a of argv.slice(2)) {
    if (a.startsWith("--lines="))
      out.maxConsoleLines = parseCliPositiveInteger("--lines", a.slice("--lines=".length));
    else if (a === "--no-untracked") out.includeUntracked = false;
    else if (a.startsWith("--out=")) out.outputPath = a.slice("--out=".length);
    else if (a.startsWith("--max-new-size="))
      out.maxNewFileSizeBytes = parseCliPositiveInteger(
        "--max-new-size",
        a.slice("--max-new-size=".length),
      );
    else if (a.startsWith("--max-buffer="))
      out.maxBuffer = parseCliPositiveInteger("--max-buffer", a.slice("--max-buffer=".length));
    else if (a.startsWith("--template-file="))
      out.promptTemplateFile = a.slice("--template-file=".length);
    else if (a.startsWith("--template=")) out.promptTemplate = a.slice("--template=".length);
    else if (a === "--no-pr-template") out.includePrTemplate = false;
    else if (a.startsWith("--pr-template-file="))
      out.prTemplateFile = a.slice("--pr-template-file=".length);
    else if (a.startsWith("--template-preset="))
      out.templatePreset = a.slice("--template-preset=".length);
    else if (a.startsWith("--exclude=")) {
      const v = a.slice("--exclude=".length).trim();
      if (v) excludes.push(v);
    } else if (a.startsWith("--exclude-file=")) {
      out.excludeFile = a.slice("--exclude-file=".length);
    } else if (a.startsWith("--")) {
      throw new Error(`Unknown option: ${a}`);
    }
  }
  if (excludes.length) out.exclude = excludes;

  return out;
}

export async function runGit(args: string[], opt: Options, cwd?: string): Promise<string> {
  const { stdout } = (await execFile("git", args, {
    cwd,
    maxBuffer: opt.maxBuffer,
  })) as ExecResult;

  return stdout;
}

export function looksBinary(buf: Buffer): boolean {
  return buf.includes(0);
}

export async function readTextFileIfExists(path: string): Promise<string | null> {
  try {
    const buf = await readFile(path, "utf8");

    return String(buf);
  } catch {
    return null;
  }
}

async function readRequiredTextFile(path: string, label: string): Promise<string> {
  let txt: string;
  try {
    txt = String(await readFile(path, "utf8"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to read ${label} file: ${path}: ${msg}`);
  }

  if (!txt.trim()) {
    throw new Error(`${label} file is empty: ${path}`);
  }

  return txt;
}

/** Read lines from a file, trim, drop comments (# ...) and blanks. */
async function readLinesIfExists(path: string): Promise<string[]> {
  const txt = await readTextFileIfExists(path);
  if (!txt) return [];

  return txt
    .split(/\r?\n/g)
    .map((s) => s.replace(/\s+#.*$/, "").trim())
    .filter((s) => !s.startsWith("#"))
    .filter(Boolean);
}

function isAbsolutePathLike(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("/");
}
function resolveRepoPath(repoRoot: string, p: string): string {
  return isAbsolutePathLike(p) ? p : join(repoRoot, p);
}
function toGitSlash(p: string): string {
  return p.replace(/\\/g, "/");
}

function outputPathToUntrackedExclude(repoRoot: string, outputPath: string): string | null {
  if (!outputPath.trim()) return null;

  const repoRootAbs = resolve(repoRoot);
  const outputPathAbs = resolve(outputPath);
  const rel = relative(repoRootAbs, outputPathAbs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;

  return toGitSlash(rel);
}

/** Build git pathspec array: [".", ":(exclude)foo", ":(exclude)bar"] */
async function buildPathspec(
  repoRoot: string,
  opt: Options,
  extraExcludes: string[] = [],
): Promise<string[]> {
  const patterns = new Set<string>();
  for (const p of opt.exclude ?? []) patterns.add(p);
  if (opt.excludeFile) {
    const abs = isAbsolutePathLike(opt.excludeFile)
      ? opt.excludeFile
      : join(repoRoot, opt.excludeFile);
    for (const line of await readLinesIfExists(abs)) patterns.add(line);
  }
  for (const p of extraExcludes) patterns.add(p);
  if (patterns.size === 0) return ["."];

  return ["."].concat([...patterns].map((p) => `:(exclude)${toGitSlash(p)}`));
}

async function buildDiffArgs(repoRoot: string, opt: Options): Promise<string[][]> {
  const ps = await buildPathspec(repoRoot, opt);

  return [
    ["diff", "--", ...ps],
    ["diff", "--cached", "--", ...ps],
  ];
}

async function buildUntrackedArgs(repoRoot: string, opt: Options): Promise<string[]> {
  const outputExclude = outputPathToUntrackedExclude(repoRoot, opt.outputPath);
  const ps = await buildPathspec(repoRoot, opt, outputExclude ? [outputExclude] : []);

  return ["ls-files", "-z", "--others", "--exclude-standard", "--", ...ps];
}

export async function collectDiff(opt: Options): Promise<string> {
  // Resolve repo root for pathspec resolution and exclude-file
  const repoRoot = (await getRepoRootSafe()) ?? process.cwd();

  const [diffArgs, diffCachedArgs] = await buildDiffArgs(repoRoot, opt);
  const unstaged = await runGit(diffArgs, opt, repoRoot);
  const staged = await runGit(diffCachedArgs, opt, repoRoot);
  let full = (unstaged + staged).trim();

  if (opt.includeUntracked) {
    const untrackedArgs = await buildUntrackedArgs(repoRoot, opt);
    const filesStdout = await runGit(untrackedArgs, opt, repoRoot);
    const files = filesStdout.split("\0");
    if (files.at(-1) === "") files.pop();

    if (files.length > 0) {
      full += NEW_FILES_HEADER;
      for (const file of files) {
        const filePath = join(repoRoot, file);
        try {
          const st = await lstat(filePath);
          if (st.isSymbolicLink()) {
            full += `\n${FILE_LABEL}${file}\n${symlinkSkipped}\n`;
            continue;
          }
          if (st.size > opt.maxNewFileSizeBytes) {
            full += `\n${FILE_LABEL}${file}\n${tooLargeSkipped(st.size)}\n`;
            continue;
          }
          const buf = await readFile(filePath);
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
  }

  if (!full.trim()) {
    throw new Error(ERROR_NO_CHANGES);
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

export async function loadPrTemplateText(repoRoot: string, opt: Options): Promise<string | null> {
  // 1) Explicit path if provided
  if (opt.prTemplateFile) {
    const p = resolveRepoPath(repoRoot, opt.prTemplateFile);

    return await readRequiredTextFile(p, "PR template");
  }
  // 2) Common defaults (first match wins)
  const candidates = [
    ".github/pull_request_template.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
    "docs/pull_request_template.md",
    "pull_request_template.md",
  ].map((p) => join(repoRoot, p));

  for (const p of candidates) {
    const txt = await readTextFileIfExists(p);
    if (txt && txt.trim()) return txt;
  }

  return null;
}

export async function main() {
  try {
    const cli = parseArgs(process.argv);
    const defaults = {
      ...defaultOptions,
      maxConsoleLines: parseEnvPositiveInteger(
        "MAX_CONSOLE_LINES",
        process.env.MAX_CONSOLE_LINES,
        MAX_CONSOLE_LINES_DEFAULT,
      ),
    };
    const repoRoot = (await getRepoRootSafe()) ?? process.cwd();
    const fileCfg = await loadUserConfig(repoRoot);
    const merged = mergeOptions(defaults, fileCfg, cli, repoRoot || null, __DIRNAME_SAFE);

    // Validate git repo (leave constant in use)
    await runGit(["rev-parse", "--show-toplevel"], merged);

    const patchContent = await collectDiff(merged);

    // === Priority: inline > file > preset > default ===
    let templateText: string | undefined;

    // 1) Inline CLI/config template has the highest priority
    if (merged.promptTemplate && merged.promptTemplate.trim()) {
      templateText = merged.promptTemplate.trim();
    } else if (merged.promptTemplateFile) {
      // 2) Template file
      const templatePath = resolveRepoPath(repoRoot, merged.promptTemplateFile);
      templateText = (await readRequiredTextFile(templatePath, "prompt template")).trim();
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
    let prTemplateText = "";
    if (merged.includePrTemplate) {
      const found = await loadPrTemplateText(repoRoot, merged);
      if (found) prTemplateText = found.trim();
    }

    const prompt = renderTemplate(templateText, {
      diff: patchContent,
      now: nowIso,
      repoRoot: repoRoot,
      prTemplate: prTemplateText,
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

export function renderTemplate(tpl: string, data: Record<string, string>): string {
  // Simple {{key}} replacement (raw substitution without escaping)
  return tpl.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, k) => {
    return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : "";
  });
}
