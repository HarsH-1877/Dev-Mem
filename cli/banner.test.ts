import { describe, it, expect } from "vitest";
import { getBanner } from "./banner.js";

describe("CLI Banner", () => {
  it("contains the DEV-MEM ASCII art", () => {
    const banner = getBanner({ noColor: true, version: "0.2.1" });
    expect(banner).toContain("██████╗");
    expect(banner).toContain("███████╗");
    expect(banner).toContain("Persistent Knowledge Graph for AI Coding Agents • v0.2.1");
  });

  it("suppresses ANSI colors when noColor is true", () => {
    const plain = getBanner({ noColor: true, version: "1.0.0" });
    // Should not contain ANSI escape sequence
    expect(plain).not.toContain("\x1b[");
  });

  it("includes ANSI color escapes when noColor is false", () => {
    const colored = getBanner({ noColor: false, version: "1.0.0" });
    expect(colored).toContain("\x1b[36m"); // Cyan
    expect(colored).toContain("\x1b[0m");  // Reset
  });

  it("respects process.env.NO_COLOR", () => {
    const prev = process.env.NO_COLOR;
    try {
      process.env.NO_COLOR = "1";
      const banner = getBanner({ version: "0.2.1" });
      expect(banner).not.toContain("\x1b[");
    } finally {
      if (prev !== undefined) {
        process.env.NO_COLOR = prev;
      } else {
        delete process.env.NO_COLOR;
      }
    }
  });

  it("includes the banner in runCli([]) and runCli(['--help'])", async () => {
    const { runCli } = await import("./index.js");
    const emptyRes = await runCli([], { cwd: process.cwd() });
    expect(emptyRes.stdout).toContain("██████╗");
    expect(emptyRes.stdout).toContain("Usage: dev-memo");

    const helpRes = await runCli(["--help"], { cwd: process.cwd() });
    expect(helpRes.stdout).toContain("██████╗");
    expect(helpRes.stdout).toContain("Commands:");
  });

  it("does NOT include the banner in operational commands like status", async () => {
    const { runCli } = await import("./index.js");
    const statusRes = await runCli(["status"], { cwd: process.cwd() });
    expect(statusRes.stdout).not.toContain("██████╗");
  });
});

