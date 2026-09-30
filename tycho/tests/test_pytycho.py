from __future__ import annotations

import base64
import gzip
import re

import numpy as np
import pytest

import pytycho
from pytycho.adapters.pydylan import family_from_pydylan, resample_hermite
from pytycho.families import frame_xy


def test_container_roundtrip():
    w = pytycho.ContainerWriter()
    a = np.arange(12, dtype=np.float32).reshape(3, 4)
    b = np.linspace(0, 1, 5)
    w.add_view("a", a)
    w.add_view("b", b)
    w.add_dataset({"id": "d", "kind": "test", "title": "t", "a": {"view": "a"}})
    data = w.to_bytes()
    assert data[:4] == b"TYCD"
    c = pytycho.Container(data)
    assert c.header["format"] == "tycho-data"
    np.testing.assert_array_equal(c.view("a"), a)
    np.testing.assert_array_equal(c.view("b"), b)
    assert c.datasets[0]["kind"] == "test"
    assert all(v["offset"] % 8 == 0 for v in c.header["views"].values())


def test_rejects_foreign_bytes():
    with pytest.raises(ValueError):
        pytycho.Container(b"ASTV" + bytes(16))


def test_frames_at_circular_limit():
    # e = 0: rotating equals rotating-pulsating; inertial is a rotation by f
    xy = np.array([[0.5, 0.2]])
    f = np.array([np.pi / 2])
    np.testing.assert_allclose(frame_xy(xy, f, 0.1, 0.0, "rotating"), xy)
    np.testing.assert_allclose(frame_xy(xy, f, 0.1, 0.0, "barycentric_inertial"), [[-0.2, 0.5]], atol=1e-12)
    # centred on the primary at (-mu, 0): shift before rotating
    np.testing.assert_allclose(frame_xy(xy, f, 0.1, 0.0, "inertial_primary"), [[-0.2, 0.6]], atol=1e-12)


def test_frames_pulsation():
    xy = np.array([[1.0, 0.0]])
    e = 0.5
    np.testing.assert_allclose(frame_xy(xy, np.array([0.0]), 0.0, e, "rotating"), [[1 - e, 0.0]])
    np.testing.assert_allclose(frame_xy(xy, np.array([np.pi]), 0.0, e, "rotating"), [[1 + e, 0.0]])


def test_hermite_resampling_is_exact_on_cubics():
    t = np.linspace(0, 2, 5)
    x = t**3
    states = np.column_stack([x, 0 * t, 0 * t, 3 * t**2, 0 * t, 0 * t])
    out = resample_hermite(t, states, np.array([0.3, 1.7]))
    np.testing.assert_allclose(out[:, 0], [0.3**3, 1.7**3], rtol=1e-12)


def test_family_from_pydylan(fake_family):
    fam = family_from_pydylan(fake_family)
    assert len(fam) == 2
    assert fam.initial_state.shape == (2, 6)
    np.testing.assert_allclose(fam.period, 2 * np.pi)


def test_export_family_end_to_end(fake_family, fake_propagator):
    fam = family_from_pydylan(fake_family)
    w = pytycho.ContainerWriter()
    pytycho.add_er3bp_family(w, "f7p", fam, title="f7p", group="family 7", branch="periapsis",
                             mu=0.012155, f0=0.0, propagate=fake_propagator, n_samples=120, n_dense=1500)
    c = pytycho.Container(w.to_bytes())
    d = c.datasets[0]
    pos = c.view(d["positions"]["view"])
    f = c.view(d["independent_variable"]["view"])
    assert pos.shape == (2, 120, 2) and f.shape == (2, 120)
    assert np.all(np.diff(f, axis=1) > 0)
    # members are periodic: the orbit closes on itself
    closure = c.view(d["closure_error"]["view"])
    assert np.all(closure < 1e-6), closure
    np.testing.assert_allclose(pos[:, 0], pos[:, -1], atol=1e-5)


def test_html_embeds_container():
    w = pytycho.ContainerWriter()
    w.add_view("a", np.ones(3, dtype=np.float32))
    data = w.to_bytes()
    page = pytycho.build_html(data, title="t <x>", runtime="/* runtime */", kiosk=True)
    assert "<tycho-viewer" in page and " kiosk" in page and "t &lt;x&gt;" in page
    blob = re.search(r'id="tycho-data" data-encoding="gzip\+base64">([^<]+)<', page).group(1)
    assert gzip.decompress(base64.b64decode(blob)) == data
    with pytest.raises(ValueError):
        pytycho.build_html(data, title="t", runtime="</script>")
