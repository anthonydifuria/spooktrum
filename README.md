# 👻 SPOOKTRUM

> The Esoteric High-Res Spectrogram Engine

A browser-based spectrogram generator that transforms audio into ultra-high-resolution spectral art. Built with vanilla JavaScript, Web Audio API, and WebGL2 — no dependencies, no build tools, no nonsense.

![GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-green)

## ✦ Features

- **Ultra-high resolution output** — Full HD, 4K, 8K, or custom dimensions
- **GPU-accelerated rendering** — WebGL2 tiling engine handles massive images without crashing
- **Professional FFT controls** — Size (256–8192), window functions, overlap
- **Beautiful colormaps** — Grayscale, Viridis, Inferno, Magma, Plasma
- **Linear ↔ Logarithmic scale** — Smooth interpolation slider
- **All audio formats** — Whatever your browser can decode (WAV, MP3, FLAC, OGG...)
- **PNG export** — Download your spectrogram as a high-quality image

## ✦ Quick Start

No installation. No npm. No build step.

```bash
# Option 1: Python
python -m http.server 8000
# Open http://localhost:8000

# Option 2: VS Code / VSCodium
# Install "Live Server" extension
# Right-click index.html → "Open with Live Server"