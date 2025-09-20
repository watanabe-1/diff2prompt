import { exec as cpExec } from "child_process";
import { readFile } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
import { DEFAULT_OUTPUT_FILENAME } from "./constants";
import type { Options } from "./generate-prompt-from-git-diff";

const exec = promisify(cpExec);

export type UserConfig = Partial<{
  outputPath: string;
  outputFile: string;
  maxConsoleLines: number;
  includeUntracked: boolean;
  maxNewFileSizeBytes: number;
  maxBuffer: number;
  promptTemplate?: string; // inline template text
  promptTemplateFile?: string; // absolute path to a template file
  templatePreset?: "default" | "minimal" | "ja" | string; // future-proof
  /** Git pathspec-style excludes; array in config */
  exclude?: string[];
  /** File path that lists excludes (one per line) */
  excludeFile?: string;
}>;

// Extract keys whose value types are assignable to V (e.g., string/number/boolean).
// - When IncludeOptional is true, ignore `undefined` in checks (works well with Partial<>).
type KeysByType<T, V, IncludeOptional extends boolean = false> = {
  [K in keyof T]-?: IncludeOptional extends true
    ? NonNullable<T[K]> extends V
      ? K
      : never
    : T[K] extends V
      ? K
      : never;
}[keyof T];

type StringKeys<T, IncludeOptional extends boolean = true> = KeysByType<
  T,
  string,
  IncludeOptional
>;
type NumberKeys<T, IncludeOptional extends boolean = true> = KeysByType<
  T,
  number,
  IncludeOptional
>;
type BooleanKeys<T, IncludeOptional extends boolean = true> = KeysByType<
  T,
  boolean,
  IncludeOptional
>;

type StringArrayKeys<T, IncludeOptional extends boolean = true> = KeysByType<
  T,
  string[],
  IncludeOptional
>;

export async function getRepoRootSafe(): Promise<string | null> {
  try {
    const res = await exec("git rev-parse --show-toplevel");

    // Handle possible shapes from promisified exec:
    // - string                => stdout
    // - [stdout, stderr]      => array (generic promisify with multiple args)
    // - { stdout, stderr }    => real exec with custom promisify
    let stdout: string | undefined;

    if (typeof res === "string") {
      stdout = res;
    } else if (Array.isArray(res)) {
      stdout = typeof res[0] === "string" ? res[0] : undefined;
    } else if (res && typeof res === "object" && "stdout" in res) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r: any = res;
      stdout = typeof r.stdout === "string" ? r.stdout : undefined;
    }

    const root = (stdout ?? "").trim();

    return root ? root : null;
  } catch {
    return null;
  }
}

