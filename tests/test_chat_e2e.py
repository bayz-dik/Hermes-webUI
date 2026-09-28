#!/usr/bin/env python3
"""End-to-end test of a real agent run through the console.

This is the test that matters: it starts an actual `hermes chat` process through
the HTTP API, follows the server-sent event stream, and asserts on what the run
really produced. Nothing here is mocked.

Usage:  python3 tests/test_chat_e2e.py [--port 8787] [--session e2e-console-test]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional

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


def req(url: str, *, token: str, method: str = "GET", body: Optional[dict[str, Any]] = None,
        timeout: float = 60.0) -> tuple[int, str]:
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("X-Hermes-Token", token)
    if body is not None:
        r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r, timeout=timeout) as res:
            return res.status, res.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", errors="replace")
    except Exception as exc:
        return 0, f"{type(exc).__name__}: {exc}"


def sse_frames(url: str, token: str, budget: float = 240.0) -> list[tuple[str, str]]:
    """Read an SSE stream until the `end` frame or the budget runs out."""
    frames: list[tuple[str, str]] = []
    r = urllib.request.Request(url)
    r.add_header("X-Hermes-Token", token)
    started = time.time()
    try:
        with urllib.request.urlopen(r, timeout=budget + 20) as res:
            event = ""
            while time.time() - started < budget:
                raw = res.readline()
                if not raw:
                    break
                line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
                if line.startswith("event: "):
                    event = line[7:]
                elif line.startswith("data: "):
                    frames.append((event, line[6:]))
                    if event == "end":
                        return frames
    except Exception as exc:
        frames.append(("transport-error", f"{type(exc).__name__}: {exc}"))
    return frames


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--session", default="console-e2e")
    ap.add_argument("--token", default="")
    args = ap.parse_args()
    base = f"http://127.0.0.1:{args.port}"

    token = args.token
    if not token:
        with urllib.request.urlopen(base + "/", timeout=20) as res:
            page = res.read().decode()
        m = re.search(r'name="hermes-web-token" content="([0-9a-f]+)"', page)
        if not m:
            print("No token in the served page; is the server up?")
            return 2
        token = m.group(1)

    print(f"End-to-end agent run through {base}")
    print("")

    prompt = "Reply with exactly: CONSOLE-E2E-OK"
    code, body = req(base + "/api/chat", token=token, method="POST",
                     body={"session": args.session, "message": prompt})
    check("POST /api/chat accepts a run", code == 202, f"HTTP {code}")
    if code != 202:
        print(body[:400])
        return 1
    run_id = json.loads(body)["run_id"]
    print(f"  run id: {run_id}")
    print("")

    started = time.time()
    frames = sse_frames(f"{base}/api/run/events?id={urllib.parse.quote(run_id)}", token, budget=300)
    elapsed = time.time() - started

    kinds = [e for e, _ in frames]
    check("stream delivered frames", len(frames) > 0, f"{len(frames)} frames in {elapsed:.1f}s")
    check("stream reported the run starting", "event" in kinds and any(
        json.loads(d).get("kind") == "status" for e, d in frames if e == "event"), str(kinds[:6]))
    check("stream bound a session id", any(
        json.loads(d).get("kind") == "session_id" for e, d in frames if e == "event"), "")
    check("stream ended with an end frame", "end" in kinds, str(kinds[-3:]))

    final: dict[str, Any] = {}
    for e, d in frames:
        if e == "end":
            final = json.loads(d)
    check("run finished cleanly", final.get("status") == "done", f"status={final.get('status')} exit={final.get('exit_code')}")
    reply = str(final.get("reply") or "")
    check("reply contains the expected token", "CONSOLE-E2E-OK" in reply, repr(reply[:120]))
    check("reply is clean of CLI status noise", "Resumed session" not in reply and "Starting fresh" not in reply,
          repr(reply[:120]))
    check("no error was reported", not final.get("error"), str(final.get("error"))[:120])

    session_id = final.get("session_id") or ""
    check("session id was captured", bool(session_id), session_id)

    # The reply must be visible in the session store, not just in the stream.
    if session_id:
        code, body = req(f"{base}/api/session?id={urllib.parse.quote(session_id)}", token=token)
        detail = json.loads(body) if code == 200 else {}
        msgs = detail.get("messages", [])
        roles = [m.get("role") for m in msgs]
        check("the run is persisted in the session store", len(msgs) >= 2, f"{len(msgs)} messages, roles={roles}")
        check("the stored transcript holds both turns", "user" in roles and "assistant" in roles, str(roles))
        stored = " ".join((m.get("content") or "") for m in msgs if m.get("role") == "assistant")
        check("the stored assistant reply matches the stream", "CONSOLE-E2E-OK" in stored, repr(stored[:120]))

    # Multi-turn: the second message must reuse the same session.
    code, body = req(base + "/api/chat", token=token, method="POST",
                     body={"session": session_id, "message": "Now reply with exactly: SECOND-TURN-OK"})
    if code == 202:
        run2 = json.loads(body)["run_id"]
        frames2 = sse_frames(f"{base}/api/run/events?id={urllib.parse.quote(run2)}", token, budget=300)
        final2 = {}
        for e, d in frames2:
            if e == "end":
                final2 = json.loads(d)
        check("a second turn runs in the same session", final2.get("status") == "done",
              f"status={final2.get('status')}")
        check("the second turn reused the session id", final2.get("session_id") == session_id,
              f"{final2.get('session_id')} vs {session_id}")
        check("the second turn answered", "SECOND-TURN-OK" in str(final2.get("reply") or ""),
              repr(str(final2.get("reply"))[:120]))
    else:
        check("a second turn runs in the same session", False, f"HTTP {code}")

    print("")
    print(f"{PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
