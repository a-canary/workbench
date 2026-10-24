# Image QA Toolkit — Decision Guide

**Platform:** qwen3.8-27B on NVIDIA V100 (16GB or 32GB VRAM)
**Purpose:** WebUI/App QA — visual regression, accessibility, design quality, content verification

This is a reference for agents and drivers. For any image/UI QA task, find your task below and use the prescribed tool.

---

## Quick Reference Table

| Task | Tool | Install | Complexity |
|------|------|---------|------------|
| Visual regression (img-diff) | `tools/image_diff.py` (numpy) | `pip install pillow numpy` | Trivial |
| OCR / text extraction | `tools/ocr.py` (multi-engine) | `pip install paddleocr paddlepaddle` | Easy |
| Edge/line detection | `tools/edge_detect.py` (OpenCV) | `pip install opencv-python-headless` | Easy |
| Layout analysis | `tools/edge_detect.py --layout` | Same as above | Easy |
| Image deduplication | `imagededup` | `pip install imagededup` | Easy |
| Image compression | `pngquant` | `apt install pngquant` | Trivial |
| Color contrast (WCAG) | Built-in formula (`tools/contrast.py`) | None | Trivial |
| Font analysis | `fonttools` | `pip install fonttools` | Easy |
| Accessibility audit | `axe-core` + `pa11y` | `npm install axe-core pa11y` | Medium |
| Full page screenshot | `Playwright` | `pip install playwright` | Easy |
| Design quality critique | qwen3.8-27B vision | API call | Easy |
| AI image detection | qwen3.8-27B vision | API call | Easy |
| Photo forensics | `Ghiro` | `apt install ghiro` | Medium |
| Responsive testing | `Playwright` multi-viewport | Same as Playwright | Medium |
| Animation/video QA | `OpenCV` video capture | Same as OpenCV | Medium |
| UI performance profiling | `Lighthouse` | `npm install lighthouse` | Medium |

---

## When to Use LLM Vision (qwen3.8-27B) vs Dedicated Tools

| Use LLM Vision (qwen) When | Use Dedicated Tool When |
|---------------------------|------------------------|
| Need natural language explanation | Need precise numeric measurement |
| Design quality assessment | Pixel-perfect comparison |
| "Is this button visible?" | "How many pixels differ?" |
| "Does this UI look professional?" | "What's the WCAG contrast ratio?" |
| AI-generated image detection | Font metrics analysis |
| General UI understanding | Batch processing (speed) |
| Accessibility reasoning | Deterministic, reproducible results |
| Noisy/complex screenshots | Simple, well-defined tasks |

**Rule of thumb:** If you need a number or a binary pass/fail → dedicated tool. If you need an opinion or explanation → qwen3.8-27B.

---

## Task Category Deep-Dives

### 1. Visual Regression (img-diff)

**Use when:** Detecting unintended visual changes between two UI screenshots.

```bash
python tools/image_diff.py baseline.png variant.png diff_output.png
```

**Benchmark results (1200x800 PNG):**
- Time: 151.6ms
- Detected 7,412 different pixels (0.77% diff)
- Pass/fail threshold: 0.1% (configurable)

**Alternatives:**
- `pixelmatch` (Node.js) — faster for JS-based pipelines
- `Argos CI` — full CI/CD visual regression platform
- `Touca` — semantic visual diff (understands UI elements)

**Config tips:**
- Threshold 0.001 (0.1%) for strict pixel-perfect
- Threshold 0.01 (1%) for minor font rendering differences
- Always save diff image for visual inspection

### 2. OCR / Text Extraction

**Use when:** Verifying text content in screenshots, extracting labels/buttons.

```bash
# VLM-based (best for UI screenshots)
python tools/ocr.py screenshot.png

# PaddleOCR (highest accuracy, GPU)
python tools/ocr.py screenshot.png paddle

# Tesseract (CPU fallback, no GPU needed)
python tools/ocr.py screenshot.png tesseract
```

**Engine selection:**
- `vlm` (qwen3.8-27B): Best for mixed UI content, understands context
- `paddle`: Best for documents, high accuracy, 80+ languages
- `tesseract`: Fastest, CPU-only, 100+ languages

### 3. Edge Detection & Layout Analysis

**Use when:** Detecting UI element boundaries, analyzing layout structure.

```bash
# Edge detection
python tools/edge_detect.py screenshot.png

# Layout analysis (returns JSON with element bounding boxes)
python tools/edge_detect.py screenshot.png --layout
```

**Benchmark results (1200x800 PNG):**
- Canny edges: 35.2ms
- Layout analysis: 37.6ms

