#!/usr/bin/env python3
"""Endpoint smoke test for the Hermes Console server.

Runs the real HTTP surface and asserts on observed status codes and payload
shapes. Every check prints PASS/FAIL with the measured value, so the output is
the evidence rather than a claim.

Usage:  python3 tests/test_api.py [--port 8787]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request
from typing import Any, Optional

PASS = 0
FAIL = 0
RESULTS: list[tuple[bool, str, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    global PASS, FAIL
    if ok:
        PASS += 1
        RESULTS.append((True, name, detail))
        print(f"  PASS  {name}" + (f"  [{detail}]" if detail else ""))
    else:
        FAIL += 1
        RESULTS.append((False, name, detail))
        print(f"  FAIL  {name}  [{detail}]")


def request(
    url: str,
    *,
    token: Optional[str] = None,
    method: str = "GET",
    body: Optional[dict[str, Any]] = None,
    origin: Optional[str] = None,
    timeout: float = 60.0,
) -> tuple[int, str]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if token:
        req.add_header("X-Hermes-Token", token)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if origin:
        req.add_header("Origin", origin)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, res.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", errors="replace")
    except Exception as exc:
        return 0, f"{type(exc).__name__}: {exc}"


def get_token(base: str) -> str:
    code, body = request(base + "/")
    if code != 200:
        print(f"Cannot load the shell page (HTTP {code}). Is the server running?")
        sys.exit(2)
    m = re.search(r'name="hermes-web-token" content="([0-9a-f]+)"', body)
    if not m:
        print("The served index.html carries no token meta tag.")
        sys.exit(2)
    return m.group(1)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8787)
    args = ap.parse_args()
    base = f"http://127.0.0.1:{args.port}"

    print(f"Hermes Console API smoke test against {base}")
    print("")
    token = get_token(base)
    check("shell page serves a session token", len(token) >= 32, f"{len(token)} chars")

    # ---------------------------------------------------------- security
    print("")
    print("security")
    code, body = request(base + "/api/system")
    check("api without a token is refused", code == 403, f"HTTP {code}")
    check("refusal explains itself", "token" in body.lower(), body[:80])

    code, _ = request(base + "/api/system", token=token, origin="http://evil.example.com")
    check("api with a foreign Origin is refused", code == 403, f"HTTP {code}")

    code, _ = request(base + "/api/system", token=token, origin="http://127.0.0.1:8787")
    check("api with a loopback Origin is allowed", code == 200, f"HTTP {code}")

    code, _ = request(base + "/api/system", token="0" * 48)
    check("api with a wrong token is refused", code == 403, f"HTTP {code}")

    code, body = request(base + "/api/skill?path=/etc/passwd", token=token)
    check("skill reader refuses a path outside the skills dir", code == 404, f"HTTP {code}")

    code, body = request(base + "/../server.py", token=token)
    check("static handler refuses path traversal", code in (403, 404), f"HTTP {code}")

    # ----------------------------------------------------------- payloads
    print("")
    print("read endpoints")
    checks: list[tuple[str, str, Any]] = [
        ("system", "/api/system", lambda d: isinstance(d.get("version"), str) and d["version"].startswith("v")),
        ("skills", "/api/skills", lambda d: d.get("total", 0) > 100 and isinstance(d.get("skills"), list)),
        ("plugins", "/api/plugins", lambda d: isinstance(d.get("plugins"), list) and d.get("total", 0) >= 3),
        ("tools", "/api/tools", lambda d: len(d.get("builtin", [])) > 10),
        ("sessions", "/api/sessions?limit=5", lambda d: isinstance(d.get("sessions"), list)),
        ("cron", "/api/cron", lambda d: isinstance(d.get("jobs"), list)),
        ("activity", "/api/activity?limit=20", lambda d: isinstance(d.get("events"), list)),
        ("runs", "/api/runs", lambda d: isinstance(d.get("runs"), list)),
    ]
    payloads: dict[str, Any] = {}
    for name, path, predicate in checks:
        code, body = request(base + path, token=token)
        if code != 200:
            check(f"GET {path}", False, f"HTTP {code}: {body[:100]}")
            continue
        try:
            data = json.loads(body)
        except Exception as exc:
            check(f"GET {path}", False, f"invalid JSON: {exc}")
            continue
        payloads[name] = data
        ok = False
        try:
            ok = bool(predicate(data))
        except Exception as exc:
            check(f"GET {path}", False, f"predicate raised: {exc}")
            continue
        check(f"GET {path}", ok, f"{len(body)} bytes")

    # ---------------------------------------------------- real content
    print("")
    print("content is real, not placeholder")
    skills = payloads.get("skills", {})
    if skills.get("skills"):
        sample = skills["skills"][0]
        check("skills carry a name and description", bool(sample.get("name")) and bool(sample.get("description")),
              f"{sample.get('name')} ({len(sample.get('description', ''))} char description)")
        check("skills are categorised", bool(sample.get("category")), str(sample.get("category")))
        cats = skills.get("categories", [])
        check("skill categories are populated", len(cats) >= 5, f"{len(cats)} categories")
        code, body = request(base + "/api/skill?path=" + urllib.parse.quote(sample["abs_path"]), token=token)
        check("a skill body can be read", code == 200 and len(body) > 500, f"HTTP {code}, {len(body)} bytes")

    system = payloads.get("system", {})
    check("system reports the configured model", bool(system.get("config", {}).get("model")),
          str(system.get("config", {}).get("model")))
    check("system counts skills on disk", system.get("skills_count", 0) > 100, str(system.get("skills_count")))

    sessions = payloads.get("sessions", {})
    if sessions.get("sessions"):
        s = sessions["sessions"][0]
        code, body = request(base + "/api/session?id=" + urllib.parse.quote(s["id"]), token=token)
        detail = json.loads(body) if code == 200 else {}
        check("a session transcript can be read",
              code == 200 and len(detail.get("messages", [])) > 0,
              f"HTTP {code}, {len(detail.get('messages', []))} messages")
        msgs = detail.get("messages", [])
        check("transcript messages have roles and content",
              all(m.get("role") and m.get("content") is not None for m in msgs[:5]) if msgs else False,
              f"roles: {sorted({m.get('role') for m in msgs})}")

    # --------------------------------------------------------- negative
    print("")
    print("error paths")
    code, body = request(base + "/api/nope", token=token)
    check("unknown endpoint returns 404", code == 404, f"HTTP {code}")

    code, body = request(base + "/api/session", token=token)
    check("missing required parameter returns 400", code == 400, f"HTTP {code}")

    code, body = request(base + "/api/chat", token=token, method="POST", body={"message": "   "})
    check("empty chat message is rejected", code == 400, f"HTTP {code}")

    code, body = request(base + "/api/chat", token=token, method="POST", body={"message": "x" * 40000})
    check("oversized chat message is rejected", code == 413, f"HTTP {code}")

    code, body = request(base + "/api/run?id=does-not-exist", token=token)
    check("unknown run returns 404", code == 404, f"HTTP {code}")

    req = urllib.request.Request(base + "/api/chat", data=b"{not json", method="POST")
    req.add_header("X-Hermes-Token", token)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            code = res.status
    except urllib.error.HTTPError as exc:
        code = exc.code
    check("malformed JSON body returns 400", code == 400, f"HTTP {code}")

    # ------------------------------------------------------ static files
    print("")
    print("static assets")
    for path, expect in (("/styles/tokens.css", "text/css"), ("/styles/app.css", "text/css"),
                         ("/favicon.svg", "image/svg+xml"),
                         ("/fonts/ibm-plex-sans-latin-400-normal.woff2", "font/woff2")):
        req = urllib.request.Request(base + path)
        try:
            with urllib.request.urlopen(req, timeout=20) as res:
                ctype = res.headers.get("Content-Type", "")
                size = len(res.read())
            check(f"GET {path}", expect in ctype and size > 100, f"{ctype}, {size} bytes")
        except Exception as exc:
            check(f"GET {path}", False, str(exc))

    m = re.search(r'src="(/assets/[^"]+\.js)"', get_token(base) and urllib.request.urlopen(base + "/").read().decode())
    if m:
        req = urllib.request.Request(base + m.group(1))
        with urllib.request.urlopen(req, timeout=20) as res:
            js = res.read().decode()
        check("app bundle is served and contains the views",
              all(s in js for s in ("Overview", "Skills", "Plugins", "Sessions", "Activity")),
              f"{len(js)} bytes")
    else:
        check("app bundle is referenced by index.html", False, "no /assets/*.js found")

    print("")
    print(f"{PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    import urllib.parse  # noqa: E402  (used inside main for quoting)
    sys.exit(main())
