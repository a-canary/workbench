#!/usr/bin/env python3
"""
Example: Run a complete webUI QA evaluation.

Generates sample UI screenshots, runs visual regression + OCR + layout analysis.
"""
import json
import os
import tempfile
from PIL import Image, ImageDraw, ImageFont
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def create_sample_ui(path: str, variant: bool = False):
    """Create a sample webUI screenshot."""
    img = Image.new("RGB", (1200, 800), color=(255, 255, 255))
    draw = ImageDraw.Draw(img)
    
    # Header
    draw.rectangle([0, 0, 1200, 60], fill=(52, 73, 94))
    draw.text((20, 20), "Dashboard", fill=(255, 255, 255))
    
    # Sidebar
    draw.rectangle([0, 60, 200, 800], fill=(236, 240, 241))
    draw.text((20, 80), "Home", fill=(44, 62, 80))
    draw.text((20, 110), "Settings", fill=(44, 62, 80))
    draw.text((20, 140), "Profile", fill=(44, 62, 80))
    
    # Main content
    draw.text((220, 80), "Welcome back, User!", fill=(44, 62, 80))
    draw.text((220, 120), "Here's your activity summary", fill=(44, 62, 80))
    
    # Card
    draw.rectangle([220, 160, 520, 300], outline=(204, 204, 204), fill=(255, 255, 255))
    draw.text((240, 180), "Tasks", fill=(44, 62, 80))
    draw.text((240, 210), "12 completed", fill=(46, 204, 113))
    
    if variant:
        # Variant: changed button color and text
        draw.rectangle([220, 320, 380, 360], fill=(231, 76, 60))
        draw.text((240, 335), "New Button", fill=(255, 255, 255))
    else:
        draw.rectangle([220, 320, 380, 360], fill=(52, 152, 219))
        draw.text((240, 335), "Original Button", fill=(255, 255, 255))
    
    img.save(path)


def main():
    print("=" * 60)
    print("WebUI QA Evaluation Demo")
    print("=" * 60)
    
    tmpdir = tempfile.mkdtemp()
    
    # Create sample screenshots
    baseline_path = os.path.join(tmpdir, "baseline.png")
    variant_path = os.path.join(tmpdir, "variant.png")
    diff_path = os.path.join(tmpdir, "diff.png")
    
    create_sample_ui(baseline_path, variant=False)
    create_sample_ui(variant_path, variant=True)
    
    print(f"\nBaseline: {baseline_path}")
    print(f"Variant:  {variant_path}")
    
    # 1. Visual Regression
    print("\n--- 1. Visual Regression ---")
    from tools.image_diff import diff_report
    report = diff_report(baseline_path, variant_path, diff_path)
    print(f"Diff ratio: {report['diff_ratio']:.4f}")
    print(f"Different pixels: {report['different_pixels']}/{report['total_pixels']}")
    print(f"Pass (threshold 0.001): {report['pass']}")
    
    # 2. Layout Analysis
    print("\n--- 2. Layout Analysis ---")
    from tools.edge_detect import analyze_layout
    layout = analyze_layout(baseline_path)
    print(f"Image size: {layout['image_size']}")
    print(f"Elements detected: {layout['elements_detected']}")
    print(f"Edge density: {layout['edge_density']:.4f}")
    
    # 3. OCR (CPU fallback for demo)
    print("\n--- 3. OCR (Tesseract) ---")
    try:
        from tools.ocr import ocr_tesseract
        text = ocr_tesseract(baseline_path)
        print(f"Extracted text: {text[:200]}")
    except Exception as e:
        print(f"Tesseract not available: {e}")
        print("Use qwen3.8-27B for VLM-based OCR in production.")
    
    print(f"\nDiff image saved to: {diff_path}")
    print("\nDemo complete.")


if __name__ == "__main__":
    main()
