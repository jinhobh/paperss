"""Shared read-only view over timeline-tracker's database and the rice palette.

Both the wallpaper generator and the panel widget read from here so they can
never disagree about what "today" looked like.
"""
import json
import sqlite3
import time
from datetime import datetime, timedelta
from pathlib import Path

HOME = Path.home()
DB = HOME / ".local/share/timeline-tracker/timeline.db"
PALETTE = HOME / ".local/share/rice/colors.json"
TODOS = HOME / ".local/share/rice/todos.json"

# Windows and helper processes that aren't meaningful "what was I doing" answers.
BORING_APPS = {"", "Unknown", "gnome-shell", "Desktop", "Ubuntu Desktop"}


def palette(fallback_source="#040480"):
    """Current rice palette, with a Klein-blue fallback if retheme never ran."""
    if PALETTE.exists():
        try:
            return json.loads(PALETTE.read_text())
        except json.JSONDecodeError:
            pass
    return {
        "source": fallback_source, "primary": "#bfc2ff", "on_primary": "#272b60",
        "surface": "#0d0549", "surface_container": "#191a4f",
        "on_surface": "#e4e1e9", "on_surface_variant": "#c6c4d6",
        "outline": "#978baf", "red": "#ffb0ad", "green": "#9bd5a0",
        "yellow": "#ddc585", "tertiary": "#e8b9d4",
    }


def _connect():
    if not DB.exists():
        return None
    try:
        return sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=2.0)
    except sqlite3.Error:
        return None


def day_bounds(day=None):
    """Unix timestamps for the start and end of a local calendar day."""
    d = day or datetime.now()
    start = d.replace(hour=0, minute=0, second=0, microsecond=0)
    return start.timestamp(), (start + timedelta(days=1)).timestamp()


def snapshot(day=None):
    """Everything the desktop wants to know about a day, in one query pass."""
    lo, hi = day_bounds(day)
    now = min(time.time(), hi)
    out = {
        "date": (day or datetime.now()).strftime("%Y-%m-%d"),
        "top_app": None, "top_app_secs": 0, "total_secs": 0,
        "top_repo": None, "repo_edits": 0, "apps": [], "repos": [],
        "hourly": [0.0] * 24, "sessions": 0, "first_ts": None, "last_ts": None,
        "available": False,
    }
    conn = _connect()
    if conn is None:
        return out
    try:
        with conn:
            # Focus time per app, clipped to the day's window.
            rows = conn.execute(
                "SELECT app, SUM(MIN(end_ts,?) - MAX(start_ts,?)) AS secs "
                "FROM focus WHERE end_ts > ? AND start_ts < ? "
                "GROUP BY app ORDER BY secs DESC", (hi, lo, lo, hi)).fetchall()
            apps = [(a or "", max(0.0, s or 0.0)) for a, s in rows]
            apps = [(a, s) for a, s in apps if a not in BORING_APPS and s > 0]
            out["apps"] = apps
            out["total_secs"] = sum(s for _, s in apps)
            if apps:
                out["top_app"], out["top_app_secs"] = apps[0]

            # Per-hour focus totals, for the activity ribbon.
            for start, end in conn.execute(
                    "SELECT start_ts, end_ts FROM focus "
                    "WHERE end_ts > ? AND start_ts < ?", (lo, hi)):
                s, e = max(start, lo), min(end, hi)
                while s < e:
                    hour = int((s - lo) // 3600)
                    edge = lo + (hour + 1) * 3600
                    chunk = min(e, edge) - s
                    if 0 <= hour < 24:
                        out["hourly"][hour] += chunk
                    s = min(e, edge)

            repos = conn.execute(
                "SELECT subject, COUNT(*) FROM events "
                "WHERE type IN ('file_edit','file_edit_bulk') "
                "AND ts >= ? AND ts < ? AND subject IS NOT NULL "
                "GROUP BY subject ORDER BY 2 DESC", (lo, hi)).fetchall()
            out["repos"] = repos
            if repos:
                out["top_repo"], out["repo_edits"] = repos[0]

            out["sessions"] = conn.execute(
                "SELECT COUNT(*) FROM events WHERE type IN ('session_start','unlock') "
                "AND ts >= ? AND ts < ?", (lo, hi)).fetchone()[0]

            span = conn.execute(
                "SELECT MIN(start_ts), MAX(end_ts) FROM focus "
                "WHERE end_ts > ? AND start_ts < ?", (lo, hi)).fetchone()
            if span and span[0]:
                out["first_ts"] = max(span[0], lo)
                out["last_ts"] = min(span[1], now)
            out["available"] = True
    except sqlite3.Error:
        return out
    finally:
        conn.close()
    return out


def current_streak(gap_tolerance=300, stale_after=600):
    """Length of the unbroken stretch of activity you're in right now.

    Walks focus spans backwards from the most recent one, joining any two that
    are less than `gap_tolerance` apart. Returns 0 when the last span is older
    than `stale_after`, so the widget reads 0 while you're away rather than
    reporting a streak that silently ended hours ago.
    """
    conn = _connect()
    if conn is None:
        return 0.0
    try:
        with conn:
            rows = conn.execute(
                "SELECT start_ts, end_ts FROM focus ORDER BY end_ts DESC LIMIT 400"
            ).fetchall()
    except sqlite3.Error:
        return 0.0
    finally:
        conn.close()

    if not rows:
        return 0.0
    now = time.time()
    latest_end = rows[0][1]
    if now - latest_end > stale_after:
        return 0.0

    run_start = rows[0][0]
    for start, end in rows[1:]:
        if run_start - end > gap_tolerance:
            break
        run_start = min(run_start, start)
    return max(0.0, latest_end - run_start)


def fmt_duration(secs):
    secs = int(secs or 0)
    h, m = secs // 3600, (secs % 3600) // 60
    if h and m:
        return f"{h}H {m:02d}M"
    if h:
        return f"{h}H"
    if m:
        return f"{m}M"
    return f"{secs}S"


# ------------------------------------------------------------------- todos

def load_todos():
    """The task list, oldest first. Open tasks sort ahead of completed ones.

    Read-side sorting (rather than reordering the file on write) keeps ids and
    file order stable, so checking something off never renumbers the entries
    the user is about to type at.
    """
    items = []
    if TODOS.exists():
        try:
            data = json.loads(TODOS.read_text())
            items = [i for i in data.get("items", []) if i.get("text")]
        except (json.JSONDecodeError, AttributeError):
            items = []
    return sorted(items, key=lambda i: (bool(i.get("done")), i.get("created", 0)))


def save_todos(items):
    TODOS.parent.mkdir(parents=True, exist_ok=True)
    tmp = TODOS.with_suffix(".json.tmp")
    tmp.write_text(json.dumps({"items": items}, indent=2))
    tmp.replace(TODOS)  # atomic, so a poster render never sees a half-written file


def headline_word(snap, fallback="HOME"):
    """The single word that best describes the day — repo beats app.

    A repo name says what you were building; an app name only says what you
    were looking at. Prefer the former when there was real editing activity.
    """
    if snap.get("top_repo") and snap.get("repo_edits", 0) >= 3:
        return Path(snap["top_repo"]).name.upper()[:12] or fallback
    if snap.get("top_app"):
        return str(snap["top_app"]).upper()[:12]
    return fallback
