#!/usr/bin/env python3
"""Hermes Console server.

Serves the built web UI and a JSON API over the local Hermes install, so the
agent can be driven from a browser without opening a terminal.

Design constraints (all of them are load-bearing):

* **Loopback only.** Binds 127.0.0.1. The server can run the agent, so it must
  never be reachable from the network.
* **CSRF guarded.** A random token is minted at startup and written into the
  served index.html. /api requires it in the X-Hermes-Token header, and requests
  carrying a foreign Origin are rejected. A page on another site cannot read
  index.html, so it cannot forge a call to 127.0.0.1.
* **Read-only on Hermes state.** The session store is opened with mode=ro. The
  only writes this process makes are under ~/.hermes-web/.
* **stdlib only.** No pip, no venv. It has to run on a phone.

Run:  python3 server.py [--port 8787] [--no-open]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.parse
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterable, Optional

APP_DIR = Path(__file__).resolve().parent
DIST_DIR = APP_DIR / "dist"
HERMES_HOME = Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes")).expanduser().resolve()
STATE_DB = HERMES_HOME / "state.db"
SKILLS_DIR = HERMES_HOME / "skills"
PLUGINS_DIR = HERMES_HOME / "plugins"
CONFIG_FILE = HERMES_HOME / "config.yaml"
ACTIVITY_FEED = HERMES_HOME / "runtime" / "live_activity.jsonl"
CRON_JOBS = HERMES_HOME / "cron" / "jobs.json"

WEB_HOME = Path(os.environ.get("HERMES_WEB_HOME") or (Path.home() / ".hermes-web")).expanduser()
RUNS_DIR = WEB_HOME / "runs"
WEB_HOME.mkdir(parents=True, exist_ok=True)
RUNS_DIR.mkdir(parents=True, exist_ok=True)

HERMES_BIN = shutil.which("hermes") or "hermes"
TOKEN = uuid.uuid4().hex + uuid.uuid4().hex[:16]
STARTED_AT = time.time()

# Subprocesses we launched, so a shutdown can reap them instead of leaking
# `hermes chat` processes that keep billing tokens in the background.
_ACTIVE: dict[str, subprocess.Popen] = {}
_ACTIVE_LOCK = threading.Lock()


# --------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------
def run_cmd(args: list[str], timeout: float = 60.0, cwd: Optional[str] = None) -> tuple[int, str, str]:
    """Run a command, never raise. Returns (exit_code, stdout, stderr)."""
    try:
        p = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=cwd,
            env={**os.environ, "HERMES_HOME": str(HERMES_HOME)},
        )
        return p.returncode, p.stdout, p.stderr
    except FileNotFoundError:
        return 127, "", f"command not found: {args[0]}"
    except subprocess.TimeoutExpired:
        return 124, "", f"timed out after {timeout:.0f}s: {' '.join(args[:3])}"
    except Exception as exc:  # pragma: no cover - defensive
        return 1, "", f"{type(exc).__name__}: {exc}"


def read_json_file(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        return None
    except Exception:
        return None


def frontmatter(text: str) -> dict[str, str]:
    """Minimal YAML frontmatter reader: flat scalar keys only.

    A full YAML parser is not available (stdlib only, and PyYAML is not in this
    interpreter), and SKILL.md frontmatter is flat by convention.
    """
    if not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    if end == -1:
        return {}
    out: dict[str, str] = {}
    for line in text[3:end].splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        m = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", line)
        if not m:
            continue
        key, val = m.group(1), m.group(2).strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
            val = val[1:-1]
        out[key] = val
    return out


def short_path(p: Path) -> str:
    try:
        return "~/" + str(p.relative_to(Path.home()))
    except ValueError:
        return str(p)


def first_paragraph(body: str, limit: int = 240) -> str:
    """First real sentence-ish chunk of a markdown body, for list previews."""
    text = re.sub(r"^---.*?\n---\n", "", body, count=1, flags=re.S)
    for block in re.split(r"\n\s*\n", text):
        clean = " ".join(
            ln.strip() for ln in block.splitlines() if not ln.strip().startswith(("#", ">", "|", "-", "*"))
        ).strip()
        clean = re.sub(r"[`*_]", "", clean)
        if len(clean) > 40:
            return clean[:limit] + ("..." if len(clean) > limit else "")
    return ""


# --------------------------------------------------------------------------
# data providers
# --------------------------------------------------------------------------
def get_version() -> dict[str, Any]:
    """Read the installed version from the install tree.

    Not `hermes --version`: that spawns the full CLI and takes ~9 seconds on this
    device. pyproject.toml carries the same version string and is right there.
    """
    version = ""
    upstream = ""
    install_dir = ""
    for candidate in (Path("/usr/local/lib/hermes-agent"), Path(HERMES_HOME).parent / "hermes-agent"):
        pyproject = candidate / "pyproject.toml"
        if pyproject.is_file():
            try:
                m = re.search(r'^version\s*=\s*"([^"]+)"', pyproject.read_text(encoding="utf-8"), re.M)
                if m:
                    version = f"v{m.group(1)}"
                    install_dir = str(candidate)
                    break
            except Exception:
                continue
    # The commit the install was built from, when the tree is a git checkout.
    git_head = Path(install_dir) / ".git" / "HEAD"
    if install_dir and git_head.is_file():
        try:
            ref = git_head.read_text(encoding="utf-8").strip()
            if ref.startswith("ref: "):
                ref_file = Path(install_dir) / ".git" / ref[5:].strip()
                upstream = ref_file.read_text(encoding="utf-8").strip()[:8] if ref_file.is_file() else ""
            else:
                upstream = ref[:8]
        except Exception:
            upstream = ""
    return {"version": version, "upstream": upstream, "install_dir": install_dir, "exit_code": 0}


def get_config_summary() -> dict[str, Any]:
    """Read only the keys the UI shows, straight from config.yaml.

    Deliberately not `hermes config get` per key: that spawns a process each time
    and the file is right here.
    """
    text = ""
    try:
        text = CONFIG_FILE.read_text(encoding="utf-8")
    except Exception:
        return {}

    def top(key: str) -> Optional[str]:
        m = re.search(rf"^{key}:\s*(.+)$", text, re.M)
        return m.group(1).strip() if m else None

    def nested(section: str, key: str) -> Optional[str]:
        m = re.search(rf"^{section}:\n((?:[ \t]+.*\n|\n)*)", text, re.M)
        if not m:
            return None
        m2 = re.search(rf"^[ \t]+{key}:\s*(.+)$", m.group(1), re.M)
        return m2.group(1).strip() if m2 else None

    plugins_enabled: list[str] = []
    m = re.search(r"^plugins:\n((?:[ \t]+.*\n|\n)*)", text, re.M)
    if m:
        block = m.group(1)
        em = re.search(r"^[ \t]+enabled:\n((?:[ \t]+-.*\n|\n)*)", block, re.M)
        if em:
            plugins_enabled = [
                ln.strip().lstrip("- ").strip() for ln in em.group(1).splitlines() if ln.strip().startswith("-")
            ]

    return {
        "model": nested("model", "default") or top("model"),
        "provider": nested("model", "provider"),
        "base_url": nested("model", "base_url"),
        "interface": nested("display", "interface"),
        "plugins_enabled": plugins_enabled,
        "path": str(CONFIG_FILE),
    }


def get_system() -> dict[str, Any]:
    cfg = get_config_summary()
    ver = get_version()
    env_keys = 0
    env_file = HERMES_HOME / ".env"
    if env_file.exists():
        try:
            env_keys = sum(
                1
                for ln in env_file.read_text(encoding="utf-8", errors="replace").splitlines()
                if re.match(r"^[A-Z][A-Z0-9_]*=", ln)
            )
        except Exception:
            env_keys = 0
    disk = shutil.disk_usage(str(Path.home()))
    return {
        "version": ver["version"],
        "upstream": ver["upstream"],
        "install_dir": ver["install_dir"],
        "python": sys.version.split()[0],
        "platform": sys.platform,
        "hermes_home": short_path(HERMES_HOME),
        "config": cfg,
        "env_keys": env_keys,
        "disk_free_gb": round(disk.free / 1024**3, 1),
        "disk_total_gb": round(disk.total / 1024**3, 1),
        "uptime_s": int(time.time() - STARTED_AT),
        "skills_count": sum(1 for _ in SKILLS_DIR.rglob("SKILL.md")) if SKILLS_DIR.is_dir() else 0,
    }


_SKILLS_CACHE: dict[str, Any] = {"at": 0.0, "data": None}


def get_skills(force: bool = False) -> list[dict[str, Any]]:
    now = time.time()
    if not force and _SKILLS_CACHE["data"] is not None and now - _SKILLS_CACHE["at"] < 30:
        return _SKILLS_CACHE["data"]
    items: list[dict[str, Any]] = []
    if SKILLS_DIR.is_dir():
        for path in sorted(SKILLS_DIR.rglob("SKILL.md")):
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
            except Exception:
                continue
            fm = frontmatter(text)
            rel = path.parent.relative_to(SKILLS_DIR)
            parts = rel.parts
            category = parts[0] if len(parts) > 1 else "uncategorised"
            name = fm.get("name") or rel.name
            desc = fm.get("description") or first_paragraph(text)
            desc = re.sub(r"\s+", " ", desc).strip()
            items.append(
                {
                    "name": name,
                    "description": desc,
                    "category": category,
                    "folder": str(rel),
                    "path": short_path(path),
                    "abs_path": str(path),
                    "bytes": len(text),
                }
            )
    items.sort(key=lambda s: (s["category"].lower(), s["name"].lower()))
    _SKILLS_CACHE["data"] = items
    _SKILLS_CACHE["at"] = now
    return items


def get_skill_body(abs_path: str) -> Optional[dict[str, Any]]:
    """Return a skill's SKILL.md. The path must resolve inside the skills dir."""
    try:
        p = Path(abs_path).resolve()
        p.relative_to(SKILLS_DIR.resolve())
    except (ValueError, OSError):
        return None
    if not p.is_file():
        return None
    try:
        text = p.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return None
    return {"path": short_path(p), "content": text, "lines": text.count("\n") + 1}


