import { readFile } from "node:fs/promises";

export type ContextProfile = "aggressive" | "balanced" | "relaxed";

export interface ContextProfilePolicy {
  warningRatio: number;
  compactRatio: number;
  ceilingRatio: number;
  keepRecentTokens: number;
}

export interface ContextThresholds {
  softWarningTokens: number;
  compactThresholdTokens: number;
  hardCeilingTokens: number;
  keepRecentTokens: number;
}

export type ThresholdSource =
  | "profile-ratio"
  | "explicit-token-override"
  | "small-window-clamp"
  | "fallback";

export interface ThresholdSources {
  softWarning: ThresholdSource;
  compact: ThresholdSource;
  hardCeiling: ThresholdSource;
  keepRecent: ThresholdSource;
}

export interface ResolveThresholdOptions {
  profile: ContextProfile;
  /** Advertised/logical model context capacity. */
  logicalContextWindow?: number | undefined;
  /** Runtime-safe usable context budget. */
  effectiveContextBudget?: number | undefined;
  /** Configuration-shaped alias for effectiveContextBudget. */
  effectiveContextBudgetTokens?: number | undefined;
  /** Compatibility alias for effectiveContextBudget. */
  effectivePrefillBudget?: number | undefined;
  /** Compatibility alias for logicalContextWindow. */
  contextWindow?: number | undefined;

  softWarningTokens?: number | undefined;
  compactThresholdTokens?: number | undefined;
  hardCeilingTokens?: number | undefined;
  keepRecentTokens?: number | undefined;
}

export interface ResolvedContextPolicy {
  thresholds: ContextThresholds;
  profile: ContextProfile;
  profilePolicy: ContextProfilePolicy;
  workingContextBudget: number | null;
  logicalContextWindow: number | null;
  effectiveContextBudget: number | null;
  workingContextBudgetSource: "effective-context-budget" | "logical-context-window" | "fallback";
  minimumHeadroomTokens: number | null;
  emergencyHeadroomTokens: number | null;
  sources: ThresholdSources;
}

export interface PiLocalContextManagerConfig {
  enabled: boolean;
  contextProfile: ContextProfile;
  /** Explicit advanced overrides. Unset fields use the selected profile policy. */
  softWarningTokens?: number;
  compactThresholdTokens?: number;
  hardCeilingTokens?: number;
  keepRecentTokens?: number;
  /** Optional runtime-safe budget for proactive context management. */
  effectiveContextBudgetTokens?: number;
  toolOutputReduction: boolean;
  semanticCompaction: boolean;
  handoff: boolean;
  checkpointReset: boolean;
  checkpointDirectory: string | null;
  debug: boolean;
}

export type LocalContextManagerConfig = PiLocalContextManagerConfig;

export const CONTEXT_PROFILE_POLICIES: Readonly<Record<ContextProfile, Readonly<ContextProfilePolicy>>> = Object.freeze({
  aggressive: Object.freeze({
    warningRatio: 0.40,
    compactRatio: 0.50,
    ceilingRatio: 0.65,
    keepRecentTokens: 8_000,
  }),
  balanced: Object.freeze({
    warningRatio: 0.525,
    compactRatio: 0.65,
    ceilingRatio: 0.80,
    keepRecentTokens: 10_000,
  }),
  relaxed: Object.freeze({
    warningRatio: 0.625,
    compactRatio: 0.75,
    ceilingRatio: 0.875,
    keepRecentTokens: 12_000,
  }),
});

/**
 * The pre-adaptive profile values are retained as the no-window fallback and as
 * a public compatibility export. A profile-only configuration has no explicit
 * token values, so these numbers are never copied into its config object.
 */
export const CONTEXT_PROFILE_THRESHOLDS: Readonly<Record<ContextProfile, Readonly<ContextThresholds>>> = Object.freeze({
  aggressive: Object.freeze({
    keepRecentTokens: 8_000,
    softWarningTokens: 16_000,
    compactThresholdTokens: 24_000,
    hardCeilingTokens: 36_000,
  }),
  balanced: Object.freeze({
    keepRecentTokens: 10_000,
    softWarningTokens: 24_000,
    compactThresholdTokens: 32_000,
    hardCeilingTokens: 48_000,
  }),
  relaxed: Object.freeze({
    keepRecentTokens: 12_000,
    softWarningTokens: 36_000,
    compactThresholdTokens: 48_000,
    hardCeilingTokens: 72_000,
  }),
});

