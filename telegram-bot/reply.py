"""Telegram Rich Messages, per telethon-richmessage-retrofit.md.

A structured reply is {"markdown": ..., "fallback": ...}. `markdown` is
Telegram's Rich Markdown; `fallback` is plain text saying the same thing, sent
in the required `message=` field and used when the rich body is refused. It is
never empty and never parsed. One-line notices stay ordinary `respond` calls.
"""

from __future__ import annotations

import logging
import re

from telethon import types
from telethon.errors import MessageNotModifiedError
from telethon.tl import functions

log = logging.getLogger("bot.reply")

_MD_SPECIAL = re.compile(r"([\\*_~`|\[\]#>=])")


def escape_md(text) -> str:
    """Escape user or data text for Telegram's Rich Markdown dialect."""
    return _MD_SPECIAL.sub(r"\\\1", str(text))


def escape_cell(text) -> str:
    """Escape for a table cell; also flattens newlines so the row stays intact."""
    return escape_md(str(text).replace("\n", " "))


def rich(markdown: str, fallback: str, files: list | None = None) -> dict:
    out = {"markdown": markdown, "fallback": fallback}
    if files:
        out["files"] = files
    return out


def join(parts, sep: str = "\n\n") -> dict:
    kept = [p for p in parts if p and (p["markdown"] or p["fallback"])]
    return rich(
        sep.join(p["markdown"] for p in kept if p["markdown"]),
        sep.join(p["fallback"] for p in kept if p["fallback"]),
        [f for p in kept for f in p.get("files", [])],
    )


def heading(text: str, level: int = 1) -> dict:
    return rich(f"{'#' * level} {escape_md(text)}", text)


def para(markdown: str, fallback: str) -> dict:
    """Authored markup with its plain twin. Dynamic parts must be escaped by
    the caller on the markdown side."""
    return rich(markdown, fallback)


def text(value: str) -> dict:
    return rich(escape_md(value), value)


def code_block(body: str) -> dict:
    return rich(f"```\n{body}\n```", body)


def bullets(items: list[dict]) -> dict:
    return rich("\n".join(f"- {i['markdown']}" for i in items), "\n".join(f"• {i['fallback']}" for i in items))


def numbered(items: list[dict]) -> dict:
    return rich(
        "\n".join(f"{n}. {i['markdown']}" for n, i in enumerate(items, 1)),
        "\n".join(f"{n}. {i['fallback']}" for n, i in enumerate(items, 1)),
    )


def photo(file_id: str, input_photo) -> dict:
    """An uploaded photo shown inside the message, as its own block. It has
    no plain twin: a message that falls back to plain text loses it."""
    return rich(f"![](tg://photo?id={file_id})", "", [types.InputRichFilePhoto(id=file_id, photo=input_photo)])


def table(headers: list[str], rows: list[list]) -> dict:
    md = [
        "| " + " | ".join(escape_cell(h) for h in headers) + " |",
        "| " + " | ".join("---" for _ in headers) + " |",
    ]
    md += ["| " + " | ".join(escape_cell(v) for v in row) + " |" for row in rows]
    plain = [" · ".join(str(v) for v in row) for row in rows]
    return rich("\n".join(md), "\n".join(plain))


# Sending.


def _rich_markdown(reply):
    return types.InputRichMessageMarkdown(markdown=reply["markdown"], files=reply.get("files") or None)


# Editing without reply_markup keeps the old keyboard; an empty inline
# keyboard is what actually removes it.
_NO_BUTTONS = types.ReplyInlineMarkup(rows=[])


def sent_message_id(result):
    """Id of the message a raw send created (bot sends come back as Updates)."""
    if isinstance(result, (types.Message, types.UpdateShortSentMessage)):
        return result.id
    for update in getattr(result, "updates", []):
        if isinstance(update, types.UpdateMessageID):
            return update.id
        if isinstance(update, (types.UpdateNewMessage, types.UpdateNewChannelMessage)):
            return update.message.id
    return None


async def send_rich_message(client, entity, reply, buttons=None):
    if not reply["fallback"].strip():
        raise ValueError("a rich message needs a non-empty fallback")
    markup = client.build_reply_markup(buttons) if buttons else None
    try:
        return await client(
            functions.messages.SendMessageRequest(
                peer=entity,
                message=reply["fallback"],
                rich_message=_rich_markdown(reply),
                reply_markup=markup,
                no_webpage=True,
            )
        )
    except Exception as err:  # noqa: BLE001 - plain text answers every refusal
        log.warning("rich send failed, falling back: %r", err)
        return await client.send_message(entity, reply["fallback"], buttons=buttons, parse_mode=None, link_preview=False)


async def edit_rich_message_at(client, peer, msg_id, reply, buttons=None):
    """Edit by chat and message id. No buttons means the keyboard is removed."""
    markup = client.build_reply_markup(buttons) if buttons else _NO_BUTTONS
    try:
        await client(
            functions.messages.EditMessageRequest(
                peer=peer,
                id=msg_id,
                message=reply["fallback"],
                rich_message=_rich_markdown(reply),
                reply_markup=markup,
                no_webpage=True,
            )
        )
    except MessageNotModifiedError:
        return
    except Exception as err:  # noqa: BLE001
        log.warning("rich edit failed, falling back: %r", err)
        try:
            await client.edit_message(peer, msg_id, text=reply["fallback"], buttons=buttons, parse_mode=None)
        except MessageNotModifiedError:
            return


async def strip_buttons(client, peer, msg_id) -> None:
    """Remove a message's keyboard and leave its text, rich body included."""
    try:
        await client(functions.messages.EditMessageRequest(peer=peer, id=msg_id, reply_markup=_NO_BUTTONS))
    except MessageNotModifiedError:
        return


async def edit_rich_message(client, event, reply, buttons=None):
    """Edit the message a CallbackQuery came from, regular chat or inline mode."""
    markup = client.build_reply_markup(buttons) if buttons else None
    is_inline = isinstance(event.query, types.UpdateInlineBotCallbackQuery)
    try:
        if is_inline:
            await client(
                functions.messages.EditInlineBotMessageRequest(
                    id=event.query.msg_id,
                    message=reply["fallback"],
                    rich_message=_rich_markdown(reply),
                    reply_markup=markup,
                    no_webpage=True,
                )
            )
        else:
            await client(
                functions.messages.EditMessageRequest(
                    peer=event.query.peer,
                    id=event.query.msg_id,
                    message=reply["fallback"],
                    rich_message=_rich_markdown(reply),
                    reply_markup=markup,
                    no_webpage=True,
                )
            )
    except MessageNotModifiedError:
        return
    except Exception as err:  # noqa: BLE001
        log.warning("rich callback edit failed, falling back: %r", err)
        try:
            if is_inline:
                await client.edit_message(event.query.msg_id, text=reply["fallback"], buttons=buttons, parse_mode=None)
            else:
                await client.edit_message(
                    event.query.peer, event.query.msg_id, text=reply["fallback"], buttons=buttons, parse_mode=None
                )
        except MessageNotModifiedError:
            return
