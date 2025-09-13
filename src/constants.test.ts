import { describe, it, expect } from "vitest";
import {
  TEMPLATE_PRESETS,
  MAX_CONSOLE_LINES_DEFAULT,
  MAX_NEWFILE_SIZE_BYTES,
  DEFAULT_MAX_BUFFER,
} from "../src/constants";

describe("constants", () => {
  it("exports sane defaults and presets", () => {
    expect(MAX_CONSOLE_LINES_DEFAULT).toBe(10);
    expect(MAX_NEWFILE_SIZE_BYTES).toBe(1_000_000);
    expect(DEFAULT_MAX_BUFFER).toBe(50 * 1024 * 1024);
    expect(TEMPLATE_PRESETS.default).toContain("Commit message:");
  });
});
