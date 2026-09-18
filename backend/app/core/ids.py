"""Reference and idempotency key generation."""

from __future__ import annotations

import hashlib
import secrets
import uuid


def new_uuid() -> str:
    return str(uuid.uuid4())


def reference(prefix: str) -> str:
    """Short human-quotable reference, e.g. ``OPP-4F2A9C31``."""
    return f"{prefix.upper()}-{secrets.token_hex(4).upper()}"


def deterministic_key(*parts: object) -> str:
    """Stable idempotency key derived from its inputs.

    Two workers processing the same logical action produce the same key, which
    is what stops a retry from buying the same product twice.
    """
    raw = "|".join(str(part) for part in parts)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()
