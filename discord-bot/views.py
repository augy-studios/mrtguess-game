"""Message builders. Each returns (embed, rows): an embed and rows of buttons.
`button(kind, label, style, **payload)` is passed in, so the registry stays in
one place. The wording follows telegram-bot/views.py.
"""

from __future__ import annotations

import unicodedata

import discord

from commands import COMMANDS

HINT_LABELS = {2: "code", 3: "map", 4: "Chinese name", 5: "letter"}

REVEAL_SECONDS = 15

# The PWA's default brand mint, for cards without a line colour of their own.
BRAND = discord.Colour(0xCCFFCC)

NAME_LENGTH = 20

GREY = discord.ButtonStyle.secondary
PRIMARY = discord.ButtonStyle.primary
DANGER = discord.ButtonStyle.danger
SUCCESS = discord.ButtonStyle.success


def clean_name(value: str | None) -> str | None:
    """A Discord display name made fit for the leaderboard, following
    main-site/api/_lib/names.js: emoji and other symbols dropped, whitespace
    collapsed, cut to 20 characters. None when nothing usable is left. The
    API still has the last word, profanity included."""
    name = unicodedata.normalize("NFKC", value or "")
    name = "".join(c for c in name if c in " _-" or c.isspace() or unicodedata.category(c)[0] in "LNM")
    name = " ".join(name.split())[:NAME_LENGTH].strip()
    return name if any(unicodedata.category(c)[0] in "LN" for c in name) else None


def escape(text) -> str:
    return discord.utils.escape_markdown(str(text))


def spaced_mask(mask: str) -> str:
    """"T__ P____" as "T _ _   P _ _ _ _", so each blank reads as one letter."""
    return " ".join(mask)


def and_list(items: list[str]) -> str:
    if len(items) <= 1:
        return "".join(items)
    return ", ".join(items[:-1]) + " and " + items[-1]


def line_colour(view: dict) -> discord.Colour:
    try:
        return discord.Colour(int(view["hints"]["colors"][0]["hex"].lstrip("#"), 16))
    except (KeyError, IndexError, ValueError):
        return BRAND


def round_buttons(view: dict, button, user_id: int):
    rid = view["round_id"]
    row = []
    if not view.get("expired"):
        row.append(button("guess", "Guess", PRIMARY, round_id=rid, user_id=user_id))
    nxt = view.get("next_hint")
    if nxt and not view.get("expired"):
        row.append(button("hint", f"Hint: {HINT_LABELS[nxt['tier']]} (-{nxt['penalty']})", GREY, round_id=rid, user_id=user_id))
    row.append(button("giveup", "Give up", DANGER, round_id=rid, user_id=user_id))
    return [row]


def round_card(view: dict, button, user_id: int, note: str | None = None, has_map: bool = False):
    """`has_map` is true when map.png goes out attached to the same message."""
    hints = view["hints"]
    lines = []
    if note:
        lines.append(f"*{escape(note)}*")
    lines.append(f"```\n{spaced_mask(view['mask'])}\n```")
    lines.append(f"**{view['length']} letters** · **{view['score']}** points")
    embed = discord.Embed(title="Guess the station", description="\n".join(lines), colour=line_colour(view))

    embed.add_field(name="Line colour", value=escape(and_list([c["name"] for c in hints["colors"]])), inline=False)
    if "codes" in hints:
        embed.add_field(name="Codes" if len(hints["codes"]) > 1 else "Code", value=" ".join(f"`{c}`" for c in hints["codes"]))
        line_names = hints.get("line_names", [])
        if line_names:
            embed.add_field(name="Lines" if len(line_names) > 1 else "Line", value=escape(and_list(line_names)))
    if "position" in hints:
        embed.add_field(name="Map", value="The station is inside the ring below.", inline=False)
        if has_map:
            embed.set_image(url="attachment://map.png")
    if "name_zh" in hints:
        embed.add_field(name="Chinese name", value=escape(hints["name_zh"]), inline=False)

    if view.get("expired"):
        embed.set_footer(text="This round has timed out. Give up to see the answer.")
    elif view.get("next_reveal_in") is not None:
        embed.set_footer(text=f"Another letter shows every {REVEAL_SECONDS} seconds.")
    else:
        embed.set_footer(text="No more letters will show on their own.")

    return embed, round_buttons(view, button, user_id)


def answer_lines(answer: dict) -> str:
    alt = " · ".join(x for x in (answer.get("name_zh"), answer.get("name_ta")) if x)
    codes = " ".join(f"`{c}`" for c in answer.get("codes") or [])
    return "\n".join(x for x in (escape(alt), codes) if x)


