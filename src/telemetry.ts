import type { ResolvedContextPolicy } from "./config.js";

export interface ContextUsageLike {
  tokens: number | null;
  contextWindow: number;
  /** Advertised/logical model window when a runtime supplies a separate budget. */
  logicalContextWindow?: number | null;
  /** Runtime-safe budget used by proactive context management. */
  effectiveContextBudget?: number | null;
  /** Compatibility alias for effectiveContextBudget. */
  effectivePrefillBudget?: number | null;
}

export type ContextTokenSource =
  | "pi-estimate"
  | "local-fallback"
  | "reported"
  | "estimated"
  | "unknown";

export interface TelemetrySnapshot {
  contextTokens: number | null;
  contextWindow: number | null;
  logicalContextWindow: number | null;
  effectiveContextBudget: number | null;
  workingContextBudget: number | null;
  percentOfWorkingBudget: number | null;
  postCompactionTokens: number | null;
  epochSlackTokens: number | null;
  epochSlackRatio: number | null;
  tokenSource: ContextTokenSource;
  compactThresholdTokens: number;
  percentOfThreshold: number | null;
  tokensAddedSinceCompaction: number | null;
  approximateToolOutputTokens: number;
  toolOutputTokensRemoved: number;
  toolOutputsReduced: number;
  compactions: number;
  lastCompactionAt: number | null;
  lastCompactionTurn: number | null;
  checkpointResets: number;
  lastCheckpointResetAt: number | null;
  lastCheckpointPath: string | null;
  currentTurn: number;
}

export class ContextTelemetry {
  private contextTokens: number | null = null;
  private contextWindow: number | null = null;
  private logicalContextWindow: number | null = null;
  private effectiveContextBudget: number | null = null;
  private tokenSource: ContextTokenSource = "unknown";
  private baselineTokens: number | null = null;
  private hasCompactionBaseline = false;
  private tokensAddedSinceCompaction: number | null = null;
  private approximateToolOutputTokens = 0;
  private toolOutputTokensRemoved = 0;
  private toolOutputsReduced = 0;
  private compactions: number;
  private lastCompactionAt: number | null;
  private lastCompactionTurn: number | null;
  private checkpointResets: number;
  private lastCheckpointResetAt: number | null;
  private lastCheckpointPath: string | null;
  private currentTurn = 0;

  constructor(
    compactions = 0,
    lastCompactionAt: number | null = null,
    checkpointResets = 0,
    lastCheckpointResetAt: number | null = null,
    lastCheckpointPath: string | null = null,
  ) {
    this.compactions = compactions;
    this.lastCompactionAt = lastCompactionAt;
    this.lastCompactionTurn = null;
    this.checkpointResets = checkpointResets;
    this.lastCheckpointResetAt = lastCheckpointResetAt;
    this.lastCheckpointPath = lastCheckpointPath;
  }

  observe(usage: ContextUsageLike | undefined): void {
    if (!usage) {
      return;
    }

    this.contextWindow = positiveFinite(usage.contextWindow);
    const logicalContextWindow = positiveFinite(usage.logicalContextWindow) ?? positiveFinite(usage.contextWindow);
    if (logicalContextWindow !== null) {
      this.logicalContextWindow = logicalContextWindow;
    }
    const effectiveCandidates = [usage.effectiveContextBudget, usage.effectivePrefillBudget]
      .map(positiveFinite)
      .filter((value): value is number => value !== null);
    if (effectiveCandidates.length > 0) {
      this.effectiveContextBudget = Math.min(...effectiveCandidates);
    } else if (usage.effectiveContextBudget !== undefined || usage.effectivePrefillBudget !== undefined) {
      this.effectiveContextBudget = null;
    }
    if (usage.tokens === null || !Number.isFinite(usage.tokens) || usage.tokens < 0) {
      this.contextTokens = null;
      this.tokensAddedSinceCompaction = null;
      this.tokenSource = "unknown";
      return;
    }

    this.setObservedTokens(usage.tokens);
    this.tokenSource = "pi-estimate";
  }

  observeEstimate(tokens: number, contextWindow?: number): void {
    const normalizedWindow = positiveFinite(contextWindow);
    if (normalizedWindow !== null) {
      this.contextWindow = normalizedWindow;
      this.logicalContextWindow = normalizedWindow;
    }
    if (!Number.isFinite(tokens) || tokens < 0) {
      this.tokenSource = "unknown";
      return;
    }
    this.setObservedTokens(tokens);
    this.tokenSource = "local-fallback";
  }

  private setObservedTokens(tokens: number): void {
    this.contextTokens = tokens;
    if (this.baselineTokens === null) {
      this.baselineTokens = tokens;
    }
    this.tokensAddedSinceCompaction = Math.max(0, tokens - this.baselineTokens);
  }

