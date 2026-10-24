"""
Visual regression image diffing using numpy.
Lightweight pixel-level comparison for QA.
"""
from PIL import Image
import numpy as np
import io
import os


def images_equal(img1_path: str, img2_path: str, threshold: float = 0.1) -> bool:
    """Compare two images pixel-by-pixel. Returns True if within threshold."""
    img1 = np.array(Image.open(img1_path).convert("RGB"))
    img2 = np.array(Image.open(img2_path).convert("RGB"))
    
    if img1.shape != img2.shape:
        # Resize img2 to match img1
        img2_img = Image.open(img2_path).convert("RGB")
        img2_img = img2_img.resize(img1.shape[:2][::-1])
        img2 = np.array(img2_img)
    
    # Count pixels that differ (any channel diff > threshold*255)
    diff = np.abs(img1.astype(int) - img2.astype(int))
    different = np.any(diff > threshold * 255, axis=2)
    diff_pixels = np.sum(different)
    total_pixels = img1.shape[0] * img1.shape[1]
    diff_ratio = diff_pixels / total_pixels
    
    return diff_ratio < 0.001  # Less than 0.1% pixels different


def diff_report(img1_path: str, img2_path: str, output_path: str = None, threshold: float = 0.1) -> dict:
    """Generate detailed diff report between two images."""
    img1 = np.array(Image.open(img1_path).convert("RGB"))
    img2 = np.array(Image.open(img2_path).convert("RGB"))
    
    if img1.shape != img2.shape:
        img2_img = Image.open(img2_path).convert("RGB")
        img2_img = img2_img.resize(img1.shape[:2][::-1])
        img2 = np.array(img2_img)
    
    height, width = img1.shape[:2]
    total_pixels = width * height
    
    # Compute diff
    diff = np.abs(img1.astype(int) - img2.astype(int))
    different = np.any(diff > threshold * 255, axis=2)
    diff_pixels = int(np.sum(different))
    diff_ratio = diff_pixels / total_pixels
    
    if output_path:
        # Create diff image: red where different
        diff_img = np.zeros_like(img1)
        diff_img[different] = [255, 0, 0]
        Image.fromarray(diff_img).save(output_path)
    
    return {
        "dimensions": f"{width}x{height}",
        "total_pixels": total_pixels,
        "different_pixels": diff_pixels,
        "diff_ratio": diff_ratio,
        "threshold": threshold,
        "pass": diff_ratio < 0.001,
        "diff_image": output_path
    }


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 3:
        print("Usage: python image_diff.py <img1> <img2> [output_diff.png]")
        sys.exit(1)
    
    report = diff_report(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
    print(f"Diff ratio: {report['diff_ratio']:.4f} ({report['different_pixels']}/{report['total_pixels']})")
    print(f"Pass: {report['pass']}")
