from __future__ import annotations

import time
import unicodedata
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


def validate_account_password(password: object) -> str:
    if not isinstance(password, str) or not 8 <= len(password) <= 128:
        raise ValueError("Password must contain 8 to 128 characters")
    try:
        password.encode("utf-8")
    except UnicodeEncodeError:
        raise ValueError("Password must contain valid Unicode characters") from None
    return password


def hash_account_password(password: object) -> str:
    return _PASSWORD_HASHER.hash(validate_account_password(password))


def verify_account_password(password_hash: object, password: object) -> bool:
    validated = validate_account_password(password)
    if not isinstance(password_hash, str) or not password_hash:
        raise TypeError("password_hash must be a non-empty string")
    try:
        return _PASSWORD_HASHER.verify(password_hash, validated)
    except VerifyMismatchError:
        return False


def normalize_username(username: object) -> tuple[str, str]:
    if not isinstance(username, str):
        raise TypeError("Username must contain 1 to 64 characters")
    display = unicodedata.normalize("NFKC", username).strip()
    if not 1 <= len(display) <= 64 or any(
        unicodedata.category(char).startswith("C") for char in display
    ):
        raise ValueError("Username must contain 1 to 64 visible characters")
    return display, display.casefold()


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
    return (
        isinstance(payload, dict)
        and set(payload) == {"v", "authenticated"}
        and type(payload["v"]) is int
        and payload["v"] == 1
        and type(payload["authenticated"]) is bool
        and payload["authenticated"] is True
    )


def create_account_session_token(
    session_secret: str,
    user_id: int,
    sid: str,
    *,
    clock: Callable[[], float] | None = None,
) -> str:
    return create_session_serializer(session_secret, clock=clock).dumps(
        {"v": 2, "uid": user_id, "sid": sid}
    )


def read_account_session_token(
    session_secret: str, token: object
) -> tuple[int, str] | None:
    if not isinstance(token, str) or not token:
        return None
    try:
        payload = create_session_serializer(session_secret).loads(
            token, max_age=SESSION_MAX_AGE_SECONDS
        )
    except BadData:
        return None
    if (
        not isinstance(payload, dict)
        or set(payload) != {"v", "uid", "sid"}
        or type(payload["v"]) is not int
        or payload["v"] != 2
        or type(payload["uid"]) is not int
        or payload["uid"] < 1
        or not isinstance(payload["sid"], str)
        or len(payload["sid"]) != 64
        or any(char not in "0123456789abcdef" for char in payload["sid"])
    ):
        return None
    return payload["uid"], payload["sid"]
