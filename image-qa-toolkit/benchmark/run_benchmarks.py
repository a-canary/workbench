#!/usr/bin/env python3
"""
Real benchmark: install, run, and compare key UI QA tools.
Generates sample UI screenshots, runs each tool, measures speed and resource usage.
"""
import json
import os
import sys
import time
import tempfile
import subprocess
from dataclasses import dataclass, field
from typing import List, Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from PIL import Image, ImageDraw, ImageFont


@dataclass
class BenchmarkResult:
    tool: str
    category: str
    task: str
    elapsed_ms: float
    success: bool
    output_summary: str
    error: Optional[str] = None


def create_test_ui(path: str, variant: bool = False, size: tuple = (1200, 800)):
    """Create a realistic sample webUI screenshot."""
    img = Image.new("RGB", size, color=(255, 255, 255))
    draw = ImageDraw.Draw(img)
    
    # Header bar
    draw.rectangle([0, 0, size[0], 60], fill=(52, 73, 94))
    draw.text((20, 20), "Dashboard", fill=(255, 255, 255))
    draw.text((size[0]-120, 20), "User Menu", fill=(255, 255, 255))
    
    # Sidebar
    draw.rectangle([0, 60, 200, size[1]], fill=(236, 240, 241))
    items = ["Home", "Projects", "Tasks", "Reports", "Settings"]
    for i, item in enumerate(items):
        draw.text((20, 80 + i*30), item, fill=(44, 62, 80))
    
    # Main content area
    draw.text((220, 80), "Welcome back, User!", fill=(44, 62, 80))
    draw.text((220, 110), "Here's your activity summary for today", fill=(98, 112, 124))
    
    # Cards
    for i, (title, value) in enumerate([("Tasks", "12"), ("Messages", "5"), ("Alerts", "2")]):
        x = 220 + i * 300
        draw.rectangle([x, 150, x+280, 250], outline=(204, 204, 204), fill=(255, 255, 255))
        draw.text((x+20, 170), title, fill=(44, 62, 80))
        draw.text((x+20, 200), value, fill=(52, 152, 219))
    
    # Button (changes in variant)
    btn_color = (231, 76, 60) if variant else (52, 152, 219)
    btn_text = "New Action" if variant else "Primary Action"
    draw.rectangle([220, 280, 400, 320], fill=btn_color)
    draw.text((240, 295), btn_text, fill=(255, 255, 255))
    
    # Table-like structure
    for row in range(5):
        y = 360 + row * 40
        draw.line([220, y, 900, y], fill=(236, 240, 241))
        draw.text((230, y+10), f"Row {row+1} Item", fill=(44, 62, 80))
        draw.text((600, y+10), f"Status", fill=(98, 112, 124))
    
    img.save(path, "PNG")
    return img


def bench_image_diff():
    """Benchmark pixelmatch visual diff."""
    results = []
    tmpdir = tempfile.mkdtemp()
    
    baseline = os.path.join(tmpdir, "baseline.png")
    variant = os.path.join(tmpdir, "variant.png")
    diff_out = os.path.join(tmpdir, "diff.png")
    
    create_test_ui(baseline, variant=False)
    create_test_ui(variant, variant=True)
    
    # Run diff
    start = time.time()
    try:
        from tools.image_diff import diff_report
        report = diff_report(baseline, variant, diff_out)
        elapsed = (time.time() - start) * 1000
        results.append(BenchmarkResult(
            tool="pixelmatch (image_diff.py)",
            category="visual_regression",
            task="detect_diff",
            elapsed_ms=elapsed,
            success=True,
            output_summary=f"diff_ratio={report['diff_ratio']:.4f}, {report['different_pixels']} pixels changed, pass={report['pass']}"
        ))
    except Exception as e:
        elapsed = (time.time() - start) * 1000
        results.append(BenchmarkResult(
            tool="pixelmatch (image_diff.py)",
            category="visual_regression",
            task="detect_diff",
            elapsed_ms=elapsed,
            success=False,
            output_summary="",
            error=str(e)
        ))
    
    return results


