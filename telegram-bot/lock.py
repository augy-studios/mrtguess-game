"""One instance at a time, enforced by the operating system.

A tmux restart that does not kill the old process leaves two copies polling,
and every round card gets edited twice. This takes an exclusive lock on
`bot.lock` for the life of the process; a second start exits naming the pid
that holds it. The kernel releases the lock when the process ends, even on
kill -9, so there is no stale lock to clear by hand.
"""

from __future__ import annotations

import os
from pathlib import Path
from types import TracebackType

try:  # POSIX, which is the VPS.
    import fcntl

    _HAS_FCNTL = True
except ImportError:  # Windows, where this only ever gets imported by a dev.
    import msvcrt

    _HAS_FCNTL = False


class AlreadyRunning(RuntimeError):
    """Another instance holds the lock."""


def _holder(path: Path, handle) -> str | None:
    """Read the pid out of a lock file somebody else is holding.

    **The read is allowed to fail and must not replace the real message.**
    `flock` on the VPS is advisory and leaves the file readable, but the
    Windows fallback locks a byte range and refuses the read outright, which
    turned a clear refusal into a traceback about a permission error on a lock
    file. The pid is the nice half of this message, not the point of it.
    """
    for read in (lambda: handle.read(), lambda: path.read_text(encoding="utf-8")):
        try:
            value = read().strip()
        except OSError:
            continue
        if value:
            return value
    return None


class SingleInstance:
    """Context manager holding the single instance lock.

    Used as `with SingleInstance(path):` around the whole run. The file handle
    is kept open on purpose: closing it drops the lock on every platform.
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        self._handle = None

    def __enter__(self) -> "SingleInstance":
        # Opened r+ where possible so the previous pid survives long enough to
        # be read back in the failure message. Truncating on open would erase
        # the one piece of information this exists to report.
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self.path.touch()

        handle = open(self.path, "r+", encoding="utf-8")

        try:
            if _HAS_FCNTL:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            else:
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            held_by = _holder(self.path, handle)
            handle.close()
            which = (
                f"as pid {held_by}"
                if held_by
                else f"and its pid could not be read from {self.path}"
            )
            raise AlreadyRunning(
                f"Another instance is already running, {which}.\n"
                f"Stop it before starting this one. Nothing has been started, "
                f"and the running instance has not been touched."
            ) from None

        handle.seek(0)
        handle.truncate()
        handle.write(str(os.getpid()))
        handle.flush()
        self._handle = handle
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        if self._handle is not None:
            # No unlock call. Closing the handle releases the lock, and so does
            # the process ending for any other reason, which is the case that
            # matters: a kill -9 must not leave a lock nobody can take.
            self._handle.close()
            self._handle = None
