"""Commands, buttons, guesses, settings and the reveal scheduler.

One live round card per player per channel, so a server channel can hold
several players' rounds at once. Letters the clock reveals, and anything done
from the card's own buttons, are edited into it. A slash command, or a guess
typed in a direct message, sends a fresh card to the bottom, and the old one
is deleted or, with tidy chat off, left without its buttons.

Every slash command and button answers Discord within three seconds by
deferring first; the API call and the card follow.
"""

from __future__ import annotations

import asyncio
import io
import logging
import time
from collections import defaultdict
from dataclasses import dataclass

import discord

import db
import mapimage
import views
from api import ApiError, GameApi
from buttons import RegistryButton, make_view

log = logging.getLogger("bot.handlers")

GONE = {"round_not_found", "round_over", "round_expired"}

# An interaction token works for 15 minutes; a minute spare for slow calls.
HOOK_LIFE_S = 14 * 60

# (channel id, user id): whose card, where.
Key = tuple[int, int]


@dataclass
class Out:
    """One message to send or edit: the embed, its buttons, and the map
    picture when the card shows one."""

    embed: discord.Embed
    view: discord.ui.View | None = None
    png: bytes | None = None

    def send_kwargs(self) -> dict:
        kw = {"embed": self.embed}
        if self.view is not None:
            kw["view"] = self.view
        if self.png:
            kw["file"] = discord.File(io.BytesIO(self.png), filename="map.png")
        return kw

    def edit_kwargs(self) -> dict:
        # view=None on an edit is what removes the buttons.
        kw = {"embed": self.embed, "view": self.view}
        if self.png:
            kw["attachments"] = [discord.File(io.BytesIO(self.png), filename="map.png")]
        return kw


class NameModal(discord.ui.Modal):
    """A leaderboard name, either for one solved round or for settings."""

    name = discord.ui.TextInput(label="Name on the leaderboard", min_length=1, max_length=20)

    def __init__(self, game: "Game", round_id: str | None) -> None:
        super().__init__(title="Add to the leaderboard" if round_id else "Leaderboard name", timeout=600)
        self.game = game
        self.round_id = round_id

    async def on_submit(self, interaction: discord.Interaction) -> None:
        await self.game.on_name_modal(interaction, self.round_id, self.name.value)


class GuessModal(discord.ui.Modal):
    guess = discord.ui.TextInput(label="Station name", placeholder="Case and spaces do not matter", max_length=64)

    def __init__(self, game: "Game", round_id: str) -> None:
        super().__init__(title="Guess the station", timeout=600)
        self.game = game
        self.round_id = round_id

    async def on_submit(self, interaction: discord.Interaction) -> None:
        await self.game.on_guess_modal(interaction, self.round_id, self.guess.value)


