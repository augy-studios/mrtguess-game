"""The command list. `start` prints it, the bot registers it with Telegram at
every startup, and `python commands.py` prints the block for BotFather.

No `help` command: `start` is the help. Descriptions never name the bot.
"""

COMMANDS = [
    ("start", "How to play, scoring, the leaderboard, and every command."),
    ("play", "Start a new round."),
    ("hint", "Buy the next hint for the round you are playing."),
    ("giveup", "End the round and see the answer."),
    ("leaderboard", "The top scores, one per name."),
]


def botfather_lines() -> list[str]:
    return [f"{name} - {description}" for name, description in COMMANDS]


if __name__ == "__main__":
    print("\n".join(botfather_lines()))
