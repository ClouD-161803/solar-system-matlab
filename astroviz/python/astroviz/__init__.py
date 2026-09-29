"""astroviz: the visualization layer for astrodynamics data.

Python side: turns arrays (from PyDylan or anywhere else) into a binary
container and stamps it into a self-contained HTML page driven by the
browser runtime in ``astroviz/web``.
"""

from .container import Container, ContainerWriter
from .families import Family, add_er3bp_family, load_family_csv
from .html import build_html

__all__ = [
    "Container",
    "ContainerWriter",
    "Family",
    "add_er3bp_family",
    "load_family_csv",
    "build_html",
]