def submitted_line(result: dict) -> str:
    """Where the name now stands on both boards."""
    rounds = result.get("rounds") or 1
    plural = "round" if rounds == 1 else "rounds"
    out = [
        f"Added as **{escape(result['name'])}**.",
        f"Best score **{result['best_score']}**, ranked **{result['rank']}**.",
    ]
    if result.get("total") is not None:
        out.append(f"Total **{result['total']}** over {rounds} {plural}, ranked **{result['total_rank']}**.")
    return " ".join(out)


def submitted_card(result: dict, button, user_id: int):
    embed = discord.Embed(description=submitted_line(result), colour=BRAND)
    return embed, [[button("leaderboard", "Leaderboard", GREY, user_id=user_id), button("play", "Play again", PRIMARY, user_id=user_id)]]


def solved_card(view: dict, button, user_id: int, saved_name: str | None = None,
                submitted: dict | None = None, note: str | None = None):
    """Three endings: already added (automatically), one tap under the saved
    name, or asked for a name."""
    answer = view["answer"]
    parts = [answer_lines(answer), f"Solved for **{view['score']}** points."]
    if submitted:
        parts.append(submitted_line(submitted))
    if note:
        parts.append(f"*{escape(note)}*")
    embed = discord.Embed(title=answer["name_en"], description="\n\n".join(p for p in parts if p), colour=line_colour(view))

    play = button("play", "Play again", PRIMARY, user_id=user_id)
    rid = view["round_id"]
    if submitted:
        rows = [[button("leaderboard", "Leaderboard", GREY, user_id=user_id), play]]
    elif saved_name:
        rows = [
            [
                button("submit", f"Add as {saved_name}", SUCCESS, round_id=rid, user_id=user_id, name=saved_name),
                button("submit", "Another name", GREY, round_id=rid, user_id=user_id),
            ],
            [play],
        ]
    else:
        rows = [[button("submit", "Add to leaderboard", SUCCESS, round_id=rid, user_id=user_id), play]]
    return embed, rows


def gave_up_card(view: dict, button, user_id: int):
    answer = view["answer"]
    embed = discord.Embed(
        title=f"It was {answer['name_en']}",
        description="\n\n".join(p for p in (answer_lines(answer), "No points this round.") if p),
        colour=line_colour(view),
    )
    return embed, [[button("play", "Play again", PRIMARY, user_id=user_id)]]


ON_OFF = {True: "On", False: "Off"}


def settings_card(settings: dict, button, user_id: int, note: str | None = None):
    name = settings["name"]
    default = settings.get("name_is_default", False)
    shown = f"{escape(name)} (your Discord name)" if name and default else escape(name) if name else "Not set"
    embed = discord.Embed(title="Settings", description=f"*{escape(note)}*" if note else None, colour=BRAND)
    embed.add_field(name="Leaderboard name", value=shown, inline=False)
    embed.add_field(name="Add solved rounds automatically", value=ON_OFF[settings["auto_submit"]])
    embed.add_field(name="Ask before buying a hint", value=ON_OFF[settings["confirm_hints"]])
    embed.add_field(name="Remove old round cards", value=ON_OFF[settings["tidy_chat"]])
    embed.add_field(name="Map hint colours", value=settings["map_style"].capitalize())
    embed.set_footer(
        text="Until you pick a leaderboard name, your Discord display name is used. A name you set here or "
        "type when adding a round is remembered instead; clear it to go back to your Discord name. "
        "With automatic adding on, every solved round goes on the leaderboard under it."
    )

    def toggle(key: str, label: str):
        on = settings[key]
        return button("setting", f"{label}: {ON_OFF[on]}", SUCCESS if on else GREY, key=key, user_id=user_id)

    name_row = [button("setname", "Change name" if name else "Set name", PRIMARY, user_id=user_id)]
    if name and not default:
        name_row.append(button("setting", "Use Discord name", GREY, key="name", user_id=user_id))
    other_style = "dark" if settings["map_style"] == "light" else "light"
    rows = [
        name_row,
        [toggle("auto_submit", "Add automatically"), toggle("confirm_hints", "Ask before hints")],
        [
            toggle("tidy_chat", "Remove old cards"),
            button("setting", f"Map colours: {settings['map_style'].capitalize()}", GREY, key="map_style",
                   value=other_style, user_id=user_id),
        ],
    ]
    return embed, rows


