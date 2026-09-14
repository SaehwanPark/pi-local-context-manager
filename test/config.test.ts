import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTEXT_PROFILE_POLICIES,
  CONTEXT_PROFILE_THRESHOLDS,
  DEFAULT_CONFIG,
  getEffectiveThresholds,
  resolveContextThresholds,
  loadConfig,
  parseConfig,
} from "../src/config.js";

describe("configuration", () => {
  it("uses safe defaults and rejects invalid token ordering", () => {
    const parsed = parseConfig({
      softWarningTokens: 40_000,
      compactThresholdTokens: 30_000,
      hardCeilingTokens: 20_000,
      keepRecentTokens: 30_000,
      debug: "yes",
    });

    expect(parsed.config).toEqual(DEFAULT_CONFIG);
    expect(parsed.errors.length).toBeGreaterThan(0);
  });

  it("keeps profile selection separate from explicit advanced overrides", () => {
    const aggressive = parseConfig({ contextProfile: "aggressive" });
    expect(aggressive.config.contextProfile).toBe("aggressive");
    expect(aggressive.config.softWarningTokens).toBeUndefined();
    expect(aggressive.config.compactThresholdTokens).toBeUndefined();
    expect(resolveContextThresholds({ profile: "aggressive" }).thresholds).toEqual(
      CONTEXT_PROFILE_THRESHOLDS.aggressive,
    );
    expect(CONTEXT_PROFILE_POLICIES.aggressive.compactRatio).toBe(0.5);

    const custom = parseConfig({
      contextProfile: "aggressive",
      compactThresholdTokens: 20_000,
    });
    expect(custom.config.contextProfile).toBe("aggressive");
    expect(custom.config.keepRecentTokens).toBeUndefined();
    expect(custom.config.compactThresholdTokens).toBe(20_000);
    expect(custom.errors).toEqual([]);

    const largeAbsoluteOverride = parseConfig({
      contextProfile: "balanced",
      softWarningTokens: 50_000,
      compactThresholdTokens: 52_000,
    });
    expect(largeAbsoluteOverride.errors).toEqual([]);
    expect(largeAbsoluteOverride.config.compactThresholdTokens).toBe(52_000);

    const invalid = parseConfig({ contextProfile: "turbo" });
    expect(invalid.config).toEqual(DEFAULT_CONFIG);
    expect(invalid.errors.join(" ")).toContain("contextProfile");
  });

  it("scales profile ratios across model windows and protects small windows", () => {
    expect(getEffectiveThresholds(DEFAULT_CONFIG, 16_000)).toEqual({
      keepRecentTokens: 2_000,
      softWarningTokens: 8_400,
      compactThresholdTokens: 9_600,
      hardCeilingTokens: 12_000,
    });
    expect(getEffectiveThresholds(DEFAULT_CONFIG, 64_000)).toEqual({
      keepRecentTokens: 8_000,
      softWarningTokens: 33_600,
      compactThresholdTokens: 41_600,
      hardCeilingTokens: 51_200,
    });
    expect(getEffectiveThresholds(DEFAULT_CONFIG, 128_000)).toEqual({
      keepRecentTokens: 10_000,
      softWarningTokens: 67_200,
      compactThresholdTokens: 83_200,
      hardCeilingTokens: 102_400,
    });
    expect(getEffectiveThresholds(DEFAULT_CONFIG, 256_000).compactThresholdTokens).toBe(166_400);
    expect(getEffectiveThresholds(DEFAULT_CONFIG, 1_000_000).keepRecentTokens).toBe(10_000);
    expect(getEffectiveThresholds(DEFAULT_CONFIG)).toEqual(CONTEXT_PROFILE_THRESHOLDS.balanced);
  });

  it("prefers the effective budget and clamps it to the logical window", () => {
    const constrained = resolveContextThresholds({
      profile: "balanced",
      logicalContextWindow: 128_000,
      effectiveContextBudget: 80_000,
    });
    expect(constrained.workingContextBudget).toBe(80_000);
    expect(constrained.effectiveContextBudget).toBe(80_000);
    expect(constrained.thresholds).toMatchObject({
      softWarningTokens: 42_000,
      compactThresholdTokens: 52_000,
      hardCeilingTokens: 64_000,
      keepRecentTokens: 10_000,
    });
    expect(constrained.sources.compact).toBe("profile-ratio");

    const clamped = resolveContextThresholds({
      profile: "balanced",
      logicalContextWindow: 128_000,
      effectiveContextBudget: 256_000,
    });
    expect(clamped.workingContextBudget).toBe(128_000);
    expect(clamped.effectiveContextBudget).toBe(128_000);
  });

  it("keeps explicit compact overrides across larger windows and clamps unsafe ones", () => {
    for (const logicalContextWindow of [64_000, 128_000, 256_000]) {
      const resolved = resolveContextThresholds({
        profile: "balanced",
        logicalContextWindow,
        compactThresholdTokens: 52_000,
      });
      expect(resolved.thresholds.compactThresholdTokens).toBe(52_000);
      expect(resolved.sources.compact).toBe("explicit-token-override");
    }

    const unsafe = resolveContextThresholds({
      profile: "balanced",
      logicalContextWindow: 32_000,
      compactThresholdTokens: 52_000,
    });
    expect(unsafe.thresholds.compactThresholdTokens).toBeLessThan(unsafe.thresholds.hardCeilingTokens);
    expect(unsafe.sources.compact).toBe("small-window-clamp");
  });

  it("keeps every profile ordered across the threshold matrix", () => {
    for (const profile of ["aggressive", "balanced", "relaxed"] as const) {
      for (const logicalContextWindow of [16_000, 32_000, 64_000, 128_000, 256_000, 1_000_000]) {
        const resolved = resolveContextThresholds({ profile, logicalContextWindow });
        const { thresholds } = resolved;
        expect(thresholds.keepRecentTokens).toBeLessThan(thresholds.softWarningTokens);
        expect(thresholds.softWarningTokens).toBeLessThan(thresholds.compactThresholdTokens);
        expect(thresholds.compactThresholdTokens).toBeLessThan(thresholds.hardCeilingTokens);
        expect(thresholds.hardCeilingTokens).toBeLessThanOrEqual(logicalContextWindow);
        expect(thresholds.keepRecentTokens).toBeLessThanOrEqual(
          CONTEXT_PROFILE_POLICIES[profile].keepRecentTokens,
        );
        expect(thresholds.compactThresholdTokens).toBeLessThanOrEqual(
          logicalContextWindow - resolved.minimumHeadroomTokens!,
        );
        expect(thresholds.hardCeilingTokens).toBeLessThanOrEqual(
          logicalContextWindow - resolved.emergencyHeadroomTokens!,
        );
      }
    }
  });

  it("parses checkpoint reset settings and rejects an invalid directory", () => {
    const parsed = parseConfig({ checkpointReset: false, checkpointDirectory: "~/private-checkpoints" });
    expect(parsed.config.checkpointReset).toBe(false);
    expect(parsed.config.checkpointDirectory).toBe("~/private-checkpoints");

    const invalid = parseConfig({ checkpointDirectory: 42 });
    expect(invalid.config.checkpointDirectory).toBe(null);
    expect(invalid.errors.join(" ")).toContain("checkpointDirectory");
  });

  it("accepts an explicit effective working-budget setting", () => {
    const parsed = parseConfig({
      contextProfile: "balanced",
      effectiveContextBudgetTokens: 80_000,
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.config.effectiveContextBudgetTokens).toBe(80_000);
    expect(resolveContextThresholds({
      profile: parsed.config.contextProfile,
      effectiveContextBudget: parsed.config.effectiveContextBudgetTokens,
    }).thresholds.compactThresholdTokens).toBe(52_000);
  });

  it("parses piLocalContextManager wrapper and legacy localContextManager wrapper", () => {
    const modern = parseConfig({ piLocalContextManager: { contextProfile: "aggressive" } });
    expect(modern.config.contextProfile).toBe("aggressive");

    const legacy = parseConfig({ localContextManager: { contextProfile: "relaxed" } });
    expect(legacy.config.contextProfile).toBe("relaxed");
  });

  it("layers global and trusted project JSON, with project values winning", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-local-context-manager-test-"));
    try {
      const globalPath = join(directory, "global.json");
      const projectPath = join(directory, "project.json");
      await writeFile(globalPath, JSON.stringify({ softWarningTokens: 20_000, debug: true }));
      await writeFile(projectPath, JSON.stringify({ compactThresholdTokens: 28_000, debug: false }));

      const loaded = await loadConfig({
        globalConfigPath: globalPath,
        projectConfigPath: projectPath,
        allowProjectConfig: true,
      });

      expect(loaded.config.softWarningTokens).toBe(20_000);
      expect(loaded.config.compactThresholdTokens).toBe(28_000);
      expect(loaded.config.debug).toBe(false);
      expect(loaded.files).toEqual([globalPath, projectPath]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("falls back to legacy config paths when primary config files are absent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-local-context-manager-test-"));
    try {
      const legacyGlobalPath = join(directory, "local-context-manager.json");
      const primaryGlobalPath = join(directory, "pi-local-context-manager.json");
      await writeFile(legacyGlobalPath, JSON.stringify({ softWarningTokens: 22_000 }));

      const loaded = await loadConfig({
        globalConfigPath: primaryGlobalPath,
        fallbackGlobalConfigPath: legacyGlobalPath,
      });

      expect(loaded.config.softWarningTokens).toBe(22_000);
      expect(loaded.files).toEqual([legacyGlobalPath]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("ignores project configuration when the project is untrusted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-local-context-manager-test-"));
    try {
      const globalPath = join(directory, "global.json");
      const projectPath = join(directory, "project.json");
      await writeFile(globalPath, JSON.stringify({ debug: true }));
      await writeFile(projectPath, JSON.stringify({ debug: false }));

      const loaded = await loadConfig({
        globalConfigPath: globalPath,
        projectConfigPath: projectPath,
        allowProjectConfig: false,
      });

      expect(loaded.config.debug).toBe(true);
      expect(loaded.files).toEqual([globalPath]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps layered token ordering valid when a later layer lowers a threshold", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-local-context-manager-test-"));
    try {
      const globalPath = join(directory, "global.json");
      const projectPath = join(directory, "project.json");
      await writeFile(globalPath, JSON.stringify({ keepRecentTokens: 10_000 }));
      await writeFile(projectPath, JSON.stringify({ softWarningTokens: 8_000 }));

      const loaded = await loadConfig({
        globalConfigPath: globalPath,
        projectConfigPath: projectPath,
        allowProjectConfig: true,
      });

      expect(loaded.config.keepRecentTokens).toBe(10_000);
      expect(loaded.config.softWarningTokens).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports malformed JSON without throwing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-local-context-manager-test-"));
    try {
      const path = join(directory, "broken.json");
      await writeFile(path, "{ broken");
      const loaded = await loadConfig({ globalConfigPath: path });
      expect(loaded.config).toEqual(DEFAULT_CONFIG);
      expect(loaded.errors.join(" ")).toContain("malformed JSON");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
