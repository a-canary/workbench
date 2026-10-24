# Image/UI Analysis Toolset — Research Report

**Target platform:** qwen3.8-27B on NVIDIA V100 (16GB or 32GB VRAM)
**Use case:** WebUI/App QA — visual regression, accessibility, design quality, content verification

---

## 1. Image Compaction (Drop Repeated Pixels / Compression)

| Tool | Type | Pros | Cons | V100 fit |
|------|------|------|------|----------|
| **imagededup** (idealo) | Python lib | Exact + near-duplicate detection (perceptual hashes, CNN embeddings), easy API | CPU-bound, no GPU acceleration | ★★★★★ (CPU tool, runs alongside) |
| **pngquant** | CLI | 70-80% size reduction, lossy but high quality | PNG only | ★★★★★ |
| **squoosh** (Google) | Web/CLI | Multi-format, interactive, modern codecs (WebP, AVIF, JPEGXL) | Heavier, browser-based UX | ★★★★ |
| **zopfli** | CLI | Better DEFLATE compression than zlib | Slow, transparent-only | ★★★ |

**Recommendation:** `imagededup` for dedup + `pngquant` for compression. Both are CPU tools that don't compete for V100 VRAM.

---

## 2. OCR (Optical Character Recognition)

| Tool | Accuracy | Speed | GPU | Multilingual | V100 fit |
|------|----------|-------|-----|--------------|----------|
| **PaddleOCR** | ★★★★★ | ★★★★ | Yes (PyTorch) | 80+ languages | ★★★★★ |
| **EasyOCR** | ★★★★ | ★★★ | Yes (PyTorch) | 80+ languages | ★★★★ |
| **Tesseract** | ★★★ | ★★★★★ | No (CPU) | 100+ languages | ★★★ (CPU fallback) |
| **qwen3.8-27B native** | ★★★★ | ★★★★ | Yes | Good | ★★★★★ (no extra dep) |

**Recommendation:** Use qwen3.8-27B's native vision capability for OCR when possible (saves pipeline complexity). Add `PaddleOCR` as a dedicated high-accuracy fallback for document-heavy scenarios. Tesseract as CPU-only emergency fallback.

---

## 3. Visual Regression (img-diff)

| Tool | Type | Self-host | CI | GPU | V100 fit |
|------|------|-----------|-----|-----|----------|
| **pixelmatch** | JS lib | Yes | Easy | No | ★★★★ (simple, fast) |
| **Resemble.js** | JS lib | Yes | Easy | No | ★★★★ |
| **Argos CI** | Platform | Yes (Docker) | GitHub Action | No | ★★★★★ (full workflow) |
| **Touca** | Platform | Yes | CI/CD | No | ★★★★ (semantic diff) |
| **BackstopJS** | Framework | Yes | CI | No | ★★★ |
| **basset.io** | Platform | Yes | GitHub/Slack | No | ★★★★ |
| **Micoo** | Platform | Yes (Docker) | CI | No | ★★★★ |
| **jest-image-snapshot** | Jest matcher | Yes | Jest | No | ★★★ (React-specific) |

**Recommendation:** `pixelmatch` for lightweight pixel-level diffing in eval scripts. `Argos CI` for full end-to-end visual regression workflow if CI integration is needed.

---

## 4. Edge/Line Detection

| Tool | Type | GPU | Use case | V100 fit |
|------|------|-----|----------|----------|
| **OpenCV** (Python) | C++ lib | Yes (CUDA) | Canny edges, Hough lines, contours, all CV ops | ★★★★★ |
| **scipy.ndimage** | Python lib | No | Basic edge filters | ★★★ |
| **Pillow** | Python lib | No | Simple image ops | ★★★ |

**Recommendation:** `OpenCV` (cv2) with CUDA backend is the clear winner. Standard for all computer vision tasks, GPU-accelerated on V100.

---

## 5. AI-Generated Image Detection

| Tool/Dataset | Type | Notes |
|--------------|------|-------|
| **WildFake** | Dataset | Large-scale challenging AIGC detection dataset |
| **GenImage** | Dataset | Million-scale benchmark for AI-generated image detection |
| **awesome-aigc-image-detection** | Curated list | Comprehensive paper/dataset/tool collection |
| **EfficientNet/Xception-based detectors** | PyTorch models | Common architectures for forgery detection |
| **qwen3.8-27B native** | VLM | Can detect AI artifacts via prompt engineering |

**Recommendation:** For webUI QA, AI detection is low priority. Use qwen3.8-27B native capability. If dedicated detection needed, fine-tune a lightweight CNN on WildFake/GenImage.

---

## 6. Photo Forensics (Fake/Edited Detection)

| Tool | Type | Notes |
|------|------|-------|
| **Ghiro** | Desktop app | Automated digital image forensics, open source |
| **forensics.media** | Web tools | Browser-based forensics tools |
| **OpenCV + custom** | Library | Build custom forensic pipelines |

**Recommendation:** Low priority for webUI QA. `Ghiro` if manual forensics needed. Otherwise, skip.

---

## 7. WebUI/App QA Benchmarks

| Benchmark | Focus | Size | Source |
|-----------|-------|------|--------|
| **UICrit** | Design critique + quality ratings | 3,059 critiques, 983 mobile UIs | arxiv.org/abs/2407.08850 |
| **Web UI Benchmark** | UI prompt handling comparison | N/A | webuibench.dev |
| **MoUI / MoIT** | Mobile UI understanding + grounding | Instruction-tuning dataset | ACL 2025 |
| **ViLaBench** | General vision-language evaluation | Multi-task | Ant Research |
| **WebArena** | Web agent tasks | Multi-step web tasks | CMU |
| **Mind2Web** | Web task completion | 2,000+ real websites | CMU |

**Recommendation:** Use `UICrit` as primary design-quality benchmark. `Web UI Benchmark` for prompt comparison. Build custom eval set for specific QA scenarios.

---

## Architecture Decision: Steal/Adapt vs Build New

**Steal/Adapt (recommended):**
- `imagededup` → image deduplication
- `pngquant` → image compression
- `PaddleOCR` → dedicated OCR
- `pixelmatch` → pixel-level visual diff
- `OpenCV` → all CV operations (edges, lines, contours, color analysis)
- `UICrit` dataset → design quality benchmark

**Build new (thin layer only):**
- Integration wrapper that routes tasks to the right tool
- Eval benchmark specifically for webUI/app QA with qwen3.8-27B
- GPU resource manager to coordinate CPU tools vs V100-bound work

**Why not build from scratch?** All core CV/OCR/diff tasks have mature, well-tested OSS solutions. Building new would waste time and introduce bugs. The value-add is in integration and benchmarking.

---

## V100 Optimization Strategy

1. **VLM (qwen3.8-27B):** Runs on V100, handles high-level vision tasks (OCR, UI understanding, design critique, AI detection)
2. **CPU tools (imagededup, pngquant, pixelmatch):** Run in parallel on CPU cores, no VRAM competition
3. **OpenCV CUDA:** For heavy CV ops that benefit from GPU (video processing, large batch image analysis)
4. **PaddleOCR GPU:** Only when dedicated OCR accuracy needed, shares V100 with VLM (sequential)

**VRAM budget (16GB V100):**
- qwen3.8-27B (int8 quantized): ~14-15GB
- PaddleOCR: ~2-3GB (run separately, not concurrently)
- OpenCV CUDA: minimal overhead

---

## Next Steps

1. Create repo structure with tool integrations
2. Build eval benchmark using UICrit + custom UI QA scenarios
3. Write integration tests
4. Document V100 deployment steps
