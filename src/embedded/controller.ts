import {
  DEFAULT_CONFIG,
  resolveContextThresholds,
  type ContextThresholds,
  type LocalContextManagerConfig,
  type ResolvedContextPolicy,
} from "../config.js";
import {
  EvidenceReductionTracker,
  EVIDENCE_COMPLETENESS_NOTE,
} from "../evidence-provenance.js";
import { CompactionGate, getRearmTokens, shouldTriggerThresholdCompaction } from "../policy.js";
import { estimateActiveContextTokens } from "../session-utils.js";
import {
  appendFullOutputNotice,
  appendPrunedOutputNotice,
  extractFullOutputPath,
  reduceToolOutput,
  SessionRecoveryStorage,
} from "../tool-output.js";
import type {
  EmbeddedCompactionRequest,
  EmbeddedContextHost,
  EmbeddedContextManager,
  EmbeddedContextManagerOptions,
  EmbeddedContextSnapshot,
  EmbeddedContextUsage,
  EmbeddedToolResult,
} from "./types.js";

export class EmbeddedContextController implements EmbeddedContextManager {
  private readonly host: EmbeddedContextHost;
  private readonly config: LocalContextManagerConfig;
  private readonly mode: "root" | "managed-child";
  private readonly evidenceTracker = new EvidenceReductionTracker();
  private readonly gate: CompactionGate;
  private readonly recoveryStorage: SessionRecoveryStorage;
  private readonly ownsRecoveryStorage: boolean;

  private currentTokens: number | null = null;
  private currentContextWindow: number | null = null;
  private currentEffectiveContextBudget: number | null = null;
  private currentTokenSource: EmbeddedContextSnapshot["tokenSource"] = "unknown";
  private turnSerial = 0;
  private compactionsCount = 0;
  private deactivated = false;
  private disposed = false;

  constructor(host: EmbeddedContextHost, options: EmbeddedContextManagerOptions = {}) {
    this.host = host;
    this.mode = options.mode ?? "managed-child";
    if (options.recoveryStorage) {
      this.recoveryStorage = options.recoveryStorage;
      this.ownsRecoveryStorage = false;
    } else {
      this.recoveryStorage = new SessionRecoveryStorage({
        onDiagnostic: (message) => this.host.onDiagnostic?.({ level: "warning", message }),
      });
      this.ownsRecoveryStorage = true;
    }

    const baseConfig: LocalContextManagerConfig = {
      ...DEFAULT_CONFIG,
      ...(options.config ?? {}),
    };

    if (this.mode === "managed-child") {
      baseConfig.checkpointReset = false;
      baseConfig.handoff = false;
    }

    this.config = baseConfig;
    const logicalContextWindow = positiveFinite(options.logicalContextWindow) ?? positiveFinite(options.contextWindow);
    const effectiveContextBudget = minPositive(
      options.effectivePrefillBudget,
      options.effectiveContextBudget,
      baseConfig.effectiveContextBudgetTokens,
    );
    this.currentContextWindow = logicalContextWindow ?? null;
    this.currentEffectiveContextBudget = clampEffectiveBudget(effectiveContextBudget === null ? undefined : effectiveContextBudget, logicalContextWindow === null ? undefined : logicalContextWindow);
    const initialPolicy = this.resolvePolicy();
    this.gate = new CompactionGate({
      rearmTokens: getRearmTokens(initialPolicy.thresholds.softWarningTokens, initialPolicy.thresholds.compactThresholdTokens),
      workingContextBudget: initialPolicy.workingContextBudget ?? undefined,
    });

    this.refreshUsage();
  }

  private resolvePolicy(): ResolvedContextPolicy {
    return resolveContextThresholds({
      profile: this.config.contextProfile,
      logicalContextWindow: this.currentContextWindow ?? undefined,
      effectiveContextBudget: this.currentEffectiveContextBudget ?? this.config.effectiveContextBudgetTokens,
      softWarningTokens: this.config.softWarningTokens,
      compactThresholdTokens: this.config.compactThresholdTokens,
      hardCeilingTokens: this.config.hardCeilingTokens,
      keepRecentTokens: this.config.keepRecentTokens,
    });
  }

  private resolveThresholds(): ContextThresholds {
    return this.resolvePolicy().thresholds;
  }

