# diff2prompt

Turn your local Git changes into a clean, copy-pastable prompt for ChatGPT (including a **commit message**, **PR title**, and **branch name** suggestion).

> ✅ Works with staged & unstaged diffs, optionally includes new/untracked files (with binary/huge-file safeguards), prints a console preview, and writes the full prompt to a file.

---

## Quick start

```bash
# 1) Install (local dev)
pnpm add -D diff2prompt
# or: npm i -D diff2prompt / bun add -d diff2prompt

# 2) Run in a Git repository
npx diff2prompt
# or if you added an npm script, e.g. "diff2prompt": "diff2prompt"
pnpm diff2prompt
```

By default, the tool:

- Reads your current repo’s diffs (`git diff` & `git diff --cached`)
- Optionally appends the contents of **untracked** files
- Generates a structured prompt that asks ChatGPT to output:
  - **Commit message** (Conventional Commits)
  - **PR title** (mirrors the commit)
  - **Branch name** (scoped kebab-case)

- Prints a **preview** (first N lines) to the console
- Writes the **full prompt** to `generated-prompt.txt` at the repo root

---

## CLI usage

```bash
diff2prompt [--lines=N] [--no-untracked] [--out=PATH] [--max-new-size=BYTES] [--max-buffer=BYTES]
```

### Flags

- `--lines=N`
  Preview line count in the console. Defaults to `MAX_CONSOLE_LINES` env or `10`.

- `--no-untracked`
  Do **not** include new/untracked files in the prompt.

- `--out=PATH`
  Output file path. If omitted, defaults to `<repoRoot>/generated-prompt.txt`
  (falls back to `process.cwd()` if repo root is unknown).

- `--max-new-size=BYTES`
  Skip new/untracked files larger than this size. Default: `1_000_000` (1MB).

- `--max-buffer=BYTES`
  Pass-through to `child_process.exec` for large diffs. Default: `50 * 1024 * 1024`.

### Environment variables

- `MAX_CONSOLE_LINES` — default preview lines (overridden by `--lines`)
- `DIFF2PROMPT_CONFIG` — absolute path to a JSON config file (see below)

---

## Configuration (optional)

You can set persistent defaults via any of the following (first match wins):

1. `DIFF2PROMPT_CONFIG=/abs/path/to/config.json`
2. `<repoRoot>/diff2prompt.config.json`
3. `<repoRoot>/.diff2promptrc`
4. `<repoRoot>/package.json` field `diff2prompt`

### Supported config fields

```json
{
  "outputPath": "generated-prompt.txt", // absolute or relative to repo root
  "outputFile": "generated-prompt.txt", // same as outputPath (alternative key)
  "maxConsoleLines": 15,
  "includeUntracked": true,
  "maxNewFileSizeBytes": 1000000,
  "maxBuffer": 52428800
}
```

- `outputPath` takes precedence over `outputFile` if both are present.
- Relative paths are resolved against the repo root.

---

## What the prompt looks like

The generated prompt asks ChatGPT to produce **all three** items in a strict format:

```txt
Commit message: <type>(<optional-scope>): <message>
PR title: <type>(<optional-scope>): <message>
Branch: <type>[/<scope>]/<short-kebab-slug>
```

It also includes guidance for Conventional Commits types, scope examples, and branch naming rules (lowercase `a–z0–9-`, `type/` prefix, optional `/scope`, length ≤ 40 after prefix).

---

## Behavior details

- **Diff collection**
  Combines `git diff` and `git diff --cached`.

- **Untracked files (optional)**
  Enumerated via `git ls-files --others --exclude-standard`.
  - **Binary files** are detected by the presence of a NUL byte and **skipped** with a note.
  - **Large files** over `maxNewFileSizeBytes` are **skipped** with size info.

- **Preview**
  Prints a header and the first N lines (configurable) to help you sanity-check before opening the output file.

- **Output**
  Full prompt is written to the configured `outputPath`. Default is `<repoRoot>/generated-prompt.txt`.

- **Exit codes**
  - `0` on success
  - `1` with an error message, e.g.
    - Not in a Git repo
    - No changes found: neither diffs nor new files

---

## Examples

```bash
# Use a custom output file
diff2prompt --out=.tmp/prompt.txt

# Preview 30 lines in console, keep default output path
diff2prompt --lines=30

# Ignore untracked files entirely
diff2prompt --no-untracked

# Allow very large diffs
diff2prompt --max-buffer=104857600

# Keep only small new files (e.g., docs/snippets)
diff2prompt --max-new-size=200000
```

---

## FAQ

**Q: It says “No changes found: neither diffs nor new files.”**
A: Stage or modify files first. The tool aggregates `git diff`, `git diff --cached`, and (optionally) untracked files.

**Q: Why are some files “binary content skipped”?**
A: Binary detection avoids pasting unreadable data into the prompt (and blowing up your token count).

---

## Contributing

1. Fork and create a feature branch.
2. Add tests for new behaviors.
3. Run the checks:

   ```bash
   bun run lint && bun run test
   ```

4. Open a PR with a clear description and screenshots/logs if helpful.

> Tip: The project itself uses the tool to craft PR prompts—dogfooding encouraged!

---

## License

MIT © Contributors of diff2prompt
