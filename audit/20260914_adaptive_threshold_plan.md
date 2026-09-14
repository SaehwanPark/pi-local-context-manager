# Implementation Plan: Adaptive Context Threshold Policy

## 1. Objective

Refactor `pi-local-context-manager` so context-management thresholds adapt naturally across models with substantially different usable context sizes.

The current implementation already adapts downward for constrained context windows, but intentionally does not scale thresholds upward. As a result, the default balanced profile remains approximately:

* keep recent: 10k
* warning: 24k
* proactive compaction: 32k
* hard ceiling: 48k

even when a model exposes 128k, 256k, or a substantially larger context window.

This can make proactive compaction unnecessarily frequent on large-context models and can leave very little useful context growth between native Pi compactions and subsequent LCM compactions. The current hysteresis logic prevents pathological immediate loops, but it does not address an unnecessarily small working-context budget.

The new policy should make profile semantics proportional to the model/runtime's **usable working context**, while remaining conservative on constrained local-model setups.

---

# 2. Design principles

The implementation should follow these principles.

### 2.1 Profiles describe aggressiveness, not token counts

`aggressive`, `balanced`, and `relaxed` should primarily answer:

> How much of the safely usable context should LCM consume before intervening?

They should no longer primarily mean:

> Use approximately 24k, 32k, or 48k tokens regardless of model size.

This makes profile behavior consistent across 32k, 64k, 128k, and 256k models.

### 2.2 Advertised context and usable context are different concepts

Do not assume that a model advertising 128k or 256k is equally comfortable using all of that context on every runtime or machine.

Define two concepts:

```ts
logicalContextWindow
effectiveContextBudget
```

where:

```text
logicalContextWindow
= model/runtime advertised context capacity

effectiveContextBudget
= context size LCM should actually treat as safely usable
```

Threshold calculations should prefer:

```text
effectiveContextBudget
→ logicalContextWindow
→ conservative legacy fallback
```

The embedded controller already distinguishes logical context from `effectivePrefillBudget` / `effectiveContextBudget`; the root extension should use the same abstraction.

### 2.3 Small windows require absolute headroom

Pure percentage scaling is unsafe for small windows because a full assistant/tool turn can consume a substantial fraction of the remaining context.

Therefore percentage thresholds must be combined with a minimum-response-headroom rule.

### 2.4 `keepRecentTokens` is different from pressure thresholds

Do not simply scale `keepRecentTokens` upward with context size.

The recent-context retention target should remain bounded because its purpose is to preserve a useful unsummarized tail while allowing compaction to reclaim substantial context.

### 2.5 Explicit numeric settings remain authoritative

Advanced users may know that a specific local configuration becomes slow or unstable beyond, for example, 52k tokens.

An explicit:

```json
{
  "compactThresholdTokens": 52000
}
```

should remain meaningful and should not unexpectedly become a percentage of the model window.

### 2.6 Pi remains the emergency authority

LCM should continue to:

* avoid intercepting Pi overflow recovery;
* use proactive compaction only at safe boundaries;
* leave Pi's emergency context protection intact;
* preserve existing cooldown and hysteresis protections.

---

# 3. New policy model

## 3.1 Working context budget

Introduce one canonical value:

```ts
workingContextBudget
```

Resolve it approximately as:

```ts
workingContextBudget =
  effectiveContextBudget
  ?? effectivePrefillBudget
  ?? logicalContextWindow
  ?? model.contextWindow
  ?? undefined;
```

When multiple values are available:

```ts
workingContextBudget = Math.min(
  logicalContextWindow,
  effectiveContextBudget
);
```

if both are known.

The effective budget must never exceed the logical model context window.

---

# 4. Profile definitions

Replace token-based profile defaults for the three pressure boundaries with ratio-based defaults.

Recommended initial values:

| Profile    | Warning | Proactive compaction | Hard ceiling | Keep recent cap |
| ---------- | ------: | -------------------: | -----------: | --------------: |
| aggressive |     40% |                  50% |          65% |              8k |
| balanced   |   52.5% |                  65% |          80% |             10k |
| relaxed    |   62.5% |                  75% |        87.5% |             12k |

