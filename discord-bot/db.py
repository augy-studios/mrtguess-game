"""Bot-local SQLite: the button registry, the live round card per player per
channel for the reveal scheduler, and each player's settings.

No game state lives here. Scores, masks and answers are the API's; losing
this file costs old buttons, the live cards' updates, and saved settings.
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
-- One live card per player per channel: a server channel can hold several
-- players' rounds at once. hook_token and hook_at are the token of the
-- interaction that sent the card and when it was issued; see card_hook in
-- handlers.py.
create table if not exists live_rounds (
    channel_id integer not null,
    user_id integer not null,
    round_id text not null,
    msg_id integer not null,
    next_tick_at real,
    last_mask text,
    last_score integer,
    hook_token text,
    hook_at real,
    primary key (channel_id, user_id)
);
create index if not exists live_rounds_tick on live_rounds (next_tick_at);
-- One row per Discord user, created on first change. Missing means defaults.
create table if not exists settings (
    user_id integer primary key,
    name text,
    auto_submit integer not null default 0,
    confirm_hints integer not null default 0,
    tidy_chat integer not null default 1,
    map_style text not null default 'light'
);
"""


def connect(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("pragma journal_mode=wal")
    conn.executescript(SCHEMA)
    # Files made before the hook columns existed.
    have = {row["name"] for row in conn.execute("pragma table_info(live_rounds)")}
    for column, kind in (("hook_token", "text"), ("hook_at", "real")):
        if column not in have:
            conn.execute(f"alter table live_rounds add column {column} {kind}")
    conn.execute("delete from buttons where created_at < ?", (time.time() - BUTTON_TTL_S,))
    return conn


# Buttons. The custom id is opaque; what it means is a row here, so a button
# survives restarts and cannot be forged by editing its id.

CUSTOM_ID_PATTERN = r"b:(?P<id>[A-Za-z0-9_-]{8,32})"


def register_button(conn, kind: str, **payload) -> str:
    button_id = secrets.token_urlsafe(9)
    conn.execute(
        "insert into buttons (id, kind, payload, created_at) values (?, ?, ?, ?)",
        (button_id, kind, json.dumps(payload), time.time()),
    )
    return f"b:{button_id}"


def read_button(conn, button_id: str) -> tuple[str, dict] | None:
    row = conn.execute("select kind, payload from buttons where id = ?", (button_id,)).fetchone()
    return (row["kind"], json.loads(row["payload"])) if row else None


# The live round cards. A card is (msg_id, hook_token, hook_at); the hook is
# None, None for a card the bot sent with its own token.

Card = tuple[int, "str | None", "float | None"]


def set_live(conn, channel_id: int, user_id: int, round_id: str, card: Card, view: dict) -> None:
    conn.execute(
        """insert into live_rounds (channel_id, user_id, round_id, msg_id, hook_token, hook_at,
             next_tick_at, last_mask, last_score)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict (channel_id, user_id) do update set round_id = excluded.round_id,
             msg_id = excluded.msg_id, hook_token = excluded.hook_token, hook_at = excluded.hook_at,
             next_tick_at = excluded.next_tick_at,
             last_mask = excluded.last_mask, last_score = excluded.last_score""",
        (channel_id, user_id, round_id, *card, next_tick(view), view["mask"], view["score"]),
    )


def update_live(conn, channel_id: int, user_id: int, view: dict, card: Card | None = None) -> None:
    """The latest view, and with a card, the new message that replaced the old one."""
    conn.execute(
        "update live_rounds set next_tick_at = ?, last_mask = ?, last_score = ? where channel_id = ? and user_id = ?",
        (next_tick(view), view["mask"], view["score"], channel_id, user_id),
    )
    if card is not None:
        conn.execute(
            "update live_rounds set msg_id = ?, hook_token = ?, hook_at = ? where channel_id = ? and user_id = ?",
            (*card, channel_id, user_id),
        )


def get_live(conn, channel_id: int, user_id: int):
    return conn.execute(
        "select * from live_rounds where channel_id = ? and user_id = ?", (channel_id, user_id)
    ).fetchone()


def clear_live(conn, channel_id: int, user_id: int) -> None:
    conn.execute("delete from live_rounds where channel_id = ? and user_id = ?", (channel_id, user_id))


def stop_ticking(conn, channel_id: int, user_id: int, retry_at: float | None = None) -> None:
    conn.execute(
        "update live_rounds set next_tick_at = ? where channel_id = ? and user_id = ?",
        (retry_at, channel_id, user_id),
    )


def due_live(conn, now: float):
    return conn.execute(
        "select * from live_rounds where next_tick_at is not null and next_tick_at <= ?", (now,)
    ).fetchall()


def next_tick(view: dict) -> float | None:
    """When the next clock letter is due, with a little slack for the API."""
    wait_ms = view.get("next_reveal_in")
    return None if wait_ms is None else time.time() + wait_ms / 1000 + 0.4


# Settings, the same five as the Telegram bot's.

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
    # to the Discord display name, and skips adding when there is none usable.
    conn.execute(
        """insert into settings (user_id, name, auto_submit, confirm_hints, tidy_chat, map_style)
           values (:user_id, :name, :auto_submit, :confirm_hints, :tidy_chat, :map_style)
           on conflict (user_id) do update set name = excluded.name, auto_submit = excluded.auto_submit,
             confirm_hints = excluded.confirm_hints, tidy_chat = excluded.tidy_chat,
             map_style = excluded.map_style""",
        {"user_id": user_id, **{k: int(v) if k in _BOOLEANS else v for k, v in current.items()}},
    )
    return current