  markTurn(turn: number): void {
    if (Number.isFinite(turn) && turn >= 0) {
      this.currentTurn = turn;
    }
  }

  setCompactionBaseline(tokens: number): void {
    if (!Number.isFinite(tokens) || tokens < 0) {
      return;
    }
    this.baselineTokens = tokens;
    this.hasCompactionBaseline = true;
    if (this.contextTokens !== null) {
      this.tokensAddedSinceCompaction = Math.max(0, this.contextTokens - tokens);
    }
  }

  recordToolOutput(tokens: number): void {
    if (Number.isFinite(tokens) && tokens > 0) {
      this.approximateToolOutputTokens += Math.floor(tokens);
    }
  }

  recordToolReduction(originalTokens: number, retainedTokens: number): void {
    const original = Math.max(0, originalTokens);
    const retained = Math.max(0, Math.min(original, retainedTokens));
    this.recordToolOutput(retained);
    this.toolOutputTokensRemoved += original - retained;
    this.toolOutputsReduced += 1;
  }

  setActiveToolOutputTokens(tokens: number): void {
    this.approximateToolOutputTokens = Number.isFinite(tokens) ? Math.max(0, Math.floor(tokens)) : 0;
  }

  markCompaction(
    timestamp: number,
    turn: number,
    postTokens: number | null,
    activeToolOutputTokens: number,
    source?: ContextTokenSource,
  ): void {
    this.compactions += 1;
    this.lastCompactionAt = Number.isFinite(timestamp) ? timestamp : Date.now();
    this.lastCompactionTurn = turn;
    this.baselineTokens = postTokens !== null && Number.isFinite(postTokens) ? postTokens : null;
    this.hasCompactionBaseline = postTokens !== null && Number.isFinite(postTokens);
    this.contextTokens = postTokens !== null && Number.isFinite(postTokens) ? postTokens : null;
    this.tokensAddedSinceCompaction = postTokens !== null && Number.isFinite(postTokens) ? 0 : null;
    if (source) {
      this.tokenSource = source;
    } else if (postTokens === null) {
      this.tokenSource = "unknown";
    }
    this.setActiveToolOutputTokens(activeToolOutputTokens);
  }

  markCheckpointReset(timestamp: number, path: string, lineageCount?: number): void {
    if (lineageCount === undefined) {
      this.checkpointResets += 1;
    } else if (Number.isSafeInteger(lineageCount) && lineageCount >= 0) {
      this.checkpointResets = lineageCount;
    }
    this.lastCheckpointResetAt = Number.isFinite(timestamp) ? timestamp : Date.now();
    this.lastCheckpointPath = path;
  }

  snapshot(
    compactThresholdTokens: number,
    policy?: Pick<ResolvedContextPolicy, "workingContextBudget" | "logicalContextWindow" | "effectiveContextBudget">,
  ): TelemetrySnapshot {
    const logicalContextWindow = policy?.logicalContextWindow ?? this.logicalContextWindow;
    const effectiveContextBudget = policy?.effectiveContextBudget ?? this.effectiveContextBudget;
    // A policy is required to make the working-budget denominator authoritative.
    // Without one, retain the historical threshold-only snapshot semantics for
    // embedders that only consume ContextTelemetry directly.
    const workingContextBudget = policy?.workingContextBudget ?? null;
    const percentOfThreshold =
      this.contextTokens !== null && compactThresholdTokens > 0
        ? (this.contextTokens / compactThresholdTokens) * 100
        : null;
    const percentOfWorkingBudget =
      this.contextTokens !== null && workingContextBudget !== null && workingContextBudget > 0
        ? (this.contextTokens / workingContextBudget) * 100
        : null;
    const epochSlackTokens =
      policy?.workingContextBudget !== null && policy !== undefined && this.hasCompactionBaseline && this.baselineTokens !== null
        ? compactThresholdTokens - this.baselineTokens
        : null;
    const epochSlackRatio =
      epochSlackTokens !== null && workingContextBudget !== null && workingContextBudget > 0
        ? epochSlackTokens / workingContextBudget
        : null;

    return {
      contextTokens: this.contextTokens,
      contextWindow: this.contextWindow,
      logicalContextWindow,
      effectiveContextBudget,
      workingContextBudget,
      percentOfWorkingBudget,
      postCompactionTokens: this.hasCompactionBaseline ? this.baselineTokens : null,
      epochSlackTokens,
      epochSlackRatio,
      tokenSource: this.tokenSource,
      compactThresholdTokens,
      percentOfThreshold,
      tokensAddedSinceCompaction: this.tokensAddedSinceCompaction,
      approximateToolOutputTokens: this.approximateToolOutputTokens,
      toolOutputTokensRemoved: this.toolOutputTokensRemoved,
      toolOutputsReduced: this.toolOutputsReduced,
      compactions: this.compactions,
      lastCompactionAt: this.lastCompactionAt,
      lastCompactionTurn: this.lastCompactionTurn,
      checkpointResets: this.checkpointResets,
      lastCheckpointResetAt: this.lastCheckpointResetAt,
      lastCheckpointPath: this.lastCheckpointPath,
      currentTurn: this.currentTurn,
    };
  }
}

