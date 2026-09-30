"""Builds a self-contained HTML page from a Tycho container and the runtime bundle.

The container bytes are gzip-compressed and base64-encoded into a script tag
of type ``application/octet-stream``; the browser runtime finds it through the
``<tycho-viewer>`` element's ``data`` attribute, decodes it with the native
``DecompressionStream`` and parses it with no library. The runtime itself is
inlined, so the page works offline, from disk, inside an iframe on a reveal.js
slide, or anywhere else a single HTML file can go.

The runtime bundle ships inside the wheel as ``pytycho/_static/tycho.js``
(built from ``web/`` by ``npm run build``).
"""

from __future__ import annotations

import base64
import gzip
import html as html_escape
import json
from importlib import resources
from pathlib import Path
from typing import Any


def _resource(name: str) -> str:
    return resources.files(__package__).joinpath(name).read_text(encoding="utf-8")


def runtime_js() -> str:
    """The bundled browser runtime. Raises if the wheel was built without it."""
    try:
        return _resource("_static/tycho.js")
    except FileNotFoundError as err:
        raise RuntimeError(
            "pytycho/_static/tycho.js is missing: run `npm ci && npm run build` in web/ "
            "(a source checkout needs this once; published wheels include it)"
        ) from err


def build_html(
    container: bytes,
    *,
    title: str,
    runtime: str | None = None,
    compress: bool = True,
    layout: dict[str, Any] | None = None,
    kiosk: bool = False,
) -> str:
    """Renders the page as a string.

    ``layout`` is the viewer's saved-layout JSON (the ``layoutJSON`` property of a
    ``<tycho-viewer>``: split tree, panels with frame and branch, family, e) used
    as the initial layout. ``kiosk`` hides the controls and autoplays, for slides.
    ``runtime`` overrides the bundled runtime, for development.
    """
    js = runtime if runtime is not None else runtime_js()
    if "</script" in js.lower():
        raise ValueError("runtime bundle contains a closing script tag")
    payload = gzip.compress(container, compresslevel=6) if compress else container
    attrs = ""
    if layout is not None:
        attrs += f' layout="{html_escape.escape(json.dumps(layout, separators=(",", ":")), quote=True)}"'
    if kiosk:
        attrs += " kiosk"
    page = _resource("template.html")
    for key, value in (
        ("{{TITLE}}", html_escape.escape(title)),
        ("{{ENCODING}}", "gzip+base64" if compress else "base64"),
        ("{{ATTRS}}", attrs),
        ("{{DATA}}", base64.b64encode(payload).decode("ascii")),
        ("{{RUNTIME}}", js),  # last, so nothing substitutes inside the runtime
    ):
        page = page.replace(key, value)
    return page


def write_html(path: str | Path, container: bytes, **kwargs: Any) -> Path:
    """Writes :func:`build_html` to ``path`` and returns it."""
    out = Path(path)
    out.write_text(build_html(container, **kwargs), encoding="utf-8")
    return out