export async function readJsonIfExists(path: string): Promise<unknown | null> {
  try {
    const buf = await readFile(path, "utf8");

    return JSON.parse(buf) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function pickString(
  obj: Record<string, unknown>,
  key: StringKeys<UserConfig>
): string | undefined {
  const v = obj[key];

  return typeof v === "string" ? v : undefined;
}

function pickNumber(
  obj: Record<string, unknown>,
  key: NumberKeys<UserConfig>
): number | undefined {
  const v = obj[key];

  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function pickBoolean(
  obj: Record<string, unknown>,
  key: BooleanKeys<UserConfig>
): boolean | undefined {
  const v = obj[key];

  return typeof v === "boolean" ? v : undefined;
}

function pickStringArray(
  obj: Record<string, unknown>,
  key: StringArrayKeys<UserConfig>
): string[] | undefined {
  const v = obj[key as string];
  if (
    Array.isArray(v) &&
    v.every((x) => typeof x === "string" && x.trim().length > 0)
  ) {
    return v as string[];
  }

  return undefined;
}

export function isAbsolutePath(p: string): boolean {
  // Windows drive, UNC, or POSIX absolute
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("/");
}

/** Normalize a raw config value into a partial Options object (with path resolution). */
export function normalizeUserConfig(
  cfgRaw: unknown,
  baseDir: string
): Partial<Options> {
  if (!isRecord(cfgRaw)) return {};

  const out: Partial<Options> = {};
  const outputPath = pickString(cfgRaw, "outputPath");
  const outputFile = pickString(cfgRaw, "outputFile");
  const exclude = pickStringArray(cfgRaw, "exclude");
  const excludeFile = pickString(cfgRaw, "excludeFile");

  let resolvedOutputPath: string | undefined;

  if (outputPath && outputPath.trim()) {
    resolvedOutputPath = isAbsolutePath(outputPath)
      ? outputPath
      : join(baseDir, outputPath);
  } else if (outputFile && outputFile.trim()) {
    resolvedOutputPath = isAbsolutePath(outputFile)
      ? outputFile
      : join(baseDir, outputFile);
  }

  if (resolvedOutputPath) out.outputPath = resolvedOutputPath;

  const maxConsoleLines = pickNumber(cfgRaw, "maxConsoleLines");
  const includeUntracked = pickBoolean(cfgRaw, "includeUntracked");
  const maxNewFileSizeBytes = pickNumber(cfgRaw, "maxNewFileSizeBytes");
  const maxBuffer = pickNumber(cfgRaw, "maxBuffer");
  const promptTemplate = pickString(cfgRaw, "promptTemplate");
  const promptTemplateFile = pickString(cfgRaw, "promptTemplateFile");
  const templatePreset = pickString(cfgRaw, "templatePreset");

  if (typeof maxConsoleLines === "number")
    out.maxConsoleLines = maxConsoleLines;
  if (typeof includeUntracked === "boolean")
    out.includeUntracked = includeUntracked;
  if (typeof maxNewFileSizeBytes === "number")
    out.maxNewFileSizeBytes = maxNewFileSizeBytes;
  if (typeof maxBuffer === "number") out.maxBuffer = maxBuffer;
  if (typeof promptTemplate === "string") out.promptTemplate = promptTemplate;
  if (typeof promptTemplateFile === "string" && promptTemplateFile.trim()) {
    out.promptTemplateFile = isAbsolutePath(promptTemplateFile)
      ? promptTemplateFile
      : join(baseDir, promptTemplateFile);
  }
  if (typeof templatePreset === "string") out.templatePreset = templatePreset;

  if (exclude && exclude.length) out.exclude = exclude;
  if (excludeFile && excludeFile.trim()) {
    out.excludeFile = isAbsolutePath(excludeFile)
      ? excludeFile
      : join(baseDir, excludeFile);
  }

  return out;
}

/** Discover and load user config (in order of precedence). */
export async function loadUserConfig(
  baseDir: string
): Promise<Partial<Options>> {
  // 1) Explicit path via environment variable
  if (process.env.DIFF2PROMPT_CONFIG) {
    const cfg = await readJsonIfExists(process.env.DIFF2PROMPT_CONFIG);
    if (cfg) return normalizeUserConfig(cfg, baseDir);
  }

  // 2) Default config files
  const candidates = [
    join(baseDir, "diff2prompt.config.json"),
    join(baseDir, ".diff2promptrc"),
  ];
  for (const p of candidates) {
    const cfg = await readJsonIfExists(p);
    if (cfg) return normalizeUserConfig(cfg, baseDir);
  }

  // 3) `diff2prompt` field inside package.json
  const pkgRaw = await readJsonIfExists(join(baseDir, "package.json"));
  if (isRecord(pkgRaw)) {
    const d2p = pkgRaw["diff2prompt"]; // unknown
    if (d2p !== undefined) {
      return normalizeUserConfig(d2p, baseDir); // accepts unknown
    }
  }

  return {};
}

/** Default output path (prefer repoRoot; otherwise fall back to cwd). */
export function resolveDefaultOutputPath(
  repoRoot: string | null,
  fallbackDir: string,
  filename = DEFAULT_OUTPUT_FILENAME
): string {
  const base = repoRoot ?? fallbackDir;

  return join(base, filename);
}

/** Merge Options in the order: defaults → file config → CLI. */
export function mergeOptions(
  defaults: Options,
  fileCfg: Partial<Options>,
  cli: Partial<Options>,
  repoRoot: string | null,
  fallbackDir: string
): Options {
  const merged: Options = {
    ...defaults,
    ...fileCfg,
    ...cli,
  };
  if (!merged.outputPath || !merged.outputPath.trim()) {
    merged.outputPath = resolveDefaultOutputPath(repoRoot, fallbackDir);
  }

  return merged;
}
