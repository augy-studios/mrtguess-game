"""Every button the bot sends. The custom id is an opaque `b:<id>` looked up
in SQLite, and discord.py matches it by pattern, so a button keeps working
across restarts with nothing held in memory per message.
"""

from __future__ import annotations

import logging

import discord

import db

log = logging.getLogger("bot.buttons")


class RegistryButton(discord.ui.DynamicItem[discord.ui.Button], template=db.CUSTOM_ID_PATTERN):
    # Set by bot.py once the game exists; the dispatcher for every press.
    game = None

    def __init__(self, custom_id: str, label: str = "", style: discord.ButtonStyle = discord.ButtonStyle.secondary):
        super().__init__(discord.ui.Button(label=label, style=style, custom_id=custom_id))
        self.button_id = custom_id.removeprefix("b:")

    @classmethod
    async def from_custom_id(cls, interaction, item, match):
        return cls(item.custom_id, item.label or "", item.style)

    async def callback(self, interaction: discord.Interaction) -> None:
        await self.game.on_button(interaction, self.button_id)


def make_view(rows) -> discord.ui.View | None:
    """Rows of buttons as a view. None means no buttons at all."""
    if not rows or not any(rows):
        return None
    view = discord.ui.View(timeout=None)
    for i, row in enumerate(rows):
        for item in row:
            item.row = i
            view.add_item(item)
    return view
