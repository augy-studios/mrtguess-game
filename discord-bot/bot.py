"""The MRT Station Guesser Discord bot. Run from this directory, in tmux:

    python bot.py

One process: discord.py's gateway connection plus the reveal clock. Game
state lives behind the API; SQLite holds buttons, the live cards and
settings.

Exit codes: 0 clean stop, 2 bad environment or token, 3 already running,
1 other.
"""

from __future__ import annotations

import asyncio
import logging
import signal
import sys

import discord
from discord import app_commands

import db
from api import GameApi
from buttons import RegistryButton
from commands import DESCRIPTIONS
from config import Config, ConfigError, load_config
from handlers import Game
from lock import AlreadyRunning, SingleInstance

log = logging.getLogger("bot")


def register(tree: app_commands.CommandTree, game: Game) -> None:
    """The slash commands, described from commands.py."""

    @tree.command(name="help", description=DESCRIPTIONS["help"])
    async def help_(interaction: discord.Interaction) -> None:
        await game.cmd_help(interaction)

    @tree.command(name="play", description=DESCRIPTIONS["play"])
    async def play(interaction: discord.Interaction) -> None:
        await game.cmd_play(interaction)

    @tree.command(name="guess", description=DESCRIPTIONS["guess"])
    @app_commands.describe(station="The station's name. Case, spaces and hyphens do not matter.")
    async def guess(interaction: discord.Interaction, station: app_commands.Range[str, 1, 64]) -> None:
        await game.cmd_guess(interaction, station)

    @tree.command(name="hint", description=DESCRIPTIONS["hint"])
    async def hint(interaction: discord.Interaction) -> None:
        await game.cmd_hint(interaction)

    @tree.command(name="giveup", description=DESCRIPTIONS["giveup"])
    async def giveup(interaction: discord.Interaction) -> None:
        await game.cmd_giveup(interaction)

    @tree.command(name="leaderboard", description=DESCRIPTIONS["leaderboard"])
    async def leaderboard(interaction: discord.Interaction) -> None:
        await game.cmd_leaderboard(interaction)

    @tree.command(name="settings", description=DESCRIPTIONS["settings"])
    async def settings(interaction: discord.Interaction) -> None:
        await game.cmd_settings(interaction)

    @tree.error
    async def on_error(interaction: discord.Interaction, error: app_commands.AppCommandError) -> None:
        log.exception("command %s failed", interaction.command and interaction.command.name, exc_info=error)
        try:
            await game.notice(interaction, "Something went wrong. Try again.")
        except discord.HTTPException:
            pass


class Bot(discord.Client):
    def __init__(self, config: Config) -> None:
        # Default intents only. Direct message text reaches a bot without the
        # privileged message content intent, and nothing else is read.
        super().__init__(intents=discord.Intents.default())
        # Servers the bot is in, and its direct messages. Not installable on a
        # user account: the reveal clock edits cards with the bot's own token,
        # which needs the bot in the channel.
        self.tree = app_commands.CommandTree(
            self,
            allowed_contexts=app_commands.AppCommandContext(guild=True, dm_channel=True, private_channel=False),
            allowed_installs=app_commands.AppInstallationType(guild=True, user=False),
        )
        self.config = config
        self.conn = db.connect(config.db_path)
        self.api = GameApi(config.site_url, config.bot_api_token)
        self.game = Game(self, self.conn, self.api, config)
        RegistryButton.game = self.game
        register(self.tree, self.game)

    async def setup_hook(self) -> None:
        self.add_dynamic_items(RegistryButton)
        try:
            synced = await self.tree.sync()
            log.info("synced %d slash commands", len(synced))
        except discord.HTTPException as err:
            # The commands from the last successful sync still work.
            log.warning("could not sync slash commands: %r", err)

    async def on_ready(self) -> None:
        log.info("connected as %s, API at %s", self.user, self.config.site_url)

    async def on_message(self, message: discord.Message) -> None:
        # Direct messages only: in a server, guesses go through /guess or the
        # card's Guess button.
        if message.guild is not None or message.author.bot:
            return
        text = (message.content or "").strip()
        if not text:
            return
        try:
            if text.startswith("/"):
                await message.channel.send("Commands are in the menu: type / and pick one. /help lists them.")
            else:
                await self.game.on_dm_text(message)
        except Exception:  # noqa: BLE001 - the player gets an answer whatever broke
            log.exception("message handling failed")
            await message.channel.send("Something went wrong. Try again.")


async def run(config: Config) -> int:
    client = Bot(config)

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

    code = 0
    async with client:
        clock = asyncio.ensure_future(client.game.run_clock(stopping))
        runner = asyncio.ensure_future(client.start(config.bot_token))
        waiting = asyncio.ensure_future(stopping.wait())
        await asyncio.wait([runner, waiting], return_when=asyncio.FIRST_COMPLETED)

        if runner.done() and not runner.cancelled() and runner.exception():
            err = runner.exception()
            if isinstance(err, discord.LoginFailure):
                print("Discord refused DISCORD_BOT_TOKEN. Reset it in the Developer Portal and update .env.", file=sys.stderr)
                code = 2
            elif isinstance(err, discord.PrivilegedIntentsRequired):
                print(f"Discord refused an intent: {err}", file=sys.stderr)
                code = 2
            else:
                log.error("the gateway connection stopped", exc_info=err)
                code = 1

        log.info("stopping")
        stopping.set()
        waiting.cancel()
        await client.close()
        await asyncio.gather(clock, runner, waiting, return_exceptions=True)

    await client.api.close()
    client.conn.close()
    log.info("stopped cleanly" if code == 0 else "stopped")
    return code


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("discord").setLevel(logging.WARNING)
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