def _table(headers: list[str], rows: list[list]) -> str:
    """A fixed width table in a code block; Discord embeds have no tables."""
    cells = [headers] + [[str(v) for v in row] for row in rows]
    widths = [max(len(r[i]) for r in cells) for i in range(len(headers))]
    lines = ["  ".join(v.ljust(widths[i]) for i, v in enumerate(r)).rstrip() for r in cells]
    body = "\n".join(lines).replace("```", "'''")
    return f"```\n{body}\n```"


def leaderboard_card(board: str, entries: list[dict], button, user_id: int, limit: int = 10):
    """Either board, with a button that swaps to the other in place."""
    if board == "total":
        title = "Leaderboard: total points"
        table = _table(["#", "Name", "Total", "Rounds"], [[e["rank"], e["name"], e["total"], e["rounds"]] for e in entries[:limit]])
        about = "Every round added to the leaderboard under a name, scores added up."
        switch = button("leaderboard", "Best scores", GREY, board="best", user_id=user_id)
    else:
        title = "Leaderboard: best score"
        table = _table(["#", "Name", "Score"], [[e["rank"], e["name"], e["score"]] for e in entries[:limit]])
        about = "Each name's single best round."
        switch = button("leaderboard", "Total points", GREY, board="total", user_id=user_id)

    if entries:
        description = f"{table}\n{about} Anyone who picks the same name shares its entry."
    else:
        description = "No scores yet. Solve a round and add yours."
    embed = discord.Embed(title=title, description=description, colour=BRAND)
    return embed, [[switch, button("play", "Play", PRIMARY, user_id=user_id)]]


SCORING = [
    ["Every round starts at", "1000"],
    ["A letter, clock or hint", "-60"],
    ["Station code hint", "-100"],
    ["Map hint", "-150"],
    ["Chinese name hint", "-200"],
    ["Wrong guess", "-20"],
    ["Giving up", "0 for the round"],
]


def help_card(button, site_url: str, donation_url: str | None):
    """Everything a start command would say. There is no start command.
    Everyone in the channel sees it, so its buttons work for whoever presses
    them."""
    embed = discord.Embed(
        title="Guess the station",
        description="A Singapore MRT and LRT guessing game, played right here. No sign up.",
        colour=BRAND,
    )
    embed.add_field(
        name="How to play",
        value="\n".join(
            [
                "1. Send /play, or press Play below. You get a station with its letters hidden, how many "
                "letters it has, and the colour of its line.",
                "2. Guess with the Guess button on the card, or /guess. In a direct message, just type it. "
                "Case, spaces and hyphens do not matter, so toapayoh counts as Toa Payoh.",
                f"3. Every {REVEAL_SECONDS} seconds another letter shows by itself, up to half the name. "
                "The card updates in place.",
                "4. Stuck? Press the hint button or send /hint. Hints come in a fixed order: the station code, "
                "such as NS19, a map with the station ringed, the Chinese name, then one letter at a time.",
                "5. Send /giveup to end the round and see the answer. A round left for an hour times out; "
                "give up on it to see what it was.",
            ]
        ),
        inline=False,
    )
    embed.add_field(name="Scoring", value=_table(["What happens", "Points"], SCORING) + "A round never drops below 50 while you are still playing it.", inline=False)
    embed.add_field(
        name="Leaderboard",
        value="Solve a round and add it in one tap under your Discord display name, or pick another name of "
        "up to 20 characters. Each solved round can go on once, within an hour of starting it. There are two "
        "boards: best score, each name's single best round, and total points, every round under a name added "
        "up. Names are not accounts: anyone who picks the same name shares its entry.",
        inline=False,
    )
    embed.add_field(
        name="Settings",
        value="/settings holds your leaderboard name, automatic adding, a check before each hint spends points, "
        "whether old round cards are removed to keep the channel tidy, and light or dark map hints.",
        inline=False,
    )
    embed.add_field(name="Commands", value="\n".join(f"`/{name}` {description}" for name, description in COMMANDS), inline=False)
    embed.add_field(
        name="About",
        value="There is no account. Your rounds are kept against your Discord user id so the game can find them "
        "again, and rounds that never reach the leaderboard are deleted after two days. Your settings, "
        "including your leaderboard name, are kept by the bot against the same id. Only a name you choose to "
        "submit is ever shown. Each player's round is their own, in a server channel or a direct message. "
        "The same game runs in the browser, with the same leaderboard.",
        inline=False,
    )

    rows = [
        [button("play", "Play", PRIMARY), button("leaderboard", "Leaderboard", GREY)],
        [discord.ui.Button(label="Play in the browser", url=site_url)],
    ]
    if donation_url:
        rows[1].append(discord.ui.Button(label="Buy Augy a Coffee", url=donation_url))
    return embed, rows
