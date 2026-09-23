"""Configuration, from the environment. `.env` beside this file is read first,
and a variable already set in the environment wins over the file.

Missing variables are reported together, so a first start on the VPS is one
restart rather than one per variable.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
REPO_ROOT = BASE_DIR.parent

# The game API and the site are the same Vercel deployment.
SITE_URL = "https://mrtguessr.uwuapps.org"

# Line geometry for the map hint, from the same checkout the bot runs from.
LINES_GEOJSON = REPO_ROOT / "main-site" / "data" / "lines.geojson"

REQUIRED = ("DISCORD_BOT_TOKEN", "BOT_API_TOKEN")


class ConfigError(RuntimeError):
    """The environment cannot produce a usable configuration."""


def load_env_file(path: Path) -> None:
    """Read a `.env` file into os.environ without overwriting what is set."""
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].lstrip()
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key and key not in os.environ:
            os.environ[key] = value


@dataclass(frozen=True)
class Config:
    bot_token: str
    bot_api_token: str
    donation_url: str | None
    site_url: str
    db_path: Path
    lock_path: Path
    lines_geojson: Path


def load_config() -> Config:
    load_env_file(BASE_DIR / ".env")

    problems = []
    missing = [name for name in REQUIRED if not os.environ.get(name, "").strip()]
    if missing:
        problems.append("missing or empty: " + ", ".join(missing))

    donation_url = os.environ.get("DONATION_URL", "").strip() or None
    if donation_url and not donation_url.startswith("https://"):
        problems.append("DONATION_URL must start with https://")

    if not LINES_GEOJSON.is_file():
        problems.append(f"{LINES_GEOJSON} is missing; run the bot from a full checkout")

    if problems:
        raise ConfigError(
            "The bot cannot start with this environment.\n  "
            + "\n  ".join(problems)
            + f"\n\nEvery variable is documented in {BASE_DIR / '.env.example'}."
        )

    return Config(
        bot_token=os.environ["DISCORD_BOT_TOKEN"].strip(),
        bot_api_token=os.environ["BOT_API_TOKEN"].strip(),
        donation_url=donation_url,
        site_url=SITE_URL,
        db_path=BASE_DIR / "bot.sqlite3",
        lock_path=BASE_DIR / "bot.lock",
        lines_geojson=LINES_GEOJSON,
    )