_PLUGINS_CACHE: dict[str, Any] = {"at": 0.0, "data": None}
PLUGIN_CACHE_FILE = WEB_HOME / "plugins-cache.json"
PLUGIN_CACHE_TTL = 300.0
BUNDLED_PLUGIN_ROOTS = (
    Path("/usr/local/lib/hermes-agent/plugins"),
    HERMES_HOME.parent / "hermes-agent" / "plugins",
)


def _plugin_dirs() -> list[Path]:
    """Every directory holding a plugin manifest, bundled and user-installed."""
    found: list[Path] = []
    for root in (*BUNDLED_PLUGIN_ROOTS, PLUGINS_DIR):
        if not root.is_dir():
            continue
        for manifest in sorted(root.rglob("plugin.yaml")):
            found.append(manifest.parent)
    return found


def _read_manifest(directory: Path) -> dict[str, str]:
    """Flat scalar frontmatter of a plugin.yaml, plus list-valued keys."""
    for candidate in ("plugin.yaml", "manifest.yaml"):
        f = directory / candidate
        if not f.is_file():
            continue
        try:
            raw = f.read_text(encoding="utf-8", errors="replace")
        except Exception:
            return {}
        fm = frontmatter("---\n" + raw)
        # `description: >` is a folded block: the value is on the lines below.
        if fm.get("description", "").strip() in (">", "|", ">-", "|-"):
            m = re.search(r"^description:\s*[>|]-?\s*\n((?:[ \t]+.*\n|\n)*)", raw, re.M)
            if m:
                fm["description"] = " ".join(
                    ln.strip() for ln in m.group(1).splitlines() if ln.strip()
                )
        return fm
    return {}


def _disk_plugins() -> list[dict[str, Any]]:
    """Every plugin manifest on this machine, with its enabled state.

    Reading manifests is instant; `hermes plugins list` spawns the full CLI and
    takes ~15s on this device, which is why this is the primary source and the
    CLI result is only used to confirm it.
    """
    cfg = get_config_summary()
    enabled_names = set(cfg.get("plugins_enabled") or [])
    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    for directory in _plugin_dirs():
        fm = _read_manifest(directory)
        name = fm.get("name") or directory.name
        if name in seen:
            continue
        seen.add(name)
        user = PLUGINS_DIR in directory.parents or directory.parent == PLUGINS_DIR
        items.append(
            {
                "name": name,
                "status": "enabled" if name in enabled_names else "not enabled",
                "version": fm.get("version") or "",
                "description": re.sub(r"\s+", " ", fm.get("description") or "").strip(),
                "author": fm.get("author") or "",
                "source": "user" if user else "bundled",
                "provides_tools": _list_field(directory, "provides_tools"),
                "provides_commands": _list_field(directory, "provides_commands"),
                "hooks": _list_field(directory, "hooks") or _list_field(directory, "provides_hooks"),
                "path": short_path(directory),
                "removed": None,
            }
        )
    items.sort(key=lambda p: (0 if p["source"] == "user" else 1, p["name"].lower()))
    return items


def _list_field(directory: Path, key: str) -> list[str]:
    """A YAML list value from a plugin manifest, e.g. `hooks:\n  - pre_tool_call`."""
    for candidate in ("plugin.yaml", "manifest.yaml"):
        f = directory / candidate
        if not f.is_file():
            continue
        try:
            raw = f.read_text(encoding="utf-8", errors="replace")
        except Exception:
            return []
        m = re.search(rf"^{re.escape(key)}:\s*\n((?:[ \t]+-.*\n|\n)*)", raw, re.M)
        if m:
            return [ln.strip().lstrip("- ").strip() for ln in m.group(1).splitlines() if ln.strip().startswith("-")]
    return []