export const DEFAULT_CONFIG: Readonly<LocalContextManagerConfig> = Object.freeze({
  enabled: true,
  contextProfile: "balanced",
  toolOutputReduction: true,
  semanticCompaction: true,
  handoff: true,
  checkpointReset: true,
  checkpointDirectory: null,
  debug: false,
});

export interface LoadedConfig {
  config: LocalContextManagerConfig;
  errors: string[];
  files: string[];
}

export interface LoadConfigOptions {
  globalConfigPath: string;
  fallbackGlobalConfigPath?: string;
  projectConfigPath?: string;
  fallbackProjectConfigPath?: string;
  allowProjectConfig?: boolean;
}

const CONTEXT_PROFILE_KEYS = ["aggressive", "balanced", "relaxed"] as const;
const BOOLEAN_KEYS = [
  "enabled",
  "toolOutputReduction",
  "semanticCompaction",
  "handoff",
  "checkpointReset",
  "debug",
] as const;
const NUMBER_KEYS = [
  "softWarningTokens",
  "compactThresholdTokens",
  "hardCeilingTokens",
  "keepRecentTokens",
  "effectiveContextBudgetTokens",
] as const;
const THRESHOLD_KEYS = [
  "keepRecentTokens",
  "softWarningTokens",
  "compactThresholdTokens",
  "hardCeilingTokens",
] as const;

type RecordValue = Record<string, unknown>;
type NumberConfigKey = (typeof NUMBER_KEYS)[number];
type ThresholdConfigKey = (typeof THRESHOLD_KEYS)[number];

