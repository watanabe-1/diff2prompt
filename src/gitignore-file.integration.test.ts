import { execFile as execFileCallback } from "child_process";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { afterEach, describe, expect, it } from "vitest";

import { collectDiff, defaultOptions } from "./generate-prompt-from-git-diff";

const execFile = promisify(execFileCallback);
const repos: string[] = [];

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd: repo, encoding: "utf8" });

  return stdout;
}

async function createRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "diff2prompt-gitignore-"));
  repos.push(repo);
  await git(repo, ["init", "-q"]);

  return repo;
}

async function put(repo: string, path: string, contents = path): Promise<void> {
  const fullPath = join(repo, path);
  await mkdir(join(fullPath, ".."), { recursive: true });
  await writeFile(fullPath, contents, "utf8");
}

async function commitAll(repo: string): Promise<void> {
  await git(repo, ["add", "."]);
  await git(repo, [
    "-c",
    "user.name=diff2prompt test",
    "-c",
    "user.email=diff2prompt@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--no-gpg-sign",
    "--no-verify",
    "-q",
    "-m",
    "base",
  ]);
}

function options(ignoreFile = "patterns.ignore") {
  return {
    ...defaultOptions,
    outputPath: "",
    gitignoreFile: ignoreFile,
  };
}

describe("--gitignore-file with real Git", () => {
  afterEach(async () => {
    await Promise.all(repos.splice(0).map((repo) => rm(repo, { recursive: true, force: true })));
  });

  it("preserves root anchoring, negation, escaping, directory rules, and spaces", async () => {
    const repo = await createRepo();
    await put(
      repo,
      "patterns.ignore",
      [
        "/build",
        "dist/*",
        "!dist/keep.js",
        String.raw`\#file`,
        String.raw`\!file`,
        "cache/",
        "space dir/",
        "/node_modules",
      ].join("\n"),
    );
    for (const path of [
      "build/root.txt",
      "packages/example/build/nested.txt",
      "dist/drop.js",
      "dist/keep.js",
      "#file",
      "!file",
      "cache/value.txt",
      "space dir/value.txt",
      "node_modules/module.js",
    ]) {
      await put(repo, path);
    }

    const diff = await collectDiff(options(), repo);

    expect(diff).toContain("packages/example/build/nested.txt");
    expect(diff).toContain("dist/keep.js");
    for (const excluded of [
      "build/root.txt",
      "dist/drop.js",
      "#file",
      "!file",
      "cache/value.txt",
      "space dir/value.txt",
      "node_modules/module.js",
    ]) {
      expect(diff).not.toContain(`File: ${excluded}`);
    }
  }, 15_000);

  it("a non-root build pattern excludes build directories at every depth", async () => {
    const repo = await createRepo();
    await put(repo, "patterns.ignore", "build\n");
    await put(repo, "build/root.txt");
    await put(repo, "packages/example/build/nested.txt");
    await put(repo, "keep.txt");

    const diff = await collectDiff(options(), repo);

    expect(diff).toContain("File: keep.txt");
    expect(diff).not.toContain("build/root.txt");
    expect(diff).not.toContain("packages/example/build/nested.txt");
  }, 15_000);

  it("applies the same ignore source to unstaged, staged, and untracked files", async () => {
    const repo = await createRepo();
    await put(repo, "patterns.ignore", "ignored-*\n");
    for (const path of [
      "ignored-unstaged.txt",
      "ignored-staged.txt",
      "kept-unstaged.txt",
      "kept-staged.txt",
    ]) {
      await put(repo, path, "base\n");
    }
    await commitAll(repo);
    await put(repo, "ignored-unstaged.txt", "changed\n");
    await put(repo, "ignored-staged.txt", "changed\n");
    await put(repo, "kept-unstaged.txt", "changed\n");
    await put(repo, "kept-staged.txt", "changed\n");
    await git(repo, ["add", "ignored-staged.txt", "kept-staged.txt"]);
    await put(repo, "ignored-untracked.txt", "hidden\n");
    await put(repo, "kept-untracked.txt", "visible\n");

    const diff = await collectDiff(options(), repo);

    expect(diff).toContain("kept-unstaged.txt");
    expect(diff).toContain("kept-staged.txt");
    expect(diff).toContain("File: kept-untracked.txt");
    expect(diff).not.toContain("ignored-unstaged.txt");
    expect(diff).not.toContain("ignored-staged.txt");
    expect(diff).not.toContain("ignored-untracked.txt");
  }, 15_000);

  it("uses --with-tree=HEAD to exclude a path deleted from the index", async () => {
    const repo = await createRepo();
    await put(repo, "patterns.ignore", "/gone.txt\n");
    await put(repo, "gone.txt", "base\n");
    await put(repo, "keep.txt", "base\n");
    await commitAll(repo);
    await git(repo, ["rm", "--cached", "-q", "gone.txt"]);
    await put(repo, "keep.txt", "changed\n");

    const listed = await git(repo, [
      "ls-files",
      "--cached",
      "--ignored",
      "--with-tree=HEAD",
      `--exclude-from=${join(repo, "patterns.ignore").replace(/\\/g, "/")}`,
      "-z",
    ]);
    const diff = await collectDiff(options(), repo);

    expect(listed.split("\0")).toContain("gone.txt");
    expect(diff).toContain("keep.txt");
    expect(diff).not.toContain("gone.txt");
  }, 15_000);
});
