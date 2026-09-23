"""The slash commands, as `/help` lists them. bot.py registers each one with
this description, and syncs the list with Discord at every startup.

No `start` command: `help` is the start. Descriptions never name the bot, and
Discord caps each at 100 characters.
"""

COMMANDS = [
    ("help", "How to play, scoring, the leaderboard, and every command."),
    ("play", "Start a new round."),
    ("guess", "Guess the station in the round you are playing."),
    ("hint", "Buy the next hint for the round you are playing."),
    ("giveup", "End the round and see the answer."),
    ("leaderboard", "Best scores and total points, one row per name."),
    ("settings", "Your leaderboard name, hint checks, card tidying and map colours."),
]

DESCRIPTIONS = dict(COMMANDS)


if __name__ == "__main__":
    for name, description in COMMANDS:
        print(f"/{name} - {description}")
