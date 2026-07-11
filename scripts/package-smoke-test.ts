import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type PackEntry = {
  files?: Array<{ path?: string }>;
};

const repoRoot = process.cwd();
const distIndexPath = resolve(repoRoot, "dist", "index.js");

function command(name: string): string {
  if (process.platform !== "win32") return name;

  if (name === "bun") return "bun.exe";
  if (name === "npm") return "npm.cmd";

  return name;
}

async function run(name: string, args: string[], cwd = repoRoot): Promise<string> {
  const { stdout } = await execFileAsync(command(name), args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });

  return stdout;
}

async function verifyPackContents(): Promise<void> {
  const stdout = await run("npm", ["pack", "--dry-run", "--json"]);
  const parsed = JSON.parse(stdout) as PackEntry[];
  const files = new Set(parsed.flatMap((entry) => entry.files ?? []).map((file) => file.path));
  const requiredFiles = [
    "package.json",
    "README.md",
    "LICENSE",
    "dist/index.js",
    "dist/schema.json",
  ];

  for (const requiredFile of requiredFiles) {
    if (!files.has(requiredFile)) {
      throw new Error(`npm pack is missing ${requiredFile}`);
    }
  }
}

async function verifyBuiltCli(): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), "diff2prompt-package-"));

  try {
    await run("git", ["init"], tempRoot);
    await run("git", ["config", "user.email", "smoke@example.test"], tempRoot);
    await run("git", ["config", "user.name", "Package Smoke Test"], tempRoot);

    const trackedPath = join(tempRoot, "tracked.txt");
    await writeFile(trackedPath, "before\n", "utf8");
    await run("git", ["add", "tracked.txt"], tempRoot);
    await run("git", ["-c", "commit.gpgsign=false", "commit", "-m", "Initial commit"], tempRoot);

    await writeFile(trackedPath, "after\n", "utf8");

    const outputPath = join(tempRoot, "prompt.txt");
    await run("node", [distIndexPath, "--no-untracked", `--out=${outputPath}`], tempRoot);

    const prompt = await readFile(outputPath, "utf8");
    if (!prompt.includes("diff --git a/tracked.txt b/tracked.txt")) {
      throw new Error("built CLI did not write the expected prompt diff");
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

await run("bun", ["run", "build"]);
await verifyPackContents();
await verifyBuiltCli();

console.log("Package smoke test passed");
