/** Git command to collect staged and unstaged diffs. */
export const GIT_CMD_DIFF = "git diff && git diff --cached";

/** Git command to list untracked files. */
export const GIT_CMD_UNTRACKED = "git ls-files --others --exclude-standard";

/** Git command to resolve the repository root directory. */
export const GIT_CMD_ROOT = "git rev-parse --show-toplevel";
