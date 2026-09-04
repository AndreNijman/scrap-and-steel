#!/usr/bin/env python3
"""slopcheck — grep audit for the stop-slop rules.

Local addition to the vendored skill, not part of Hardik Pandya's upstream
repo.

Reads HTML, Markdown or plain text and reports each hit with the sentence it
sits in and which field it came from. Exits 1 when anything is found, so it
can gate a commit.

    slopcheck.py index.html projects/*.html
    slopcheck.py --allow-file .slopcheck-allow site/**/*.html
    slopcheck.py --only head index.html      # titles and meta only
    slopcheck.py --quiet index.html          # counts per file, no detail

WHY THE FIELD LABELS MATTER: an earlier version stripped <head> before
checking, treating only rendered prose as copy. Em dashes then survived in
every <title>, og:title and twitter:title on two live sites, because nothing
was looking there. Titles, meta descriptions, alt text and aria-labels are
copy. They are checked separately and labelled.
"""

import argparse, html, pathlib, re, sys

# ── the rules ─────────────────────────────────────────────────────────────
PHRASES = [
    r"here'?s (?:the thing|what|this|that|why)", r"the uncomfortable truth",
    r"it turns out", r"the real \w+ is", r"let me be clear", r"the truth is",
    r"i'?ll say it again", r"i'?m going to be honest", r"can we talk about",
    r"full stop\.", r"let that sink in", r"this matters because",
    r"make no mistake", r"at its core", r"in today'?s", r"it'?s worth noting",
    r"at the end of the day", r"when it comes to", r"in a world where",
    r"the reality is", r"\bnavigate\b", r"\bunpack\b", r"lean into",
    r"\blandscape\b", r"game.changer", r"double down", r"deep dive",
    r"take a step back", r"moving forward", r"circle back", r"on the same page",
    r"\bhint:", r"plot twist:", r"spoiler:", r"a feature, not a bug",
    r"let me walk you through", r"as we'?ll see", r"the rest of this essay",
    r"the reasons are structural", r"the implications are significant",
    r"the stakes are high", r"the consequences are real",
    r"this is genuinely hard", r"actually matters",
]
ADVERBS = (r"\b(?:really|just|literally|genuinely|honestly|simply|actually|deeply|truly|"
           r"fundamentally|inherently|inevitably|interestingly|importantly|crucially)\b")
EXTREMES = r"\b(?:every|always|never|everyone|everybody|nobody|everything)\b"
STRUCTS = [
    (r"\bnot (?:just )?\w[\w\s]{0,25}?,? but\b", "binary contrast (not X but Y)"),
    (r"\bisn'?t \w[\w\s]{0,25}?,? it'?s\b", "binary contrast (isn't X it's Y)"),
    (r"\bthe (?:answer|question|problem) isn'?t\b", "rhetorical misdirection"),
    (r"stops being \w+ and starts", "false transformation"),
    (r"\bwhat if\b", "rhetorical setup"),
    (r"here'?s what i mean", "redundant preview"),
    (r"think about it", "condescending prompt"),
    (r"and that'?s okay", "unnecessary permission"),
    (r"\bthat'?s it\.\s*that'?s\b", "dramatic fragmentation"),
]
WH_START = r"^(?:What|When|Where|Which|Who|Why|How|So|Look,)\b"

# -ly words that are not adverbs doing emphasis work
LY_OK = {"only", "early", "family", "reply", "supply", "apply", "italy", "assembly",
         "monopoly", "multiply", "anomaly", "panoply", "july", "ally", "rally",
         "holy", "ugly", "likely", "weekly", "monthly", "yearly", "daily"}

# Words ending -en/-ed that are not past participles. Without these the passive
# heuristic fires on "is token-identical", because \w+(en) happily matches
# "tok"+"en".
NOT_PARTICIPLES = {
    "token", "garden", "often", "open", "wooden", "golden", "kitchen", "oxygen",
    "children", "women", "citizen", "warden", "burden", "sudden", "green",
    "between", "when", "then", "even", "eleven", "seven", "screen", "listen",
    "happen", "dozen", "linen", "siren", "sullen", "swollen",
    "bed", "red", "need", "feed", "speed", "indeed", "shed", "sled", "bred",
    "hundred", "sacred", "naked", "wicked", "embed", "exceed", "proceed",
}
PASSIVE_LEAD = r"\b(is|are|was|were|been|being)\s+([a-z]+(?:ed|en))\b"


# Block-level elements end a thought. Without this the flattener glues a card
# label to the paragraph beside it and the rhythm checks fire on "sentences"
# that no reader ever sees as one.
BLOCK = (r"</?(?:p|div|section|article|nav|header|footer|main|aside|h[1-6]|li|ul|ol|"
         r"dl|dt|dd|td|th|tr|table|blockquote|figure|figcaption|br|hr|span|a|label|button)\b[^>]*>")


def visible_text(raw: str) -> str:
    raw = re.sub(r"<script[\s\S]*?</script>", " ", raw, flags=re.I)
    raw = re.sub(r"<style[\s\S]*?</style>", " ", raw, flags=re.I)
    raw = re.sub(r"<!--[\s\S]*?-->", " ", raw)
    raw = re.sub(BLOCK, "\n", raw, flags=re.I)
    raw = re.sub(r"<[^>]+>", " ", raw)
    return html.unescape(raw)