Represent them explicitly:

```ts
export interface ContextProfilePolicy {
  warningRatio: number;
  compactRatio: number;
  ceilingRatio: number;
  keepRecentTokens: number;
}
```

For example:

```ts
const CONTEXT_PROFILE_POLICIES = {
  aggressive: {
    warningRatio: 0.40,
    compactRatio: 0.50,
    ceilingRatio: 0.65,
    keepRecentTokens: 8_000,
  },
  balanced: {
    warningRatio: 0.525,
    compactRatio: 0.65,
    ceilingRatio: 0.80,
    keepRecentTokens: 10_000,
  },
  relaxed: {
    warningRatio: 0.625,
    compactRatio: 0.75,
    ceilingRatio: 0.875,
    keepRecentTokens: 12_000,
  },
};
```

Treat these as initial defaults subject to benchmark validation.

---

# 5. Small-window safety

## 5.1 Headroom constraint

Percentage thresholds should not consume so much context that the next assistant/tool cycle immediately risks native Pi compaction or overflow.

Introduce a reserve calculation such as:

```ts
responseHeadroom = calculateResponseHeadroom(workingContextBudget);
```

A reasonable initial policy:

```text
normal/large windows:
  max(16k, 10% of working budget)

small windows:
  clamp the reserve so it does not consume an unreasonable
  fraction of the total budget
```

One possible implementation:

```ts
function getMinimumHeadroom(budget: number): number {
  return Math.min(
    Math.floor(budget * 0.40),
    Math.max(8_000, Math.min(16_384, Math.floor(budget * 0.25))),
  );
}
```

The precise formula should be validated experimentally rather than treated as fixed doctrine.

The proactive compaction threshold becomes bounded by:

```text
compactThreshold
<= workingContextBudget - minimumHeadroom
```

Likewise:

```text
hardCeiling
<= workingContextBudget - emergencyHeadroom
```

with a smaller remaining reserve permitted at the hard ceiling.

---

# 6. Threshold resolution

Introduce one central resolver.

Suggested API:

```ts
interface ResolveThresholdOptions {
  profile: ContextProfile;
  logicalContextWindow?: number;
  effectiveContextBudget?: number;

  softWarningTokens?: number;
  compactThresholdTokens?: number;
  hardCeilingTokens?: number;
  keepRecentTokens?: number;
}

function resolveContextThresholds(
  options: ResolveThresholdOptions,
): ContextThresholds;
```

The calculation should proceed in this order:

```text
1. Resolve working context budget.

2. Load ratio policy for selected profile.

3. Calculate automatic warning / compact / ceiling
   from working budget.

4. Apply small-window/headroom constraints.

5. Calculate bounded keepRecentTokens.

6. Apply explicit advanced numeric overrides.

7. Validate final ordering and safety invariants.

8. Return both effective thresholds and provenance.
```

---

# 7. Preserve threshold provenance

LCM should know whether each threshold came from:

* profile ratio;
* explicit absolute user override;
* small-window safety clamp;
* legacy/fallback behavior.

Add diagnostic metadata such as:

```ts
interface ResolvedContextPolicy {
  thresholds: ContextThresholds;
  workingContextBudget: number | null;
  logicalContextWindow: number | null;
  effectiveContextBudget: number | null;

  sources: {
    softWarning: ThresholdSource;
    compact: ThresholdSource;
    hardCeiling: ThresholdSource;
    keepRecent: ThresholdSource;
  };
}
```

Possible source type:

```ts
type ThresholdSource =
  | "profile-ratio"
  | "explicit-token-override"
  | "small-window-clamp"
  | "fallback";
```

This will make `/context-stats` substantially easier to interpret and debug.

---

# 8. Configuration model

## 8.1 Distinguish unset from default

Currently profiles materialize into numeric token settings. That makes it difficult to determine whether `32_000` is:

* the extension's balanced default, or
* an explicit user request.

Change the internal representation so numeric fields can be absent:

```ts
interface LocalContextManagerConfig {
  contextProfile: ContextProfile;

  softWarningTokens?: number;
  compactThresholdTokens?: number;
  hardCeilingTokens?: number;
  keepRecentTokens?: number;

  effectiveContextBudgetTokens?: number;

  // existing behavioral settings...
}
```

Profile selection should no longer copy token thresholds into these fields.

Instead:

```text
profile = automatic policy
numeric field = explicit override
```

This separation is important.

---

# 9. Backward compatibility

Existing configuration files must continue to work.

For example:

```json
{
  "contextProfile": "balanced",
  "compactThresholdTokens": 40000
}
```

should mean:

```text
Use the balanced automatic policy,
but force proactive compaction at 40k.
```

Do not silently reinterpret existing token overrides as ratios.

### Legacy profile-only configurations

For:

```json
{
  "contextProfile": "balanced"
}
```

the behavior intentionally changes from fixed ~32k proactive compaction to adaptive percentage-based compaction.

This should be documented as a deliberate policy change.

---

# 10. Effective prefill budget

Add a root-level equivalent of the embedded controller's existing effective budget support.

Possible configuration:

```json
{
  "effectiveContextBudgetTokens": 80000
}
```

Example:

```text
model advertises:       128k
runtime-safe budget:     80k
balanced compaction:   ~52k
hard ceiling:          ~64k
```

instead of either:

```text
legacy fixed compact:    32k
```

or:

```text
blind 65% of 128k:       83k
```

This gives users with constrained local hardware a direct and understandable control.

---

# 11. Future runtime integration

Do not require runtime auto-detection in the first implementation.

However, design the resolver so a runtime or companion extension can eventually supply:

```ts
effectivePrefillBudget
```

without changing policy code.

Possible future sources include:

* oMLX memory-guard limits;
* llama.cpp configured context;
* runtime-provided usable context;
* empirically learned prefill-performance knee;
* companion extension telemetry.

The current work should provide the abstraction, not attempt autonomous hardware tuning yet.

---

# 12. `keepRecentTokens`

Retain the current conceptual behavior:

```ts
keepRecentTokens = Math.min(
  profileKeepRecentCap,
  constrainedWindowFraction,
);
```

For example:

```ts
automaticKeepRecent = Math.min(
  profile.keepRecentTokens,
  Math.floor(workingContextBudget * 0.125),
);
```

This gives:

```text
16k budget  → ≤2k
32k budget  → ≤4k
64k budget  → ≤8k
128k budget → 10k balanced cap
256k budget → 10k balanced cap
```

This property is desirable.

An explicit user override should still be accepted subject to ordering and safety validation.

---

# 13. Post-compaction epoch slack

Add an explicit policy invariant:

> Routine successful compaction should normally create substantial working-context slack before the next proactive compaction.

The current `CompactionGate` already prevents immediate retriggering with hysteresis and meaningful-growth checks. Preserve it.

However, additionally diagnose cases where:

```text
compactThreshold - postCompactionTokens
```

is unexpectedly small.

For example:

```ts
epochSlackRatio =
  (compactThreshold - postCompactionTokens)
  / workingContextBudget;
```

Potential diagnostic condition:

```text
epoch slack < 10% of working budget
```

or:

```text
epoch slack < max(8k, 10% budget)
```

Initially this can be telemetry/debug information rather than dynamically changing thresholds.

This will help validate whether the new profile ratios actually solve the frequent-compaction UX problem.

---

# 14. Compaction gate

Do not substantially redesign `CompactionGate`.

Preserve:

* in-flight protection;
* minimum turn gap;
* post-compaction growth requirement;
* retry backoff after failures;
* rearm watermark;
* semantic-compaction handling.

Its current role is useful and orthogonal to threshold selection.

Potential small improvement:

