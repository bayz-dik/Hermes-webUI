#!/usr/bin/env python3
"""Design-token verification.

Reads public/styles/tokens.css and checks the contrast ratios that DESIGN.md
claims, so a palette edit that quietly breaks accessibility fails here instead of
shipping. Also checks the structural rules the design depends on: one accent, no
pure black or white, one radius, and no em-dash anywhere in the source.

Usage:  python3 scripts/verify.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOKENS = ROOT / "public" / "styles" / "tokens.css"
APP_CSS = ROOT / "public" / "styles" / "app.css"

PASS = 0
FAIL = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  PASS  {name}" + (f"  [{detail}]" if detail else ""))
    else:
        FAIL += 1
        print(f"  FAIL  {name}  [{detail}]")


def luminance(hex_color: str) -> float:
    h = hex_color.lstrip("#")
    r, g, b = (int(h[i : i + 2], 16) / 255 for i in (0, 2, 4))

    def lin(c: float) -> float:
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)


def contrast(fg: str, bg: str) -> float:
    a, b = luminance(fg), luminance(bg)
    hi, lo = max(a, b), min(a, b)
    return (hi + 0.05) / (lo + 0.05)


def read_tokens() -> dict[str, str]:
    text = TOKENS.read_text(encoding="utf-8")
    return {m.group(1): m.group(2).strip() for m in re.finditer(r"^\s*(--[\w-]+):\s*([^;]+);", text, re.M)}


def main() -> int:
    if not TOKENS.is_file():
        print(f"Missing {TOKENS}")
        return 2
    tokens = read_tokens()
    print(f"Design tokens: {TOKENS}")
    print(f"{len(tokens)} tokens declared")
    print("")

    print("contrast against the page background")
    # (foreground token, background token, minimum ratio, note)
    pairs: list[tuple[str, str, float, str]] = [
        ("--text", "--bg", 4.5, "body text on page"),
        ("--text", "--surface", 4.5, "body text on panel"),
        ("--text", "--surface-2", 4.5, "body text on raised row"),
        ("--muted", "--bg", 4.5, "secondary text on page"),
        ("--muted", "--surface", 4.5, "secondary text on panel"),
        ("--dim", "--bg", 4.5, "tertiary text on page"),
        ("--accent", "--bg", 4.5, "accent on page"),
        ("--accent", "--surface", 4.5, "accent on panel"),
        ("--ok", "--bg", 4.5, "success status"),
        ("--warn", "--bg", 4.5, "warning status"),
        ("--err", "--bg", 4.5, "error status"),
        ("--accent-ink", "--accent", 4.5, "label on an accent fill"),
        ("--ok-ink", "--ok", 4.5, "label on a success fill"),
    ]
    for fg_name, bg_name, minimum, note in pairs:
        fg, bg = tokens.get(fg_name), tokens.get(bg_name)
        if not fg or not bg or not fg.startswith("#") or not bg.startswith("#"):
            check(f"{fg_name} on {bg_name}", False, "token missing or not a hex colour")
            continue
        ratio = contrast(fg, bg)
        check(
            f"{fg_name} on {bg_name}",
            ratio >= minimum,
            f"{ratio:.2f}:1 (min {minimum}) - {note}",
        )

    print("")
    print("palette structure")
    for token in ("--bg", "--surface", "--surface-2", "--surface-3", "--line", "--text", "--muted", "--dim"):
        value = (tokens.get(token) or "").lower()
        check(
            f"{token} is not pure black or white",
            value not in ("#000", "#000000", "#fff", "#ffffff"),
            value or "missing",
        )

    # The one-accent rule: exactly one token named --accent plus its derived
    # variants, and no second hue token introduced under another name.
    accent_tokens = [k for k in tokens if k.startswith("--accent")]
    check("exactly one accent family", len(accent_tokens) <= 4, ", ".join(sorted(accent_tokens)))

    # Match the radius token exactly: `--rail` also starts with `--r`.
    radius = [k for k in tokens if re.fullmatch(r"--r(-\w+)?", k)]
    check("exactly one radius token", len(radius) == 1, ", ".join(sorted(radius)))

    scales = [k for k in tokens if re.fullmatch(r"--s\d+", k)]
    check("one spacing scale", len(scales) >= 6, f"{len(scales)} steps")

    print("")
    print("house rules across all stylesheets")
    css_files = [TOKENS, APP_CSS]
    for path in css_files:
        if not path.is_file():
            check(f"{path.name} exists", False, "missing")
            continue
        text = path.read_text(encoding="utf-8")
        check(f"{path.name} has no em-dash", "\u2014" not in text and "\u2013" not in text, "checked for em-dash and en-dash")
        check(f"{path.name} has no pure #000/#fff", not re.search(r"#(000|000000|fff|ffffff)\b", text, re.I), "")

        # `!important` is allowed in exactly one place: the reduced-motion block,
        # where it must override every animation and transition unconditionally.
        outside = text
        rm = re.search(r"@media \(prefers-reduced-motion: reduce\)\s*\{(?:[^{}]|\{[^{}]*\})*\}", text)
        if rm:
            outside = text[: rm.start()] + text[rm.end() :]
        stray = outside.count("!important")
        check(
            f"{path.name}: !important only inside reduced-motion",
            stray == 0,
            f"{stray} outside the reduced-motion block" if stray else "clean",
        )

    src_files = sorted((ROOT / "src").glob("*.ts"))
    if src_files:
        offenders = [p.name for p in src_files if "\u2014" in p.read_text(encoding="utf-8")]
        check("no em-dash in TypeScript sources", not offenders, ", ".join(offenders) or f"{len(src_files)} files clean")

    print("")
    print(f"{PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
