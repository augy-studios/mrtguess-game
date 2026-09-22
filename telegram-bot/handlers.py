"""Commands, buttons, guesses, settings and the reveal scheduler.

One live round card per chat. Letters the clock reveals are edited into it;
a guess or a typed command sends a fresh card at the bottom of the chat, and
the old one is deleted or, with tidy chat off, left without its buttons.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import defaultdict

from telethon import Button

import db
import mapimage
import reply as r
import views
from api import ApiError, GameApi

log = logging.getLogger("bot.handlers")

GONE = {"round_not_found", "round_over", "round_expired"}

NAME_PROMPT = (
    "Send the name to show on the leaderboard, up to 20 characters. "
    "Names are shared: anyone who picks the same one shares its entry."
)


class Game:
    def __init__(self, client, conn, api: GameApi, config) -> None:
        self.client = client
        self.conn = conn
        self.api = api
        self.config = config
        self.locks: defaultdict[int, asyncio.Lock] = defaultdict(asyncio.Lock)

    def button(self, kind: str, label: str, **payload):
        return Button.inline(label, db.register_button(self.conn, kind, **payload))

    def settings(self, user_id: int) -> dict:
        return db.get_settings(self.conn, user_id)

    # Sending helpers.

    async def send(self, chat_id: int, built) -> int | None:
        rich, buttons = built
        return r.sent_message_id(await r.send_rich_message(self.client, chat_id, rich, buttons))

    async def delete(self, chat_id: int, msg_id: int | None) -> None:
        if not msg_id:
            return
        try:
            await self.client.delete_messages(chat_id, [msg_id])
        except Exception as err:  # noqa: BLE001 - a message left behind is harmless
            log.info("could not delete %s in %s: %r", msg_id, chat_id, err)

    async def retire_card(self, chat_id: int, user_id: int, msg_id: int | None) -> None:
        """An old round card goes, or with tidy chat off, stays without buttons."""
        if not msg_id:
            return
        if self.settings(user_id)["tidy_chat"]:
            await self.delete(chat_id, msg_id)
            return
        try:
            await r.strip_buttons(self.client, chat_id, msg_id)
        except Exception as err:  # noqa: BLE001 - its buttons already refuse a finished round
            log.info("could not strip buttons from %s in %s: %r", msg_id, chat_id, err)

    async def send_map(self, chat_id: int, user_id: int, view: dict) -> None:
        pos = view["hints"].get("position")
        if not pos:
            return
        style = self.settings(user_id)["map_style"]
        image = await asyncio.to_thread(mapimage.render, self.config.lines_geojson, pos["lat"], pos["lon"], style)
        await self.client.send_file(chat_id, image, caption="Map hint: the station is inside the ring.")

    async def api_failed(self, chat_id: int, err: ApiError) -> None:
        if err.code in GONE:
            db.clear_live(self.conn, chat_id)
            await self.client.send_message(chat_id, "That round is over. Send /play for another.")
        elif err.code == "no_more_hints":
            await self.client.send_message(chat_id, "No more hints for this one. Keep guessing, or /giveup.")
        else:
            log.warning("api error %s %s: %s", err.status, err.code, err.message)
            await self.client.send_message(chat_id, "The game server did not answer. Try again in a moment.")

    # Rounds, each run under the chat's lock.

    async def start_round(self, chat_id: int, user_id: int) -> None:
        db.clear_prompt(self.conn, chat_id)
        view = await self.api.new_round(user_id)
        old = db.get_live(self.conn, chat_id)
        if old:
            await self.retire_card(chat_id, user_id, old["msg_id"])
        msg_id = await self.send(chat_id, views.round_card(view, self.button, user_id))
        db.set_live(self.conn, chat_id, user_id, view["round_id"], msg_id, view)

    async def replace_card(self, chat_id: int, live, view: dict, note: str | None = None) -> None:
        await self.retire_card(chat_id, live["user_id"], live["msg_id"])
        msg_id = await self.send(chat_id, views.round_card(view, self.button, live["user_id"], note))
        db.update_live(self.conn, chat_id, view, msg_id)

    async def finish(self, chat_id: int, live, view: dict) -> None:
        user_id = live["user_id"]
        db.clear_live(self.conn, chat_id)
        await self.retire_card(chat_id, user_id, live["msg_id"])
        if not view["solved"]:
            await self.send(chat_id, views.gave_up_card(view, self.button, user_id))
            return

        prefs = self.settings(user_id)
        submitted, note = None, None
        if prefs["auto_submit"] and prefs["name"]:
            try:
                submitted = await self.api.submit(view["round_id"], prefs["name"])
            except ApiError as err:
                note = (
                    "Your saved name was refused, so this round was not added. Change it in /settings."
                    if err.status == 400
                    else "This round could not be added automatically. Try the button."
                )
        await self.send(
            chat_id,
            views.solved_card(view, self.button, user_id, prefs["name"], submitted=submitted, note=note),
        )

    async def guess(self, chat_id: int, live, text: str) -> None:
        view = await self.api.guess(live["user_id"], live["round_id"], text)
        if view["correct"]:
            await self.finish(chat_id, live, view)
        else:
            await self.replace_card(chat_id, live, view, f"Not {text[:40]}. -20 points.")

    async def hint(self, chat_id: int, live, event=None) -> None:
        """Buys the next hint. From a button on the card, the card is edited in
        place; otherwise a fresh card goes to the bottom."""
        view = await self.api.hint(live["user_id"], live["round_id"])
        new_map = view["hint_tier"] == 3 and view.get("penalty") == 150
        if event is not None:
            rich, buttons = views.round_card(view, self.button, live["user_id"])
            await r.edit_rich_message(self.client, event, rich, buttons)
            db.update_live(self.conn, chat_id, view)
            if new_map:
                await self.send_map(chat_id, live["user_id"], view)
        else:
            if new_map:
                await self.send_map(chat_id, live["user_id"], view)
            await self.replace_card(chat_id, live, view)

    async def ask_hint(self, chat_id: int, live, event=None) -> None:
        """A hint, or with confirmation on, a question first."""
        if not self.settings(live["user_id"])["confirm_hints"]:
            await self.hint(chat_id, live, event)
            return
        view = await self.api.state(live["user_id"], live["round_id"])
        nxt = view.get("next_hint")
        if not nxt:
            raise ApiError(409, "no_more_hints")
        what = views.HINT_LABELS[nxt["tier"]]
        uid, rid = live["user_id"], live["round_id"]
        await self.client.send_message(
            chat_id,
            f"Spend {nxt['penalty']} points on the {what}?",
            buttons=[[
                self.button("hint_yes", f"Yes, -{nxt['penalty']}", round_id=rid, user_id=uid),
                self.button("hint_no", "No", user_id=uid),
            ]],
        )

    async def give_up(self, chat_id: int, live) -> None:
        view = await self.api.give_up(live["user_id"], live["round_id"])
        await self.finish(chat_id, live, view)

    async def leaderboard(self, chat_id: int, user_id: int) -> None:
        data = await self.api.leaderboard()
        await self.send(chat_id, views.leaderboard_card(data.get("entries", []), self.button, user_id))

    # Names.

    async def submit_name(self, chat_id: int, user_id: int, round_id: str, name: str) -> None:
        """Adds a round under a name, typed or saved. A refused name reopens the
        prompt; any name that goes through becomes the remembered one."""
        try:
            result = await self.api.submit(round_id, name)
        except ApiError as err:
            if err.status == 400:
                db.set_prompt(self.conn, chat_id, "submit", round_id)
                await self.client.send_message(chat_id, f"{err.message or 'That name will not work.'} Send another.")
                return
            db.clear_prompt(self.conn, chat_id)
            await self.client.send_message(chat_id, err.message or "Could not add that round.")
            return
        db.clear_prompt(self.conn, chat_id)
        db.save_settings(self.conn, user_id, name=result["name"])
        buttons = [[self.button("leaderboard", "Leaderboard", user_id=user_id), self.button("play", "Play again", user_id=user_id)]]
        await self.send(chat_id, (views.submitted_line(result), buttons))

    async def set_name(self, chat_id: int, user_id: int, name: str) -> None:
        try:
            result = await self.api.check_name(name)
        except ApiError as err:
            if err.status == 400:
                await self.client.send_message(chat_id, f"{err.message or 'That name will not work.'} Send another.")
                return
            raise
        db.clear_prompt(self.conn, chat_id)
        prefs = db.save_settings(self.conn, user_id, name=result["name"])
        await self.send(chat_id, views.settings_card(prefs, self.button, user_id, note=f"Saved {result['name']}."))

    # Entry points.

    async def run_locked(self, chat_id: int, action) -> None:
        async with self.locks[chat_id]:
            try:
                await action()
            except ApiError as err:
                await self.api_failed(chat_id, err)

    async def on_command(self, event, name: str) -> None:
        chat_id, user_id = event.chat_id, event.sender_id
        db.clear_prompt(self.conn, chat_id)

        if name == "start":
            await self.send(chat_id, views.start_card(self.button, user_id, self.config.donation_url))
            return
        if name == "settings":
            await self.send(chat_id, views.settings_card(self.settings(user_id), self.button, user_id))
            return
        if name == "play":
            await self.run_locked(chat_id, lambda: self.start_round(chat_id, user_id))
            return
        if name == "leaderboard":
            await self.run_locked(chat_id, lambda: self.leaderboard(chat_id, user_id))
            return

        live = db.get_live(self.conn, chat_id)
        if live is None:
            await event.respond("You are not in a round. Send /play to start one.")
            return
        if name == "hint":
            await self.run_locked(chat_id, lambda: self.ask_hint(chat_id, db.get_live(self.conn, chat_id) or live))
        elif name == "giveup":
            await self.run_locked(chat_id, lambda: self.give_up(chat_id, db.get_live(self.conn, chat_id) or live))

    async def on_text(self, event, text: str) -> None:
        chat_id, user_id = event.chat_id, event.sender_id
        prompt = db.get_prompt(self.conn, chat_id)
        if prompt is not None and prompt["kind"] == "submit":
            await self.run_locked(chat_id, lambda: self.submit_name(chat_id, user_id, prompt["round_id"], text))
            return
        if prompt is not None and prompt["kind"] == "setname":
            await self.run_locked(chat_id, lambda: self.set_name(chat_id, user_id, text))
            return
        if db.get_live(self.conn, chat_id) is None:
            await event.respond("Send /play to start a round.")
            return

        async def act():
            live = db.get_live(self.conn, chat_id)
            if live is not None:
                await self.guess(chat_id, live, text)

        await self.run_locked(chat_id, act)

    async def on_button(self, event, kind: str, payload: dict) -> None:
        chat_id, user_id = event.chat_id, event.sender_id
        if payload.get("user_id") not in (None, user_id):
            await event.answer("That button belongs to someone else.", alert=True)
            return

        if kind in ("hint", "giveup", "hint_yes"):
            live = db.get_live(self.conn, chat_id)
            if live is None or live["round_id"] != payload.get("round_id"):
                await event.answer("That round is over.", alert=True)
                if kind == "hint_yes":
                    await self.delete(chat_id, event.query.msg_id)
                return
            await event.answer()

            # Read again under the lock: a guess may have replaced the card.
            def fresh():
                return db.get_live(self.conn, chat_id) or live

            if kind == "hint":
                await self.run_locked(chat_id, lambda: self.ask_hint(chat_id, fresh(), event))
            elif kind == "hint_yes":
                await self.delete(chat_id, event.query.msg_id)
                await self.run_locked(chat_id, lambda: self.hint(chat_id, fresh()))
            else:
                await self.run_locked(chat_id, lambda: self.give_up(chat_id, fresh()))
            return

        if kind == "hint_no":
            await event.answer("Kept your points.")
            await self.delete(chat_id, event.query.msg_id)
            return

        if kind == "setting":
            await self.change_setting(event, user_id, payload)
            return

        await event.answer()
        if kind == "play":
            await self.run_locked(chat_id, lambda: self.start_round(chat_id, user_id))
        elif kind == "leaderboard":
            await self.run_locked(chat_id, lambda: self.leaderboard(chat_id, user_id))
        elif kind == "submit" and payload.get("name"):
            name = payload["name"]
            await self.run_locked(chat_id, lambda: self.submit_name(chat_id, user_id, payload["round_id"], name))
        elif kind == "submit":
            db.set_prompt(self.conn, chat_id, "submit", payload["round_id"])
            await self.client.send_message(chat_id, NAME_PROMPT)
        elif kind == "setname":
            db.set_prompt(self.conn, chat_id, "setname")
            await self.client.send_message(chat_id, NAME_PROMPT)

    async def change_setting(self, event, user_id: int, payload: dict) -> None:
        """A toggle on the settings card. The card is redrawn in place."""
        key = payload.get("key")
        prefs = self.settings(user_id)
        if key == "name":
            prefs = db.save_settings(self.conn, user_id, name=None)
        elif key == "map_style":
            prefs = db.save_settings(self.conn, user_id, map_style=payload.get("value", "light"))
        elif key in ("auto_submit", "confirm_hints", "tidy_chat"):
            if key == "auto_submit" and not prefs["name"]:
                await event.answer("Set a leaderboard name first.", alert=True)
                return
            prefs = db.save_settings(self.conn, user_id, **{key: not prefs[key]})
        else:
            await event.answer()
            return
        await event.answer("Saved.")
        rich, buttons = views.settings_card(prefs, self.button, user_id)
        await r.edit_rich_message(self.client, event, rich, buttons)

    # The clock.

    async def tick(self, row) -> None:
        chat_id = row["chat_id"]
        async with self.locks[chat_id]:
            live = db.get_live(self.conn, chat_id)
            if live is None or live["round_id"] != row["round_id"]:
                return
            try:
                view = await self.api.state(live["user_id"], live["round_id"])
            except ApiError as err:
                if err.code in GONE:
                    db.clear_live(self.conn, chat_id)
                else:
                    # Try again shortly rather than lose the card's updates.
                    self.conn.execute(
                        "update live_rounds set next_tick_at = ? where chat_id = ?", (time.time() + 15, chat_id)
                    )
                return

            changed = view["mask"] != live["last_mask"] or view["score"] != live["last_score"] or view.get("expired")
            if changed:
                rich, buttons = views.round_card(view, self.button, live["user_id"])
                await r.edit_rich_message_at(self.client, chat_id, live["msg_id"], rich, buttons)
            db.update_live(self.conn, chat_id, view)
            if view.get("expired"):
                self.conn.execute("update live_rounds set next_tick_at = null where chat_id = ?", (chat_id,))

    async def run_clock(self, stopping: asyncio.Event) -> None:
        while not stopping.is_set():
            for row in db.due_live(self.conn, time.time()):
                try:
                    await self.tick(row)
                except Exception:  # noqa: BLE001 - one chat must not stop the clock for all
                    log.exception("tick failed for chat %s", row["chat_id"])
            try:
                await asyncio.wait_for(stopping.wait(), timeout=1.0)
            except asyncio.TimeoutError:
                pass
