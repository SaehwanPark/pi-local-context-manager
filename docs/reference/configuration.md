---
title: Configuration reference
description: Configure pi-local-context-manager thresholds, optional workflows, and local checkpoint storage.
---

# Configuration reference

[Documentation portal]({{ '/' | relative_url }}) · [How to use it]({{ '/guides/how-to-use.html' | relative_url }}) · [Command reference]({{ '/reference/commands.html' | relative_url }})

No configuration is required. The invisible default is the `balanced` context mode. If a long local-model session becomes slow, try `/context-mode aggressive`; if compaction feels unnecessarily frequent, try `/context-mode relaxed`. Change numeric settings only for benchmarking or a specialized setup.

## Where configuration lives

The global configuration file is:

```text
~/.pi/agent/pi-local-context-manager.json
```

If Pi uses a different agent directory, the extension follows `PI_CODING_AGENT_DIR`:

```bash
PI_CODING_AGENT_DIR=/path/to/pi-agent pi
```

A trusted project can override global values with:

```text
<project>/.pi/pi-local-context-manager.json
```

Project configuration is read only when Pi considers the project trusted. This prevents a checked-out project from silently changing your global behavior. See Pi's [project trust documentation](https://github.com/earendil-works/pi#project-trust) if you are new to that prompt.

Later project values override global values. You may either put settings at the top level or use an optional `piLocalContextManager` (or legacy `localContextManager`) wrapper:

```json
{
  "piLocalContextManager": {
    "contextProfile": "balanced",
    "toolOutputReduction": true
  }
}
```

After editing a file, start a new Pi session or run `/reload`.

## All settings

| Setting | Default | What it controls |
| --- | ---: | --- |
| `enabled` | `true` | Master switch for extension behavior. |
| `contextProfile` | `balanced` | Ratio policy: `aggressive`, `balanced`, or `relaxed`. Numeric settings below can override individual values. |
| `softWarningTokens` | unset | Explicit token override for the warning boundary. Unset uses the selected profile ratio. |
| `compactThresholdTokens` | unset | Explicit token override for guarded proactive compaction. Unset uses the selected profile ratio. |
| `hardCeilingTokens` | unset | Explicit token override for the status boundary; Pi still owns emergency compaction. |
| `keepRecentTokens` | unset | Explicit recent-context target for semantic deep compaction. Unset uses the profile cap and a 12.5% budget bound. |
| `effectiveContextBudgetTokens` | unset | Optional runtime-safe working budget. It constrains proactive policy without changing the advertised model window. |
| `toolOutputReduction` | `true` | Allows reduction of eligible newly arriving oversized tool results. |
| `semanticCompaction` | `true` | Enables `request_context_compaction` and `/compact-phase`. |
| `handoff` | `true` | Enables `/handoff <objective>`. |
| `checkpointReset` | `true` | Enables `request_context_reset`, `/checkpoint-reset`, and `/context-checkpoints`. |
| `checkpointDirectory` | `null` | Alternate local root for checkpoint archives. `null` uses Pi's agent directory. |
| `debug` | `false` | Writes diagnostic messages to stderr. |

Explicit numeric thresholds must be positive integers in this order:

```text
keepRecentTokens < softWarningTokens < compactThresholdTokens < hardCeilingTokens
```

For example, the resolved profile `keepRecentTokens` is lower than the warning threshold, and the warning threshold is lower than the proactive compaction threshold. If you provide an invalid number or ordering, the extension keeps the prior valid value and shows a configuration warning.

## Profiles and automatic adaptation

Profiles describe how much of the usable working context LCM should consume:

| Profile | Warning | Proactive compact | Hard ceiling | Keep-recent cap |
| --- | ---: | ---: | ---: | ---: |
| `aggressive` | 40% | 50% | 65% | 8k |
| `balanced` | 52.5% | 65% | 80% | 10k |
| `relaxed` | 62.5% | 75% | 87.5% | 12k |

The extension separates three values:

```text
model context window  = logical capacity advertised by the model/runtime
working budget        = effective usable capacity for LCM policy
threshold             = profile ratio or explicit token boundary
```

The working budget prefers a configured/runtime effective budget and otherwise uses the logical model window. If neither is available, the previous profile values remain the conservative fallback. For example, a 128k model with `effectiveContextBudgetTokens: 80000` uses a balanced compact boundary of about 52k and a hard ceiling of about 64k, rather than blindly using 65% and 80% of 128k.

Automatic compact thresholds leave a minimum response reserve on small windows. Explicit token overrides remain absolute and meaningful; when a requested value cannot fit the effective budget, it is safely clamped and `/context-stats` reports the clamp source.

Use the guided command for the current session:

```text
/context-mode aggressive
```

This does not write a configuration file. To persist the choice, add the setting explicitly:

```json
{
  "contextProfile": "aggressive"
}
```

## A sensible custom configuration

Most users need only a profile:

```json
{
  "contextProfile": "aggressive"
}
```

For a specialized setup, numeric settings can override a profile bundle:

```json
{
  "contextProfile": "balanced",
  "softWarningTokens": 18000,
  "compactThresholdTokens": 26000,
  "hardCeilingTokens": 40000,
  "keepRecentTokens": 8000
}
```

If the model advertises more context than the local runtime can comfortably prefill, set an effective working budget while retaining the model's logical window:

```json
{
  "contextProfile": "balanced",
  "effectiveContextBudgetTokens": 80000
}
```

If you only need to turn off one behavior, use a small project override instead:

```json
{
  "piLocalContextManager": {
    "toolOutputReduction": false
  }
}
```

Turning off reduction leaves original tool results intact; it does not turn off Pi's native compaction. Turning off `semanticCompaction`, `handoff`, or `checkpointReset` disables only that extension workflow and reports the disabled state when its command is used.

## Choosing a mode

Start with `balanced` and let the extension work in the background. Choose by symptom rather than by hardware model:

- **Sessions become slow as they grow:** use `aggressive`.
- **Everything feels comfortable:** keep `balanced`.
- **Compaction happens too often even though long prompts remain fast:** use `relaxed`.

Run `/context-stats` to see the active mode, logical model window, working budget, effective thresholds, and provenance for each boundary. Hardware, runtime, model, quantization, and caching all affect performance, so this release does not assign thresholds from a machine lookup table.

Use the four numeric fields only when measuring a specialized setup. Keep `keepRecentTokens` below the other thresholds, and treat `hardCeilingTokens` as a status boundary rather than a setting that forces a reset. The extension does not yet learn a performance knee or retune itself from latency measurements.

## Checkpoint storage

With `checkpointDirectory: null`, archives are stored under:

```text
<agent-dir>/pi-local-context-manager/checkpoints/<repository-hash>/<timestamp>-<reason>.md
```

The default agent directory is `~/.pi/agent`. A configured path can be absolute or relative; relative paths resolve from the Pi agent directory, never the working tree (protecting repositories from accidental checkpoint commits). The extension still separates repositories with a non-reversible repository hash.

Checkpoint files are local agent state. They may contain project paths, decisions, test results, and model-generated text. The extension creates them atomically with restrictive permissions, but your filesystem and backup tools still determine who can read them. Do not commit them by accident.

## Failure behavior

Configuration is designed to fail soft:

- missing files use defaults;
- malformed JSON is ignored with a warning;
- invalid individual values fall back to the previous valid layer;
- an untrusted project file is not applied;
- a reduction, compaction, handoff, or checkpoint failure preserves the active session whenever possible.

Set `debug` to `true` temporarily when you need diagnostic messages. Turn it back off if you do not want routine details in stderr.
