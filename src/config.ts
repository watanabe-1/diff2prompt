import { exec as cpExec } from "child_process";
import { readFile } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
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
}>;

// 値の型 V (例: string/number/boolean など) に"代入可能"なプロパティのキーを抽出
// - IncludeOptional が true のときは undefined を無視して判定（Partial対策）
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

export function isAbsolutePath(p: string): boolean {
  // Windows drive or UNC or posix absolute
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("/");
}

/** 設定ファイルの raw を Options 部分集合へ正規化（パス解決込み） */
export function normalizeUserConfig(
  cfgRaw: unknown,
  baseDir: string
): Partial<Options> {
  if (!isRecord(cfgRaw)) return {};

  const out: Partial<Options> = {};
  const outputPath = pickString(cfgRaw, "outputPath");
  const outputFile = pickString(cfgRaw, "outputFile");

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

  return out;
}

/** 設定ファイルの探索 & 読み込み（優先順位順） */
export async function loadUserConfig(
  baseDir: string
): Promise<Partial<Options>> {
  // 1) 明示パス（環境変数）
  if (process.env.DIFF2PROMPT_CONFIG) {
    const cfg = await readJsonIfExists(process.env.DIFF2PROMPT_CONFIG);
    if (cfg) return normalizeUserConfig(cfg, baseDir);
  }

  // 2) 既定の設定ファイル
  const candidates = [
    join(baseDir, "diff2prompt.config.json"),
    join(baseDir, ".diff2promptrc"),
  ];
  for (const p of candidates) {
    const cfg = await readJsonIfExists(p);
    if (cfg) return normalizeUserConfig(cfg, baseDir);
  }

  // 3) package.json の diff2prompt フィールド
  const pkgRaw = await readJsonIfExists(join(baseDir, "package.json"));
  if (isRecord(pkgRaw)) {
    const d2p = pkgRaw["diff2prompt"]; // unknown
    if (d2p !== undefined) {
      return normalizeUserConfig(d2p, baseDir); // normalizeUserConfig accepts unknown
    }
  }

  return {};
}

/** 既定の出力先（repoRoot 優先、なければ cwd） */
export function resolveDefaultOutputPath(
  repoRoot: string | null,
  fallbackDir: string,
  filename = "generated-prompt.txt"
): string {
  const base = repoRoot ?? fallbackDir;

  return join(base, filename);
}

/** 既定値 → 設定ファイル → CLI の順でマージした Options を返す */
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
