"""The MRT Station Guesser Telegram bot. Run from this directory, in tmux:

    python bot.py

One process: Telethon's event loop plus the reveal clock. Game state lives
behind the API; SQLite holds buttons and the live card per chat.

Exit codes: 0 clean stop, 2 bad environment, 3 already running, 1 other.
"""

from __future__ import annotations

import asyncio
import logging
import re
import signal
import sys

from telethon import TelegramClient, events
from telethon.tl.functions.bots import SetBotCommandsRequest
from telethon.tl.types import BotCommand, BotCommandScopeDefault

import db
from api import GameApi
from commands import COMMANDS
from config import Config, ConfigError, load_config
from handlers import Game
from lock import AlreadyRunning, SingleInstance

# `/name`, optionally addressed to the bot, with an optional argument.
COMMAND = re.compile(r"^/([A-Za-z][A-Za-z0-9_]*)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$")
KNOWN = {name for name, _ in COMMANDS}

log = logging.getLogger("bot")


async def register_commands(client) -> None:
    """The menu beside the message box, from commands.py. A failure only costs
    the menu; every command works typed."""
    try:
        await client(
            SetBotCommandsRequest(
                scope=BotCommandScopeDefault(),
                lang_code="",
                commands=[BotCommand(command=n, description=d) for n, d in COMMANDS],
            )
        )
    except Exception as err:  # noqa: BLE001
        log.warning("could not register the command list: %r", err)


def wire(client, game: Game) -> None:
    async def on_message(event) -> None:
        text = (event.raw_text or "").strip()
        if not text:
            return
        try:
            match = COMMAND.match(text)
            if match:
                name = match.group(1).lower()
                if name in KNOWN:
                    await game.on_command(event, name)
                elif name == "help":
                    # Not a command: /start is the help.
                    await event.respond("Everything is in /start.")
                else:
                    await event.respond("I do not know that one. Send /start for the list.")
            else:
                await game.on_text(event, text)
        except Exception:  # noqa: BLE001 - the player gets an answer whatever broke
            log.exception("message handling failed")
            await event.respond("Something went wrong. Try again.")

    async def on_button(event) -> None:
        record = db.read_button(game.conn, event.data or b"")
        if record is None:
            await event.answer("That button has expired. Send /play to start again.", alert=True)
            return
        try:
            await game.on_button(event, *record)
        except Exception:  # noqa: BLE001
            log.exception("button %s failed", record[0])
            await event.answer("Something went wrong. Try again.", alert=True)

    # Private chats only: a round belongs to one player.
    client.add_event_handler(on_message, events.NewMessage(incoming=True, func=lambda e: e.is_private))
    client.add_event_handler(on_button, events.CallbackQuery(func=lambda e: e.is_private))


async def run(config: Config) -> int:
    conn = db.connect(config.db_path)
    api = GameApi(config.site_url, config.bot_api_token)

    client = TelegramClient(str(config.session_path), config.api_id, config.api_hash)
    await client.start(bot_token=config.bot_token)
    me = await client.get_me()
    log.info("connected as @%s, API at %s", getattr(me, "username", "?"), config.site_url)

    game = Game(client, conn, api, config)
    wire(client, game)
    await register_commands(client)

    stopping = asyncio.Event()
    loop = asyncio.get_running_loop()
    for name in ("SIGINT", "SIGTERM"):
        sig = getattr(signal, name, None)
        if sig is None:
            continue
        try:
            loop.add_signal_handler(sig, stopping.set)
        except NotImplementedError:
            pass  # Windows: ctrl-c arrives as KeyboardInterrupt instead.

    clock = asyncio.ensure_future(game.run_clock(stopping))
    disconnected = asyncio.ensure_future(client.run_until_disconnected())
    waiting = asyncio.ensure_future(stopping.wait())
    log.info("ready")
    await asyncio.wait([disconnected, waiting], return_when=asyncio.FIRST_COMPLETED)

    log.info("stopping")
    stopping.set()
    for task in (disconnected, waiting):
        task.cancel()
    await asyncio.gather(clock, disconnected, waiting, return_exceptions=True)
    await client.disconnect()
    await api.close()
    conn.close()
    log.info("stopped cleanly")
    return 0


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("telethon").setLevel(logging.WARNING)
    try:
        config = load_config()
    except ConfigError as err:
        print(str(err), file=sys.stderr)
        return 2
    try:
        with SingleInstance(config.lock_path):
            return asyncio.run(run(config))
    except AlreadyRunning as err:
        print(str(err), file=sys.stderr)
        return 3
    except KeyboardInterrupt:
        log.info("interrupted, stopping")
        return 0
    except Exception:
        log.exception("the bot stopped on an error")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
