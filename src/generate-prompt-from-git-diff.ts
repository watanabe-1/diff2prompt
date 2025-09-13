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
} from "./constants";

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
  }

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

export async function collectDiff(opt: Options): Promise<string> {
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

export function printPreview(prompt: string, maxLines: number) {
  console.log("\n--- Prompt for ChatGPT (preview) ---\n");
  const lines = prompt.split("\n");
  for (const line of lines.slice(0, Math.max(0, maxLines))) {
    console.log(line);
  }
  if (lines.length > maxLines) console.log("... (truncated) ...");
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
      "generated-prompt.txt"
    );
  }

  try {
    await runGit("git rev-parse --show-toplevel", merged);

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
