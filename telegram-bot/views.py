"""Message builders. Each returns (rich, buttons). `button(kind, label,
**payload)` is passed in, so the registry stays in one place.
"""

from __future__ import annotations

from telethon import Button

import reply as r
from commands import COMMANDS

HINT_LABELS = {2: "code", 3: "map", 4: "Chinese name", 5: "letter"}

REVEAL_SECONDS = 15


def spaced_mask(mask: str) -> str:
    """"T__ P____" as "T _ _   P _ _ _ _", so each blank reads as one letter."""
    return " ".join(mask)


def and_list(items: list[str]) -> str:
    if len(items) <= 1:
        return "".join(items)
    return ", ".join(items[:-1]) + " and " + items[-1]


def hint_lines(view: dict) -> list[dict]:
    hints = view["hints"]
    lines = []
    colours = and_list([c["name"] for c in hints["colors"]])
    lines.append(r.para(f"Line colour: **{r.escape_md(colours)}**", f"Line colour: {colours}"))
    if "code_prefixes" in hints:
        codes = ", ".join(hints["code_prefixes"])
        names = and_list(hints.get("line_names", []))
        lines.append(r.para(f"Code: **{r.escape_md(codes)}**, {r.escape_md(names)}", f"Code: {codes}, {names}"))
    if "position" in hints:
        lines.append(r.para("Map: in the picture sent with it", "Map: in the picture sent with it"))
    if "name_zh" in hints:
        zh = hints["name_zh"]
        lines.append(r.para(f"Chinese name: **{r.escape_md(zh)}**", f"Chinese name: {zh}"))
    return lines


def round_buttons(view: dict, button, user_id: int):
    row = []
    nxt = view.get("next_hint")
    if nxt and not view.get("expired"):
        label = f"Hint: {HINT_LABELS[nxt['tier']]} (-{nxt['penalty']})"
        row.append(button("hint", label, round_id=view["round_id"], user_id=user_id))
    row.append(button("giveup", "Give up", round_id=view["round_id"], user_id=user_id))
    return [row]


def round_card(view: dict, button, user_id: int, note: str | None = None):
    letters = view["length"]
    parts = []
    if note:
        parts.append(r.para(f"*{r.escape_md(note)}*", note))
    parts.append(r.heading("Guess the station", 2))
    parts.append(r.code_block(spaced_mask(view["mask"])))
    parts.append(
        r.para(
            f"**{letters} letters** · **{view['score']}** points",
            f"{letters} letters · {view['score']} points",
        )
    )
    parts.append(r.join(hint_lines(view), "\n"))

    if view.get("expired"):
        parts.append(r.text("This round has timed out. Give up to see the answer."))
    elif view.get("next_reveal_in") is not None:
        parts.append(r.text(f"Send your guess as a message. Another letter shows every {REVEAL_SECONDS} seconds."))
    else:
        parts.append(r.text("Send your guess as a message. No more letters will show on their own."))

    return r.join(parts), round_buttons(view, button, user_id)


def answer_lines(answer: dict) -> dict:
    alt = " · ".join(x for x in (answer.get("name_zh"), answer.get("name_ta")) if x)
    codes = " ".join(answer.get("codes") or [])
    return r.join([r.text(alt) if alt else None, r.para(f"`{codes}`", codes) if codes else None], "\n")


def solved_card(view: dict, button, user_id: int):
    answer = view["answer"]
    rich = r.join(
        [
            r.heading(answer["name_en"]),
            answer_lines(answer),
            r.para(f"Solved for **{view['score']}** points.", f"Solved for {view['score']} points."),
        ]
    )
    buttons = [
        [
            button("submit", "Add to leaderboard", round_id=view["round_id"], user_id=user_id),
            button("play", "Play again", user_id=user_id),
        ]
    ]
    return rich, buttons


def gave_up_card(view: dict, button, user_id: int):
    answer = view["answer"]
    rich = r.join(
        [
            r.heading(f"It was {answer['name_en']}"),
            answer_lines(answer),
            r.text("No points this round."),
        ]
    )
    return rich, [[button("play", "Play again", user_id=user_id)]]


def leaderboard_card(entries: list[dict], button, user_id: int, limit: int = 10):
    parts = [r.heading("Leaderboard")]
    if entries:
        parts.append(r.table(["#", "Name", "Score"], [[e["rank"], e["name"], e["score"]] for e in entries[:limit]]))
        parts.append(r.text("Each name shows its best score. Anyone who picks the same name shares its entry."))
    else:
        parts.append(r.text("No scores yet. Solve a round and add yours."))
    return r.join(parts), [[button("play", "Play", user_id=user_id)]]


def start_card(button, user_id: int, donation_url: str | None):
    """Everything a help command would say. There is no help command."""
    rich = r.join(
        [
            r.heading("Guess the station"),
            r.text("A Singapore MRT and LRT guessing game, played in this chat. No sign up."),
            r.heading("How to play", 2),
            r.numbered(
                [
                    r.text(
                        "Send /play, or press Play below. You get a station with its letters hidden, "
                        "how many letters it has, and the colour of its line."
                    ),
                    r.text(
                        "Send your guess as an ordinary message. Case, spaces and hyphens do not matter, "
                        "so toapayoh counts as Toa Payoh."
                    ),
                    r.text(
                        f"Every {REVEAL_SECONDS} seconds another letter shows by itself, up to half the name. "
                        "The card updates in place."
                    ),
                    r.text(
                        "Stuck? Press the hint button or send /hint. Hints come in a fixed order: the line code, "
                        "a map with the station ringed, the Chinese name, then one letter at a time."
                    ),
                    r.text(
                        "Send /giveup to end the round and see the answer. A round left for an hour times out; "
                        "give up on it to see what it was."
                    ),
                ]
            ),
            r.heading("Scoring", 2),
            r.table(
                ["What happens", "Points"],
                [
                    ["Every round starts at", "1000"],
                    ["A letter, from the clock or a hint", "-60"],
                    ["Line code hint", "-100"],
                    ["Map hint", "-150"],
                    ["Chinese name hint", "-200"],
                    ["Wrong guess", "-20"],
                    ["Giving up", "0 for the round"],
                ],
            ),
            r.text("A round never drops below 50 while you are still playing it."),
            r.heading("Leaderboard", 2),
            r.text(
                "Solve a round, press Add to leaderboard, and send a name of up to 20 characters. "
                "Each solved round can go on once, within an hour of starting it. The board shows each name's "
                "best score. Names are not accounts: anyone who picks the same name shares its entry."
            ),
            r.heading("Commands", 2),
            r.table(["Command", "What it does"], [[f"/{name}", description] for name, description in COMMANDS]),
            r.heading("About", 2),
            r.text(
                "There is no account. Your rounds are kept against your Telegram user id so the game can find "
                "them again, and rounds that never reach the leaderboard are deleted after two days. Only a name "
                "you choose to submit is ever shown. Works in private chats only."
            ),
        ]
    )
    buttons = [[button("play", "Play", user_id=user_id), button("leaderboard", "Leaderboard", user_id=user_id)]]
    if donation_url:
        buttons.append([Button.url("Buy Augy a Coffee", donation_url)])
    return rich, buttons