def get_plugins(force: bool = False) -> dict[str, Any]:
    """Installed plugins plus which source answered.

    Order of preference: the on-disk manifests (instant, complete), then the
    cached CLI result. `confirmed_by_cli` says whether the CLI agreed, so the UI
    can be honest about which one it is showing.
    """
    now = time.time()
    cached = _PLUGINS_CACHE["data"]
    if not force and cached is not None and now - _PLUGINS_CACHE["at"] < PLUGIN_CACHE_TTL:
        return cached

    disk = _disk_plugins()
    result: dict[str, Any] = {
        "plugins": disk,
        "source": "manifests",
        "confirmed_by_cli": False,
        "cli_error": "",
        "at": now,
    }

    # The CLI list is authoritative for bundled-plugin status and is cached on
    # disk for minutes, so the first page load pays for it and later ones do not.
    cli = read_json_file(PLUGIN_CACHE_FILE)
    if not isinstance(cli, dict) or now - float(cli.get("at") or 0) > PLUGIN_CACHE_TTL or force:
        code, out, err = run_cmd([HERMES_BIN, "plugins", "list", "--json"], timeout=120)
        if code == 0:
            try:
                cli = {"at": now, "plugins": json.loads(out)}
                PLUGIN_CACHE_FILE.write_text(json.dumps(cli), encoding="utf-8")
            except Exception:
                cli = None
        else:
            cli = None
            result["cli_error"] = (err or out).strip()[:300]

    if isinstance(cli, dict) and isinstance(cli.get("plugins"), list):
        by_name = {str(p.get("name")): p for p in cli["plugins"] if isinstance(p, dict)}
        for item in disk:
            match = by_name.get(item["name"])
            if match:
                item["status"] = str(match.get("status") or item["status"])
                if match.get("version"):
                    item["version"] = str(match["version"])
                if not item["description"] and match.get("description"):
                    item["description"] = str(match["description"])
        result["confirmed_by_cli"] = True

    _PLUGINS_CACHE["data"] = result
    _PLUGINS_CACHE["at"] = now
    return result


_TOOLSET_LABELS: dict[str, str] = {
    "web": "Web Search & Scraping",
    "browser": "Browser Automation",
    "terminal": "Terminal & Processes",
    "file": "File Operations",
    "code_execution": "Code Execution",
    "vision": "Vision / Image Analysis",
    "video": "Video Analysis",
    "image_gen": "Image Generation",
    "video_gen": "Video Generation",
    "x_search": "X (Twitter) Search",
    "tts": "Text-to-Speech",
    "stt": "Speech-to-Text",
    "skills": "Skills",
    "todo": "Task Planning",
    "memory": "Memory",
    "context_engine": "Context Engine",
    "session_search": "Session Search",
    "connections": "Connections",
    "clarify": "Clarifying Questions",
    "delegation": "Task Delegation",
    "cronjob": "Cron Jobs",
    "homeassistant": "Home Assistant",
    "spotify": "Spotify",
    "yuanbao": "Yuanbao",
    "computer_use": "Computer Use",
    "discord": "Discord",
    "discord_admin": "Discord Admin",
    "a2a": "A2A",
    "ai_team": "Ai Team",
    "decision": "Decision",
}


def _yaml_list_block(text: str, section: str, subsection: str = "") -> list[str]:
    """Read `section:` (optionally `section:\n  subsection:`) into a flat list."""
    if subsection:
        m = re.search(rf"^{re.escape(section)}:\n((?:[ \t]+.*\n|\n)*)", text, re.M)
        if not m:
            return []
        m2 = re.search(rf"^[ \t]+{re.escape(subsection)}:\s*\n((?:[ \t]+-.*\n|\n)*)", m.group(1), re.M)
        if not m2:
            return []
        body = m2.group(1)
    else:
        m = re.search(rf"^{re.escape(section)}:\s*\n((?:[ \t]+-.*\n|\n)*)", text, re.M)
        if not m:
            return []
        body = m.group(1)
    return [ln.strip().lstrip("- ").strip() for ln in body.splitlines() if ln.strip().startswith("-")]


TOOLS_CACHE_FILE = WEB_HOME / "tools-cache.json"
TOOLS_CACHE_TTL = 600.0
_TOOLS_CACHE: dict[str, Any] = {"at": 0.0, "data": None}
_TOOLS_REFRESHING = threading.Event()


def _parse_tools_cli(out: str) -> Optional[dict[str, Any]]:
    """Parse `hermes tools list` into the same shape the UI consumes."""
    builtin: list[dict[str, Any]] = []
    plugin: list[dict[str, Any]] = []
    section = ""
    for line in out.splitlines():
        if "Built-in toolsets" in line:
            section = "builtin"
            continue
        if "Plugin toolsets" in line:
            section = "plugin"
            continue
        m = re.match(r"^\s*(\S)\s+(enabled|disabled)\s+(\S+)\s+(.*)$", line)
        if not m or section not in ("builtin", "plugin"):
            continue
        builtin_or_plugin = builtin if section == "builtin" else plugin
        builtin_or_plugin.append(
            {"name": m.group(3), "enabled": m.group(2) == "enabled", "label": m.group(4).strip()}
        )
    if not builtin and not plugin:
        return None
    return {
        "builtin": builtin,
        "plugin": plugin,
        "enabled_count": sum(1 for t in builtin + plugin if t["enabled"]),
        "total": len(builtin) + len(plugin),
        "error": "",
        "source": "cli",
    }


def _refresh_tools_cache() -> None:
    """Run the slow CLI once and persist the answer. Never raises."""
    if _TOOLS_REFRESHING.is_set():
        return
    _TOOLS_REFRESHING.set()
    try:
        code, out, err = run_cmd([HERMES_BIN, "tools", "list"], timeout=180)
        if code == 0:
            parsed = _parse_tools_cli(out)
            if parsed:
                TOOLS_CACHE_FILE.write_text(json.dumps({"at": time.time(), "data": parsed}), encoding="utf-8")
                _TOOLS_CACHE["data"] = parsed
                _TOOLS_CACHE["at"] = time.time()
    except Exception:
        pass
    finally:
        _TOOLS_REFRESHING.clear()


def get_tools(force: bool = False) -> dict[str, Any]:
    """Which toolsets are on.

    `hermes tools list` is authoritative: it knows about toolsets a plugin
    registers at runtime, which no manifest lists. It also takes ~22s here, so
    the answer is cached on disk and refreshed in the background. When no cache
    exists yet, fall back to deriving the answer from config.yaml, which is
    instant but cannot see runtime-registered toolsets.
    """
    now = time.time()

    if force:
        _refresh_tools_cache()

    cached = _TOOLS_CACHE["data"]
    if cached is None:
        stored = read_json_file(TOOLS_CACHE_FILE)
        if isinstance(stored, dict) and isinstance(stored.get("data"), dict):
            cached = stored["data"]
            _TOOLS_CACHE["data"] = cached
            _TOOLS_CACHE["at"] = float(stored.get("at") or 0)
    if cached is not None:
        if now - _TOOLS_CACHE["at"] > TOOLS_CACHE_TTL and not _TOOLS_REFRESHING.is_set():
            threading.Thread(target=_refresh_tools_cache, name="refresh-tools", daemon=True).start()
        return cached

    # Nothing cached: derive from config, and kick off the CLI for next time.
    threading.Thread(target=_refresh_tools_cache, name="refresh-tools", daemon=True).start()
    return _tools_from_config()


