#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -d .venv ]; then python3 -m venv .venv; fi
source .venv/bin/activate
if [ ! -f .venv/.installed ]; then
 python -m pip install --upgrade pip
 python -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
 python -m pip install -r requirements.txt
 touch .venv/.installed
fi
echo 'Open http://127.0.0.1:8000'
python -m uvicorn app:app --host 127.0.0.1 --port 8000
