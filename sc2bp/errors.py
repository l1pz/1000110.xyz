"""Errors shared by the playlist sources (`soundcloud.py`, `youtube.py`)."""


class PlaylistError(Exception):
    """The playlist could not be read. `retryable`: trying again later may work (a timeout)."""

    def __init__(self, message: str, retryable: bool = False):
        super().__init__(message)
        self.retryable = retryable


class BadUrl(PlaylistError):
    """The address is not a playlist link this service reads."""