function isContextProfile(value: unknown): value is ContextProfile {
  return typeof value === "string" && (CONTEXT_PROFILE_KEYS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveFinite(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function normalizeProfile(value: ContextProfile): ContextProfile {
  return isContextProfile(value) ? value : "balanced";
}

function normalizeWindow(value: unknown): number | undefined {
  return positiveFinite(value);
}

/**
 * Reserve enough room for a normal assistant/tool cycle before proactive
 * compaction. The reserve grows with large windows but is bounded on small
 * windows so it cannot consume the whole usable budget.
 */
export function getMinimumHeadroom(budget: number): number {
  const normalized = normalizeWindow(budget) ?? 1;
  return Math.min(
    Math.floor(normalized * 0.40),
    Math.max(8_000, Math.min(16_384, Math.floor(normalized * 0.25))),
  );
}

/**
 * Emergency headroom is deliberately smaller than the normal response reserve.
 * Explicit advanced thresholds may use this smaller reserve while automatic
 * profile ratios use getMinimumHeadroom().
 */
export function getEmergencyHeadroom(budget: number): number {
  const normalized = normalizeWindow(budget) ?? 1;
  return Math.min(
    getMinimumHeadroom(normalized),
    Math.max(4_000, Math.min(8_000, Math.floor(normalized * 0.125))),
  );
}

function legacyThresholds(profile: ContextProfile): ContextThresholds {
  return { ...CONTEXT_PROFILE_THRESHOLDS[normalizeProfile(profile)] };
}

function isExplicitSource(source: ThresholdSource): boolean {
  return source === "explicit-token-override";
}

function clampPositive(value: number, maximum: number): number {
  return Math.max(1, Math.min(Math.floor(value), Math.max(1, Math.floor(maximum))));
}

function minimumThreshold(key: keyof ContextThresholds): number {
  // A zero-token keep window is the only way to represent a strict four-way
  // ordering for the tiny synthetic budgets used by defensive callers.
  return key === "keepRecentTokens" ? 0 : 1;
}

/**
 * Keep the four boundaries strictly ordered while preserving explicit values
 * whenever there is room inside the usable budget. Invalid combinations from a
 * hand-written config are therefore made safe at runtime even if a host bypasses
 * parseConfig().
 */
function normalizeOrdering(
  thresholds: ContextThresholds,
  sources: ThresholdSources,
  caps: Partial<Record<keyof ContextThresholds, number>>,
): void {
  const keys: Array<keyof ContextThresholds> = [
    "keepRecentTokens",
    "softWarningTokens",
    "compactThresholdTokens",
    "hardCeilingTokens",
  ];
  const sourceKeys: Record<keyof ContextThresholds, keyof ThresholdSources> = {
    keepRecentTokens: "keepRecent",
    softWarningTokens: "softWarning",
    compactThresholdTokens: "compact",
    hardCeilingTokens: "hardCeiling",
  };

  for (let pass = 0; pass < keys.length * 2; pass += 1) {
    let changed = false;
    for (let index = 0; index < keys.length - 1; index += 1) {
      const lowerKey = keys[index];
      const upperKey = keys[index + 1];
      const upperSource = sources[sourceKeys[upperKey]];
      if (thresholds[lowerKey] < thresholds[upperKey]) {
        continue;
      }

      const upperCap = caps[upperKey];
      if (upperSource === "explicit-token-override") {
        // Preserve an explicit upper boundary when possible by lowering the
        // preceding automatic boundary. This keeps absolute overrides stable
        // as the logical model window grows.
        const lowered = thresholds[upperKey] - 1;
        if (lowered >= minimumThreshold(lowerKey)) {
          thresholds[lowerKey] = lowered;
          sources[sourceKeys[lowerKey]] = "small-window-clamp";
        } else {
          const raised = thresholds[lowerKey] + 1;
          if (upperCap === undefined || raised <= upperCap) {
            thresholds[upperKey] = raised;
            sources[sourceKeys[upperKey]] = "small-window-clamp";
          } else {
            thresholds[lowerKey] = Math.max(minimumThreshold(lowerKey), upperCap - 1);
            sources[sourceKeys[lowerKey]] = "small-window-clamp";
          }
        }
      } else {
        const raised = thresholds[lowerKey] + 1;
        if (upperCap !== undefined && raised > upperCap) {
          thresholds[lowerKey] = Math.max(minimumThreshold(lowerKey), upperCap - 1);
          sources[sourceKeys[lowerKey]] = "small-window-clamp";
        } else {
          thresholds[upperKey] = raised;
          if (!isExplicitSource(upperSource)) {
            sources[sourceKeys[upperKey]] = "small-window-clamp";
          }
        }
      }
      changed = true;
    }
    if (!changed) {
      break;
    }
  }

  const ceilingCap = caps.hardCeilingTokens;
  if (ceilingCap !== undefined && thresholds.hardCeilingTokens > ceilingCap) {
    thresholds.hardCeilingTokens = Math.max(1, Math.floor(ceilingCap));
    sources.hardCeiling = "small-window-clamp";
    if (thresholds.compactThresholdTokens >= thresholds.hardCeilingTokens) {
      thresholds.compactThresholdTokens = Math.max(1, thresholds.hardCeilingTokens - 1);
      sources.compact = "small-window-clamp";
    }
    if (thresholds.softWarningTokens >= thresholds.compactThresholdTokens) {
      thresholds.softWarningTokens = Math.max(1, thresholds.compactThresholdTokens - 1);
      sources.softWarning = "small-window-clamp";
    }
    if (thresholds.keepRecentTokens >= thresholds.softWarningTokens) {
      thresholds.keepRecentTokens = Math.max(0, thresholds.softWarningTokens - 1);
      sources.keepRecent = "small-window-clamp";
    }
  }
}

/**
 * Resolve all context boundaries from one canonical working-budget policy.
 * Runtime-safe/effective budgets always win over the advertised model window,
 * and the effective budget is never allowed to exceed that logical window.
 */
export function resolveContextThresholds(options: ResolveThresholdOptions): ResolvedContextPolicy {
  const profile = normalizeProfile(options.profile);
  const profilePolicy = CONTEXT_PROFILE_POLICIES[profile];
  const logicalContextWindow = normalizeWindow(options.logicalContextWindow) ?? normalizeWindow(options.contextWindow) ?? null;

  const effectiveCandidates = [
    options.effectiveContextBudget,
    options.effectiveContextBudgetTokens,
    options.effectivePrefillBudget,
  ]
    .map(normalizeWindow)
    .filter((value): value is number => value !== undefined);
  const configuredEffective = effectiveCandidates.length > 0 ? Math.min(...effectiveCandidates) : undefined;
  const effectiveContextBudget = configuredEffective === undefined
    ? null
    : logicalContextWindow === null
      ? configuredEffective
      : Math.min(configuredEffective, logicalContextWindow);
  const workingContextBudget = effectiveContextBudget ?? logicalContextWindow;

  const fallback = legacyThresholds(profile);
  const thresholds: ContextThresholds = workingContextBudget === null
    ? { ...fallback }
    : {
        keepRecentTokens: Math.max(0, Math.floor(workingContextBudget * 0.125)),
        softWarningTokens: Math.max(1, Math.floor(workingContextBudget * profilePolicy.warningRatio)),
        compactThresholdTokens: Math.max(1, Math.floor(workingContextBudget * profilePolicy.compactRatio)),
        hardCeilingTokens: Math.max(1, Math.floor(workingContextBudget * profilePolicy.ceilingRatio)),
      };

  const sources: ThresholdSources = workingContextBudget === null
    ? {
        keepRecent: "fallback",
        softWarning: "fallback",
        compact: "fallback",
        hardCeiling: "fallback",
      }
    : {
        keepRecent: Math.floor(workingContextBudget * 0.125) < profilePolicy.keepRecentTokens
          ? "small-window-clamp"
          : "profile-ratio",
        softWarning: "profile-ratio",
        compact: "profile-ratio",
        hardCeiling: "profile-ratio",
      };

  let minimumHeadroomTokens: number | null = null;
  let emergencyHeadroomTokens: number | null = null;
  let compactAutomaticCap: number | undefined;
  let ceilingCap: number | undefined;
  if (workingContextBudget !== null) {
    minimumHeadroomTokens = getMinimumHeadroom(workingContextBudget);
    emergencyHeadroomTokens = getEmergencyHeadroom(workingContextBudget);
    compactAutomaticCap = Math.max(1, workingContextBudget - minimumHeadroomTokens);
    ceilingCap = Math.max(1, workingContextBudget - emergencyHeadroomTokens);
    if (thresholds.compactThresholdTokens > compactAutomaticCap) {
      thresholds.compactThresholdTokens = compactAutomaticCap;
      sources.compact = "small-window-clamp";
    }
    if (thresholds.hardCeilingTokens > ceilingCap) {
      thresholds.hardCeilingTokens = ceilingCap;
      sources.hardCeiling = "small-window-clamp";
    }
    const boundedKeep = Math.min(
      profilePolicy.keepRecentTokens,
      Math.max(0, Math.floor(workingContextBudget * 0.125)),
    );
    thresholds.keepRecentTokens = boundedKeep;
  }

  const overrideEntries: Array<[keyof ContextThresholds, number | undefined, keyof ThresholdSources]> = [
    ["softWarningTokens", positiveFinite(options.softWarningTokens), "softWarning"],
    ["compactThresholdTokens", positiveFinite(options.compactThresholdTokens), "compact"],
    ["hardCeilingTokens", positiveFinite(options.hardCeilingTokens), "hardCeiling"],
    ["keepRecentTokens", positiveFinite(options.keepRecentTokens), "keepRecent"],
  ];
  for (const [key, override, sourceKey] of overrideEntries) {
    if (override === undefined) {
      continue;
    }
    thresholds[key] = override;
    sources[sourceKey] = "explicit-token-override";
  }

  // Explicit values remain meaningful, but a runtime-limited budget still gets
  // an emergency reserve. Automatic profile ratios use the larger normal reserve.
  if (workingContextBudget !== null) {
    const explicitCompact = positiveFinite(options.compactThresholdTokens) !== undefined;
    const explicitCeiling = positiveFinite(options.hardCeilingTokens) !== undefined;
    if (explicitCompact && compactAutomaticCap !== undefined) {
      const explicitCap = Math.max(1, workingContextBudget - (emergencyHeadroomTokens ?? 0));
      const safe = clampPositive(thresholds.compactThresholdTokens, explicitCap);
      if (safe !== thresholds.compactThresholdTokens) {
        thresholds.compactThresholdTokens = safe;
        sources.compact = "small-window-clamp";
      }
    }
    if (explicitCeiling && ceilingCap !== undefined) {
      const safe = clampPositive(thresholds.hardCeilingTokens, ceilingCap);
      if (safe !== thresholds.hardCeilingTokens) {
        thresholds.hardCeilingTokens = safe;
        sources.hardCeiling = "small-window-clamp";
      }
    }
    // Explicit keepRecent remains bounded to the same safe budget, while the
    // profile default is already capped at 12.5% of the working budget.
    if (positiveFinite(options.keepRecentTokens) !== undefined) {
      const safe = clampPositive(
        thresholds.keepRecentTokens,
        Math.max(1, workingContextBudget - (emergencyHeadroomTokens ?? 0)),
      );
      if (safe !== thresholds.keepRecentTokens) {
        thresholds.keepRecentTokens = safe;
        sources.keepRecent = "small-window-clamp";
      }
    }
  }

  const orderingCaps: Partial<Record<keyof ContextThresholds, number>> = {};
  if (workingContextBudget !== null && ceilingCap !== undefined) {
    orderingCaps.keepRecentTokens = Math.max(0, ceilingCap - 3);
    orderingCaps.softWarningTokens = Math.max(1, ceilingCap - 2);
    orderingCaps.compactThresholdTokens = Math.max(1, ceilingCap - 1);
    orderingCaps.hardCeilingTokens = ceilingCap;
  }
  normalizeOrdering(thresholds, sources, orderingCaps);

  // Ordering repairs can raise a non-explicit boundary (for example relaxed
  // warning/compact ratios on a very small window). Re-apply the safety caps and
  // lower the preceding boundaries so the reserve remains authoritative.
  if (
    compactAutomaticCap !== undefined &&
    thresholds.compactThresholdTokens > compactAutomaticCap &&
    sources.compact !== "explicit-token-override"
  ) {
    thresholds.compactThresholdTokens = compactAutomaticCap;
    sources.compact = "small-window-clamp";
    if (thresholds.softWarningTokens >= thresholds.compactThresholdTokens) {
      thresholds.softWarningTokens = Math.max(1, thresholds.compactThresholdTokens - 1);
      sources.softWarning = "small-window-clamp";
    }
  }
  if (ceilingCap !== undefined && thresholds.hardCeilingTokens > ceilingCap) {
    thresholds.hardCeilingTokens = ceilingCap;
    sources.hardCeiling = "small-window-clamp";
  }
  if (thresholds.compactThresholdTokens >= thresholds.hardCeilingTokens) {
    thresholds.compactThresholdTokens = Math.max(1, thresholds.hardCeilingTokens - 1);
    sources.compact = "small-window-clamp";
  }
  if (thresholds.softWarningTokens >= thresholds.compactThresholdTokens) {
    thresholds.softWarningTokens = Math.max(1, thresholds.compactThresholdTokens - 1);
    sources.softWarning = "small-window-clamp";
  }
  if (thresholds.keepRecentTokens >= thresholds.softWarningTokens) {
    thresholds.keepRecentTokens = Math.max(0, thresholds.softWarningTokens - 1);
    sources.keepRecent = "small-window-clamp";
  }

  return {
    thresholds,
    profile,
    profilePolicy,
    workingContextBudget,
    logicalContextWindow,
    effectiveContextBudget,
    workingContextBudgetSource: effectiveContextBudget !== null
      ? "effective-context-budget"
      : logicalContextWindow !== null
        ? "logical-context-window"
        : "fallback",
    minimumHeadroomTokens,
    emergencyHeadroomTokens,
    sources,
  };
}

/** Descriptive alias for callers that prefer the policy-oriented name. */
export const resolveContextPolicy = resolveContextThresholds;

/**
 * Backward-compatible threshold-only API. New code should use
 * resolveContextThresholds() when it needs provenance or budget metadata.
 */
export function getEffectiveThresholds(
  config: LocalContextManagerConfig,
  contextWindow?: number,
  effectiveContextBudget?: number,
): ContextThresholds {
  return resolveContextThresholds({
    profile: config.contextProfile,
    logicalContextWindow: contextWindow,
    effectiveContextBudget: effectiveContextBudget ?? config.effectiveContextBudgetTokens,
    softWarningTokens: config.softWarningTokens,
    compactThresholdTokens: config.compactThresholdTokens,
    hardCeilingTokens: config.hardCeilingTokens,
    keepRecentTokens: config.keepRecentTokens,
  }).thresholds;
}

function configObject(value: unknown): RecordValue | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const nested = value.piLocalContextManager ?? value.localContextManager;
  return isRecord(nested) ? nested : value;
}

function describeSource(source: string): string {
  return source ? ` in ${source}` : "";
}

function applyLayer(
  base: LocalContextManagerConfig,
  raw: unknown,
  source: string,
  errors: string[],
): LocalContextManagerConfig {
  const values = configObject(raw);
  if (!values) {
    errors.push(`Ignoring malformed configuration${describeSource(source)}: expected a JSON object`);
    return { ...base };
  }

  const candidate: LocalContextManagerConfig = { ...base };
  const changedNumbers = new Set<NumberConfigKey>();
  const numericBase: Partial<Record<NumberConfigKey, number>> = {};
  for (const key of NUMBER_KEYS) {
    if (candidate[key] !== undefined) {
      numericBase[key] = candidate[key];
    }
  }

  if ("contextProfile" in values) {
    const value = values.contextProfile;
    if (!isContextProfile(value)) {
      errors.push(`Ignoring contextProfile${describeSource(source)}: expected aggressive, balanced, or relaxed`);
    } else {
      candidate.contextProfile = value;
    }
  }

  for (const key of BOOLEAN_KEYS) {
    if (!(key in values)) {
      continue;
    }
    if (typeof values[key] !== "boolean") {
      errors.push(`Ignoring ${key}${describeSource(source)}: expected a boolean`);
      continue;
    }
    candidate[key] = values[key];
  }

  if ("checkpointDirectory" in values) {
    const value = values.checkpointDirectory;
    if (
      value !== null &&
      (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value))
    ) {
      errors.push(
        `Ignoring checkpointDirectory${describeSource(source)}: expected a non-empty string or null`,
      );
    } else {
      candidate.checkpointDirectory = value === null ? null : value.trim();
    }
  }

  for (const key of NUMBER_KEYS) {
    if (!(key in values)) {
      continue;
    }
    const value = values[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      errors.push(`Ignoring ${key}${describeSource(source)}: expected a positive integer`);
      continue;
    }
    candidate[key] = value;
    changedNumbers.add(key);
  }

  const ordering = [
    ["keepRecentTokens", "softWarningTokens", "keepRecentTokens must be below softWarningTokens"],
    ["softWarningTokens", "compactThresholdTokens", "softWarningTokens must be below compactThresholdTokens"],
    ["compactThresholdTokens", "hardCeilingTokens", "compactThresholdTokens must be below hardCeilingTokens"],
  ] as const satisfies ReadonlyArray<readonly [ThresholdConfigKey, ThresholdConfigKey, string]>;
  const reported = new Set<string>();

  let changed = true;
  while (changed) {
    changed = false;
    // Only compare boundaries that are materialized as explicit values. An
    // unset neighbor is resolved against the active model budget later, so a
    // large absolute override must not be rejected merely because it exceeds
    // the legacy no-window fallback.
    const definedKeys = THRESHOLD_KEYS.filter((key) => candidate[key] !== undefined);
    for (let index = 0; index < definedKeys.length - 1; index += 1) {
      const lowerKey = definedKeys[index];
      const upperKey = definedKeys[index + 1];
      const message = ordering.find(
        ([expectedLower, expectedUpper]) => expectedLower === lowerKey && expectedUpper === upperKey,
      )?.[2] ?? `${lowerKey} must be below ${upperKey}`;
      if (candidate[lowerKey]! < candidate[upperKey]!) {
        continue;
      }
      if (!reported.has(message)) {
        errors.push(`Invalid token ordering${describeSource(source)}: ${message}`);
        reported.add(message);
      }

      const lowerChanged = changedNumbers.has(lowerKey);
      const upperChanged = changedNumbers.has(upperKey);
      if (lowerChanged && !upperChanged) {
        if (numericBase[lowerKey] === undefined) {
          delete candidate[lowerKey];
        } else {
          candidate[lowerKey] = numericBase[lowerKey];
        }
        changedNumbers.delete(lowerKey);
      } else if (upperChanged && !lowerChanged) {
        if (numericBase[upperKey] === undefined) {
          delete candidate[upperKey];
        } else {
          candidate[upperKey] = numericBase[upperKey];
        }
        changedNumbers.delete(upperKey);
      } else {
        if (!lowerChanged && !upperChanged) {
          break;
        }
        if (numericBase[lowerKey] === undefined) {
          delete candidate[lowerKey];
        } else {
          candidate[lowerKey] = numericBase[lowerKey];
        }
        if (numericBase[upperKey] === undefined) {
          delete candidate[upperKey];
        } else {
          candidate[upperKey] = numericBase[upperKey];
        }
        changedNumbers.delete(lowerKey);
        changedNumbers.delete(upperKey);
      }
      changed = true;
      break;
    }
  }

  return candidate;
}

export function parseConfig(
  raw: unknown,
  base: LocalContextManagerConfig = DEFAULT_CONFIG,
  source = "",
): { config: LocalContextManagerConfig; errors: string[] } {
  const errors: string[] = [];
  const config = applyLayer(base, raw, source, errors);
  return { config, errors };
}

async function readConfigFile(path: string): Promise<{ value?: unknown; error?: string; found: boolean }> {
  try {
    const text = await readFile(path, "utf8");
    try {
      return { value: JSON.parse(text) as unknown, found: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: `Ignoring malformed JSON in ${path}: ${message}`, found: true };
    }
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
    if (code === "ENOENT") {
      return { found: false };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { error: `Unable to read ${path}: ${message}`, found: true };
  }
}

export async function loadConfig(options: LoadConfigOptions): Promise<LoadedConfig> {
  let config: LocalContextManagerConfig = { ...DEFAULT_CONFIG };
  const errors: string[] = [];
  const files: string[] = [];

  let global = await readConfigFile(options.globalConfigPath);
  let globalPath = options.globalConfigPath;
  if (!global.found && options.fallbackGlobalConfigPath) {
    const fallback = await readConfigFile(options.fallbackGlobalConfigPath);
    if (fallback.found) {
      global = fallback;
      globalPath = options.fallbackGlobalConfigPath;
    }
  }
  if (global.found) {
    files.push(globalPath);
  }
  if (global.error) {
    errors.push(global.error);
  } else if (global.found) {
    const parsed = parseConfig(global.value, config, globalPath);
    config = parsed.config;
    errors.push(...parsed.errors);
  }

  if (options.allowProjectConfig !== false && options.projectConfigPath) {
    let project = await readConfigFile(options.projectConfigPath);
    let projectPath = options.projectConfigPath;
    if (!project.found && options.fallbackProjectConfigPath) {
      const fallback = await readConfigFile(options.fallbackProjectConfigPath);
      if (fallback.found) {
        project = fallback;
        projectPath = options.fallbackProjectConfigPath;
      }
    }
    if (project.found) {
      files.push(projectPath);
    }
    if (project.error) {
      errors.push(project.error);
    } else if (project.found) {
      const parsed = parseConfig(project.value, config, projectPath);
      config = parsed.config;
      errors.push(...parsed.errors);
    }
  }

  return { config, errors, files };
}