def _tools_from_config() -> dict[str, Any]:
    """Which toolsets are on, computed from config rather than the CLI.

    `hermes tools list` takes ~22s here because it boots the whole agent stack.
    The same answer is in config.yaml: platform_toolsets.cli is the allow-list,
    and known_builtin_toolsets / known_plugin_toolsets enumerate everything
    registered. Enabled state is membership in the allow-list, which is exactly
    the rule the CLI applies.
    """
    try:
        text = CONFIG_FILE.read_text(encoding="utf-8")
    except Exception as exc:
        return {"builtin": [], "plugin": [], "enabled_count": 0, "total": 0,
                "error": f"Could not read {CONFIG_FILE}: {exc}"}

    allowed = set(_yaml_list_block(text, "platform_toolsets", "cli"))
    builtin_names = _yaml_list_block(text, "known_builtin_toolsets", "cli")
    plugin_names = _yaml_list_block(text, "known_plugin_toolsets", "cli")

    # Plugin toolsets registered by an enabled plugin are on even when they are
    # not in the platform allow-list; read the manifests for that.
    for plugin in get_plugins()["plugins"]:
        if str(plugin.get("status", "")).startswith("enabled"):
            for tool in plugin.get("provides_tools") or []:
                allowed.add(str(tool))

    def entry(name: str) -> dict[str, Any]:
        return {"name": name, "enabled": name in allowed, "label": _TOOLSET_LABELS.get(name, name)}

    builtin = [entry(n) for n in builtin_names]
    plugin = [entry(n) for n in plugin_names]
    # Toolsets that are on but not listed in either catalogue still exist.
    for name in sorted(allowed):
        if name not in builtin_names and name not in plugin_names:
            plugin.append(entry(name))

    return {
        "builtin": builtin,
        "plugin": plugin,
        "enabled_count": sum(1 for t in builtin + plugin if t["enabled"]),
        "total": len(builtin) + len(plugin),
        "error": "",
        "source": "config",
    }


def _state_conn() -> Optional[sqlite3.Connection]:
    if not STATE_DB.exists():
        return None
    try:
        conn = sqlite3.connect(f"file:{STATE_DB}?mode=ro", uri=True, timeout=5)
        conn.row_factory = sqlite3.Row
        return conn
    except Exception:
        return None


def get_sessions(limit: int = 60, query: str = "") -> list[dict[str, Any]]:
    conn = _state_conn()
    if conn is None:
        return []
    try:
        sql = (
            "SELECT id, title, display_name, model, source, profile_name, started_at, "
            "ended_at, last_activity_at, message_count, tool_call_count, "
            "input_tokens, output_tokens, archived, pinned, hidden "
            "FROM sessions WHERE hidden=0 "
        )
        params: list[Any] = []
        if query:
            sql += "AND (COALESCE(title,'') LIKE ? OR COALESCE(display_name,'') LIKE ? OR id LIKE ?) "
            like = f"%{query}%"
            params += [like, like, like]
        sql += "ORDER BY COALESCE(last_activity_at, started_at) DESC LIMIT ?"
        params.append(max(1, min(limit, 400)))
        rows = conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]
    except Exception:
        return []
    finally:
        conn.close()


def get_session_detail(session_id: str, limit: int = 400) -> dict[str, Any]:
    conn = _state_conn()
    if conn is None:
        return {"session": None, "messages": []}
    try:
        row = conn.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone()
        msgs = conn.execute(
            "SELECT id, role, content, tool_name, tool_calls, timestamp, active, compacted "
            "FROM messages WHERE session_id=? ORDER BY id ASC LIMIT ?",
            (session_id, max(1, min(limit, 2000))),
        ).fetchall()
        return {
            "session": dict(row) if row else None,
            "messages": [dict(m) for m in msgs],
        }
    except Exception as exc:
        return {"session": None, "messages": [], "error": str(exc)}
    finally:
        conn.close()


def get_models() -> dict[str, Any]:
    """Everything needed to pick a model: current state, custom providers, builtins.

    Custom providers come from `custom_providers` in config.yaml and carry their
    own model lists, so they are the useful half of this. Builtin providers come
    from the models.dev cache; only the ones with a key in .env are flagged as
    usable, because offering 225 providers with no credentials is noise.
    """
    try:
        text = CONFIG_FILE.read_text(encoding="utf-8")
    except Exception as exc:
        return {"error": f"Could not read {CONFIG_FILE}: {exc}"}

    current = get_config_summary()

    # -- custom providers --------------------------------------------------
    custom: list[dict[str, Any]] = []
    m = re.search(r"^custom_providers:\n((?:[ \t]+.*\n|\n)*?)(?=^\S|\Z)", text, re.M)
    if m:
        block = m.group(1)
        # Split on each `  - name:` entry so per-provider fields stay together.
        entries = re.split(r"^  - name:", block, flags=re.M)[1:]
        for entry in entries:
            name = entry.splitlines()[0].strip() if entry.strip() else ""
            base = re.search(r"^\s+base_url:\s*(\S+)", entry, re.M)
            default = re.search(r"^\s+model:\s*(\S+)", entry, re.M)
            # An explicit key_env in the manifest wins over deriving it from the
            # URL: that is the field Hermes itself writes when the name it
            # generates would be ambiguous.
            explicit_key = re.search(r"^\s+key_env:\s*(\S+)", entry, re.M)
            models_block = re.search(r"^\s+models:\n((?:[ \t]+.*\n|\n)*)", entry, re.M)
            models: list[str] = []
            if models_block:
                for line in models_block.group(1).splitlines():
                    mm = re.match(r"^\s+([^\s:][^:]*):", line)
                    if mm:
                        models.append(mm.group(1).strip())
            env_name = explicit_key.group(1) if explicit_key else (
                _env_key_for_url(base.group(1)) if base else ""
            )
            if name.lower() in HIDDEN_PROVIDERS:
                continue
            custom.append(
                {
                    "name": name,
                    "base_url": base.group(1) if base else "",
                    "default_model": default.group(1) if default else "",
                    "models": models,
                    "env_key": env_name,
                    "key_present": _env_has(env_name) if env_name else False,
                }
            )

    # -- builtin providers -------------------------------------------------
    builtin: list[dict[str, Any]] = []
    cache = read_json_file(HERMES_HOME / "models_dev_cache.json")
    if isinstance(cache, dict):
        for pid, entry in cache.items():
            if not isinstance(entry, dict):
                continue
            raw_models = entry.get("models")
            ids: list[str] = []
            if isinstance(raw_models, dict):
                ids = [str(k) for k in raw_models]
            elif isinstance(raw_models, list):
                ids = [str(x) for x in raw_models if isinstance(x, str)]
            env_names = entry.get("env")
            if isinstance(env_names, str):
                env_names = [env_names]
            present = [str(e) for e in (env_names or []) if _env_has(str(e))]
            builtin.append(
                {
                    "id": pid,
                    "name": str(entry.get("name") or pid),
                    "models": sorted(ids),
                    "env_keys": [str(e) for e in (env_names or [])],
                    "key_present": bool(present),
                }
            )
    builtin.sort(key=lambda p: (not p["key_present"], p["name"].lower()))

    return {
        "current": {
            "model": current.get("model"),
            "provider": current.get("provider"),
            "base_url": current.get("base_url"),
        },
        "custom_providers": custom,
        "builtin_providers": builtin,
        "usable_builtin": sum(1 for p in builtin if p["key_present"]),
        "config_path": str(CONFIG_FILE),
    }


