"""The Tycho data container (``.tyd``): a JSON header followed by 8-byte aligned typed buffers.

Layout::

    bytes 0..3   magic b"TYCD"
    bytes 4..7   u32 little endian, format version
    bytes 8..11  u32 little endian, byte length of the JSON header
    header       UTF-8 JSON, then zero padding to the next multiple of 8
    body         the typed buffers, each padded to 8 bytes, in insertion order

The header holds ``views`` (name -> offset, length, dtype, shape) and
``datasets`` (plain JSON records that reference views by name). Readers need
nothing but a JSON parser and typed-array constructors, which is the point:
the browser runtime parses it with no library.
"""

from __future__ import annotations

import json
import struct
from typing import Any

import numpy as np

MAGIC = b"TYCD"
VERSION = 1

_DTYPES = {
    "float32": "<f4",
    "float64": "<f8",
    "int32": "<i4",
    "uint8": "|u1",
}


def _pad(n: int) -> int:
    return (-n) % 8


class ContainerWriter:
    """Accumulates typed views and dataset records, then serialises them."""

    def __init__(self, generator: str = "pytycho") -> None:
        self.generator = generator
        self.datasets: list[dict[str, Any]] = []
        self.meta: dict[str, Any] = {}
        self._views: dict[str, dict[str, Any]] = {}
        self._chunks: list[bytes] = []
        self._offset = 0

    def add_view(self, name: str, array: np.ndarray, dtype: str | None = None) -> str:
        """Stores ``array`` under ``name`` and returns the name for referencing."""
        if name in self._views:
            raise ValueError(f"view {name!r} already exists")
        a = np.ascontiguousarray(array)
        if dtype is not None:
            a = a.astype(dtype)
        dt = a.dtype.name
        if dt not in _DTYPES:
            raise TypeError(f"unsupported dtype {dt}; use one of {sorted(_DTYPES)}")
        raw = a.astype(_DTYPES[dt]).tobytes()
        self._views[name] = {
            "offset": self._offset,
            "length": len(raw),
            "dtype": dt,
            "shape": list(a.shape),
        }
        padded = raw + b"\0" * _pad(len(raw))
        self._chunks.append(padded)
        self._offset += len(padded)
        return name

    def add_dataset(self, record: dict[str, Any]) -> None:
        self.datasets.append(record)

    def header(self) -> dict[str, Any]:
        return {
            "format": "tycho-data",
            "version": VERSION,
            "generator": self.generator,
            "meta": self.meta,
            "views": self._views,
            "datasets": self.datasets,
        }

    def to_bytes(self) -> bytes:
        header = json.dumps(self.header(), separators=(",", ":")).encode("utf-8")
        head = MAGIC + struct.pack("<II", VERSION, len(header)) + header
        head += b"\0" * _pad(len(head))
        return head + b"".join(self._chunks)

    def write(self, path: str) -> None:
        with open(path, "wb") as fh:
            fh.write(self.to_bytes())


class Container:
    """Read side, mirroring the browser runtime's reader."""

    def __init__(self, data: bytes) -> None:
        if data[:4] != MAGIC:
            raise ValueError("not a Tycho data container")
        version, hlen = struct.unpack_from("<II", data, 4)
        if version != VERSION:
            raise ValueError(f"unsupported container version {version}")
        self.header = json.loads(data[12 : 12 + hlen].decode("utf-8"))
        body_start = 12 + hlen + _pad(12 + hlen)
        self._body = memoryview(data)[body_start:]

    @property
    def datasets(self) -> list[dict[str, Any]]:
        return self.header["datasets"]

    def view(self, name: str) -> np.ndarray:
        info = self.header["views"][name]
        buf = self._body[info["offset"] : info["offset"] + info["length"]]
        return np.frombuffer(buf, dtype=_DTYPES[info["dtype"]]).reshape(info["shape"])

    @classmethod
    def read(cls, path: str) -> "Container":
        with open(path, "rb") as fh:
            return cls(fh.read())
