"""UTF-8 byte-level helpers shared by the bounded buffers (bash.py) and the live
step tail (effects.py). Both cap output by bytes, which can land mid-character;
these helpers tell a cut from malformed content so only the cut is repaired."""

from __future__ import annotations


def _utf8_incomplete_suffix(data: bytes) -> int:
    """Length of a trailing partial UTF-8 sequence in `data` (0 when it ends on a
    character boundary). Only a proper prefix of a valid sequence counts; invalid
    content bytes are left for errors="replace" so real output is never hidden."""
    i = len(data)
    continuation = 0
    while i > 0 and continuation < 3 and data[i - 1] & 0xC0 == 0x80:
        continuation += 1
        i -= 1
    if continuation == 0:
        # A lone leading byte right at the end starts a sequence the data cuts off.
        return 1 if i > 0 and data[i - 1] >= 0xC2 else 0
    if i == 0 or data[i - 1] & 0xC0 == 0x80:
        return 0  # no leading byte in reach: malformed content, not a cut
    lead = data[i - 1]
    if lead < 0xC2:
        return 0  # ASCII before orphans or an overlong lead: malformed content
    expected = 2 if lead < 0xE0 else 3 if lead < 0xF0 else 4
    present = continuation + 1
    return present if present < expected else 0


def _utf8_leading_continuations(data: bytes) -> int:
    """Length of the leading continuation-byte run in `data`: the remainder of a
    character whose start was cut away. A leading byte is never stripped - its
    continuations follow inside the contiguous data, so the character is whole."""
    count = 0
    while count < 3 and count < len(data) and data[count] & 0xC0 == 0x80:
        count += 1
    return count
