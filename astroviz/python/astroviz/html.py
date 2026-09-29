"""Builds a self-contained HTML page from a container and the runtime bundle.

The container bytes are gzip-compressed and base64-encoded into a script tag
of type ``application/octet-stream``; the browser runtime finds it through the
custom element's ``data`` attribute, decodes it with the native
``DecompressionStream`` and parses it with no library. The runtime itself is
inlined, so the resulting file works offline, from disk, inside an iframe on
a reveal.js slide, or anywhere else a single HTML file can go.
"""

from __future__ import annotations

import base64
import gzip
import html as html_escape
import json
from importlib import resources
from typing import Any


def _template() -> str:
    return resources.files(__package__).joinpath("template.html").read_text(encoding="utf-8")


def build_html(
    container: bytes,
    runtime_js: str,
    *,
    title: str,
    compress: bool = True,
    layout: dict[str, Any] | None = None,
    kiosk: bool = False,
) -> str:
    """Renders the page. ``layout`` is the viewer's saved-layout JSON (panels with
    frame and branch, the split tree, family) used as the initial layout; ``kiosk``
    hides the controls so the page embeds cleanly in a slide."""
    if "</script" in runtime_js.lower():
        raise ValueError("runtime bundle contains a closing script tag")
    payload = gzip.compress(container, compresslevel=6) if compress else container
    encoded = base64.b64encode(payload).decode("ascii")
    encoding = "gzip+base64" if compress else "base64"
    html = _template()
    html = html.replace("{{TITLE}}", title)
    html = html.replace("{{ENCODING}}", encoding)
    html = html.replace("{{DATA}}", encoded)
    html = html.replace("{{RUNTIME}}", runtime_js)
    attrs = ""
    if layout is not None:
        attrs += f' layout="{html_escape.escape(json.dumps(layout, separators=(",", ":")), quote=True)}"'
    if kiosk:
        attrs += " kiosk"
    html = html.replace("{{ATTRS}}", attrs)
    return html