  private refreshUsage(): { tokens: number | null; thresholds: ContextThresholds } {
    if (this.disposed) {
      return { tokens: null, thresholds: this.resolveThresholds() };
    }

    let usage: EmbeddedContextUsage | null = null;
    try {
      usage = this.host.getContextUsage();
    } catch (error) {
      this.host.onDiagnostic?.({
        level: "warning",
        message: `Error reading host context usage: ${error instanceof Error ? error.message : String(error)}`,
        error,
      });
    }

    const logicalContextWindow = positiveFinite(usage?.logicalContextWindow ?? usage?.contextWindow) ?? this.currentContextWindow;
    const usageEffectiveCandidates = [usage?.effectiveContextBudget, usage?.effectivePrefillBudget]
      .map(positiveFinite)
      .filter((value): value is number => value !== undefined);
    const hasUsageEffectiveValue = usage?.effectiveContextBudget !== undefined || usage?.effectivePrefillBudget !== undefined;
    const effectiveContextBudget = usageEffectiveCandidates.length > 0
      ? Math.min(...usageEffectiveCandidates)
      : !hasUsageEffectiveValue
      ? this.currentEffectiveContextBudget
      : null;
    this.currentContextWindow = logicalContextWindow ?? null;
    this.currentEffectiveContextBudget = clampEffectiveBudget(effectiveContextBudget === null ? undefined : effectiveContextBudget, logicalContextWindow === null ? undefined : logicalContextWindow);

    if (usage && usage.tokens !== null && Number.isFinite(usage.tokens) && usage.tokens >= 0) {
      this.currentTokens = usage.tokens;
      this.currentTokenSource = usage.source ?? "pi-estimate";
    } else {
      try {
        const entries = this.host.getContextEntries();
        this.currentTokens = estimateActiveContextTokens(entries);
        this.currentTokenSource = "local-fallback";
      } catch (error) {
        this.currentTokens = null;
        this.currentTokenSource = "unknown";
        this.host.onDiagnostic?.({
          level: "warning",
          message: `Error estimating active context: ${error instanceof Error ? error.message : String(error)}`,
          error,
        });
      }
    }

    const policy = this.resolvePolicy();
    const thresholds = policy.thresholds;
    this.gate.setRearmTokens(getRearmTokens(thresholds.softWarningTokens, thresholds.compactThresholdTokens));
    this.gate.setWorkingContextBudget(policy.workingContextBudget);
    this.gate.observe(this.currentTokens, thresholds.compactThresholdTokens);

    try {
      this.host.onStatus?.(this.snapshot());
    } catch {
      // Host status notification is non-fatal
    }

    return { tokens: this.currentTokens, thresholds };
  }

  observeTurnStart(): void {
    if (this.disposed || this.deactivated) return;
    this.turnSerial += 1;
    this.refreshUsage();
  }

  observeTurnEnd(): void {
    if (this.disposed || this.deactivated) return;
    this.refreshUsage();
  }

  async observeSettled(): Promise<void> {
    if (this.disposed || this.deactivated || !this.config.enabled) {
      return;
    }

    const { tokens, thresholds } = this.refreshUsage();

    if (!shouldTriggerThresholdCompaction(tokens, thresholds.compactThresholdTokens)) {
      return;
    }

    if (!this.gate.canRequest(this.turnSerial, false) || !this.gate.request(this.turnSerial)) {
      return;
    }

    const request: EmbeddedCompactionRequest = {
      reason: "threshold",
    };

    if (this.evidenceTracker.hasReducedSinceLastCompaction) {
      request.customInstructions = EVIDENCE_COMPLETENESS_NOTE;
    }

    try {
      await this.host.compact(request);
      this.compactionsCount += 1;
      this.evidenceTracker.markCompaction();

      const postUsage = this.refreshUsage();
      this.gate.complete(postUsage.tokens, this.turnSerial);
    } catch (error) {
      this.gate.fail(this.turnSerial);
      const message = error instanceof Error ? error.message : String(error);
      this.host.onDiagnostic?.({
        level: "warning",
        message: `Embedded compaction failed: ${message}`,
        error,
      });
    }
  }