class Game:
    def __init__(self, client: discord.Client, conn, api: GameApi, config) -> None:
        self.client = client
        self.conn = conn
        self.api = api
        self.config = config
        self.locks: defaultdict[Key, asyncio.Lock] = defaultdict(asyncio.Lock)
        # Key -> (round_id, PNG): the map hint, drawn once per round.
        self.maps: dict[Key, tuple[str, bytes]] = {}
        # user_id -> Discord display name, cleaned. Memory only: every action
        # starts from one of the user's own interactions, which fills it again.
        self.display_names: dict[int, str | None] = {}

    def button(self, kind: str, label: str, style=views.GREY, **payload):
        return RegistryButton(db.register_button(self.conn, kind, **payload), label, style)

    def remember(self, user: discord.abc.User) -> None:
        self.display_names[user.id] = views.clean_name(getattr(user, "global_name", None) or user.name)

    def settings(self, user_id: int) -> dict:
        """Saved settings. A leaderboard name never set, or cleared, is the
        user's Discord display name; `name_is_default` says which it is."""
        prefs = db.get_settings(self.conn, user_id)
        prefs["name_is_default"] = not prefs["name"]
        if not prefs["name"]:
            prefs["name"] = self.display_names.get(user_id)
        return prefs

    # Building messages.

    async def map_png(self, key: Key, user_id: int, view: dict) -> bytes | None:
        """The round's map hint. Kept per card so the clock's edits reuse it;
        after a restart the next edit draws it again."""
        pos = view["hints"].get("position")
        if not pos:
            return None
        cached = self.maps.get(key)
        if cached and cached[0] == view["round_id"]:
            return cached[1]
        style = self.settings(user_id)["map_style"]
        try:
            image = await asyncio.to_thread(mapimage.render, self.config.lines_geojson, pos["lat"], pos["lon"], style)
        except Exception as err:  # noqa: BLE001 - the card still goes out, without the picture
            log.warning("could not draw the map for %s: %r", key, err)
            return None
        png = image.getvalue()
        self.maps[key] = (view["round_id"], png)
        return png

    async def round_card(self, key: Key, user_id: int, view: dict, note: str | None = None) -> Out:
        png = await self.map_png(key, user_id, view)
        embed, rows = views.round_card(view, self.button, user_id, note, has_map=png is not None)
        return Out(embed, make_view(rows), png)

    def out(self, built) -> Out:
        embed, rows = built
        return Out(embed, make_view(rows))

    # Sending. A target is an interaction that has already been answered or
    # deferred, whose followup makes the new message, or a channel.

    async def send(self, target, out: Out) -> db.Card:
        """Sends a message and returns it as a card: its id and, when an
        interaction sent it, that interaction's token and issue time."""
        if isinstance(target, discord.Interaction):
            msg = await target.followup.send(wait=True, **out.send_kwargs())
            return msg.id, target.token, target.created_at.timestamp()
        msg = await target.send(**out.send_kwargs())
        return msg.id, None, None

    async def notice(self, target, text: str) -> None:
        """A one-line answer: only the player sees it when Discord allows."""
        if isinstance(target, discord.Interaction):
            if target.response.is_done():
                await target.followup.send(text, ephemeral=True)
            else:
                await target.response.send_message(text, ephemeral=True)
        else:
            await target.send(text)

    def card_hook(self, live) -> discord.Webhook | None:
        """The webhook of the interaction that sent the card, while its token
        lasts. Through a user install the bot is often not in the channel, so
        its own token cannot touch the card, but the interaction's can."""
        token, at = live["hook_token"], live["hook_at"]
        if token and at and time.time() - at < HOOK_LIFE_S:
            return discord.Webhook.partial(self.client.application_id, token, client=self.client)
        return None

    async def edit_live(self, key: Key, live, **kwargs) -> None:
        msg_id = live["msg_id"]
        hook = self.card_hook(live)
        try:
            if hook is not None:
                await hook.edit_message(msg_id, **kwargs)
            else:
                await self.client.get_partial_messageable(key[0]).get_partial_message(msg_id).edit(**kwargs)
        except discord.HTTPException as err:
            log.info("could not edit %s in %s: %r", msg_id, key[0], err)

    async def retire_card(self, key: Key, live) -> None:
        """An old round card goes, or with tidy chat off, stays without buttons."""
        if not self.settings(live["user_id"])["tidy_chat"]:
            await self.edit_live(key, live, view=None)
            return
        msg_id = live["msg_id"]
        hook = self.card_hook(live)
        try:
            if hook is not None:
                await hook.delete_message(msg_id)
            else:
                await self.client.get_partial_messageable(key[0]).get_partial_message(msg_id).delete()
        except discord.HTTPException as err:  # a card left behind is harmless
            log.info("could not retire %s in %s: %r", msg_id, key[0], err)

    async def api_failed(self, key: Key, target, err: ApiError) -> None:
        if err.code in GONE:
            db.clear_live(self.conn, *key)
            await self.notice(target, "That round is over. Send /play for another.")
        elif err.code == "no_more_hints":
            await self.notice(target, "No more hints for this one. Keep guessing, or /giveup.")
        elif err.status in (400, 429) and err.message:
            await self.notice(target, err.message)
        else:
            log.warning("api error %s %s: %s", err.status, err.code, err.message)
            await self.notice(target, "The game server did not answer. Try again in a moment.")

    # Rounds, each run under the card's lock.

    async def start_round(self, key: Key, user_id: int, target) -> None:
        view = await self.api.new_round(user_id)
        old = db.get_live(self.conn, *key)
        if old:
            await self.retire_card(key, old)
        card = await self.send(target, await self.round_card(key, user_id, view))
        db.set_live(self.conn, key[0], user_id, view["round_id"], card, view)

    async def replace_card(self, key: Key, live, view: dict, target, note: str | None = None) -> None:
        await self.retire_card(key, live)
        card = await self.send(target, await self.round_card(key, live["user_id"], view, note))
        db.update_live(self.conn, *key, view, card)

    async def edit_card(self, key: Key, live, view: dict, note: str | None = None) -> None:
        out = await self.round_card(key, live["user_id"], view, note)
        await self.edit_live(key, live, **out.edit_kwargs())
        db.update_live(self.conn, *key, view)

    async def finish(self, key: Key, live, view: dict, target) -> None:
        user_id = live["user_id"]
        db.clear_live(self.conn, *key)
        self.maps.pop(key, None)
        await self.retire_card(key, live)
        if not view["solved"]:
            await self.send(target, self.out(views.gave_up_card(view, self.button, user_id)))
            return

        prefs = self.settings(user_id)
        submitted, note = None, None
        if prefs["auto_submit"] and prefs["name"]:
            try:
                submitted = await self.api.submit(view["round_id"], prefs["name"])
            except ApiError as err:
                which = "Discord name" if prefs["name_is_default"] else "saved name"
                note = (
                    f"Your {which} was refused, so this round was not added. Set another in /settings."
                    if err.status == 400
                    else "This round could not be added automatically. Try the button."
                )
        await self.send(
            target,
            self.out(views.solved_card(view, self.button, user_id, prefs["name"], submitted=submitted, note=note)),
        )

    async def guess(self, key: Key, live, text: str, target, in_place: bool = False) -> None:
        view = await self.api.guess(live["user_id"], live["round_id"], text)
        if view["correct"]:
            await self.finish(key, live, view, target)
            return
        note = f"Not {text[:40]}. -20 points."
        if in_place:
            await self.edit_card(key, live, view, note)
        else:
            await self.replace_card(key, live, view, target, note)

    async def hint(self, key: Key, live, target=None) -> dict:
        """Buys the next hint. With no target the card is edited in place;
        otherwise a fresh card goes out through the target."""
        view = await self.api.hint(live["user_id"], live["round_id"])
        if target is None:
            await self.edit_card(key, live, view)
        else:
            await self.replace_card(key, live, view, target)
        return view

    async def ask_hint(self, key: Key, live, interaction: discord.Interaction) -> None:
        """The check before a hint, only the player sees it. The interaction
        was deferred as ephemeral."""
        view = await self.api.state(live["user_id"], live["round_id"])
        nxt = view.get("next_hint")
        if not nxt:
            raise ApiError(409, "no_more_hints")
        uid, rid = live["user_id"], live["round_id"]
        what = views.HINT_LABELS[nxt["tier"]]
        rows = [[
            self.button("hint_yes", f"Yes, -{nxt['penalty']}", views.PRIMARY, round_id=rid, user_id=uid),
            self.button("hint_no", "No", views.GREY, user_id=uid),
        ]]
        await interaction.followup.send(f"Spend {nxt['penalty']} points on the {what}?", view=make_view(rows), ephemeral=True)

    async def give_up(self, key: Key, live, target) -> None:
        view = await self.api.give_up(live["user_id"], live["round_id"])
        await self.finish(key, live, view, target)

    async def leaderboard(self, user_id: int, target, board: str = "best", in_place: bool = False) -> None:
        """A new leaderboard message, or from its own switch button, the same
        message redrawn as the other board."""
        data = await self.api.leaderboard(board)
        out = self.out(views.leaderboard_card(board, data.get("entries", []), self.button, user_id))
        if in_place:
            await target.edit_original_response(**out.edit_kwargs())
        else:
            await self.send(target, out)

    # Names.

    async def submit_name(self, user_id: int, round_id: str, name: str, target) -> None:
        """Adds a round under a name, typed or saved. Any name that goes
        through becomes the remembered one, except the Discord name, which
        stays a default that follows the account."""
        try:
            result = await self.api.submit(round_id, name)
        except ApiError as err:
            if err.status == 400:
                await self.notice(target, f"{err.message or 'That name will not work.'} Press Another name to try again.")
                return
            await self.notice(target, err.message or "Could not add that round.")
            return
        prefs = self.settings(user_id)
        if not (prefs["name_is_default"] and result["name"] == prefs["name"]):
            db.save_settings(self.conn, user_id, name=result["name"])
        await self.send(target, self.out(views.submitted_card(result, self.button, user_id)))

    async def set_name(self, user_id: int, name: str, interaction: discord.Interaction) -> None:
        """From the settings card's name box. The card is redrawn in place."""
        try:
            result = await self.api.check_name(name)
        except ApiError as err:
            if err.status == 400:
                await self.notice(interaction, f"{err.message or 'That name will not work.'} Press Change name to try again.")
                return
            raise
        db.save_settings(self.conn, user_id, name=result["name"])
        out = self.out(views.settings_card(self.settings(user_id), self.button, user_id, note=f"Saved {result['name']}."))
        await interaction.edit_original_response(**out.edit_kwargs())

    # Entry points.

    async def run_locked(self, key: Key, target, action) -> None:
        async with self.locks[key]:
            try:
                await action()
            except ApiError as err:
                await self.api_failed(key, target, err)
            except discord.HTTPException as err:
                log.warning("discord refused a reply in %s: %r", key[0], err)

    @staticmethod
    def key_of(interaction: discord.Interaction) -> Key:
        return (interaction.channel_id, interaction.user.id)

    def live_for(self, key: Key):
        return db.get_live(self.conn, *key)

    async def not_playing(self, interaction: discord.Interaction) -> None:
        await self.notice(interaction, "You are not in a round here. Send /play to start one.")

    async def cmd_play(self, interaction: discord.Interaction) -> None:
        self.remember(interaction.user)
        await interaction.response.defer(thinking=True)
        key = self.key_of(interaction)
        await self.run_locked(key, interaction, lambda: self.start_round(key, interaction.user.id, interaction))

    async def cmd_guess(self, interaction: discord.Interaction, text: str) -> None:
        self.remember(interaction.user)
        key = self.key_of(interaction)
        if self.live_for(key) is None:
            await self.not_playing(interaction)
            return
        await interaction.response.defer(thinking=True)

        async def act():
            live = self.live_for(key)
            if live is None:
                await self.notice(interaction, "That round is over. Send /play for another.")
                return
            await self.guess(key, live, text.strip(), interaction)

        await self.run_locked(key, interaction, act)

    async def cmd_hint(self, interaction: discord.Interaction) -> None:
        self.remember(interaction.user)
        key = self.key_of(interaction)
        live = self.live_for(key)
        if live is None:
            await self.not_playing(interaction)
            return
        if self.settings(interaction.user.id)["confirm_hints"]:
            await interaction.response.defer(ephemeral=True, thinking=True)
            await self.run_locked(key, interaction, lambda: self.ask_hint(key, self.live_for(key) or live, interaction))
        else:
            await interaction.response.defer(thinking=True)
            await self.run_locked(key, interaction, lambda: self.hint(key, self.live_for(key) or live, interaction))

    async def cmd_giveup(self, interaction: discord.Interaction) -> None:
        self.remember(interaction.user)
        key = self.key_of(interaction)
        live = self.live_for(key)
        if live is None:
            await self.not_playing(interaction)
            return
        await interaction.response.defer(thinking=True)
        await self.run_locked(key, interaction, lambda: self.give_up(key, self.live_for(key) or live, interaction))

    async def cmd_leaderboard(self, interaction: discord.Interaction) -> None:
        self.remember(interaction.user)
        await interaction.response.defer(thinking=True)
        key = self.key_of(interaction)
        await self.run_locked(key, interaction, lambda: self.leaderboard(interaction.user.id, interaction))

    async def cmd_settings(self, interaction: discord.Interaction) -> None:
        self.remember(interaction.user)
        uid = interaction.user.id
        out = self.out(views.settings_card(self.settings(uid), self.button, uid))
        await interaction.response.send_message(ephemeral=True, **out.send_kwargs())

    async def cmd_help(self, interaction: discord.Interaction) -> None:
        self.remember(interaction.user)
        uid = interaction.user.id
        out = self.out(views.help_card(self.button, uid, self.config.site_url, self.config.donation_url))
        # Only the asker needs the rules anywhere but their own chat with the bot.
        await interaction.response.send_message(ephemeral=not interaction.context.dm_channel, **out.send_kwargs())

    async def on_dm_text(self, message: discord.Message) -> None:
        """A plain message in a direct message is a guess, as on Telegram."""
        self.remember(message.author)
        key = (message.channel.id, message.author.id)
        if self.live_for(key) is None:
            await message.channel.send("Send /play to start a round.")
            return

        async def act():
            live = self.live_for(key)
            if live is not None:
                await self.guess(key, live, message.content.strip(), message.channel)

        await self.run_locked(key, message.channel, act)

    async def on_guess_modal(self, interaction: discord.Interaction, round_id: str, text: str) -> None:
        """From the Guess button on the card: a wrong guess edits the card in
        place, and nothing new lands in the channel."""
        key = self.key_of(interaction)
        live = self.live_for(key)
        if live is None or live["round_id"] != round_id:
            await self.notice(interaction, "That round is over. Send /play for another.")
            return
        await interaction.response.defer()

        async def act():
            fresh = self.live_for(key)
            if fresh is None or fresh["round_id"] != round_id:
                await self.notice(interaction, "That round is over. Send /play for another.")
                return
            await self.guess(key, fresh, text.strip(), interaction, in_place=True)

        await self.run_locked(key, interaction, act)

    async def on_name_modal(self, interaction: discord.Interaction, round_id: str | None, name: str) -> None:
        self.remember(interaction.user)
        uid = interaction.user.id
        key = self.key_of(interaction)
        if round_id:
            await interaction.response.defer(thinking=True)
            await self.run_locked(key, interaction, lambda: self.submit_name(uid, round_id, name.strip(), interaction))
        else:
            await interaction.response.defer()
            await self.run_locked(key, interaction, lambda: self.set_name(uid, name.strip(), interaction))

    async def on_button(self, interaction: discord.Interaction, button_id: str) -> None:
        record = db.read_button(self.conn, button_id)
        if record is None:
            await self.notice(interaction, "That button has expired. Send /play to start again.")
            return
        kind, payload = record
        uid = interaction.user.id
        if payload.get("user_id") not in (None, uid):
            await self.notice(interaction, "That button belongs to someone else.")
            return
        self.remember(interaction.user)
        key = self.key_of(interaction)

        if kind in ("guess", "hint", "giveup", "hint_yes"):
            live = self.live_for(key)
            if live is None or live["round_id"] != payload.get("round_id"):
                if kind == "hint_yes":
                    await interaction.response.edit_message(content="That round is over.", view=None)
                else:
                    await self.notice(interaction, "That round is over. Send /play for another.")
                return

            # Read again under the lock: a guess may have replaced the card.
            def fresh():
                return self.live_for(key) or live

            if kind == "guess":
                await interaction.response.send_modal(GuessModal(self, live["round_id"]))
            elif kind == "hint" and self.settings(uid)["confirm_hints"]:
                await interaction.response.defer(ephemeral=True, thinking=True)
                await self.run_locked(key, interaction, lambda: self.ask_hint(key, fresh(), interaction))
            elif kind == "hint":
                await interaction.response.defer()
                await self.run_locked(key, interaction, lambda: self.hint(key, fresh()))
            elif kind == "hint_yes":
                await interaction.response.defer()

                async def bought():
                    view = await self.hint(key, fresh())
                    what = views.HINT_LABELS.get(view["hint_tier"], "hint")
                    await interaction.edit_original_response(content=f"Spent {view.get('penalty', 0)} points on the {what}.", view=None)

                await self.run_locked(key, interaction, bought)
            else:
                await interaction.response.defer()
                await self.run_locked(key, interaction, lambda: self.give_up(key, fresh(), interaction))
            return

        if kind == "hint_no":
            await interaction.response.edit_message(content="Kept your points.", view=None)
        elif kind == "setting":
            await self.change_setting(interaction, uid, payload)
        elif kind == "setname":
            await interaction.response.send_modal(NameModal(self, None))
        elif kind == "submit" and payload.get("name"):
            await interaction.response.defer(thinking=True)
            name = payload["name"]
            await self.run_locked(key, interaction, lambda: self.submit_name(uid, payload["round_id"], name, interaction))
        elif kind == "submit":
            await interaction.response.send_modal(NameModal(self, payload["round_id"]))
        elif kind == "play":
            await interaction.response.defer(thinking=True)
            await self.run_locked(key, interaction, lambda: self.start_round(key, uid, interaction))
        elif kind == "leaderboard" and payload.get("board") in ("best", "total"):
            await interaction.response.defer()
            board = payload["board"]
            await self.run_locked(key, interaction, lambda: self.leaderboard(uid, interaction, board, in_place=True))
        elif kind == "leaderboard":
            await interaction.response.defer(thinking=True)
            await self.run_locked(key, interaction, lambda: self.leaderboard(uid, interaction))
        else:
            await self.notice(interaction, "That button has expired. Send /play to start again.")

    async def change_setting(self, interaction: discord.Interaction, user_id: int, payload: dict) -> None:
        """A toggle on the settings card. The card is redrawn in place."""
        key = payload.get("key")
        prefs = self.settings(user_id)
        if key == "name":
            db.save_settings(self.conn, user_id, name=None)
        elif key == "map_style":
            db.save_settings(self.conn, user_id, map_style=payload.get("value", "light"))
        elif key in ("auto_submit", "confirm_hints", "tidy_chat"):
            if key == "auto_submit" and not prefs["name"]:
                await self.notice(interaction, "Set a leaderboard name first.")
                return
            db.save_settings(self.conn, user_id, **{key: not prefs[key]})
        else:
            await interaction.response.defer()
            return
        out = self.out(views.settings_card(self.settings(user_id), self.button, user_id))
        await interaction.response.edit_message(**out.edit_kwargs())

    # The clock.

    async def tick(self, row) -> None:
        key = (row["channel_id"], row["user_id"])
        async with self.locks[key]:
            live = self.live_for(key)
            if live is None or live["round_id"] != row["round_id"]:
                return
            try:
                view = await self.api.state(live["user_id"], live["round_id"])
            except ApiError as err:
                if err.code in GONE:
                    db.clear_live(self.conn, *key)
                else:
                    # Try again shortly rather than lose the card's updates.
                    db.stop_ticking(self.conn, *key, retry_at=time.time() + 15)
                return

            changed = view["mask"] != live["last_mask"] or view["score"] != live["last_score"] or view.get("expired")
            if changed:
                out = await self.round_card(key, live["user_id"], view)
                await self.edit_live(key, live, **out.edit_kwargs())
            db.update_live(self.conn, *key, view)
            if view.get("expired"):
                db.stop_ticking(self.conn, *key)

    async def run_clock(self, stopping: asyncio.Event) -> None:
        while not stopping.is_set():
            for row in db.due_live(self.conn, time.time()):
                try:
                    await self.tick(row)
                except Exception:  # noqa: BLE001 - one card must not stop the clock for all
                    log.exception("tick failed for %s/%s", row["channel_id"], row["user_id"])
            try:
                await asyncio.wait_for(stopping.wait(), timeout=1.0)
            except asyncio.TimeoutError:
                pass
