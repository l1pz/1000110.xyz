"""The playlist sources a job can come from. Each is a module with `check_url`, `list_playlist` and `read_tracks`."""

from urllib.parse import urlparse

import soundcloud
import youtube
from errors import BadUrl

SOURCES = {"soundcloud": soundcloud, "youtube": youtube}


def source_of(url: str) -> str:
    """`soundcloud` or `youtube` by the link's host; anything else is refused before any request is made."""
    try:
        host = urlparse(url.strip()).hostname
    except ValueError:
        raise BadUrl("that is not a link") from None
    if host in soundcloud.HOSTS:
        return "soundcloud"
    if host in youtube.HOSTS:
        return "youtube"
    raise BadUrl("only soundcloud or youtube playlist links work")
