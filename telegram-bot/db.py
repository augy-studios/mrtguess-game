"""Bot-local SQLite: the button registry, the live round card per chat for the
reveal scheduler, pending prompts, and each player's settings.

No game state lives here. Scores, masks and answers are the API's; losing
this file costs old buttons, the live card's updates, and saved settings.
"""

from __future__ import annotations

import json
import secrets
import sqlite3
import time
from pathlib import Path

BUTTON_TTL_S = 14 * 24 * 3600

SCHEMA = """
create table if not exists buttons (
    id text primary key,
    kind text not null,
    payload text not null,
    created_at real not null
);
create table if not exists live_rounds (
    chat_id integer primary key,
    user_id integer not null,
    round_id text not null,
    msg_id integer not null,
    next_tick_at real,
    last_mask text,
    last_score integer
);
create index if not exists live_rounds_tick on live_rounds (next_tick_at);
-- A typed message the bot is waiting for. kind is 'submit' (a name for
-- round_id) or 'setname' (a name for settings).
create table if not exists prompts (
    chat_id integer primary key,
    kind text not null,
    round_id text,
    expires_at real not null
);
-- One row per Telegram user, created on first change. Missing means defaults.
create table if not exists settings (
    user_id integer primary key,
    name text,
    auto_submit integer not null default 0,
    confirm_hints integer not null default 0,
    tidy_chat integer not null default 1,
    map_style text not null default 'light'
);
drop table if exists name_prompts;
"""


def connect(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("pragma journal_mode=wal")
    conn.executescript(SCHEMA)
    conn.execute("delete from buttons where created_at < ?", (time.time() - BUTTON_TTL_S,))
    return conn


# Buttons. The callback data is an opaque id; what it means is a row here,
# so a button survives restarts and cannot be forged by editing its data.


def register_button(conn, kind: str, **payload) -> bytes:
    button_id = secrets.token_urlsafe(9)
    conn.execute(
        "insert into buttons (id, kind, payload, created_at) values (?, ?, ?, ?)",
        (button_id, kind, json.dumps(payload), time.time()),
    )
    return f"b:{button_id}".encode()


def read_button(conn, data: bytes) -> tuple[str, dict] | None:
    raw = data.decode("utf-8", "replace")
    if not raw.startswith("b:"):
        return None
    row = conn.execute("select kind, payload from buttons where id = ?", (raw[2:],)).fetchone()
    return (row["kind"], json.loads(row["payload"])) if row else None


# The live round card in each chat.


def set_live(conn, chat_id: int, user_id: int, round_id: str, msg_id: int, view: dict) -> None:
    conn.execute(
        """insert into live_rounds (chat_id, user_id, round_id, msg_id, next_tick_at, last_mask, last_score)
           values (?, ?, ?, ?, ?, ?, ?)
           on conflict (chat_id) do update set user_id = excluded.user_id, round_id = excluded.round_id,
             msg_id = excluded.msg_id, next_tick_at = excluded.next_tick_at,
             last_mask = excluded.last_mask, last_score = excluded.last_score""",
        (chat_id, user_id, round_id, msg_id, next_tick(view), view["mask"], view["score"]),
    )


def update_live(conn, chat_id: int, view: dict, msg_id: int | None = None) -> None:
    conn.execute(
        """update live_rounds set next_tick_at = ?, last_mask = ?, last_score = ?,
             msg_id = coalesce(?, msg_id) where chat_id = ?""",
        (next_tick(view), view["mask"], view["score"], msg_id, chat_id),
    )


def get_live(conn, chat_id: int):
    return conn.execute("select * from live_rounds where chat_id = ?", (chat_id,)).fetchone()


def clear_live(conn, chat_id: int) -> None:
    conn.execute("delete from live_rounds where chat_id = ?", (chat_id,))


def due_live(conn, now: float):
    return conn.execute(
        "select * from live_rounds where next_tick_at is not null and next_tick_at <= ?", (now,)
    ).fetchall()


def next_tick(view: dict) -> float | None:
    """When the next clock letter is due, with a little slack for the API."""
    wait_ms = view.get("next_reveal_in")
    return None if wait_ms is None else time.time() + wait_ms / 1000 + 0.4


# Prompts: the next plain message is a name, not a guess.

PROMPT_TTL_S = 10 * 60


def set_prompt(conn, chat_id: int, kind: str, round_id: str | None = None) -> None:
    conn.execute(
        "insert or replace into prompts (chat_id, kind, round_id, expires_at) values (?, ?, ?, ?)",
        (chat_id, kind, round_id, time.time() + PROMPT_TTL_S),
    )


def get_prompt(conn, chat_id: int):
    """The waiting prompt, or None. Left in place until the caller clears it,
    so a refused name can be tried again."""
    row = conn.execute("select kind, round_id, expires_at from prompts where chat_id = ?", (chat_id,)).fetchone()
    if not row or row["expires_at"] < time.time():
        clear_prompt(conn, chat_id)
        return None
    return row


def clear_prompt(conn, chat_id: int) -> None:
    conn.execute("delete from prompts where chat_id = ?", (chat_id,))


# Settings.

DEFAULTS = {"name": None, "auto_submit": False, "confirm_hints": False, "tidy_chat": True, "map_style": "light"}
_BOOLEANS = ("auto_submit", "confirm_hints", "tidy_chat")


def get_settings(conn, user_id: int) -> dict:
    row = conn.execute("select * from settings where user_id = ?", (user_id,)).fetchone()
    if row is None:
        return dict(DEFAULTS)
    out = {key: row[key] for key in DEFAULTS}
    for key in _BOOLEANS:
        out[key] = bool(out[key])
    return out


def save_settings(conn, user_id: int, **changes) -> dict:
    unknown = set(changes) - set(DEFAULTS)
    if unknown:
        raise ValueError(f"unknown settings: {unknown}")
    current = get_settings(conn, user_id)
    current.update(changes)
    # No saved name is fine even with automatic adding on: the bot falls back
    # to the Telegram first name, and skips adding when there is none usable.
    conn.execute(
        """insert into settings (user_id, name, auto_submit, confirm_hints, tidy_chat, map_style)
           values (:user_id, :name, :auto_submit, :confirm_hints, :tidy_chat, :map_style)
           on conflict (user_id) do update set name = excluded.name, auto_submit = excluded.auto_submit,
             confirm_hints = excluded.confirm_hints, tidy_chat = excluded.tidy_chat,
             map_style = excluded.map_style""",
        {"user_id": user_id, **{k: int(v) if k in _BOOLEANS else v for k, v in current.items()}},
    )
    return current
