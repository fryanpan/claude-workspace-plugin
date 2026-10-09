"""A Haiku block whose only names are sanctioned placeholders is a pass.

The prompt tells Haiku that Alice, Bob and the house fixture names are
placeholders, and it still blocks on them: a planning-voice line asking Bob,
and a sentence about checking the hover for Alice, were both refused, the
second after Haiku's own sweep had marked the name `keep`. Each refusal costs
the owner a look at a push that leaks nothing. So the reply is read, not only
its verdict word, and a block is overridden only when the reply proves it is
about those names and nothing else:

- the NAMES sweep lists at least one name marked `keep`, and every `keep`
  name is made only of `scrub_names.PLACEHOLDER_NAMES`, whole and in exact
  case; and
- every LEAKS row names one of them and carries nothing else a leak can be: no
  email, handle, number, amount or key (`scrub_names._marks`), and none of the
  words a non-name leak is described with. A capitalised word the row quotes
  must be a placeholder too, so a row naming a second person still blocks.

Anything the reply does not prove keeps the block. A malformed sweep, an
empty LEAKS list, a row about an email, or any other name marked `keep` all
block exactly as before.
"""

from __future__ import annotations

import re
from typing import List, Optional, Tuple

import scrub_names

_VERDICTS = ("keep", "maintainer", "placeholder", "not-a-person")
_SPLIT = re.compile(r"\s+[—–]\s+|\s+-{1,2}\s+")
# The words a reply uses for a leak that is not a name. A row carrying one is
# about more than a placeholder, so it blocks whoever else it names.
_NOT_A_NAME = re.compile(
    r"\b(?:e-?mail|phone|address|account|salary|medical|health|diagnos\w*|"
    r"credential|password|secret|token|key|path|username|handle|number|amount|"
    r"financial|ssn|birth|internal|private|client|customer|project|repo\w*|url)\b",
    re.IGNORECASE,
)
_QUOTED = re.compile(r"'([^']+)'|\"([^\"]+)\"|`([^`]+)`|“([^”]+)”|‘([^’]+)’")


def _section(text: str, head: str) -> Optional[List[str]]:
    """The `- ` rows under `head:`, or None when the reply has no such heading."""
    lines = text.split("\n")
    for i, line in enumerate(lines):
        if line.strip().upper().startswith(head + ":"):
            rows = []
            for row in lines[i + 1:]:
                stripped = row.strip()
                if stripped.startswith("- "):
                    rows.append(stripped[2:])
                elif stripped and not stripped.startswith("("):
                    break
            return rows
    return None


def _sweep(text: str) -> Optional[List[Tuple[str, str]]]:
    """(name, verdict) per NAMES row; None if any row cannot be read."""
    rows = _section(text, "NAMES")
    if rows is None:
        return None
    out = []
    for row in rows:
        parts = _SPLIT.split(row)
        verdict = parts[-1].strip().strip("`*").lower()
        if len(parts) < 2 or verdict not in _VERDICTS:
            return None
        out.append((parts[0].strip().strip("`'\"*"), verdict))
    return out


def _only_placeholders(name: str) -> bool:
    words = re.findall(r"[^\W\d_]+", re.sub(r"['’]s\b", "", name))
    return bool(words) and all(w in scrub_names.PLACEHOLDER_NAMES for w in words)


def _names_a_placeholder(row: str) -> bool:
    return any(re.search(rf"(?<![^\W_]){re.escape(n)}(?![^\W_])", row)
               for n in scrub_names.PLACEHOLDER_NAMES)


def _quotes_only_placeholders(row: str) -> bool:
    quoted = " ".join("".join(m) for m in _QUOTED.findall(row))
    return all(w in scrub_names.PLACEHOLDER_NAMES
               for w in re.findall(r"\b[A-Z][^\W\d_]+", quoted))


def only_placeholders(reply: str) -> bool:
    """True when a LEAKS_FOUND reply blocks over sanctioned placeholders alone."""
    sweep = _sweep(reply)
    leaks = _section(reply, "LEAKS")
    if not sweep or not leaks:
        return False
    kept = [name for name, verdict in sweep if verdict == "keep"]
    if not kept or not all(_only_placeholders(name) for name in kept):
        return False
    for row in leaks:
        # "<file>:<line> — <description>": the path may say "project" or
        # "repo" without the finding being about one, so only the words judge.
        said = _SPLIT.split(row, maxsplit=1)[-1]
        if (not _names_a_placeholder(said) or scrub_names._marks(said)
                or _NOT_A_NAME.search(said) or not _quotes_only_placeholders(said)):
            return False
    return True
