"""Self-test cases: a push carrying only sanctioned placeholders passes.

Called from `scrub-selftest.py` with that module, whose helpers (`expect`,
the loopback Haiku stub, `spawn_haiku`) these cases drive. No case calls the
real API: every verdict below is a reply the stub was told to give.

The names are read off `scrub_names.PLACEHOLDER_NAMES`, never written out
here, and the unfamiliar surname is fabricated at run time. A test line that
spelled a placeholder in a sentence would itself be the shape it tests, and a
real-looking surname would be the leak.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
from types import ModuleType

import scrub_names
import scrub_placeholders

# Every word a case adds is published here RARE_BELOW times, so the only new
# word on a line is the one the case is about.
PUBLIC = ("I was checking the hover for, not polishing. Ask the Pier desk.\n"
          "Kept in a/notes.md b/notes.md and a/test.ts b/test.ts.\n"
          * scrub_names.RARE_BELOW)


def _lines() -> dict:
    first, second = scrub_names.PLACEHOLDER_NAMES[:2]
    house = scrub_names.HOUSE_FIXTURE_NAMES[-1]
    return {"hover": f"I was checking the hover for {first}, not polishing.",
            "ask": f"Ask {second}.", "ask-house": f"Ask {house}.",
            "first": first, "second": second}


def _surname() -> str:
    """An invented surname, from the generator the recall corpus plants."""
    here = os.path.dirname(os.path.abspath(__file__))
    spec = importlib.util.spec_from_file_location("scrub_recall", os.path.join(here, "scrub-recall.py"))
    recall = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(recall)
    return recall.fabricate_name("placeholder-negative").split()[-1]


def _reply(names: list[tuple[str, str]], leaks: list[str]) -> tuple[int, str]:
    rows = "\n".join(f"- {n} — notes.md — {v}" for n, v in names) or "none"
    text = f"NAMES:\n{rows}\n\nVERDICT: LEAKS_FOUND\nLEAKS:\n" + "\n".join(
        f"- notes.md:1 — {leak}" for leak in leaks)
    return 200, json.dumps({"content": [{"text": text}]})


def check(t: ModuleType) -> None:
    lines = _lines()
    surname = _surname()
    first, second = lines["first"], lines["second"]
    public = scrub_names.Vocabulary()
    public.learn(PUBLIC)

    def sent(line: str) -> str:
        return scrub_names.select(t.rules_patch("notes.md", [line]), public).text

    for case in ("hover", "ask", "ask-house"):
        t.expect(f"placeholders: the {case} line, new only for its placeholder, is not sent",
                 0 if sent(lines[case]) == "" else 1, 0, sent(lines[case]))
    for label, line in (
        ("an unfamiliar surname", f"Ask {surname}."),
        ("an unfamiliar surname beside a placeholder", f"I was checking the hover for {first} {surname}."),
        ("a published capitalised word as a placeholder's surname", f"{first} Pier was checking the hover."),
        ("a longer word that starts with a placeholder", f"Ask {second}by."),
        ("a placeholder in lower case", f"Ask {second.lower()}."),
        ("a placeholder in upper case", f"Ask {second.upper()}."),
    ):
        t.expect(f"placeholders: {label} is still sent",
                 0 if f"+{line}" in sent(line) else 1, 0, sent(line))

    check_verdicts(t, first, second, surname)
    check_end_to_end(t, lines, surname)


def check_verdicts(t: ModuleType, first: str, second: str, surname: str) -> None:
    """The reply, read: only a block about placeholders alone is overridden."""
    named = f"Personal name '{first}' used as sample data in a test string"
    cases = (
        ("a block naming only a placeholder passes", _reply([(first, "keep")], [named]), True),
        ("...and only the house names and the pair", _reply(
            [(f"{first} {scrub_names.HOUSE_FIXTURE_NAMES[-1]}", "keep"), (second, "keep")],
            [f"Names {first} and {second} in a fixture"]), True),
        ("a block naming an unfamiliar surname still blocks", _reply(
            [(surname, "keep")], [f"Personal surname '{surname}' in a test fixture"]), False),
        ("a placeholder kept beside an unfamiliar name still blocks", _reply(
            [(first, "keep"), (surname, "keep")], [named]), False),
        ("a placeholder with that surname still blocks", _reply(
            [(f"{first} {surname}", "keep")], [named]), False),
        ("a longer name starting with a placeholder still blocks", _reply(
            [(first + "a", "keep")], [f"Personal name '{first}a' in a test string"]), False),
        ("a placeholder's email still blocks", _reply(
            [(first, "keep")], [f"Email address for {first} in a fixture"]), False),
        ("a row naming no placeholder still blocks", _reply(
            [(first, "keep")], ["A home address in a fixture"]), False),
        ("a sweep with nothing kept still blocks", _reply([(first, "placeholder")], [named]), False),
        ("an unreadable sweep still blocks", (200, json.dumps({"content": [{
            "text": f"NAMES:\n- {first}\nVERDICT: LEAKS_FOUND\nLEAKS:\n- notes.md:1 — {named}"}]})), False),
    )
    for label, reply, passes in cases:
        text = json.loads(reply[1])["content"][0]["text"]
        t.expect(f"placeholder verdict: {label}",
                 0 if scrub_placeholders.only_placeholders(text) is passes else 1, 0, text)

    # The same replies from a fake model at the stub, through scrub-haiku.py's
    # exit code: the answer a push actually acts on.
    server, stub = t.start_haiku_stub()
    try:
        with tempfile.TemporaryDirectory() as tmp:
            ledger = os.path.join(tmp, "spend.jsonl")
            for path, (label, reply, passes) in (("/placeholder-only", cases[0]),
                                                 ("/unfamiliar-surname", cases[2])):
                t.HAIKU_STUB_REPLIES[path] = reply
                before = t.HaikuStub.calls
                r = t.spawn_haiku(f"{stub}{path}", "block-all", ledger=ledger)
                calls = t.HaikuStub.calls - before
                t.expect(f"placeholder verdict at the stub: {label}",
                         0 if calls == 1 and r.returncode == (0 if passes else 1) else 1, 0,
                         f"exit {r.returncode}, {calls} call(s)\n{r.stderr}")
    finally:
        server.shutdown()
        server.server_close()


def check_end_to_end(t: ModuleType, lines: dict, surname: str) -> None:
    """A push of the two incident lines makes no call; the control makes one and blocks."""
    server, stub = t.start_haiku_stub()
    t.HAIKU_STUB_REPLIES["/unfamiliar-surname-e2e"] = _reply(
        [(surname, "keep")], [f"Personal surname '{surname}' in a test fixture"])
    tmp = tempfile.TemporaryDirectory()
    try:
        repo = os.path.join(tmp.name, "riverbend-placeholder-repo")
        os.makedirs(repo)
        env = t.clean_git_env()

        def g(*args: str) -> None:
            subprocess.run(["git", *t.IDENT, *args], cwd=repo, check=True,
                           capture_output=True, text=True, env=env)

        g("init", "-q")
        with open(os.path.join(repo, "notes.md"), "w") as f:
            f.write(PUBLIC)
        g("add", "-A")
        g("commit", "-qm", "desk notes")
        ledger = os.path.join(tmp.name, "spend.jsonl")

        def pushed(added: list[str], path: str):
            before = t.HaikuStub.calls
            r = t.spawn_haiku(f"{stub}{path}", "block-all", ledger=ledger, cwd=repo,
                              stdin=t.rules_patch("test.ts", added),
                              argv=("--public-base", "HEAD"))
            return r, t.HaikuStub.calls - before

        r, calls = pushed([lines["hover"], lines["ask"]], "/leaks-usage")
        t.expect("placeholders: a push of the two incident lines makes no call and passes",
                 0 if r.returncode == 0 and calls == 0 else 1, 0,
                 f"exit {r.returncode}, {calls} call(s)\n{r.stderr}")
        r, calls = pushed([f"Ask {surname}."], "/unfamiliar-surname-e2e")
        t.expect("placeholders: an unfamiliar surname in a fixture reaches Haiku and blocks",
                 0 if r.returncode == 1 and calls == 1 else 1, 0,
                 f"exit {r.returncode}, {calls} call(s)\n{r.stderr}")
    finally:
        server.shutdown()
        server.server_close()
        tmp.cleanup()


if __name__ == "__main__":
    sys.exit("run through scripts/scrub-selftest.py")