def _env_key_for_url(url: str) -> str:
    """The .env variable Hermes derives from a custom endpoint.

    Mirrors `hermes_cli.config.custom_endpoint_key_env`: the identity is
    host:port (not just host, so two endpoints on one host get separate slots),
    non-alphanumerics collapse to underscores, uppercased. Getting this wrong
    makes every custom provider look like it has no key.
    """
    if not url:
        return ""
    hostport = re.sub(r"^https?://", "", url).split("/")[0]
    slug = re.sub(r"[^A-Za-z0-9]+", "_", hostport).strip("_").upper()
    return f"HERMES_CUSTOM_{slug}_API_KEY" if slug else "HERMES_CUSTOM_API_KEY"


def _env_has(name: str) -> bool:
    """Whether a key is set in .env or the process environment."""
    if not name:
        return False
    if os.environ.get(name):
        return True
    try:
        text = (HERMES_HOME / ".env").read_text(encoding="utf-8", errors="replace")
    except Exception:
        return False
    return re.search(rf"^{re.escape(name)}=\S+", text, re.M) is not None


# Providers the user does not want offered in the picker. Kept as an explicit
# list rather than a heuristic: it is a preference, not something derivable.
HIDDEN_PROVIDERS = {"goatrouter"}


def add_provider(payload: dict[str, Any]) -> dict[str, Any]:
    """Append a custom endpoint to `custom_providers`, with its key in .env.

    Writes only the `custom_providers:` block, keeps a backup, and refuses
    anything it cannot validate: a duplicate name, a non-http URL, or a key name
    that does not match Hermes' own `custom_endpoint_key_env` convention.
    """
    name = str(payload.get("name") or "").strip()
    base_url = str(payload.get("base_url") or "").strip()
    api_key = str(payload.get("api_key") or "").strip()
    models_raw = payload.get("models")
    default_model = str(payload.get("default_model") or "").strip()

    if not name:
        return {"ok": False, "error": "A provider name is required."}
    if not re.fullmatch(r"[\w .-]{1,60}", name):
        return {"ok": False, "error": f"Provider name has unexpected characters: {name!r}"}
    if not re.fullmatch(r"https?://\S{1,300}", base_url):
        return {"ok": False, "error": f"base_url must be an http(s) URL, got {base_url!r}"}
    if not api_key:
        return {"ok": False, "error": "An API key is required, or the provider will fail on the first call."}

    try:
        text = CONFIG_FILE.read_text(encoding="utf-8")
    except Exception as exc:
        return {"ok": False, "error": f"Could not read config: {exc}"}

    # Refuse a duplicate name or endpoint: silently adding a second entry with the
    # same name makes the picker ambiguous and the config confusing.
    m = re.search(r"^custom_providers:\n((?:[ \t]+.*\n|\n)*?)(?=^\S|\Z)", text, re.M)
    existing_block = m.group(1) if m else ""
    for entry in re.split(r"^  - name:", existing_block, flags=re.M)[1:]:
        existing_name = entry.splitlines()[0].strip() if entry.strip() else ""
        existing_base = re.search(r"^\s+base_url:\s*(\S+)", entry, re.M)
        if existing_name.lower() == name.lower():
            return {"ok": False, "error": f"A provider named {name!r} already exists."}
        if existing_base and existing_base.group(1).rstrip("/") == base_url.rstrip("/"):
            return {"ok": False, "error": f"An endpoint with this base_url already exists ({existing_name})."}

    # Models: a pasted list, or just the default one.
    models: list[str] = []
    if isinstance(models_raw, str):
        models = [ln.strip() for ln in models_raw.splitlines() if ln.strip()]
    elif isinstance(models_raw, list):
        models = [str(x).strip() for x in models_raw if str(x).strip()]
    if default_model and default_model not in models:
        models.insert(0, default_model)
    for model in models:
        if not re.fullmatch(r"[\w./:@+-]{1,200}", model):
            return {"ok": False, "error": f"Model id contains unexpected characters: {model!r}"}

    env_key = _env_key_for_url(base_url)
    if not re.fullmatch(r"HERMES_CUSTOM_[A-Z0-9_]{1,80}_API_KEY", env_key):
        return {"ok": False, "error": f"Could not derive a valid key name from {base_url!r}."}

    # -- write the key to .env first, so a config entry never points at nothing --
    env_file = HERMES_HOME / ".env"
    try:
        env_text = env_file.read_text(encoding="utf-8") if env_file.is_file() else ""
        if re.search(rf"^{re.escape(env_key)}=", env_text, re.M):
            env_text = re.sub(rf"^{re.escape(env_key)}=.*$", f"{env_key}={api_key}", env_text, flags=re.M)
        else:
            if env_text and not env_text.endswith("\n"):
                env_text += "\n"
            env_text += f"{env_key}={api_key}\n"
        shutil.copy2(env_file, env_file.with_name(f".env.bak-console-{time.strftime('%Y%m%d-%H%M%S')}"))
        tmp = env_file.with_name(".env.tmp")
        tmp.write_text(env_text, encoding="utf-8")
        os.replace(tmp, env_file)
    except Exception as exc:
        return {"ok": False, "error": f"Could not write the key to .env: {exc}"}

    # -- append the provider entry ----------------------------------------
    entry_lines = [f"  - name: {name}", f"    base_url: {base_url}", f"    key_env: {env_key}"]
    if default_model:
        entry_lines.append(f"    model: {default_model}")
    if models:
        entry_lines.append("    models:")
        for model in models:
            entry_lines.append(f"      {model}: {{}}")
    new_entry = "\n".join(entry_lines) + "\n"

    if m:
        # Append after the last existing entry, keeping the rest of the file as is.
        insert_at = m.end(1)
        updated = text[:insert_at] + new_entry + text[insert_at:]
    else:
        updated = text.rstrip("\n") + "\n\ncustom_providers:\n" + new_entry

    try:
        backup = CONFIG_FILE.with_name(f"config.yaml.bak-console-{time.strftime('%Y%m%d-%H%M%S')}")
        shutil.copy2(CONFIG_FILE, backup)
        tmp = CONFIG_FILE.with_suffix(".yaml.tmp")
        tmp.write_text(updated, encoding="utf-8")
        os.replace(tmp, CONFIG_FILE)
    except Exception as exc:
        return {"ok": False, "error": f"Could not write config: {exc}"}

    # Read back rather than assume.
    after = [p for p in get_models().get("custom_providers", []) if p["name"] == name]
    found = after[0] if after else None
    return {
        "ok": True,
        "added": name,
        "env_key": env_key,
        "models_parsed": len(found["models"]) if found else 0,
        "key_present": bool(found and found["key_present"]),
        "backup": short_path(backup),
        "note": "Switch to it from the list above, then start a new session in Chat.",
    }


