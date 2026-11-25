"""Smoke tests using the actual bundled checkpoints (not stub predictions)."""
from __future__ import annotations

import io
import sys
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import app


def sample_jpeg() -> bytes:
    buffer = io.BytesIO()
    image = Image.new("RGB", (350, 260), (118, 134, 122))
    image.save(buffer, format="JPEG")
    return buffer.getvalue()


def test_model_metadata():
    with TestClient(app) as client:
        res = client.get("/api/health")
        assert res.status_code == 200
        assert res.json()["models_loaded"] == 3
        assert res.json()["device"] == "cpu"
        metadata = client.get("/api/models").json()["models"]
        assert {m["id"]: m["class_count"] for m in metadata} == {
            "asl": 26, "isl": 26, "everyday": 44
        }
        assert next(m for m in metadata if m["id"] == "isl")["image_size"] == 160


def test_all_real_models_can_predict():
    with TestClient(app) as client:
        for mode in ["asl", "isl", "everyday"]:
            response = client.post(
                "/api/predict",
                data={"mode": mode, "threshold": "0.70"},
                files={"file": ("sign.jpg", sample_jpeg(), "image/jpeg")},
            )
            assert response.status_code == 200, (mode, response.text)
            data = response.json()
            assert data["mode"] == mode
            assert data["image_saved"] is False
            assert len(data["top_predictions"]) == 3
            assert all(0 <= x["confidence"] <= 1 for x in data["top_predictions"])
            assert data["label"] == data["top_predictions"][0]["label"]


def test_bad_inputs():
    with TestClient(app) as client:
        invalid = client.post(
            "/api/predict",
            data={"mode": "invalid"},
            files={"file": ("sign.jpg", sample_jpeg(), "image/jpeg")},
        )
        assert invalid.status_code == 422
        bad_image = client.post(
            "/api/predict",
            data={"mode": "asl"},
            files={"file": ("bad.png", b"not an image", "image/png")},
        )
        assert bad_image.status_code == 400
        big_file = client.post(
            "/api/predict",
            data={"mode": "asl"},
            files={"file": ("bad.jpg", b"0" * (8 * 1024 * 1024 + 1), "image/jpeg")},
        )
        assert big_file.status_code == 413


def test_site_and_static_files():
    with TestClient(app) as client:
        assert client.get("/").status_code == 200
        assert 'SignBridge AI' in client.get("/").text
        assert client.get("/static/app.js").status_code == 200
        assert client.get("/static/styles.css").status_code == 200