  async transformToolResult(result: EmbeddedToolResult): Promise<EmbeddedToolResult> {
    if (this.disposed || this.deactivated || !this.config.enabled || !this.config.toolOutputReduction) {
      return result;
    }

    this.recoveryStorage.noteReferences(result.input);
    if (result.isError) {
      const pruned = this.recoveryStorage.findPrunedReferences(result.input);
      if (pruned.length > 0) {
        return { ...result, content: appendPrunedOutputNotice(result.content, pruned) };
      }
    }

    let reduction;
    try {
      reduction = reduceToolOutput({
        toolName: result.toolName,
        input: result.input,
        content: result.content,
        details: result.details,
        isError: result.isError,
      });
    } catch (error) {
      this.host.onDiagnostic?.({
        level: "warning",
        message: `Tool output reduction failed: ${error instanceof Error ? error.message : String(error)}`,
        error,
      });
      return result;
    }

    if (!reduction.changed) {
      return result;
    }

    let fullOutputPath = extractFullOutputPath(result.details, reduction.originalText);
    if (!fullOutputPath) {
      try {
        fullOutputPath = await this.recoveryStorage.save(reduction.originalText, result.toolName);
      } catch (error) {
        this.host.onDiagnostic?.({
          level: "warning",
          message: `Could not save recovery copy: ${error instanceof Error ? error.message : String(error)}`,
          error,
        });
      }
    }

    if (!fullOutputPath) {
      // P0.3: Embedded output reduction can lose authoritative output if recovery storage fails.
      // Match root LCM semantics: preserve original tool result byte-for-byte, do not record evidence reduction.
      this.host.onDiagnostic?.({
        level: "warning",
        message: `Preserving original tool output because recovery storage is unavailable for ${result.toolName}`,
      });
      return result;
    }

    if (reduction.category) {
      this.evidenceTracker.record(reduction.category);
    }

    let content = reduction.content;
    if (
      !content.some(
        (block) =>
          block.type === "text" &&
          block.text.toLowerCase().includes("full output") &&
          block.text.includes(fullOutputPath),
      )
    ) {
      content = appendFullOutputNotice(content, fullOutputPath, this.recoveryStorage.retentionNote);
    }

    try {
      this.host.onStatus?.(this.snapshot());
    } catch {
      // Best effort
    }

    return {
      ...result,
      content,
    };
  }

  snapshot(): EmbeddedContextSnapshot {
    const policy = this.resolvePolicy();
    const thresholds = policy.thresholds;
    const percentOfThreshold =
      this.currentTokens !== null && thresholds.compactThresholdTokens > 0
        ? (this.currentTokens / thresholds.compactThresholdTokens) * 100
        : null;
    const percentOfWorkingBudget =
      this.currentTokens !== null && policy.workingContextBudget !== null && policy.workingContextBudget > 0
        ? (this.currentTokens / policy.workingContextBudget) * 100
        : null;

    return {
      tokens: this.currentTokens,
      contextTokens: this.currentTokens,
      contextWindow: this.currentContextWindow,
      logicalContextWindow: this.currentContextWindow,
      effectiveContextBudget: this.currentEffectiveContextBudget,
      workingContextBudget: policy.workingContextBudget,
      workingContextBudgetSource: policy.workingContextBudgetSource,
      percentOfWorkingBudget,
      tokenSource: this.currentTokenSource,
      softWarningTokens: thresholds.softWarningTokens,
      compactThresholdTokens: thresholds.compactThresholdTokens,
      hardCeilingTokens: thresholds.hardCeilingTokens,
      keepRecentTokens: thresholds.keepRecentTokens,
      thresholdSources: policy.sources,
      percentOfThreshold,
      thresholdRatio: percentOfThreshold !== null ? percentOfThreshold / 100 : undefined,
      mode: this.mode,
      enabled: this.config.enabled && !this.deactivated && !this.disposed,
      toolOutputsReduced: this.evidenceTracker.totalReducedCount,
      reducedOutputsSinceCompaction: this.evidenceTracker.reducedSinceLastCompactionCount,
      compactions: this.compactionsCount,
    };
  }

  deactivate(): void {
    if (this.disposed) return;
    // Recovery files are intentionally retained. A reduced tool result may
    // already be present in the child transcript, and deleting its referenced
    // file during an embedded->native fallback would make that transcript
    // unrecoverable.
    this.deactivated = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.deactivated = true;
    this.disposed = true;
    if (this.ownsRecoveryStorage) {
      void this.recoveryStorage.cleanup().catch(() => undefined);
    }
  }
}

function positiveFinite(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function minPositive(...values: unknown[]): number | undefined {
  const candidates = values.map(positiveFinite).filter((value): value is number => value !== undefined);
  return candidates.length > 0 ? Math.min(...candidates) : undefined;
}

function clampEffectiveBudget(effective: number | undefined, logical: number | undefined): number | null {
  if (effective === undefined) return null;
  return logical === undefined ? effective : Math.min(effective, logical);
}

export function createEmbeddedContextManager(
  host: EmbeddedContextHost,
  options?: EmbeddedContextManagerOptions,
): EmbeddedContextManager {
  return new EmbeddedContextController(host, options);
}