def set_model(payload: dict[str, Any]) -> dict[str, Any]:
    """Switch the default model, writing only the `model:` block of config.yaml.

    Deliberately not `hermes config set`: that boots the full CLI and takes ~40s
    per key here, and a switch needs up to four keys. This edits the block
    surgically, keeps a timestamped backup, and re-reads the file to confirm what
    it wrote. Everything outside `model:` is preserved byte for byte.
    """
    model = str(payload.get("model") or "").strip()
    provider = str(payload.get("provider") or "").strip()
    base_url = str(payload.get("base_url") or "").strip()
    env_key = str(payload.get("env_key") or "").strip()

    if not model:
        return {"ok": False, "error": "A model id is required."}
    if not re.fullmatch(r"[\w./:@+-]{1,200}", model):
        return {"ok": False, "error": f"Model id contains unexpected characters: {model!r}"}

    try:
        text = CONFIG_FILE.read_text(encoding="utf-8")
    except Exception as exc:
        return {"ok": False, "error": f"Could not read config: {exc}"}

    # Build the replacement block. `provider: custom` is what tells Hermes to use
    # an explicit base_url rather than a known provider's endpoint.
    lines = ["model:", f"  default: {model}"]
    if base_url:
        if not re.fullmatch(r"https?://\S{1,300}", base_url):
            return {"ok": False, "error": f"base_url must be an http(s) URL, got {base_url!r}"}
        lines.append("  provider: custom")
        lines.append(f"  base_url: {base_url}")
        if env_key:
            if not re.fullmatch(r"HERMES_CUSTOM_[A-Z0-9_]{1,80}_API_KEY", env_key):
                return {"ok": False, "error": f"Refusing to write an unexpected env var name: {env_key!r}"}
            if not _env_has(env_key):
                return {
                    "ok": False,
                    "error": f"{env_key} is not set in .env, so this provider would fail on the first call.",
                }
            lines.append(f"  api_key: ${{{env_key}}}")
    else:
        if not provider or provider == "custom":
            return {"ok": False, "error": "A provider id is required when no base_url is given."}
        if not re.fullmatch(r"[\w.-]{1,60}", provider):
            return {"ok": False, "error": f"Provider id contains unexpected characters: {provider!r}"}
        lines.append(f"  provider: {provider}")

    new_block = "\n".join(lines) + "\n"

    # Replace the top-level `model:` block, leaving every other line untouched.
    match = re.search(r"^model:\n((?:[ \t]+.*\n|\n)*)", text, re.M)
    if not match:
        return {"ok": False, "error": "Could not find a top-level `model:` block in config.yaml."}
    updated = text[: match.start()] + new_block + text[match.end() :]

    backup = CONFIG_FILE.with_name(f"config.yaml.bak-console-{time.strftime('%Y%m%d-%H%M%S')}")
    try:
        shutil.copy2(CONFIG_FILE, backup)
        tmp = CONFIG_FILE.with_suffix(".yaml.tmp")
        tmp.write_text(updated, encoding="utf-8")
        os.replace(tmp, CONFIG_FILE)
    except Exception as exc:
        return {"ok": False, "error": f"Could not write config: {exc}"}

    # Read back: the only proof the switch landed.
    after = get_config_summary()
    applied = after.get("model") == model and (after.get("base_url") or "") == (base_url or after.get("base_url"))
    return {
        "ok": True,
        "applied": applied,
        "backup": short_path(backup),
        "now": {
            "model": after.get("model"),
            "provider": after.get("provider"),
            "base_url": after.get("base_url"),
        },
        "note": "Applies to new sessions. A running conversation keeps the model it started with.",
    }


def get_cron() -> list[dict[str, Any]]:
    data = read_json_file(CRON_JOBS)
    if isinstance(data, dict):
        jobs = data.get("jobs", [])
    elif isinstance(data, list):
        jobs = data
    else:
        jobs = []
    return [j for j in jobs if isinstance(j, dict)]


def tail_activity(since: float = 0.0, limit: int = 300) -> list[dict[str, Any]]:
    if not ACTIVITY_FEED.exists():
        return []
    try:
        size = ACTIVITY_FEED.stat().st_size
        read_from = max(0, size - 512 * 1024)
        with ACTIVITY_FEED.open("rb") as fh:
            fh.seek(read_from)
            raw = fh.read().decode("utf-8", errors="replace")
        lines = raw.splitlines()
        if read_from > 0 and lines:
            lines = lines[1:]
        events: list[dict[str, Any]] = []
        for ln in lines[-2000:]:
            ln = ln.strip()
            if not ln:
                continue
            try:
                ev = json.loads(ln)
            except Exception:
                continue
            if isinstance(ev, dict) and float(ev.get("ts") or 0) > since:
                events.append(ev)
        return events[-limit:]
    except Exception:
        return []


# --------------------------------------------------------------------------
# chat runs
# --------------------------------------------------------------------------
class Run:
    """One `hermes chat` invocation, streamed to the browser as it happens."""

    def __init__(self, run_id: str, session: str, message: str) -> None:
        self.id = run_id
        self.session = session
        self.message = message
        self.started_at = time.time()
        self.ended_at: Optional[float] = None
        self.exit_code: Optional[int] = None
        self.session_id: Optional[str] = None
        self.reply = ""
        self.log: list[dict[str, Any]] = []
        self.status = "running"  # running | done | error | stopped
        self.error = ""
        self.path = RUNS_DIR / f"{run_id}.jsonl"
        self._lock = threading.Lock()
        self._proc: Optional[subprocess.Popen] = None

    def emit(self, kind: str, **fields: Any) -> None:
        ev = {"ts": time.time(), "kind": kind, **fields}
        with self._lock:
            self.log.append(ev)
            try:
                with self.path.open("a", encoding="utf-8") as fh:
                    fh.write(json.dumps(ev, ensure_ascii=False) + "\n")
            except Exception:
                pass

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "id": self.id,
                "session": self.session,
                "session_id": self.session_id,
                "message": self.message,
                "status": self.status,
                "exit_code": self.exit_code,
                "reply": self.reply,
                "error": self.error,
                "started_at": self.started_at,
                "ended_at": self.ended_at,
                "events": list(self.log),
            }

    def stop(self) -> None:
        proc = self._proc
        if proc and proc.poll() is None:
            self.emit("status", text="stopping")
            try:
                proc.terminate()
            except Exception:
                pass


RUNS: dict[str, Run] = {}
RUNS_LOCK = threading.Lock()

# CLI status lines that share stdout with the answer. Matched only at the start
# of a line so a reply that happens to mention a session is untouched.
CLI_NOISE = re.compile(
    r"^(↻\s+Resumed session|Session \S+ found but has no messages\.|Starting fresh\.|"
    r"No session named |Created session |Using session )"
)


def load_persisted_runs(limit: int = 40) -> None:
    """Rebuild the run list from disk so a page reload does not lose history."""
    try:
        files = sorted(RUNS_DIR.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)[:limit]
    except Exception:
        return
    for f in files:
        run_id = f.stem
        try:
            events = [json.loads(l) for l in f.read_text(encoding="utf-8").splitlines() if l.strip()]
        except Exception:
            continue
        if not events:
            continue
        first = events[0]
        run = Run(run_id, str(first.get("session") or ""), str(first.get("message") or ""))
        run.log = events
        run.started_at = float(events[0].get("ts") or run.started_at)
        for ev in events:
            k = ev.get("kind")
            if k == "session_id":
                run.session_id = str(ev.get("session_id") or "") or None
            elif k == "reply":
                run.reply = str(ev.get("text") or "")
            elif k == "exit":
                run.exit_code = int(ev.get("code") or 0)
                run.ended_at = float(ev.get("ts") or time.time())
                run.status = "done" if run.exit_code == 0 else "error"
            elif k == "error":
                run.error = str(ev.get("text") or "")
                run.status = "error"
            elif k == "status" and ev.get("text") == "stopped":
                run.status = "stopped"
        if run.status == "running" and run.ended_at is None:
            # The server died mid-run; nothing is streaming it any more.
            run.status = "stopped"
            run.error = run.error or "Server restarted while this run was in flight."
        RUNS[run_id] = run


