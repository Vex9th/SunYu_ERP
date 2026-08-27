from __future__ import annotations

import time
from collections.abc import Callable
from hashlib import sha256
from typing import Any

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from itsdangerous import BadData, TimestampSigner, URLSafeTimedSerializer

SESSION_COOKIE_NAME = "sunyu_session"
SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60
_SESSION_SALT = "sunyu-erp-session-v1"
_SESSION_PAYLOAD = {"v": 1, "authenticated": True}
_PASSWORD_HASHER = PasswordHasher()


class ClockTimestampSigner(TimestampSigner):
    def __init__(
        self,
        *args: Any,
        clock: Callable[[], float] | None = None,
        **kwargs: Any,
    ) -> None:
        self._clock = clock or time.time
        super().__init__(*args, **kwargs)

    def get_timestamp(self) -> int:
        return int(self._clock())


def validate_password(password: object) -> str:
    if (
        not isinstance(password, str)
        or len(password) != 6
        or any(character < "0" or character > "9" for character in password)
    ):
        raise ValueError("password must be exactly six ASCII digits")
    return password


def hash_password(password: object) -> str:
    return _PASSWORD_HASHER.hash(validate_password(password))


def verify_password(password_hash: object, password: object) -> bool:
    validated_password = validate_password(password)
    if not isinstance(password_hash, str) or not password_hash:
        raise TypeError("password_hash must be a non-empty string")
    try:
        return _PASSWORD_HASHER.verify(password_hash, validated_password)
    except VerifyMismatchError:
        return False


def create_session_serializer(
    session_secret: object,
    *,
    clock: Callable[[], float] | None = None,
) -> URLSafeTimedSerializer:
    if not isinstance(session_secret, str) or not session_secret.strip():
        raise TypeError("session_secret must be a non-empty string")
    return URLSafeTimedSerializer(
        session_secret,
        salt=_SESSION_SALT,
        signer=ClockTimestampSigner,
        signer_kwargs={"clock": clock, "digest_method": sha256},
    )


def create_session_token(
    session_secret: object,
    *,
    clock: Callable[[], float] | None = None,
) -> str:
    return create_session_serializer(session_secret, clock=clock).dumps(
        _SESSION_PAYLOAD
    )


def is_session_token_valid(session_secret: object, token: object) -> bool:
    if not isinstance(token, str) or not token:
        return False
    try:
        payload = create_session_serializer(session_secret).loads(
            token,
            max_age=SESSION_MAX_AGE_SECONDS,
        )
    except BadData:
        return False
    return payload == _SESSION_PAYLOAD
