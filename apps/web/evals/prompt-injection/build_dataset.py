#!/usr/bin/env python3
"""Build the prompt-injection eval dataset for sanitizeContextNote.

Attack sources come from NVIDIA garak (Apache-2.0), a public LLM vulnerability
scanner, so the test set is not written by the author of the filter under test:

  * indirect_injection     - injection instructions from garak.probes.latentinjection
                             (payload filled with garak's default trigger "Haha pwned!")
  * jailbreak_dan          - garak/data/dan/*.json (DAN, STAN, DUDE, developer-mode ...)
  * jailbreak_in_the_wild  - garak/data/inthewild_jailbreak_llms.json
  * sysprompt_extraction   - garak/data/sysprompt_extraction/attacks.json

Benign notes are paragraphs from ORION's own docs/ and context/ markdown (real
operational text, including imperative sentences), plus garak's
"normal_instructions" payloads.

Usage (from repo root):
  pip download garak==0.17.0 --no-deps -d /tmp/garak && \
  unzip -q -o /tmp/garak/garak-0.17.0-py3-none-any.whl -d /tmp/garak/whl
  python3 apps/web/evals/prompt-injection/build_dataset.py /tmp/garak/whl/garak
"""
import ast
import glob
import hashlib
import json
import os
import re
import sys

GARAK_VERSION = "0.17.0"
TRIGGER = "Haha pwned!"
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))


def latent_injection_instructions(garak_dir):
    src = open(os.path.join(garak_dir, "probes", "latentinjection.py")).read()
    ns = {"PAYLOAD_MARKER": "{PAYLOAD}", "TRIGGER_MARKER": "{TRIGGER}", "INJECTION_MARKER": "{INJ}"}
    out = []
    for node in ast.walk(ast.parse(src)):
        if not isinstance(node, ast.Assign):
            continue
        for tgt in node.targets:
            if (getattr(tgt, "id", None) or getattr(tgt, "attr", None)) != "injection_instructions":
                continue
            try:
                out += eval(compile(ast.Expression(node.value), "garak", "eval"), ns)  # noqa: S307 - static literals from a pinned wheel
            except Exception:
                pass  # templates built at runtime from mixins; skipped
    out = [s for s in dict.fromkeys(out) if s.strip() != "{PAYLOAD}"]
    return [s.replace("{PAYLOAD}", TRIGGER) for s in out]


def dan_prompts(garak_dir):
    out = []
    for f in sorted(glob.glob(os.path.join(garak_dir, "data", "dan", "*.json"))):
        data = json.load(open(f))
        items = data if isinstance(data, list) else [data]
        for p in items:
            if isinstance(p, str):
                out.append(p.replace("{generator.name}", "ChatGPT"))
    return list(dict.fromkeys(out))


def in_the_wild(garak_dir):
    data = json.load(open(os.path.join(garak_dir, "data", "inthewild_jailbreak_llms.json")))
    return list(dict.fromkeys(p for p in data if isinstance(p, str) and p.strip()))


def sysprompt(garak_dir):
    data = json.load(open(os.path.join(garak_dir, "data", "sysprompt_extraction", "attacks.json")))
    return [p for group in data.values() for p in group]


def benign_notes(garak_dir):
    notes = []
    files = sorted(glob.glob(os.path.join(REPO, "docs", "*.md")) + glob.glob(os.path.join(REPO, "context", "*.md")))
    for f in files:
        text = open(f, encoding="utf-8").read()
        # split into note-sized chunks on headings / blank-line runs
        for chunk in re.split(r"\n(?=#{1,4} )", text):
            chunk = chunk.strip()
            if 200 <= len(chunk) <= 4000:
                notes.append({"source": os.path.relpath(f, REPO), "text": chunk})
    normal = json.load(open(os.path.join(garak_dir, "data", "payloads", "normal_instructions.json")))["payloads"]
    notes += [{"source": "garak:normal_instructions", "text": p} for p in normal]
    return notes


def main():
    garak_dir = sys.argv[1]
    attacks = []
    for category, items in [
        ("indirect_injection", latent_injection_instructions(garak_dir)),
        ("jailbreak_dan", dan_prompts(garak_dir)),
        ("jailbreak_in_the_wild", in_the_wild(garak_dir)),
        ("sysprompt_extraction", sysprompt(garak_dir)),
    ]:
        for text in items:
            attacks.append({"id": hashlib.sha1(text.encode()).hexdigest()[:10], "category": category, "text": text})
    dataset = {
        "meta": {
            "attack_source": f"NVIDIA garak {GARAK_VERSION} (Apache-2.0) https://github.com/NVIDIA/garak",
            "benign_source": "ORION docs/ and context/ markdown + garak normal_instructions",
            "trigger": TRIGGER,
        },
        "attacks": attacks,
        "benign": benign_notes(garak_dir),
    }
    out = os.path.join(HERE, "dataset.json")
    json.dump(dataset, open(out, "w"), indent=1, ensure_ascii=False)
    from collections import Counter
    print(out, Counter(a["category"] for a in attacks), "benign:", len(dataset["benign"]))


if __name__ == "__main__":
    main()