export function formatTokenCount(tokens: number | null): string {
  if (tokens === null) {
    return "?";
  }
  if (tokens < 1_000) {
    return `${Math.round(tokens)}`;
  }
  if (tokens < 10_000) {
    return `${(tokens / 1_000).toFixed(1)}k`;
  }
  return `${Math.round(tokens / 1_000)}k`;
}

export function formatTokenSourceDescription(source: ContextTokenSource): string {
  switch (source) {
    case "pi-estimate":
    case "reported":
      return "Pi estimate";
    case "local-fallback":
    case "estimated":
      return "local fallback estimate";
    default:
      return "unknown";
  }
}

export function formatTelemetryStatus(snapshot: TelemetrySnapshot): string {
  const tokenFormatted = formatTokenCount(snapshot.contextTokens);
  const isEstimate =
    (snapshot.tokenSource === "local-fallback" || snapshot.tokenSource === "estimated") &&
    snapshot.contextTokens !== null;
  const context = isEstimate ? `~${tokenFormatted}` : tokenFormatted;
  const denominator = snapshot.workingContextBudget ?? snapshot.compactThresholdTokens;
  const threshold = formatTokenCount(denominator);
  const percentValue = snapshot.percentOfWorkingBudget ?? snapshot.percentOfThreshold;
  const percent = percentValue === null ? "?" : `${Math.round(percentValue)}%`;
  const added = formatTokenCount(snapshot.tokensAddedSinceCompaction);
  const tools = formatTokenCount(snapshot.approximateToolOutputTokens);
  const compact = snapshot.workingContextBudget !== null
    ? ` · compact ${formatTokenCount(snapshot.compactThresholdTokens)}`
    : "";
  return `ctx ${context}/${threshold} (${percent})${compact} · +${added} · tool≈${tools} · c${snapshot.compactions}`;
}

export function formatTelemetryDetails(snapshot: TelemetrySnapshot): string {
  const tokenFormatted = formatTokenCount(snapshot.contextTokens);
  const sourceDescription = formatTokenSourceDescription(snapshot.tokenSource);
  const sourceLabel = snapshot.tokenSource !== "unknown" ? ` (${sourceDescription})` : "";
  const lines = [
    `Context: ${tokenFormatted} tokens${sourceLabel}`,
    `Token source: ${sourceDescription}`,
    `Context window: ${formatTokenCount(snapshot.contextWindow)}`,
    `Logical model window: ${formatTokenCount(snapshot.logicalContextWindow)}`,
    `Effective working budget: ${formatTokenCount(snapshot.workingContextBudget)}`,
    `Budget consumed: ${snapshot.percentOfWorkingBudget === null ? "unknown" : `${snapshot.percentOfWorkingBudget.toFixed(1)}%`}`,
    `Compact threshold: ${formatTokenCount(snapshot.compactThresholdTokens)} tokens`,
    `Threshold consumed: ${snapshot.percentOfThreshold === null ? "unknown" : `${snapshot.percentOfThreshold.toFixed(1)}%`}`,
    `Post-compaction slack: ${snapshot.epochSlackTokens === null ? "unknown" : `${formatTokenCount(snapshot.epochSlackTokens)} tokens${snapshot.epochSlackRatio === null ? "" : ` (${(snapshot.epochSlackRatio * 100).toFixed(1)}% of working budget)`}`}`,
    `Added since compaction: ${formatTokenCount(snapshot.tokensAddedSinceCompaction)} tokens`,
    `Active tool output: approximately ${formatTokenCount(snapshot.approximateToolOutputTokens)} tokens`,
    `Tool output reduced: ${snapshot.toolOutputsReduced} result(s), approximately ${formatTokenCount(snapshot.toolOutputTokensRemoved)} tokens removed`,
    `Compactions in session: ${snapshot.compactions}`,
    `Last compaction: ${snapshot.lastCompactionAt === null ? "never" : new Date(snapshot.lastCompactionAt).toISOString()}`,
    `Checkpoint resets in session lineage: ${snapshot.checkpointResets}`,
    `Last checkpoint reset: ${snapshot.lastCheckpointResetAt === null ? "never" : new Date(snapshot.lastCheckpointResetAt).toISOString()}`,
  ];
  if (snapshot.lastCheckpointPath !== null) {
    lines.push(`Last checkpoint path: ${snapshot.lastCheckpointPath}`);
  }
  if (snapshot.lastCompactionTurn !== null) {
    lines.push(`Last compaction turn: ${snapshot.lastCompactionTurn}`);
  }
  return lines.join("\n");
}

function positiveFinite(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : null;
}
