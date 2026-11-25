"""Real CPU inference for the three user-trained SignBridge AI checkpoints.

Images are processed in memory only; this module never saves uploaded frames.
"""
from __future__ import annotations

import json
import os
import threading
from dataclasses import dataclass
from pathlib import Path

import torch
from PIL import Image, ImageOps
from torchvision import models, transforms

ROOT = Path(__file__).resolve().parent
MODEL_DIR = ROOT / "models"

# Limit CPU contention on typical Windows laptops.
torch.set_num_threads(max(1, min(int(os.getenv("SIGNBRIDGE_CPU_THREADS", "4")), os.cpu_count() or 2)))


class SquarePad:
    """Match training: gray-pad to square *before* resizing."""

    def __call__(self, image: Image.Image) -> Image.Image:
        width, height = image.size
        side = max(width, height)
        left = (side - width) // 2
        top = (side - height) // 2
        return ImageOps.expand(
            image,
            (left, top, side - width - left, side - height - top),
            fill=(127, 127, 127),
        )


@dataclass(frozen=True)
class ModelSpec:
    slug: str
    display_name: str
    checkpoint: str
    labels_file: str
    metrics_file: str
    image_size: int
    description: str
    model_scope: str


SPECS = {
    "asl": ModelSpec(
        "asl", "ASL Alphabet", "asl_alphabet_best.pth", "asl_class_names.json",
        "asl_test_metrics.json", 224, "Recognize A–Z ASL fingerspelling images.",
        "26 alphabet classes; static-image classifier; not ASL sentence translation.",
    ),
    "isl": ModelSpec(
        "isl", "ISL Alphabet", "isl_alphabet_best.pth", "isl_class_names.json",
        "isl_test_metrics.json", 160, "Recognize A–Z ISL alphabet images.",
        "26 alphabet classes; CPU frozen-feature training; not signer-independent.",
    ),
    "everyday": ModelSpec(
        "everyday", "ISL Everyday Signs", "isl_everyday_best_fixed.pth",
        "isl_everyday_class_names.json", "isl_everyday_test_metrics.json", 224,
        "Recognize 44 trained ISL everyday words and phrases.",
        "44 classes, 42 represented in the original test set; no unseen-signer validation.",
    ),
}


class TorchSignClassifier:
    def __init__(self, spec: ModelSpec):
        self.spec = spec
        self.lock = threading.Lock()
        checkpoint_path = MODEL_DIR / spec.checkpoint
        labels_path = MODEL_DIR / spec.labels_file
        if not checkpoint_path.is_file() or not labels_path.is_file():
            raise FileNotFoundError(
                f"Model assets missing for {spec.slug}: {checkpoint_path} / {labels_path}"
            )

        # Safe loading: only tensors and simple checkpoint metadata are accepted.
        checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
        with labels_path.open(encoding="utf-8") as handle:
            class_names = json.load(handle)
        if class_names != checkpoint["class_names"]:
            raise ValueError(f"Class label mismatch for {spec.slug}")
        if len(set(class_names)) != len(class_names):
            raise ValueError(f"Duplicate class labels for {spec.slug}")
        if checkpoint.get("image_size", spec.image_size) != spec.image_size:
            raise ValueError(f"Input size differs from training for {spec.slug}")
        self.labels = class_names
        self.epoch = checkpoint.get("epoch")
        network = models.mobilenet_v3_small(weights=None)
        in_features = network.classifier[3].in_features
        network.classifier[3] = torch.nn.Linear(in_features, len(class_names))
        network.load_state_dict(checkpoint["model_state_dict"], strict=True)
        network.eval()
        self.model = network.to("cpu")

        self.transform = transforms.Compose([
            SquarePad(),
            transforms.Resize((spec.image_size, spec.image_size)),
            transforms.ToTensor(),
            transforms.Normalize(
                mean=[0.485, 0.456, 0.406],
                std=[0.229, 0.224, 0.225],
            ),
        ])
        with (MODEL_DIR / spec.metrics_file).open(encoding="utf-8") as handle:
            self.metrics = json.load(handle)

    def predict(self, image: Image.Image, top_k: int = 3) -> list[dict]:
        input_tensor = self.transform(image.convert("RGB")).unsqueeze(0)
        # Serialize CPU inference to prevent many webcam requests saturating a laptop.
        with self.lock, torch.inference_mode():
            scores = torch.softmax(self.model(input_tensor), dim=1).squeeze(0)
        values, indices = scores.topk(min(top_k, len(self.labels)))
        return [
            {"label": self.labels[int(i)], "confidence": round(float(v), 6)}
            for v, i in zip(values.tolist(), indices.tolist())
        ]

    def description(self) -> dict:
        accuracy = self.metrics["test_accuracy"]
        f1 = self.metrics.get("macro_f1", self.metrics.get("macro_f1_tested_classes"))
        return {
            "id": self.spec.slug,
            "name": self.spec.display_name,
            "description": self.spec.description,
            "scope": self.spec.model_scope,
            "classes": self.labels,
            "class_count": len(self.labels),
            "image_size": self.spec.image_size,
            "best_epoch": self.epoch,
            "test_accuracy": accuracy,
            "test_macro_f1": f1,
            "test_images": self.metrics["test_images"],
            "evaluation_note": self.metrics.get(
                "evaluation_note",
                self.metrics.get("evaluation_limitations", self.metrics.get("limitations", "")),
            ),
        }


class ModelRegistry:
    def __init__(self):
        self.models = {slug: TorchSignClassifier(spec) for slug, spec in SPECS.items()}

    def get(self, slug: str) -> TorchSignClassifier:
        return self.models[slug]

    def descriptions(self) -> list[dict]:
        return [self.models[slug].description() for slug in SPECS]