def head_fields(raw: str):
    """Title, meta descriptions, social titles, alt text, aria-labels.

    These never appear in rendered prose and were the blind spot that let em
    dashes survive in every page title across two sites.
    """
    out = []
    m = re.search(r"<title[^>]*>([\s\S]*?)</title>", raw, re.I)
    if m:
        out.append(("title", html.unescape(m.group(1)).strip()))
    for attr, pat in (
        ("meta description", r'<meta[^>]+name=["\']description["\'][^>]+content=(["\'])((?:(?!\1)[^>])*)\1'),
        ("og:title",         r'<meta[^>]+property=["\']og:title["\'][^>]+content=(["\'])((?:(?!\1)[^>])*)\1'),
        ("og:description",   r'<meta[^>]+property=["\']og:description["\'][^>]+content=(["\'])((?:(?!\1)[^>])*)\1'),
        ("twitter:title",    r'<meta[^>]+name=["\']twitter:title["\'][^>]+content=(["\'])((?:(?!\1)[^>])*)\1'),
        ("twitter:description", r'<meta[^>]+name=["\']twitter:description["\'][^>]+content=(["\'])((?:(?!\1)[^>])*)\1'),
    ):
        for _q, hit in re.findall(pat, raw, re.I):
            out.append((attr, html.unescape(hit).strip()))
    for _q, hit in re.findall(r'<img[^>]+alt=(["\'])((?:(?!\1)[^>]){4,})\1', raw, re.I):
        out.append(("alt", html.unescape(hit).strip()))
    for _q, hit in re.findall(r'aria-label=(["\'])((?:(?!\1)[^>]){4,})\1', raw, re.I):
        out.append(("aria-label", html.unescape(hit).strip()))
    return out


def sentences(text: str):
    out = []
    for line in text.split("\n"):
        line = re.sub(r"[ \t]+", " ", line).strip()
        if not line:
            continue
        out += [s.strip() for s in re.split(r"(?<=[.!?])\s+", line) if s.strip()]
    return out


def check(segment: str, field: str, allow):
    """Run every rule over one chunk of copy."""
    found = []
    def add(kind, detail):
        if any(a in segment for a in allow):
            return
        found.append((field, kind, detail, segment[:150]))

    low = segment.lower()
    for p in PHRASES:
        m = re.search(p, low)
        if m: add("phrase", m.group(0))
    for m in re.finditer(ADVERBS, low): add("adverb", m.group(0))
    for m in re.finditer(r"\b\w{4,}ly\b", low):
        if m.group(0) not in LY_OK: add("adverb(-ly)", m.group(0))
    for m in re.finditer(EXTREMES, low): add("lazy extreme", m.group(0))
    for p, name in STRUCTS:
        if re.search(p, low): add("structure", name)
    for m in re.finditer(PASSIVE_LEAD, low):
        word = m.group(2)
        # hyphenated compounds are adjectives: "is token-identical", "is well-known"
        after = low[m.end():m.end() + 1]
        if word in NOT_PARTICIPLES or after == "-":
            continue
        add("passive", m.group(0))
    # The Wh- rule is about openers becoming a crutch across sentences. A short
    # heading like "How I work" is a label, so only judge real sentences.
    if len(segment.split()) > 5 and re.search(WH_START, segment):
        add("sentence start", segment.split()[0])
    if "—" in segment or "–" in segment: add("em/en dash", "—")
    return found


def audit(path: str, allow, only=None):
    raw = pathlib.Path(path).read_text(encoding="utf8", errors="replace")
    is_markup = path.endswith((".html", ".htm", ".xml"))
    findings = []

    if is_markup and only in (None, "head"):
        for field, value in head_fields(raw):
            findings += check(value, field, allow)

    if only in (None, "prose"):
        text = visible_text(raw) if is_markup else raw
        sents = sentences(text)
        for s in sents:
            findings += check(s, "prose", allow)
        for s in sents:
            if re.search(r"\w+, \w[\w\s]{0,20}, (?:and|or) \w+", s):
                if not any(a in s for a in allow):
                    findings.append(("prose", "rhythm", "three-item list", s[:150]))
        for i in range(len(sents) - 2):
            L = [len(x) for x in sents[i:i + 3]]
            if max(L) - min(L) <= 6 and min(L) > 20:
                if not any(a in sents[i] for a in allow):
                    findings.append(("prose", "rhythm", f"3 sentences same length {L}", sents[i][:150]))

    # de-duplicate identical hits
    seen, unique = set(), []
    for f in findings:
        if f in seen: continue
        seen.add(f); unique.append(f)
    return unique


def main():
    ap = argparse.ArgumentParser(description="Audit copy against the stop-slop rules.")
    ap.add_argument("paths", nargs="+")
    ap.add_argument("--allow-file", help="file of exact strings to skip, one per line")
    ap.add_argument("--only", choices=["head", "prose"], help="limit to one surface")
    ap.add_argument("--quiet", action="store_true", help="counts only")
    a = ap.parse_args()

    allow = []
    if a.allow_file and pathlib.Path(a.allow_file).exists():
        allow = [l.strip() for l in pathlib.Path(a.allow_file).read_text().splitlines()
                 if l.strip() and not l.startswith("#")]

    total = 0
    for path in a.paths:
        f = audit(path, allow, a.only)
        total += len(f)
        if a.quiet:
            print(f"{len(f):>4}  {path}")
            continue
        print(f"\n=== {path} — {len(f)} hits ===")
        for field, kind, detail, ctx in f:
            print(f"  [{field}] {kind}: {detail}")
            print(f"      {ctx}")
    print(f"\nTOTAL: {total}" + (f"  (allow-list skipped {len(allow)} strings)" if allow else ""))
    sys.exit(1 if total else 0)


if __name__ == "__main__":
    main()
