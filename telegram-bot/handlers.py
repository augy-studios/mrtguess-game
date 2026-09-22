"""Commands, buttons, guesses and the reveal scheduler.

One live round card per chat. Letters the clock reveals are edited into it;
a guess or a typed command sends a fresh card at the bottom of the chat and
deletes the old one, so the card is always the last thing on screen.
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


class Game:
    def __init__(self, client, conn, api: GameApi, config) -> None:
        self.client = client
        self.conn = conn
        self.api = api
        self.config = config
        self.locks: defaultdict[int, asyncio.Lock] = defaultdict(asyncio.Lock)

    def button(self, kind: str, label: str, **payload):
        return Button.inline(label, db.register_button(self.conn, kind, **payload))

    # Sending helpers.

    async def send(self, chat_id: int, built) -> int | None:
        rich, buttons = built
        return r.sent_message_id(await r.send_rich_message(self.client, chat_id, rich, buttons))

    async def drop_card(self, chat_id: int, msg_id: int | None) -> None:
        if not msg_id:
            return
        try:
            await self.client.delete_messages(chat_id, [msg_id])
        except Exception as err:  # noqa: BLE001 - an old card left behind is harmless
            log.info("could not delete card %s in %s: %r", msg_id, chat_id, err)

    async def send_map(self, chat_id: int, view: dict) -> None:
        pos = view["hints"].get("position")
        if not pos:
            return
        image = await asyncio.to_thread(mapimage.render, self.config.lines_geojson, pos["lat"], pos["lon"])
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

    # Actions, each run under the chat's lock.

    async def start_round(self, chat_id: int, user_id: int) -> None:
        db.clear_prompt(self.conn, chat_id)
        view = await self.api.new_round(user_id)
        old = db.get_live(self.conn, chat_id)
        if old:
            await self.drop_card(chat_id, old["msg_id"])
        msg_id = await self.send(chat_id, views.round_card(view, self.button, user_id))
        db.set_live(self.conn, chat_id, user_id, view["round_id"], msg_id, view)

    async def replace_card(self, chat_id: int, live, view: dict, note: str | None = None) -> None:
        await self.drop_card(chat_id, live["msg_id"])
        msg_id = await self.send(chat_id, views.round_card(view, self.button, live["user_id"], note))
        db.update_live(self.conn, chat_id, view, msg_id)

    async def finish(self, chat_id: int, live, view: dict) -> None:
        db.clear_live(self.conn, chat_id)
        await self.drop_card(chat_id, live["msg_id"])
        card = views.solved_card if view["solved"] else views.gave_up_card
        await self.send(chat_id, card(view, self.button, live["user_id"]))

    async def guess(self, chat_id: int, live, text: str) -> None:
        view = await self.api.guess(live["user_id"], live["round_id"], text)
        if view["correct"]:
            await self.finish(chat_id, live, view)
        else:
            await self.replace_card(chat_id, live, view, f"Not {text[:40]}. -20 points.")

    async def hint(self, chat_id: int, live, event=None) -> None:
        view = await self.api.hint(live["user_id"], live["round_id"])
        new_map = view["hint_tier"] == 3 and view.get("penalty") == 150
        if event is not None:
            rich, buttons = views.round_card(view, self.button, live["user_id"])
            await r.edit_rich_message(self.client, event, rich, buttons)
            db.update_live(self.conn, chat_id, view)
            if new_map:
                await self.send_map(chat_id, view)
        else:
            if new_map:
                await self.send_map(chat_id, view)
            await self.replace_card(chat_id, live, view)

    async def give_up(self, chat_id: int, live) -> None:
        view = await self.api.give_up(live["user_id"], live["round_id"])
        await self.finish(chat_id, live, view)

    async def leaderboard(self, chat_id: int, user_id: int) -> None:
        data = await self.api.leaderboard()
        await self.send(chat_id, views.leaderboard_card(data.get("entries", []), self.button, user_id))

    async def submit_name(self, chat_id: int, user_id: int, round_id: str, name: str) -> None:
        try:
            result = await self.api.submit(round_id, name)
        except ApiError as err:
            if err.status == 400:
                # Keep the prompt open for another try.
                await self.client.send_message(chat_id, f"{err.message or 'That name will not work.'} Send another.")
                return
            db.clear_prompt(self.conn, chat_id)
            await self.client.send_message(chat_id, err.message or "Could not add that round.")
            return
        db.clear_prompt(self.conn, chat_id)
        rich = r.para(
            f"Added as **{r.escape_md(result['name'])}**. That name is ranked **{result['rank']}**, "
            f"with a best of **{result['best_score']}**.",
            f"Added as {result['name']}. That name is ranked {result['rank']}, with a best of {result['best_score']}.",
        )
        buttons = [[self.button("leaderboard", "Leaderboard", user_id=user_id), self.button("play", "Play again", user_id=user_id)]]
        await self.send(chat_id, (rich, buttons))

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
            await self.run_locked(chat_id, lambda: self.hint(chat_id, db.get_live(self.conn, chat_id) or live))
        elif name == "giveup":
            await self.run_locked(chat_id, lambda: self.give_up(chat_id, db.get_live(self.conn, chat_id) or live))

    async def on_text(self, event, text: str) -> None:
        chat_id, user_id = event.chat_id, event.sender_id
        round_id = db.take_prompt(self.conn, chat_id)
        if round_id:
            await self.run_locked(chat_id, lambda: self.submit_name(chat_id, user_id, round_id, text))
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

        if kind in ("hint", "giveup"):
            live = db.get_live(self.conn, chat_id)
            if live is None or live["round_id"] != payload.get("round_id"):
                await event.answer("That round is over.", alert=True)
                return
            await event.answer()
            if kind == "hint":
                await self.run_locked(chat_id, lambda: self.hint(chat_id, live, event))
            else:
                await self.run_locked(chat_id, lambda: self.give_up(chat_id, live))
            return

        await event.answer()
        if kind == "play":
            await self.run_locked(chat_id, lambda: self.start_round(chat_id, user_id))
        elif kind == "leaderboard":
            await self.run_locked(chat_id, lambda: self.leaderboard(chat_id, user_id))
        elif kind == "submit":
            db.set_prompt(self.conn, chat_id, payload["round_id"])
            await self.client.send_message(
                chat_id,
                "Send the name to show on the leaderboard, up to 20 characters. "
                "Names are shared: anyone who picks the same one shares its entry.",
            )

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
