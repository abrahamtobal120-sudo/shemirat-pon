#!/usr/bin/env python3
"""Prepare an experimental iOS Safari project from the desktop extension."""

import json
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SOURCE = ROOT.parent / "shomer-web"
OUTPUT = ROOT / "dist"
EXTENSION = OUTPUT / "extension"


def main():
    if sys.platform != "darwin" or shutil.which("xcrun") is None:
        raise SystemExit("Se necesita macOS con Xcode y xcrun para generar el proyecto Safari.")
    if OUTPUT.exists():
        raise SystemExit(f"El directorio {OUTPUT} ya existe; consérvalo o muévelo antes de generar otro proyecto.")
    required = ("common", "content", "engine", "icons", "lib", "_locales", "models", "popup", "rules")
    OUTPUT.mkdir()
    for name in required:
        shutil.copytree(SOURCE / name, EXTENSION / name)
    shutil.copy2(SOURCE / "background.js", EXTENSION / "background.js")
    manifest = json.loads((SOURCE / "manifest.json").read_text(encoding="utf-8"))
    manifest.pop("minimum_chrome_version", None)
    (EXTENSION / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    subprocess.run(
        [
            "xcrun", "safari-web-extension-converter", str(EXTENSION),
            "--ios-only", "--no-open", "--no-prompt", "--copy-resources",
            "--project-location", str(OUTPUT),
            "--app-name", "Shomer Safari",
            "--bundle-identifier", "dev.shomer.Shomer-Safari",
        ],
        check=True,
    )
    print(f"Proyecto generado en {OUTPUT}. Revisa la compatibilidad y configura la firma en Xcode.")


if __name__ == "__main__":
    main()