Scale the default growth margin relative to the working budget rather than relying primarily on a 1,500-token absolute floor.

For example:

```ts
growthMargin = Math.max(
  1_500,
  Math.floor(workingContextBudget * 0.03),
);
```

with sensible upper bounds.

This should be a secondary change and independently tested.

---

# 15. Warning behavior

Warnings should describe context pressure relative to the **working budget**, not merely relative to the compact threshold.

Current status reporting primarily expresses percentage-of-compaction-threshold.

Add:

```text
Context: 61k
Working budget: 96k
Model window: 128k
Budget used: 64%
Compact at: 62k
```

instead of only:

```text
ctx 61k/62k (98%)
```

The latter makes it easy to mistakenly interpret a threshold as the model's true context capacity.

---

# 16. `/context-stats`

Expand `/context-stats` to report:

```text
Context mode: balanced

Current context: 61,200 tokens
Logical model window: 128,000 tokens
Effective working budget: 96,000 tokens
Working budget source: configured effective budget

Effective thresholds:
  keep recent: 10,000
  warning: 50,400
  proactive compact: 62,400
  hard ceiling: 76,800

Budget consumed: 63.8%
Compact threshold consumed: 98.1%

Threshold policy:
  warning: balanced ratio (52.5%)
  compact: balanced ratio (65%)
  ceiling: balanced ratio (80%)
  keep recent: balanced cap
```

If a numeric override is active:

```text
Proactive compact: 52,000
Source: explicit token override
```

This makes the policy transparent enough for advanced users without requiring manual tuning for normal users.

---

# 17. Profile switching

`/context-mode aggressive|balanced|relaxed` should only change the active ratio profile.

It should not inject numeric defaults into configuration state.

Changing:

```text
balanced → relaxed
```

should immediately recalculate effective thresholds against the current working budget.

Explicit numeric overrides should remain active unless deliberately cleared.

If this combination becomes confusing, `/context-stats` should clearly show:

```text
Mode: relaxed
Compact threshold: 52k (explicit override)
```

---

# 18. Testing plan

## 18.1 Threshold matrix

Add deterministic tests for at least:

```text
16k
32k
64k
128k
256k
1M
```

for all three profiles.

Tests should verify ratios, clamps, ordering, and headroom.

---

## 18.2 Effective-budget tests

Example:

```text
logical window:       128k
effective budget:      80k
```

Verify that thresholds are calculated against 80k.

Also test:

```text
effective budget > logical window
```

and verify it is clamped to the logical context.

---

## 18.3 Explicit override precedence

Test:

```json
{
  "contextProfile": "balanced",
  "compactThresholdTokens": 52000
}
```

against:

```text
64k
128k
256k
```

and verify proactive compaction remains at 52k where safe.

If an override becomes impossible because the actual working budget is smaller, clamp safely and expose that fact diagnostically.

---

## 18.4 Model switching

Within one session or harness lifecycle:

```text
64k model
→ 128k model
→ 32k model
```

verify that:

* thresholds recalculate;
* gate rearm state remains safe;
* no stale thresholds survive;
* warning state behaves correctly.

---

## 18.5 Small-window safety

Test at least:

```text
16k
24k
32k
48k
```

Ensure:

* proactive threshold leaves useful response headroom;
* ordering remains valid;
* LCM does not fight Pi's native emergency compaction.

---

## 18.6 Post-compaction behavior

Simulate:

```text
128k balanced
compact threshold ≈ 83k
Pi compaction lands around 24–30k
```

Verify:

* no immediate second compaction;
* substantial epoch growth is possible;
* gate rearming works normally.

Also retain current near-threshold regression cases such as a compaction landing just below the proactive boundary.

---

## 18.7 Effective prefill constraint

Example:

```text
advertised model context: 128k
runtime effective budget: 64k
```

The result should resemble a 64k working-context policy rather than 128k policy.

This is particularly important for local-model deployments.

---

# 19. Documentation changes

Rewrite configuration documentation so the main explanation becomes:

> Profiles scale with the usable context budget. `balanced` normally compacts around 65% of that budget. Smaller contexts are automatically constrained to leave enough room for another model response. Advanced users can override thresholds with explicit token counts.

Remove wording that says large advertised windows never increase thresholds.

Document the distinction between:

```text
Model context window
Effective working budget
Threshold
```

with a concrete example.

---

# 20. Migration and release strategy

This is behaviorally significant enough to warrant a minor-version feature release rather than an invisible patch.

Recommended sequence:

### Phase 1 — Policy abstraction

Implement:

* profile ratio definitions;
* working-budget resolver;
* threshold provenance;
* new tests.

Do not touch lifecycle behavior.

### Phase 2 — Root/embedded convergence

Make both:

```text
root extension
embedded context manager
```

use the same threshold resolver.

Remove duplicated policy interpretation.

### Phase 3 — Configuration migration

Introduce:

```text
effectiveContextBudgetTokens
```

and separate profile-derived values from explicit token overrides.

Maintain parsing compatibility.

### Phase 4 — UI and diagnostics

Update:

* status line;
* `/context-stats`;
* `/context-mode`;
* debug diagnostics.

### Phase 5 — Full resilience regression

Run the existing:

* compaction failure tests;
* OOM simulations;
* transport failure cases;
* compaction hysteresis tests;
* child-agent/fabric coordination tests;
* session replacement tests;
* embedded-manager tests.

Threshold refactoring must not weaken the resilience work already completed in v0.5.x.

### Phase 6 — Real local-model validation

Test representative configurations such as:

```text
32k constrained local model
64k local model
128k local model
128k model with ~64–96k practical prefill budget
256k-capable model/runtime
```

Measure:

* average context at compaction;
* post-compaction context;
* turns between compactions;
* prefill latency;
* compaction latency;
* failures/OOMs;
* repeated-compaction incidence.

---

# 21. Acceptance criteria

The change is ready when all of the following hold:

* `balanced` no longer compacts every model at a fixed 32k threshold.
* 128k and 256k models receive meaningfully larger working epochs by default.
* 16–32k models remain conservatively protected.
* An effective runtime/prefill budget can constrain an advertised larger context.
* `keepRecentTokens` does not grow unboundedly with model context.
* Explicit token overrides remain backward-compatible.
* Root and embedded controllers share the same threshold policy.
* Pi overflow/emergency compaction behavior remains untouched.
* Existing hysteresis and failure-backoff tests continue to pass.
* `/context-stats` clearly explains why each threshold has its current value.
* Typical native compaction no longer lands only a few thousand tokens below the next LCM proactive compaction on large-context models.
* No additional manual tuning is required for ordinary users.

---

# 22. Recommended initial target behavior

For a normal balanced profile, expected approximate behavior should look like:

| Working budget |           Warn |        Compact |        Ceiling | Keep |
| -------------: | -------------: | -------------: | -------------: | ---: |
|            32k | safety-clamped | safety-clamped | safety-clamped |  ≤4k |
|            64k |           ~34k |           ~42k |           ~51k |  ≤8k |
|            80k |           ~42k |           ~52k |           ~64k |  10k |
|           128k |           ~67k |           ~83k |          ~102k |  10k |
|           256k |          ~134k |          ~166k |          ~205k |  10k |

The 32k row should intentionally be governed more by safety/headroom constraints than by raw percentages.

These numbers are starting points, not permanent constants. The architectural goal is more important:

> percentages determine normal context pressure; absolute constraints protect small or runtime-limited environments.

---

# 23. Non-goals for this change

Do not add, yet:

* autonomous hardware benchmarking;
* learned threshold tuning;
* latency-sensitive online adaptation;
* GPU/RAM model lookup tables;
* vendor-specific thresholds;
* automatic inference of quantization-dependent limits.

Those can be layered on later once the policy accepts an effective working-budget signal.

The immediate goal is to make the default policy structurally correct across heterogeneous context sizes without making configuration more complicated for users.