def start_run(session: str, message: str) -> Run:
    run_id = time.strftime("%Y%m%d_%H%M%S") + "_" + uuid.uuid4().hex[:6]
    run = Run(run_id, session, message)
    with RUNS_LOCK:
        RUNS[run_id] = run

    args = [HERMES_BIN, "chat", "-Q", "--source", "web"]
    if session:
        args += ["--continue", session, "--create-if-missing"]
    args += ["-q", message]

    run.emit("status", text="starting", session=session or "(new)", message=message)

    def worker() -> None:
        try:
            proc = subprocess.Popen(
                args,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                cwd=str(Path.home()),
                env={**os.environ, "HERMES_HOME": str(HERMES_HOME)},
            )
            run._proc = proc
            with _ACTIVE_LOCK:
                _ACTIVE[run_id] = proc

            lines: list[str] = []
            assert proc.stdout is not None
            for line in proc.stdout:
                stripped = line.rstrip("\n")
                lines.append(stripped)
                if not stripped.strip():
                    continue
                m = re.match(r"^\s*session_id:\s*(\S+)\s*$", stripped)
                if m:
                    run.session_id = m.group(1)
                    run.emit("session_id", session_id=m.group(1))
                    continue
                if stripped.startswith("↻ Resumed session"):
                    run.emit("status", text=stripped.strip())
                    continue
                run.emit("out", text=stripped)

            code = proc.wait()
            run.exit_code = code
            run.ended_at = time.time()

            # The CLI writes its own status lines to the same stream as the
            # answer. They are shown live in the run log (useful while it is
            # working) but must not end up inside the reply the user reads.
            body = "\n".join(
                ln
                for ln in lines
                if not CLI_NOISE.match(ln.strip()) and not re.match(r"^\s*session_id:\s*\S+\s*$", ln)
            ).strip()
            run.reply = body
            if body:
                run.emit("reply", text=body)
            run.status = "done" if code == 0 else "error"
            if code != 0 and not run.error:
                run.error = f"hermes chat exited with code {code}"
                run.emit("error", text=run.error)
            run.emit("exit", code=code)
        except FileNotFoundError:
            run.status = "error"
            run.error = f"'{HERMES_BIN}' not found on PATH"
            run.ended_at = time.time()
            run.emit("error", text=run.error)
            run.emit("exit", code=127)
        except Exception as exc:
            run.status = "error"
            run.error = f"{type(exc).__name__}: {exc}"
            run.ended_at = time.time()
            run.emit("error", text=run.error)
            run.emit("exit", code=1)
        finally:
            with _ACTIVE_LOCK:
                _ACTIVE.pop(run_id, None)

    threading.Thread(target=worker, name=f"run-{run_id}", daemon=True).start()
    return run


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------
MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".map": "application/json",
    ".txt": "text/plain; charset=utf-8",
    ".webmanifest": "application/manifest+json",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "HermesConsole"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        # Keep the console readable: one line per request, no address noise.
        sys.stderr.write(f"  {self.command} {self.path.split('?')[0]}\n")

    # -- plumbing ---------------------------------------------------------
    def _send(self, code: int, body: bytes, ctype: str, extra: Optional[dict[str, str]] = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, payload: Any, code: int = 200) -> None:
        self._send(code, json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8"),
                   "application/json; charset=utf-8")

    def _err(self, code: int, message: str) -> None:
        self._json({"error": message, "status": code}, code)

    def _guard(self, qs: Optional[dict[str, list[str]]] = None) -> bool:
        """Reject cross-site and unauthenticated API calls.

        The token normally travels in the X-Hermes-Token header. The streaming
        endpoints also accept `?token=` because the browser's EventSource API
        cannot set headers. That is safe here: the server is loopback-bound, the
        response sets Referrer-Policy: no-referrer, and a cross-origin page still
        cannot read the token out of the served HTML.
        """
        origin = self.headers.get("Origin")
        if origin and not re.match(r"^https?://(127\.0\.0\.1|localhost)(:\d+)?$", origin):
            self._err(403, "Origin not allowed: this console only serves loopback requests.")
            return False
        supplied = self.headers.get("X-Hermes-Token") or ""
        if not supplied and qs:
            supplied = (qs.get("token") or [""])[0]
        if supplied != TOKEN:
            self._err(403, "Missing or stale session token. Reload the page.")
            return False
        return True

    # -- routes -----------------------------------------------------------
    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        if path == "/api/health":
            self._json({"ok": True, "uptime_s": int(time.time() - STARTED_AT), "token_required": True})
            return
        if path.startswith("/api/"):
            if not self._guard(qs):
                return
            self._api_get(path, qs)
            return
        self._static(path)

    def do_HEAD(self) -> None:  # noqa: N802
        self.do_GET()

    def do_POST(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if not parsed.path.startswith("/api/"):
            self._err(404, "Unknown endpoint.")
            return
        if not self._guard():
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length > 256 * 1024:
            self._err(413, "Request body too large.")
            return
        raw = self.rfile.read(length) if length else b""
        try:
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception as exc:
            self._err(400, f"Body is not valid JSON: {exc}")
            return
        self._api_post(parsed.path, payload if isinstance(payload, dict) else {})

    # -- api --------------------------------------------------------------
    def _api_get(self, path: str, qs: dict[str, list[str]]) -> None:
        one = lambda k, d="": (qs.get(k) or [d])[0]  # noqa: E731

        if path == "/api/system":
            self._json(get_system())
        elif path == "/api/skills":
            items = get_skills(force=one("force") == "1")
            q = one("q").strip().lower()
            cat = one("category").strip().lower()
            if cat and cat != "all":
                items = [s for s in items if s["category"].lower() == cat]
            if q:
                items = [
                    s
                    for s in items
                    if q in s["name"].lower() or q in s["description"].lower() or q in s["folder"].lower()
                ]
            cats: dict[str, int] = {}
            for s in get_skills():
                cats[s["category"]] = cats.get(s["category"], 0) + 1
            self._json(
                {
                    "total": len(get_skills()),
                    "shown": len(items),
                    "categories": [{"name": k, "count": v} for k, v in sorted(cats.items())],
                    "skills": items,
                }
            )
        elif path == "/api/skill":
            body = get_skill_body(one("path"))
            if body is None:
                self._err(404, "Skill not found, or the path is outside the skills directory.")
            else:
                self._json(body)
        elif path == "/api/plugins":
            data = get_plugins(force=one("force") == "1")
            plugins = data["plugins"]
            enabled = [p for p in plugins if str(p.get("status", "")).startswith("enabled")]
            self._json(
                {
                    "total": len(plugins),
                    "enabled": len(enabled),
                    "source": data.get("source", "manifests"),
                    "confirmed_by_cli": bool(data.get("confirmed_by_cli")),
                    "cli_error": data.get("cli_error", ""),
                    "plugins": plugins,
                }
            )
        elif path == "/api/tools":
            self._json(get_tools(force=one("force") == "1"))
        elif path == "/api/sessions":
            sessions = get_sessions(limit=int(one("limit", "60") or 60), query=one("q"))
            self._json({"total": len(sessions), "sessions": sessions})
        elif path == "/api/session":
            sid = one("id")
            if not sid:
                self._err(400, "Parameter 'id' is required.")
            else:
                self._json(get_session_detail(sid))
        elif path == "/api/models":
            self._json(get_models())
        elif path == "/api/cron":
            jobs = get_cron()
            self._json({"total": len(jobs), "jobs": jobs})
        elif path == "/api/activity":
            since = float(one("since", "0") or 0)
            events = tail_activity(since=since, limit=int(one("limit", "200") or 200))
            self._json({"events": events, "now": time.time()})
        elif path == "/api/runs":
            with RUNS_LOCK:
                runs = sorted(RUNS.values(), key=lambda r: r.started_at, reverse=True)[:40]
            self._json(
                {
                    "runs": [
                        {k: v for k, v in r.snapshot().items() if k != "events"} for r in runs
                    ]
                }
            )
        elif path == "/api/run":
            rid = one("id")
            run = RUNS.get(rid)
            if run is None:
                self._err(404, "Run not found.")
            else:
                self._json(run.snapshot())
        elif path == "/api/run/events":
            self._sse_run(one("id"), float(one("after", "0") or 0))
        elif path == "/api/stream":
            self._sse_activity(float(one("since", "0") or 0))
        else:
            self._err(404, f"No such endpoint: {path}")

    def _api_post(self, path: str, payload: dict[str, Any]) -> None:
        if path == "/api/chat":
            message = str(payload.get("message") or "").strip()
            session = str(payload.get("session") or "").strip()
            if not message:
                self._err(400, "Field 'message' is required.")
                return
            if len(message) > 32000:
                self._err(413, "Message is longer than 32000 characters.")
                return
            run = start_run(session, message)
            self._json({"run_id": run.id, "session": session, "status": "running"}, 202)
        elif path == "/api/model/set":
            result = set_model(payload)
            self._json(result, 200 if result.get("ok") else 400)
        elif path == "/api/provider/add":
            result = add_provider(payload)
            self._json(result, 200 if result.get("ok") else 400)
        elif path == "/api/run/stop":
            run = RUNS.get(str(payload.get("id") or ""))
            if run is None:
                self._err(404, "Run not found.")
            else:
                run.stop()
                self._json({"ok": True, "id": run.id})
        else:
            self._err(404, f"No such endpoint: {path}")

    # -- streaming --------------------------------------------------------
    def _sse_headers(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

    def _sse_write(self, event: str, data: Any) -> bool:
        try:
            chunk = f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False, default=str)}\n\n"
            self.wfile.write(chunk.encode("utf-8"))
            self.wfile.flush()
            return True
        except (BrokenPipeError, ConnectionResetError, OSError):
            return False

    def _sse_run(self, run_id: str, after: float) -> None:
        run = RUNS.get(run_id)
        if run is None:
            self._err(404, "Run not found.")
            return
        self._sse_headers()
        sent = 0
        idle = 0.0
        while True:
            events = run.log
            while sent < len(events):
                ev = events[sent]
                sent += 1
                if float(ev.get("ts") or 0) <= after:
                    continue
                if not self._sse_write("event", ev):
                    return
            snap = run.snapshot()
            if run.status != "running":
                self._sse_write("end", {"status": run.status, "exit_code": run.exit_code,
                                        "reply": run.reply, "error": run.error,
                                        "session_id": run.session_id})
                return
            time.sleep(0.25)
            idle += 0.25
            if idle >= 15:
                idle = 0.0
                if not self._sse_write("ping", {"t": time.time()}):
                    return

    def _sse_activity(self, since: float) -> None:
        self._sse_headers()
        cursor = since or (time.time() - 2)
        last_ping = time.time()
        while True:
            events = tail_activity(since=cursor, limit=120)
            for ev in events:
                cursor = max(cursor, float(ev.get("ts") or cursor))
                if not self._sse_write("activity", ev):
                    return
            if time.time() - last_ping > 15:
                last_ping = time.time()
                if not self._sse_write("ping", {"t": time.time()}):
                    return
            time.sleep(1.0)

    # -- static -----------------------------------------------------------
    def _static(self, path: str) -> None:
        if path == "/":
            path = "/index.html"
        rel = urllib.parse.unquote(path).lstrip("/")
        target = (DIST_DIR / rel).resolve()
        try:
            target.relative_to(DIST_DIR.resolve())
        except ValueError:
            self._err(403, "Path escapes the served directory.")
            return
        if not target.is_file():
            # Single-page app: unknown paths fall back to the shell.
            fallback = DIST_DIR / "index.html"
            if fallback.is_file() and "." not in Path(rel).name:
                target = fallback
            else:
                self._err(404, f"Not found: {path}")
                return
        try:
            body = target.read_bytes()
        except Exception as exc:
            self._err(500, f"Could not read {rel}: {exc}")
            return

        if target.name == "index.html":
            # The token is injected per response, so it is never a static file
            # another process could read from disk before the server starts.
            html = body.decode("utf-8").replace(
                "<head>", f'<head>\n    <meta name="hermes-web-token" content="{TOKEN}" />'
            )
            body = html.encode("utf-8")
            self._send(200, body, MIME[".html"], {"Cache-Control": "no-store"})
            return

        ctype = MIME.get(target.suffix.lower(), "application/octet-stream")
        cache = "public, max-age=31536000, immutable" if "/assets/" in str(target) else "no-cache"
        self._send(200, body, ctype, {"Cache-Control": cache})


