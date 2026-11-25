"""SignBridge AI - local-first, CPU-capable assistive web application."""
from __future__ import annotations

import io
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps, UnidentifiedImageError

from inference import ModelRegistry, SPECS

ROOT = Path(__file__).resolve().parent
MAX_UPLOAD_BYTES = 8 * 1024 * 1024
MAX_IMAGE_PIXELS = 16_000_000
Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS

log = logging.getLogger("signbridge")


@asynccontextmanager
async def lifespan(application: FastAPI):
    application.state.registry = ModelRegistry()  # Load real weights exactly once.
    log.info("Loaded ASL, ISL alphabet, and ISL everyday checkpoints")
    yield
    application.state.registry = None


app = FastAPI(
    title="SignBridge AI",
    version="1.0.0",
    description="CPU-based sign-image recognition using three trained checkpoints.",
    lifespan=lifespan,
    docs_url="/api/docs",
    redoc_url=None,
)
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")


@app.middleware("http")
async def privacy_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store" if request.url.path.startswith("/api/") else "no-cache"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Permissions-Policy"] = "camera=(self), microphone=()"
    return response


@app.get("/", include_in_schema=False)
async def home():
    return FileResponse(ROOT / "templates" / "index.html")


@app.get("/api/health")
async def health(request: Request):
    registry = request.app.state.registry
    return {"status": "ready", "models_loaded": len(registry.models), "device": "cpu", "images_stored": False}


@app.get("/api/models")
async def models(request: Request):
    return {"models": request.app.state.registry.descriptions()}


def decode_image(blob: bytes) -> Image.Image:
    """Validate image bytes without writing to disk or trusting file extensions."""
    try:
        with Image.open(io.BytesIO(blob)) as opened:
            if opened.format not in {"JPEG", "PNG", "WEBP", "BMP"}:
                raise HTTPException(status_code=415, detail="Use JPEG, PNG, WEBP or BMP images.")
            width, height = opened.size
            if width * height > MAX_IMAGE_PIXELS:
                raise HTTPException(status_code=413, detail="Image dimensions are too large (max 16 MP).")
            opened.verify()

        with Image.open(io.BytesIO(blob)) as opened:
            image = ImageOps.exif_transpose(opened).convert("RGB")
            # Keep memory bounded; preserves aspect ratio, pads later.
            image.thumbnail((2048, 2048), Image.Resampling.LANCZOS)
            return image
    except HTTPException:
        raise
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError, Image.DecompressionBombError) as exc:
        raise HTTPException(status_code=400, detail="Image could not be read. Try a clear JPG or PNG.") from exc


@app.post("/api/predict")
async def predict(
    request: Request,
    file: UploadFile = File(...),
    mode: str = Form("asl"),
    threshold: float = Form(0.70),
):
    if mode not in SPECS:
        raise HTTPException(status_code=422, detail="Choose asl, isl, or everyday.")
    if not (0.0 <= threshold <= 1.0):
        raise HTTPException(status_code=422, detail="Threshold must be between 0 and 1.")

    try:
        blob = await file.read(MAX_UPLOAD_BYTES + 1)
    finally:
        await file.close()
    if not blob:
        raise HTTPException(status_code=400, detail="The image is empty.")
    if len(blob) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Image exceeds 8 MB. Choose a smaller image.")
    image = await run_in_threadpool(decode_image, blob)
    classifier = request.app.state.registry.get(mode)
    predictions = await run_in_threadpool(classifier.predict, image)
    top = predictions[0]
    return {
        "mode": mode,
        "label": top["label"],
        "confidence": top["confidence"],
        "above_threshold": top["confidence"] >= threshold,
        "threshold": threshold,
        "top_predictions": predictions,
        "note": "Confidence is an uncalibrated model score, not proof that a hand sign is present.",
        "image_saved": False,
    }


@app.exception_handler(Exception)
async def unexpected_error(_request: Request, exc: Exception):
    log.exception("Request failed without image logging: %s", type(exc).__name__)
    return JSONResponse(status_code=500, content={"detail": "Prediction failed. Check server logs."})