def bench_opencv_edges():
    """Benchmark OpenCV edge detection."""
    results = []
    tmpdir = tempfile.mkdtemp()
    img_path = os.path.join(tmpdir, "ui.png")
    create_test_ui(img_path)
    
    # Edge detection
    start = time.time()
    try:
        from tools.edge_detect import detect_edges, analyze_layout
        edges = detect_edges(img_path)
        elapsed = (time.time() - start) * 1000
        import numpy as np
        edge_density = float(np.mean(edges > 0))
        results.append(BenchmarkResult(
            tool="OpenCV (Canny edges)",
            category="edge_detection",
            task="detect_edges",
            elapsed_ms=elapsed,
            success=True,
            output_summary=f"edge_density={edge_density:.4f}"
        ))
    except Exception as e:
        elapsed = (time.time() - start) * 1000
        results.append(BenchmarkResult(
            tool="OpenCV (Canny edges)",
            category="edge_detection",
            task="detect_edges",
            elapsed_ms=elapsed,
            success=False,
            error=str(e)
        ))
    
    # Layout analysis
    start = time.time()
    try:
        from tools.edge_detect import analyze_layout
        layout = analyze_layout(img_path)
        elapsed = (time.time() - start) * 1000
        results.append(BenchmarkResult(
            tool="OpenCV (layout analysis)",
            category="layout",
            task="analyze_layout",
            elapsed_ms=elapsed,
            success=True,
            output_summary=f"elements={layout['elements_detected']}, size={layout['image_size']}"
        ))
    except Exception as e:
        elapsed = (time.time() - start) * 1000
        results.append(BenchmarkResult(
            tool="OpenCV (layout analysis)",
            category="layout",
            task="analyze_layout",
            elapsed_ms=elapsed,
            success=False,
            error=str(e)
        ))
    
    return results


def bench_color_contrast():
    """Benchmark WCAG color contrast calculation."""
    results = []
    
    def contrast_ratio(c1, c2):
        """Calculate WCAG contrast ratio between two RGB colors."""
        def luminance(rgb):
            r, g, b = [x / 255.0 for x in rgb]
            r = r / 12.92 if r <= 0.04045 else ((r + 0.055) / 1.055) ** 2.4
            g = g / 12.92 if g <= 0.04045 else ((g + 0.055) / 1.055) ** 2.4
            b = b / 12.92 if b <= 0.04045 else ((b + 0.055) / 1.055) ** 2.4
            return 0.2126 * r + 0.7152 * g + 0.0722 * b
        
        l1 = luminance(c1)
        l2 = luminance(c2)
        lighter = max(l1, l2)
        darker = min(l1, l2)
        return (lighter + 0.05) / (darker + 0.05)
    
    # Test common UI color pairs
    test_pairs = [
        ("white on dark blue", (255, 255, 255), (52, 73, 94)),
        ("black on white", (0, 0, 0), (255, 255, 255)),
        ("light gray on white", (150, 150, 150), (255, 255, 255)),
        ("blue button text", (255, 255, 255), (52, 152, 219)),
    ]
    
    start = time.time()
    try:
        ratios = []
        for name, fg, bg in test_pairs:
            ratio = contrast_ratio(fg, bg)
            ratios.append((name, ratio))
        
        elapsed = (time.time() - start) * 1000
        summary = "; ".join([f"{n}: {r:.1f}:1" for n, r in ratios])
        results.append(BenchmarkResult(
            tool="WCAG contrast formula (built-in)",
            category="color_contrast",
            task="calculate_contrast",
            elapsed_ms=elapsed,
            success=True,
            output_summary=summary
        ))
    except Exception as e:
        elapsed = (time.time() - start) * 1000
        results.append(BenchmarkResult(
            tool="WCAG contrast formula",
            category="color_contrast",
            task="calculate_contrast",
            elapsed_ms=elapsed,
            success=False,
            error=str(e)
        ))
    
    return results


def bench_font_analysis():
    """Benchmark font analysis using fonttools."""
    results = []
    
    start = time.time()
    try:
        from fontTools.ttLib import TTFont
        # Find a system font
        import glob
        font_paths = glob.glob("/usr/share/fonts/**/*.ttf", recursive=True)
        if not font_paths:
            font_paths = glob.glob("/usr/share/fonts/**/*.otf", recursive=True)
        
        if font_paths:
            font = TTFont(font_paths[0])
            metrics = font["hhea"]
            units_per_em = font["head"].unitsPerEm
            ascent = metrics.ascent
            descent = metrics.descent
            
            elapsed = (time.time() - start) * 1000
            results.append(BenchmarkResult(
                tool="fonttools",
                category="typography",
                task="font_metrics",
                elapsed_ms=elapsed,
                success=True,
                output_summary=f"font={os.path.basename(font_paths[0])}, unitsPerEm={units_per_em}, ascent={ascent}, descent={descent}"
            ))
        else:
            results.append(BenchmarkResult(
                tool="fonttools",
                category="typography",
                task="font_metrics",
                elapsed_ms=(time.time() - start) * 1000,
                success=False,
                error="No system fonts found"
            ))
    except Exception as e:
        elapsed = (time.time() - start) * 1000
        results.append(BenchmarkResult(
            tool="fonttools",
            category="typography",
            task="font_metrics",
            elapsed_ms=elapsed,
            success=False,
            error=str(e)
        ))
    
    return results


