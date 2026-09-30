# Prompt-injection eval: `sanitizeContextNote` (SOC2 C-001)

Measures how well ORION's context sanitizer (`src/lib/sanitize-context.ts`) stops
prompt-injection and jailbreak text before notes, knowledge-base entries and
vector-search results are injected into an agent's prompt.

```bash
cd apps/web && npm run eval:injection                 # all cases -> results.json
node evals/prompt-injection/run.mjs --split=dev       # tune here only
node evals/prompt-injection/run.mjs --split=test      # report here (held out)
```

Node >= 22.18 (native TypeScript type stripping).

## Test set

| Set | Count | Source |
| --- | ---: | --- |
| Indirect injection instructions | 21 | [NVIDIA garak](https://github.com/NVIDIA/garak) 0.17.0 `probes/latentinjection.py` (trigger "Haha pwned!") |
| DAN-family jailbreaks | 13 | garak `data/dan/` |
| In-the-wild jailbreaks | 650 | garak `data/inthewild_jailbreak_llms.json` |
| System-prompt extraction | 28 | garak `data/sysprompt_extraction/attacks.json` |
| Benign notes | 308 | Paragraphs of ORION's own `docs/` and `context/` markdown + garak `normal_instructions` |
| Stress set (hard negatives) | 30 | ORION's own agent/system prompts (`src/prompts/**/*.md`): legitimate but instruction-heavy |

Attack text comes from a public, third-party scanner (garak, Apache-2.0), not
from the filter's author. `build_dataset.py` regenerates `dataset.json` from the
pinned garak wheel.

Each attack is tested in three placements (2,136 cases):

- **standalone**: the whole note is the attack
- **own_line**: the attack is its own paragraph inside a real ORION doc note
- **inline**: the attack is appended to the end of a sentence inside a real note

Carrier notes are 20 benign notes the filter does not flag, so any detection is
caused by the attack, not the carrier.

## Metrics

- **Detected**: the sanitizer flagged the note (its C-001 warning fired).
- **Fully removed**: no line of the attack survives in the sanitized note. A line
  counts as surviving if its first 60 characters are still present, so the
  8,000-character truncation isn't credited as a defense.
- **False positives**: benign notes the sanitizer flagged.

## Held-out split

Every attack and benign note is assigned to `dev` or `test` by a hash of its
text (about 50/50). Sanitizer changes are tuned on `dev` only; `test` is run once
at the end and is the number to report, so the result isn't just memorizing
these 712 prompts.

## Baseline, all cases (2026-09-29, `main` @ 6d7a868)

| Metric | Result |
| --- | ---: |
| False positives (benign notes flagged) | **0%** (0 / 308) |
| Attacks detected, all cases | **5.9%** |
| Attacks fully removed, all cases | **5.6%** |
| Category-balanced detection / removal | 7.3% / 3.5% |
| Detected, standalone or own-line | 8.7% |
| Detected, inline | 0.3% |

| Category | Placement | n | Detected | Fully removed |
| --- | --- | ---: | ---: | ---: |
| indirect_injection | standalone | 21 | 4.8% | 4.8% |
| indirect_injection | own_line | 21 | 4.8% | 4.8% |
| indirect_injection | inline | 21 | 0% | 0% |
| jailbreak_dan | standalone | 13 | 15.4% | 0% |
| jailbreak_dan | own_line | 13 | 15.4% | 0% |
| jailbreak_dan | inline | 13 | 15.4% | 0% |
| jailbreak_in_the_wild | standalone | 650 | 8.8% | 8.8% |
| jailbreak_in_the_wild | own_line | 650 | 8.8% | 8.8% |
| jailbreak_in_the_wild | inline | 650 | 0% | 0% |
| sysprompt_extraction | standalone | 28 | 7.1% | 7.1% |
| sysprompt_extraction | own_line | 28 | 7.1% | 7.1% |
| sysprompt_extraction | inline | 28 | 0% | 0% |

### What the baseline shows

1. **Very precise, but most attacks get through.** No false positives, but about
   94% of attacks pass unflagged. The 10 patterns only cover a few exact
   phrasings. For example, "Ignore **the** above directions" misses the
   `ignore (previous|above|prior) instructions` pattern.
2. **Every pattern is anchored to the start of a line (`^\s*`).** An injection
   appended mid-paragraph is almost never seen (0.3% inline detection).
3. **Detecting an attack doesn't mean removing it.** Only the matching lines are
   stripped. DAN jailbreaks are flagged 15% of the time but never fully removed:
   the rest of the jailbreak still reaches the model.

## Hardened sanitizer: before vs after (held-out `test` split)

The redesign normalizes text (NFKC, zero-width and bidi characters removed),
matches weighted signals anywhere in a line across five families (override,
persona/jailbreak, fake conversation turns, system-prompt extraction, output
hijacking), and **withholds a flagged note whole** instead of stripping lines.
It was tuned on `dev` only, and `test` was run once.

| Held-out `test` split (342 attacks, 1,026 cases) | Before | After |
| --- | ---: | ---: |
| Attack cases detected | 6.0% | **75.8%** |
| Attack cases fully removed | 6.0% | **75.8%** |
| Detected when the attack is appended mid-sentence | 0.0% | **75.7%** |
| Category-balanced detection | 3.8% | 56.1% |
| False positives, benign notes | 0% (0/152) | 0.7% (1/152) |
| Stress set flagged (ORION agent prompts) | 0% (0/18) | 0% (0/18) |

| `test` category | n | Before | After |
| --- | ---: | ---: | ---: |
| In-the-wild jailbreaks | 308 | 6.3% | 79.4% |
| DAN-family jailbreaks | 8 | 0% | 87.5% |
| System-prompt extraction | 15 | 8.9% | 33.3% |
| Indirect injection | 11 | 0% | 24.3% |

(Category figures average the three placements.)

### Caveats

- **Small categories overfit.** On `dev`, extraction and indirect injection
  reached 100% and 50%; on `test` they fell to 33% and 24%. With 11–15 prompts
  per half, the hand-written signals generalize poorly. They need more data or a
  model-based classifier, not more regexes.
- **The one false positive** on `test` is a paragraph of `docs/SECURITY.md`. It
  was left as found rather than tuned away, to keep `test` held out.
- **Regex signals are a floor, not a ceiling.** Paraphrased or encoded attacks
  will get past them. The next step is a model-based injection classifier
  layered on top, measured with this same harness.

## Attribution

Attack prompts in `dataset.json` are from NVIDIA garak 0.17.0, licensed under
Apache-2.0 (https://github.com/NVIDIA/garak/blob/main/LICENSE). The jailbreak
text is adversarial by design. It is test data only and is never loaded into
ORION at runtime.