def main() -> int:
    ap = argparse.ArgumentParser(description="Local web console for Hermes Agent.")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-open", action="store_true", help="Do not try to open a browser.")
    args = ap.parse_args()

    if not DIST_DIR.is_dir():
        print("dist/ is missing. Build the UI first:\n  npm install && npm run build", file=sys.stderr)
        return 2

    load_persisted_runs()

    # Warm the two slow paths in the background so the first page load is fast:
    # the plugin manifest scan, and the CLI confirmation cached to disk.
    def warm() -> None:
        try:
            get_plugins()
        except Exception:
            pass
        try:
            # The tools list is authoritative but slow; pay for it once at
            # startup so every later page load reads the cache.
            _refresh_tools_cache()
        except Exception:
            pass

    threading.Thread(target=warm, name="warm-plugins", daemon=True).start()

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    url = f"http://{args.host}:{args.port}/"

    print("")
    print("  Hermes Console")
    print(f"  {url}")
    print(f"  hermes home   {short_path(HERMES_HOME)}")
    print(f"  runs          {short_path(RUNS_DIR)}")
    print(f"  bound to      {args.host} (loopback only)")
    print("")
    print("  Stop with Ctrl+C.")
    print("")

    def shutdown(_sig: int, _frm: Any) -> None:
        print("\n  Stopping...")
        with _ACTIVE_LOCK:
            for proc in _ACTIVE.values():
                try:
                    proc.terminate()
                except Exception:
                    pass
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, shutdown)
        except (ValueError, OSError):
            pass

    if not args.no_open:
        def opener() -> None:
            time.sleep(0.6)
            for cmd in (["termux-open-url", url], ["xdg-open", url], ["open", url]):
                if shutil.which(cmd[0]):
                    try:
                        subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                        return
                    except Exception:
                        continue
            try:
                webbrowser.open(url)
            except Exception:
                pass

        threading.Thread(target=opener, daemon=True).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    print("  Stopped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
