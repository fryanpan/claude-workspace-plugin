"""The free pass in front of the Haiku scanner: which lines might hold a name.

Most added lines are code and prose built from words this repository has
published a thousand times, and none of them can publish a name that is not
already public. So a push is first read locally, for nothing, and only lines
carrying something NEW — an unpublished word or capitalised pair, an email,
handle, long number, amount or key — travel to Haiku, with a few lines either
side so the model can tell a person from a function.

**The cost in recall.** A name made only of words the repository already uses
is not flagged, and a line that is not flagged is never judged by anything.
Measured recall, and why this trade was chosen over the models that were
tried, are in docs/architecture/scrub-name-finder.md.

Standard library only: this runs inside a git hook, on whatever Python the
machine has.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from collections import Counter
from typing import Dict, List, NamedTuple, Optional, Set, Tuple

# Fewer sightings than this in the public vocabulary is new enough to send. 1
# would mean a name that slipped through once is never flagged again.
RARE_BELOW = 5
# Lines either side of a flagged line that travel with it.
CONTEXT_LINES = 2
# A flagged line whose every trigger has already travelled this often stays.
REPEATS_SENT = 2

# --- The sanctioned placeholder names ---------------------------------------
#
# Builders here write the three house words wherever a real person's or
# client's name would go: a fixture, a mock payload, a doc example, a sample
# transcript. They are invented place-words and name nobody. On 2026-09-15 the
# gate blocked one as `Personal surname "saltmarsh" used as sample data`, and a
# push-range block is not cleared by a forward commit, so that branch was
# rebuilt as one commit. `scrub-haiku.py` renders them into the scanner's closed
# placeholder list; the half a person reads is CLAUDE.md's "Leak gates".
#
# PLACEHOLDER_NAMES adds the two the scanner's prompt names first. A line whose
# only new word is one of these five is never sent, and a Haiku block naming
# only these is overridden (scrub_placeholders.py). The exemption is these
# words whole, as written or in capitals (a test constant): a longer word, a
# lower-case or mixed spelling, or an unfamiliar surname beside one is new.
HOUSE_FIXTURE_NAMES = ("Harborlight", "Riverbend", "Saltmarsh")
PLACEHOLDER_NAMES = ("Alice", "Bob") + HOUSE_FIXTURE_NAMES
PLACEHOLDER_SPELLINGS = frozenset(PLACEHOLDER_NAMES + tuple(n.upper() for n in PLACEHOLDER_NAMES))

_RUN = re.compile(r"[^\W_]+(?:['’][^\W_]+)*")
_HEXISH = re.compile(r"^[0-9a-fA-F]{7,}$")
_LETTERS = re.compile(r"[^\W\d_]+")
_CAMEL = re.compile(r"(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")
_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_HANDLE = re.compile(r"(?<![\w.@/])@([A-Za-z0-9][A-Za-z0-9-]{1,38})(?![\w/])")
_TITLE_PAIR = re.compile(r"\b([A-Z][a-z]+)[ \t]+(?=([A-Z][a-z]+)\b)")
# A word in the place people's names go: after "ask" or "thanks", before
# "said", as an `author` or `speaker` value, or owning something. The count is
# of that word in such a place, so "ask Carol" is new where "carol" is common.
_CUE_BEFORE = re.compile(
    r"(?:\b(?:ask|asked|thanks|thank|cc|ping|per|with|from|by|told|tell|via|for)[ \t]+"
    r"|\b(?:name|author|assignee|owner|speaker|reviewer|user|by)[\"']?[ \t]*[:=][ \t]*[\"'`])"
    r"([^\W\d_][^\W\d_]+)\b",
    re.IGNORECASE,
)
_CUE_AFTER = re.compile(
    r"\b([^\W\d_][^\W\d_]+)[ \t]+(?:said|says|asked|wants|prefers|suggested|raised|and I)\b",
    re.IGNORECASE,
)
_OWNER = re.compile(r"\b([A-Z][a-z]+)['’]s\b")
# Numbers, amounts, readings and keys, which tokens() drops, count as marks of
# their own; a new one is sent like a new word. ISO dates are left out.
_OPAQUE = re.compile(r"(?<![\w-])(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{20,}(?![\w-])"
                     r"|(?<![0-9A-Za-z])[0-9a-fA-F]{16,}(?![0-9A-Za-z])"
                     r"|(?<![^\W_])[^\W_]{40,}(?![^\W_])")
_NUMBER = re.compile(r"(?<!\w)(?<!\d\.)\+?\(?\d[\d ().-]{4,}\d(?!\w|\.\d)")
_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_MONEY = re.compile(r"[$€£]\s?\d[\d,]*(?:\.\d+)?"
                    r"|\b\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|GBP|dollars)\b", re.IGNORECASE)
_READING = re.compile(r"\b\d+(?:\.\d+)?\s?(?:mg/dl|mmol/l|mmhg|bpm|mcg|mg|iu)\b", re.IGNORECASE)


def _marks(text: str) -> List[str]:
    """Emails, handles, and the digit and opaque shapes a leak can take."""
    out = [m.group(0).lower() for m in _EMAIL.finditer(text)]
    out += ["@" + m.group(1).lower() for m in _HANDLE.finditer(text)]
    out += ["key " + m.group(0).lower() for m in _OPAQUE.finditer(text)]
    for m in _NUMBER.finditer(text):
        digits = re.sub(r"\D", "", m.group(0))
        if len(digits) >= 6 and not _ISO_DATE.match(m.group(0)):
            out.append("# " + digits)
    out += ["$ " + m.group(0).lower() for m in _MONEY.finditer(text)]
    out += ["reading " + m.group(0).lower() for m in _READING.finditer(text)]
    return out


def _cued(text: str) -> List[str]:
    words = [w.lower() for w in _CUE_BEFORE.findall(text)]
    words += [w.lower() for w in _CUE_AFTER.findall(text)]
    words += ["'s " + w.lower() for w in _OWNER.findall(text)]
    return words


class Token(NamedTuple):
    word: str
    title: bool   # Capitalised and otherwise lower case, e.g. "Harborlight"
    split: bool   # cut out of a camelCase run, so its capital means nothing


def tokens(text: str) -> List[Token]:
    """Every word-ish piece of a line, camelCase split apart.

    Hex runs, and long runs mixing letters and digits, are skipped: they are
    hashes and encoded blobs, never names, and each would be "new".
    """
    out: List[Token] = []
    for m in _RUN.finditer(text):
        run = m.group(0)
        if _HEXISH.match(run):
            continue
        if len(run) >= 40 or (len(run) >= 20 and sum(c.isdigit() for c in run) >= 2):
            continue
        run = run.replace("’", "'")
        head, apostrophe, tail = run.rpartition("'")
        if apostrophe and tail.lower() == "s" and "'" not in head:
            run = head  # "Saltmarsh's" is read as "Saltmarsh"
        elif apostrophe:
            # A contraction stays whole: split at the apostrophe, its first
            # half would enter the vocabulary a thousand times and hide a
            # person who has that half as a name.
            out.append(Token(run, run[0].isupper() and run[1:].islower(), False))
            continue
        for lm in _LETTERS.finditer(run):
            word = lm.group(0)
            latin = all(ord(c) <= 0x24F for c in word)
            parts = _CAMEL.split(word) if latin else [word]
            for part in parts:
                # One Latin letter is an initial or a loop variable; one Han
                # character can be a whole given name.
                if len(part) < 2 and latin:
                    continue
                title = part[0].isupper() and part[1:].islower()
                out.append(Token(part, title, len(parts) > 1))
    return out


class Vocabulary:
    """How often the already-public repository uses each word.

    Words case-folded; capitalised words in exactly that case, which is what
    separates "carol singers" from "Carol"; capitalised pairs, which flag a full
    name made of two words the repository already uses; words in a name's
    place (`_CUE_BEFORE`); and marks: emails, handles, long numbers, amounts,
    readings and opaque keys.
    """

    def __init__(self) -> None:
        self.lower: Counter = Counter()
        self.case: Counter = Counter()
        self.pairs: Counter = Counter()
        self.cued: Counter = Counter()
        self.marks: Counter = Counter()  # _marks(): emails, handles, numbers, keys

    def learn(self, text: str) -> None:
        for t in tokens(text):
            self.lower[t.word.lower()] += 1
            if t.title and not t.split:
                self.case[t.word] += 1
        for a, b in _TITLE_PAIR.findall(text):
            self.pairs[f"{a} {b}".lower()] += 1
        self.cued.update(_cued(text))
        self.marks.update(_marks(text))

    def __len__(self) -> int:
        return len(self.lower)


def triggers(text: str, vocab: Vocabulary) -> Set[str]:
    """What on this line is new to the public repository. Empty = not sent."""
    hits: Set[str] = set()
    found = tokens(text)
    for t in found:
        folded = t.word.lower()
        if vocab.lower[folded] < RARE_BELOW:
            hits.add(folded)
        elif t.title and not t.split and vocab.case[t.word] < RARE_BELOW:
            hits.add(folded)
    for a, b in _TITLE_PAIR.findall(text):
        pair = f"{a} {b}".lower()
        if vocab.pairs[pair] < RARE_BELOW and not _placeholder_pair(a, b, vocab):
            hits.add(pair)
    for cued in _cued(text):
        if vocab.cued[cued] < RARE_BELOW:
            hits.add(cued.replace("'s ", ""))
    for mark in _marks(text):
        if vocab.marks[mark] < RARE_BELOW:
            hits.add(mark)
    return hits - _placeholders_on(found)


def _placeholders_on(found: List[Token]) -> Set[str]:
    """Folded placeholders the line spells only in a sanctioned case, whole."""
    exact = {t.word.lower() for t in found if t.word in PLACEHOLDER_SPELLINGS and not t.split}
    return exact - {t.word.lower() for t in found if t.word not in PLACEHOLDER_SPELLINGS or t.split}


def _placeholder_pair(a: str, b: str, vocab: Vocabulary) -> bool:
    """A placeholder after a published word, never before: what follows may be a surname."""
    return b in PLACEHOLDER_NAMES and (a in PLACEHOLDER_NAMES or vocab.case[a] >= RARE_BELOW)


# --- The public vocabulary, read from git ------------------------------------

def _git(args: List[str], stdin: Optional[bytes] = None) -> bytes:
    try:
        return subprocess.run(
            ["git", *args], input=stdin, capture_output=True, check=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError):
        return b""


def public_base(rev_args: List[str]) -> Optional[str]:
    """The newest commit the push builds on that the remote already has.

    `git rev-list --boundary` marks with `-` the commits just outside the
    selected range: parents of the becoming-public commits that are
    themselves already public. Their trees are public by the same definition
    scrub_git.py uses, so every word in them is too. The newest of them is
    normally the `main` the branch last merged. None when the push has no
    public ancestor, and then nothing is known and every line is new.
    """
    out = _git(["rev-list", "--boundary", *rev_args]).decode()
    boundary = [line[1:].strip() for line in out.splitlines() if line.startswith("-")]
    if not boundary:
        return None
    newest = _git(["log", "--no-walk=sorted", "--format=%H", *boundary]).decode().split()
    return newest[0] if newest else None


def vocabulary_at(rev: Optional[str]) -> Vocabulary:
    """Every word in `rev`'s tree and in the commit messages behind it.

    An unreadable rev gives an empty vocabulary, which flags every line: a
    pass that cannot see what is public sends everything, never nothing.
    """
    vocab = Vocabulary()
    if not rev:
        return vocab
    paths = [p for p in _git(["ls-tree", "-r", "-z", "--name-only", rev]).decode(
        "utf-8", errors="replace").split("\0") if p]
    blob = _git(["cat-file", "--batch"], "\n".join(f"{rev}:{p}" for p in paths).encode())
    i = 0
    while i < len(blob):
        nl = blob.find(b"\n", i)
        if nl < 0:
            break
        header = blob[i:nl].split()
        if len(header) < 3 or header[1] == b"missing":
            i = nl + 1
            continue
        size = int(header[2])
        data = blob[nl + 1: nl + 1 + size]
        i = nl + 1 + size + 1
        if b"\0" not in data[:8000]:
            vocab.learn(data.decode("utf-8", errors="replace"))
    vocab.learn("\n".join(paths))
    vocab.learn(_git(["log", "--format=%B", rev]).decode("utf-8", errors="replace"))
    return vocab


# --- Picking lines out of a push patch ---------------------------------------

_FILE_STARTS = ("diff --git ", "diff --cc ", "diff --combined ")
_HEADER_ENDS = ("@@", "GIT binary patch", "Binary files ")


class _Line(NamedTuple):
    text: str
    kind: str      # commit | head | msg | file | hunk | add | del | ctx
    scan: str      # the part the rules read, "" when the line is not read
    commit: int    # which commit section it sits in
    file: int      # which file header precedes it, -1 in a commit header
    hunk: int      # index of the hunk header it sits under, -1 if none


def _parse(patch: str, identity_placeholder: str) -> List[_Line]:
    lines: List[_Line] = []
    commit = file = hunk = -1
    in_header = False
    in_file_header = False
    columns = 1
    for text in patch.split("\n"):
        idx = len(lines)
        if re.match(r"^commit [0-9a-f]{7,}", text):
            commit += 1
            file = hunk = -1
            in_header, in_file_header = True, False
            lines.append(_Line(text, "commit", "", commit, file, hunk))
            continue
        if text.startswith(_FILE_STARTS):
            in_header, in_file_header = False, True
            file, hunk = idx, -1
            # The path is published too, and a file can be named for a person.
            # Only the paths are read; "diff --git" is the same on every file.
            lines.append(_Line(text, "file", text.split(" ", 2)[-1], commit, file, hunk))
            continue
        if in_header:
            if text.startswith("    "):
                lines.append(_Line(text, "msg", text[4:], commit, file, hunk))
            elif re.match(r"^(Author|Commit|Committer): ", text):
                # push_patch has already swapped identities the remote carries
                # for the placeholder, so any other identity is new by definition.
                new = identity_placeholder not in text
                lines.append(_Line(text, "head", text if new else "", commit, file, hunk))
            else:
                lines.append(_Line(text, "head", "", commit, file, hunk))
            continue
        if text.startswith("@@"):
            in_file_header = False
            columns = max(1, len(text) - len(text.lstrip("@")) - 1)
            hunk = idx
            lines.append(_Line(text, "hunk", "", commit, file, hunk))
            continue
        if in_file_header:
            if text.startswith(_HEADER_ENDS):
                in_file_header = False
            lines.append(_Line(text, "file", "", commit, file, hunk))
            continue
        sign, body = text[:columns], text[columns:]
        if file < 0 or hunk < 0:
            lines.append(_Line(text, "ctx", "", commit, file, hunk))
        elif "+" in sign:
            lines.append(_Line(text, "add", body, commit, file, hunk))
        elif "-" in sign:
            lines.append(_Line(text, "del", "", commit, file, hunk))
        else:
            lines.append(_Line(text, "ctx", "", commit, file, hunk))
    return lines


class Selection(NamedTuple):
    """What the pass kept, and enough numbers to say what it cost."""

    text: str                    # the excerpt Haiku reads; "" means no call
    read: int                    # lines the rules read
    flagged: int                 # lines with at least one trigger
    sent: int                    # flagged lines that travelled after repeats
    triggers: Dict[str, int]     # trigger -> lines it was found on


def _section(line: _Line) -> Tuple[int, int]:
    return (line.commit, line.file)


def select(patch: str, vocab: Vocabulary, identity_placeholder: str = "\0",
           context: Optional[int] = None, repeats: Optional[int] = None) -> Selection:
    """The flagged lines of `patch`, with context, as a smaller patch.

    Each kept stretch is re-headed so Haiku can still tell where it is and
    which way it goes: the `commit` line for a message, the `diff` line of its
    file, and the `@@` line of the hunk it sits in. Context never crosses into
    another file or another commit's message.
    """
    context = CONTEXT_LINES if context is None else context
    repeats = REPEATS_SENT if repeats is None else repeats
    lines = _parse(patch, identity_placeholder)
    seen: Counter = Counter()
    found: Counter = Counter()
    keep: Set[int] = set()
    read = flagged = sent = 0
    for i, line in enumerate(lines):
        if not line.scan:
            continue
        read += 1
        hits = triggers(line.scan, vocab)
        if not hits:
            continue
        flagged += 1
        found.update(hits)
        fresh = [h for h in hits if seen[h] < repeats]
        seen.update(hits)
        if not fresh:
            continue
        sent += 1
        keep.add(i)
        if line.kind in ("file", "head"):
            continue
        for j in range(max(0, i - context), min(len(lines), i + context + 1)):
            other = lines[j]
            if (other.kind in ("msg", "add", "del", "ctx")
                    and _section(other) == _section(line) and other.hunk == line.hunk):
                keep.add(j)
    if not keep:
        return Selection("", read, flagged, 0, dict(found))
    starts = {line.commit: i for i, line in reversed(list(enumerate(lines))) if line.kind == "commit"}
    out: List[str] = []
    shown_commit = shown_file = prev = -2
    for i in sorted(keep):
        line = lines[i]
        if line.commit != shown_commit:
            shown_commit, shown_file = line.commit, -2
            if line.commit in starts:
                prev = starts[line.commit]
                out.append(lines[prev].text)
        if line.file != shown_file:
            shown_file = line.file
            j = line.file
            while 0 <= j < len(lines) and lines[j].kind == "file" and lines[j].file == line.file:
                out.append(lines[j].text)
                prev, j = j, j + 1
        if line.kind == "file":
            continue  # its whole header block is already out
        if line.kind in ("add", "del", "ctx") and i != prev + 1:
            out.append(lines[line.hunk].text)
        out.append(line.text)
        prev = i
    return Selection("\n".join(out), read, flagged, sent, dict(found))


def rules_off() -> bool:
    """SCRUB_HAIKU_RULES=off sends the whole push, as it went before this pass."""
    return os.environ.get("SCRUB_HAIKU_RULES", "").strip().lower() in ("off", "0", "false")


# --- Remembering the vocabulary between pushes -------------------------------
#
# Reading the public tree takes 3 to 13 seconds, and every push would pay it.
# But the vocabulary only grows: a published word stays in public history. So
# the vocabulary at the last base is kept, and a push whose base descends from
# it reads only the commits in between; any other base rebuilds from the tree.

# Bump when tokens() or the tables change: an old file then rebuilds.
CACHE_VERSION = 2
_TABLES = ("lower", "case", "pairs", "cued", "marks")


def _cache_path() -> Optional[str]:
    common = _git(["rev-parse", "--path-format=absolute", "--git-common-dir"]).decode().strip()
    return os.path.join(common, "scrub-haiku", "vocabulary.json") if common else None


def _load(path: str) -> "tuple[Optional[str], Optional[Vocabulary]]":
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if data.get("version") != CACHE_VERSION:
            return None, None
        vocab = Vocabulary()
        for table in _TABLES:
            getattr(vocab, table).update(data[table])
        return str(data["commit"]), vocab
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return None, None


def _save(path: str, commit: str, vocab: Vocabulary) -> None:
    data = {"version": CACHE_VERSION, "commit": commit}
    data.update({table: dict(getattr(vocab, table)) for table in _TABLES})
    tmp = f"{path}.{os.getpid()}.tmp"
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f)
        os.replace(tmp, path)  # atomic, so a concurrent push never reads half
    except OSError:
        pass  # a cache that cannot be written only costs the next push time


def learn_range(vocab: Vocabulary, since: str, until: str) -> None:
    """Add the words `since..until` published: added lines, paths, messages."""
    patch = _git(["log", "--patch", "--cc", "--no-color", f"{since}..{until}"])
    for line in _parse(patch.decode("utf-8", errors="replace"), "\0"):
        if line.kind in ("add", "msg", "file"):
            vocab.learn(line.scan)


def public_vocabulary(base: Optional[str]) -> Vocabulary:
    """The vocabulary at `base`, from the cache when it can be."""
    if not base:
        return Vocabulary()
    path = _cache_path()
    cached_at, vocab = _load(path) if path else (None, None)
    if vocab is not None and cached_at == base:
        return vocab
    ancestor = cached_at and subprocess.run(
        ["git", "merge-base", "--is-ancestor", cached_at, base], capture_output=True,
    ).returncode == 0
    if vocab is not None and ancestor:
        learn_range(vocab, cached_at, base)
    else:
        vocab = vocabulary_at(base)
    if path:
        _save(path, base, vocab)
    return vocab
