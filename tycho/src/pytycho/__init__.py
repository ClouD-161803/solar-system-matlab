"""pytycho: the Python side of Tycho, animated astrodynamics in a single HTML file.

Turns arrays (from PyDylan through :mod:`pytycho.adapters.pydylan`, or from
anywhere else as plain NumPy) into a Tycho data container (``.tyd``) and a
self-contained HTML page driven by the bundled browser runtime.
"""

from .container import Container, ContainerWriter
from .families import Family, Propagator, add_er3bp_family
from .html import build_html, runtime_js, write_html

__version__ = "0.1.0"

__all__ = [
    "Container",
    "ContainerWriter",
    "Family",
    "Propagator",
    "add_er3bp_family",
    "build_html",
    "runtime_js",
    "write_html",
    "__version__",
]
