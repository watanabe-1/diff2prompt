/** Header shown before previewing the generated prompt. */
export const PREVIEW_HEADER = "\n--- Prompt (preview) ---\n";

/** Separator header before listing new/untracked files. */
export const NEW_FILES_HEADER = "\n\n--- New files (contents) ---\n";

/** Message printed when preview is truncated. */
export const TRUNCATED_LINE = "... (truncated) ...";

/** Label prefix for each file entry. */
export const FILE_LABEL = "File: ";

/** Error message when neither diff nor new files are found. */
export const ERROR_NO_CHANGES =
  "No changes found: neither diffs nor new files.";

/** Default filename for generated prompt output */
export const DEFAULT_OUTPUT_FILENAME = "generated-prompt.txt";

/** Console preview default lines */
export const MAX_CONSOLE_LINES_DEFAULT = 10;

/** 1MB: skip huge new files to avoid giant prompts */
export const MAX_NEWFILE_SIZE_BYTES = 1_000_000;

/** Default maxBuffer for child_process.exec (50MB) */
export const DEFAULT_MAX_BUFFER = 50 * 1024 * 1024;

/** Built-in prompt template presets */
export const TEMPLATE_PRESETS: Record<string, string> = Object.freeze({
  default: `
I made changes to the following code. Here is the diff of the modifications:

{{diff}}

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
`.trim(),

  minimal: `
{{diff}}

Please output:
- Commit: <type>(<scope?>): <message>
- PR: same as commit
- Branch: <type>[/<scope>]/<slug>
`.trim(),

  ja: `
次の差分に基づいて、コミットメッセージ（Conventional Commits）、PRタイトル（コミットと同一）、ブランチ名（<type>[/<scope>]/<slug>）を生成してください。

差分:
{{diff}}
`.trim(),
});
