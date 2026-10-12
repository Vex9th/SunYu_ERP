from __future__ import annotations

import errno
import os
from pathlib import Path
from typing import BinaryIO


def try_lock(path: Path) -> BinaryIO | None:
    """与 Go LockFileEx/flock 兼容；锁随进程退出释放，文件本身不代表忙碌。"""
    stream = path.open("a+b")
    try:
        stream.seek(0)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as error:
        stream.close()
        if error.errno in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
            return None
        raise
    return stream


def release_lock(stream: BinaryIO) -> None:
    try:
        stream.seek(0)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
    finally:
        stream.close()