**What it detects:**
- Significant contours (>0.1% of image area)
- Bounding boxes of UI regions
- Edge density (useful for complexity metric)

### 4. Color Contrast (WCAG)

**Use when:** Verifying text/background contrast meets accessibility standards.

```python
from tools.contrast import contrast_ratio, wcag_check

# Calculate ratio
ratio = contrast_ratio((255, 255, 255), (52, 73, 94))  # 9.3:1

# Check WCAG compliance
result = wcag_check((255, 255, 255), (52, 73, 94))
# {'aa': True, 'aa_large': True, 'aaa': True, 'ratio': 9.3}
```

**WCAG standards:**
- AA normal text: 4.5:1
- AA large text: 3.0:1
- AAA normal text: 7.0:1
- AAA large text: 4.5:1

**Benchmark results:**
- Time: <1ms per check (pure math, no I/O)

### 5. Typography / Font Analysis

**Use when:** Analyzing font metrics, detecting font rendering issues.

```python
from fontTools.ttLib import TTFont

font = TTFont("/path/to/font.ttf")
head = font["head"]
hhea = font["hhea"]

print(f"Units per EM: {head.unitsPerEm}")
print(f"Ascent: {hhea.ascent}")
print(f"Descent: {hhea.descent}")
```

**Benchmark results:**
- Font loading + metrics: 20.2ms

### 6. Image Deduplication

**Use when:** Finding duplicate or near-duplicate screenshots in test runs.

```python
from imagededup.methods import PHash

hasher = PHash()
encoding_map = {
    "screenshot1.png": hasher.encode_image("screenshot1.png"),
    "screenshot2.png": hasher.encode_image("screenshot2.png"),
}
duplicates = hasher.find_duplicates(encoding_map=encoding_map)
```

**Benchmark results:**
- 3 images hashed + duplicate detection: 3,671ms (first run, model loading)
- Subsequent runs: ~100ms per image

### 7. Accessibility Auditing

**Use when:** Full WCAG accessibility compliance check.

```bash
# pa11y (CLI)
npx pa11y https://example.com

# axe-core (JavaScript)
npm install axe-core
# Inject into page and run
```

**Tools:**
- `axe-core` — most rules, deepest analysis (Deque)
- `pa11y` — CLI wrapper around axe-core + htmlcs
- `Lighthouse` — accessibility as part of overall audit

**LLM vision alternative:**
Ask qwen3.8-27B: "Analyze this UI screenshot for accessibility issues: missing alt text, poor contrast, small tap targets, unclear labels."

### 8. Responsive Design Testing

**Use when:** Testing UI across multiple viewport sizes.

```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch()
    viewports = [
        {"width": 375, "height": 667, "name": "iPhone SE"},
        {"width": 768, "height": 1024, "name": "iPad"},
        {"width": 1366, "height": 768, "name": "Laptop"},
        {"width": 1920, "height": 1080, "name": "Desktop"},
    ]
    
    for vp in viewports:
        page = browser.new_page(viewport=vp)
        page.goto("https://example.com")
        page.screenshot(path=f"screenshot_{vp['name']}.png")
```

### 9. Animation / Video Frame Analysis

**Use when:** Testing CSS animations, transitions, video playback.

```python
import cv2

# Capture frames from video
cap = cv2.VideoCapture("animation.mp4")
frames = []
while True:
    ret, frame = cap.read()
    if not ret:
        break
    frames.append(frame)

# Compare frames for motion detection
import numpy as np
for i in range(1, len(frames)):
    diff = np.abs(frames[i].astype(int) - frames[i-1].astype(int))
    motion = np.sum(diff > 30)
    print(f"Frame {i}: {motion} pixels changed")
```

### 10. AI-Generated Image Detection

**Use when:** Detecting if an image was AI-generated (Deepfake, diffusion models).

**LLM vision (qwen3.8-27B):**
```
"Analyze this image for signs of AI generation: inconsistent lighting, 
unnatural textures, warped text, anatomical errors, repetitive patterns.
Give a confidence score 0-100."
```

**Dedicated tools (if high accuracy needed):**
- Fine-tune a lightweight CNN on WildFake/GenImage datasets
- Use EfficientNet/Xception-based detectors

**Note:** For webUI QA, AI detection is low priority. Use LLM vision.

### 11. Photo Forensics

**Use when:** Detecting edited/forged images (not typically needed for UI QA).

**Tools:**
- `Ghiro` — automated digital image forensics (desktop app)
- `forensics.media` — browser-based tools

### 12. Design System Compliance

**Use when:** Verifying UI follows design system (spacing, colors, typography).

