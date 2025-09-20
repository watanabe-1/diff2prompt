# diff2prompt

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/watanabe-1/diff2prompt)

Turn your local Git changes into a clean, copy-pastable prompt for ChatGPT (including a **commit message**, **PR title**, and **branch name** suggestion).

> ✅ Works with staged & unstaged diffs, optionally includes new/untracked files (with binary/huge-file safeguards), prints a console preview, and writes the full prompt to a file.
> 🎨 Supports **custom prompt templates** (inline, file-based, or preset).
> 🛡 Supports **exclude rules** to skip untracked files by glob-like patterns or list files.

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
diff2prompt [--lines=N] [--no-untracked] [--out=PATH] [--max-new-size=BYTES] [--max-buffer=BYTES] \
            [--template=STRING] [--template-file=PATH] [--template-preset=NAME] \
            [--exclude=GLOB] [--exclude-file=PATH]
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

- `--template=STRING`
  Inline template string. Placeholders: `{{diff}}`, `{{now}}`, `{{repoRoot}}`.

- `--template-file=PATH`
  Load template from a file (absolute or relative to repo root).

- `--template-preset=NAME`
  Use a built-in preset (currently `default`, `minimal`, `ja`). Falls back to `default` if unknown.

- `--exclude=GLOB`
  Skip untracked files matching the given pattern. Supports multiple uses.
  Example: `--exclude=dist --exclude="build dir"`

- `--exclude-file=PATH`
  Load exclude patterns (one per line, `#` for comments). Relative paths are resolved against the repo root.
  Example file:

  ```txt
  dist
  node_modules
  *.log
  ```

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
  "outputPath": "generated-prompt.txt",
  "outputFile": "generated-prompt.txt",
  "maxConsoleLines": 15,
  "includeUntracked": true,
  "maxNewFileSizeBytes": 1000000,
  "maxBuffer": 52428800,
  "promptTemplate": "Commit: {{diff}}",
  "promptTemplateFile": ".github/prompt.tpl.md",
  "templatePreset": "minimal",
  "exclude": ["dist", "node_modules"],
  "excludeFile": ".gitignore"
}
```

- `outputPath` takes precedence over `outputFile` if both are present.
- `promptTemplate` (inline string) has the highest priority, then `promptTemplateFile`, then `templatePreset`, then built-in default.
- Relative paths are resolved against the repo root.
- `exclude` and `excludeFile` let you filter out noisy untracked files.
  - Patterns can include spaces (`"build dir"`).
  - Lines starting with `#` are treated as comments in `excludeFile`.

---

## Examples

```bash
# Use a custom output file
diff2prompt --out=.tmp/prompt.txt

# Ignore untracked files
diff2prompt --no-untracked

# Exclude common build artifacts
diff2prompt --exclude=dist --exclude=node_modules

# Exclude with spaces
diff2prompt --exclude="build dir"

# Exclude from a file (patterns resolved relative to repo root)
diff2prompt --exclude-file=.gitignore
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

4. Open a PR with a clear description and logs/screenshots if helpful.

---

## License

MIT © Contributors of diff2prompt