def bench_image_dedup():
    """Benchmark image deduplication."""
    results = []
    tmpdir = tempfile.mkdtemp()
    
    # Create similar images
    img1 = os.path.join(tmpdir, "img1.png")
    img2 = os.path.join(tmpdir, "img2.png")
    img3 = os.path.join(tmpdir, "img3_different.png")
    
    create_test_ui(img1)
    create_test_ui(img2)  # Identical to img1
    create_test_ui(img3, variant=True, size=(800, 600))  # Different
    
    start = time.time()
    try:
        from imagededup.methods import PHash
        hasher = PHash()
        
        # Hash each image
        h1 = hasher.encode_image(img1)
        h2 = hasher.encode_image(img2)
        h3 = hasher.encode_image(img3)
        
        # Create encoding map {path: hash}
        encoding_map = {img1: h1, img2: h2, img3: h3}
        
        # Find duplicates
        duplicates = hasher.find_duplicates(encoding_map=encoding_map)
        elapsed = (time.time() - start) * 1000
        
        results.append(BenchmarkResult(
            tool="imagededup (pHash)",
            category="image_dedup",
            task="find_duplicates",
            elapsed_ms=elapsed,
            success=True,
            output_summary=f"3 images hashed, {len(duplicates)} duplicate groups found"
        ))
    except Exception as e:
        elapsed = (time.time() - start) * 1000
        results.append(BenchmarkResult(
            tool="imagededup (pHash)",
            category="image_dedup",
            task="find_duplicates",
            elapsed_ms=elapsed,
            success=False,
            output_summary="",
            error=str(e)
        ))
    
    return results


def main():
    print("=" * 70)
    print("Image QA Toolkit - Real Benchmarks")
    print("=" * 70)
    
    all_results = []
    
    print("\n[1/5] Visual Regression (pixelmatch)...")
    all_results.extend(bench_image_diff())
    
    print("[2/5] Edge Detection & Layout (OpenCV)...")
    all_results.extend(bench_opencv_edges())
    
    print("[3/5] Color Contrast (WCAG)...")
    all_results.extend(bench_color_contrast())
    
    print("[4/5] Font Analysis (fonttools)...")
    all_results.extend(bench_font_analysis())
    
    print("[5/5] Image Deduplication (imagededup)...")
    all_results.extend(bench_image_dedup())
    
    # Print results
    print("\n" + "=" * 70)
    print("RESULTS")
    print("=" * 70)
    
    for r in all_results:
        status = "✓" if r.success else "✗"
        print(f"\n{status} {r.tool} [{r.category}]")
        print(f"  Task: {r.task}")
        print(f"  Time: {r.elapsed_ms:.1f}ms")
        if r.output_summary:
            print(f"  Output: {r.output_summary}")
        if r.error:
            print(f"  Error: {r.error}")
    
    # Save results
    output_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "benchmark_results.json")
    results_json = [
        {
            "tool": r.tool,
            "category": r.category,
            "task": r.task,
            "elapsed_ms": round(r.elapsed_ms, 2),
            "success": r.success,
            "output_summary": r.output_summary,
            "error": r.error
        }
        for r in all_results
    ]
    
    with open(output_path, "w") as f:
        json.dump({"benchmarks": results_json, "timestamp": time.strftime("%Y-%m-%d %H:%M:%S")}, f, indent=2)
    
    print(f"\nResults saved to: {output_path}")
    
    # Summary
    total = len(all_results)
    passed = sum(1 for r in all_results if r.success)
    avg_time = sum(r.elapsed_ms for r in all_results) / total
    print(f"\nSummary: {passed}/{total} passed, avg time {avg_time:.1f}ms")


if __name__ == "__main__":
    main()