```python
# Check color usage against design system palette
def check_colors(screenshot_path, allowed_colors, tolerance=10):
    from PIL import Image
    import numpy as np
    
    img = np.array(Image.open(screenshot_path))
    colors = set()
    for row in img[::10, ::10]:  # Sample every 10th pixel
        for pixel in row:
            colors.add(tuple(pixel[:3]))
    
    violations = []
    for color in colors:
        if not any(
            abs(color[i] - allowed[i]) <= tolerance 
            for allowed in allowed_colors for i in range(3)
        ):
            violations.append(color)
    
    return violations
```

### 13. UI Performance Profiling

**Use when:** Measuring UI rendering performance.

```bash
# Lighthouse (Chrome DevTools-based)
npx lighthouse https://example.com --output=json --output-path=lighthouse.json
```

**Metrics to track:**
- First Contentful Paint (FCP)
- Largest Contentful Paint (LCP)
- Cumulative Layout Shift (CLS)
- First Input Delay (FID)
- Time to Interactive (TTI)

---

## V100 / qwen3.8-27B Optimization Notes

### VRAM Budget (16GB V100)
| Component | VRAM Usage | Notes |
|-----------|-----------|-------|
| qwen3.8-27B (int8) | 14-15 GB | Main VLM |
| PaddleOCR GPU | 2-3 GB | Run sequentially, not concurrent |
| OpenCV CUDA | <1 GB | Minimal overhead |

### Execution Strategy
1. **qwen3.8-27B on V100:** High-level vision tasks (understanding, critique, AI detection)
2. **CPU tools in parallel:** image_diff, contrast, fonttools, imagededup
3. **OpenCV CUDA:** Batch image processing, video analysis
4. **PaddleOCR GPU:** Only when dedicated OCR accuracy needed (sequential with VLM)

### When to Use Each GPU
- **V100:** qwen3.8-27B inference (primary workload)
- **CPU:** All lightweight tools (no GPU needed, faster to start)
- **V100 (sequential):** PaddleOCR when OCR accuracy matters more than speed

---

## Integration Examples for Agents/Drivers

### Example 1: Visual Regression Check
```python
from tools.image_diff import diff_report

report = diff_report("baseline.png", "current.png", "diff.png")
if report["pass"]:
    print("✓ No visual regression detected")
else:
    print(f"✗ Visual regression: {report['diff_ratio']:.2%} pixels changed")
    print(f"  Diff image: {report['diff_image']}")
    # Attach diff image to bug report
```

### Example 2: OCR Verification
```python
from tools.ocr import ocr

extracted = ocr("screenshot.png", engine="vlm")
expected = "Submit"
if expected.lower() in extracted.lower():
    print("✓ Button text verified")
else:
    print(f"✗ Expected '{expected}' in extracted text")
```

### Example 3: Accessibility Quick Check
```python
from tools.contrast import wcag_check

# Check header text contrast
result = wcag_check((255, 255, 255), (52, 73, 94))
if result["aa"]:
    print("✓ Meets WCAG AA")
else:
    print(f"✗ Fails WCAG AA (ratio: {result['ratio']}:1)")
```

### Example 4: Layout Analysis + LLM Review
```python
from tools.edge_detect import analyze_layout
import json

layout = analyze_layout("screenshot.png")
print(f"Detected {layout['elements_detected']} UI elements")

# Send to qwen for design review
prompt = f"""
Review this UI layout:
{json.dumps(layout, indent=2)}

Are the elements properly aligned? Is there good spacing?
Any design issues?
"""
# Call qwen3.8-27B with screenshot + prompt
```

---

## Benchmark Results Summary

| Tool | Category | Task | Time (ms) | Status |
|------|----------|------|-----------|--------|
| numpy image_diff | visual_regression | detect_diff | 151.6 | ✓ |
| OpenCV | edge_detection | detect_edges | 35.2 | ✓ |
| OpenCV | layout | analyze_layout | 37.6 | ✓ |
| WCAG formula | color_contrast | calculate_contrast | <1 | ✓ |
| fonttools | typography | font_metrics | 20.2 | ✓ |
| imagededup | image_dedup | find_duplicates | 3,671 | ✓ |

*All benchmarks run on 1200x800 PNG UI screenshots. imagededup includes model loading time (first run).*

---

## Research & Tool Selection

Full research report comparing 30+ OSS tools: [RESEARCH.md](RESEARCH.md)

**Key decisions:**
- **Steal/adapt, don't build:** All core CV/OCR/diff tasks have mature OSS solutions
- **LLM vision for understanding, dedicated tools for measurement**
- **CPU tools for speed, V100 for VLM inference**
- **Multi-engine OCR with fallback chain**
