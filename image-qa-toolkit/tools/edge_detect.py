"""
Edge and line detection using OpenCV.
Useful for UI layout analysis and element boundary detection.
"""
import cv2
import numpy as np


def detect_edges(image_path: str, output_path: str = None, low_thresh: int = 50, high_thresh: int = 150) -> np.ndarray:
    """Canny edge detection."""
    img = cv2.imread(image_path)
    if img is None:
        raise FileNotFoundError(f"Image not found: {image_path}")
    
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, low_thresh, high_thresh)
    
    if output_path:
        cv2.imwrite(output_path, edges)
    
    return edges


def detect_lines(image_path: str, output_path: str = None, min_length: int = 50, max_gap: int = 10) -> list:
    """Hough line transform for line detection."""
    img = cv2.imread(image_path)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 50, 150)
    
    lines = cv2.HoughLinesP(edges, 1, np.pi/180, threshold=50, 
                           minLineLength=min_length, maxLineGap=max_gap)
    
    if output_path and lines is not None:
        result = img.copy()
        for line in lines:
            x1, y1, x2, y2 = line[0]
            cv2.line(result, (x1, y1), (x2, y2), (0, 255, 0), 2)
        cv2.imwrite(output_path, result)
    
    return lines.tolist() if lines is not None else []


def detect_contours(image_path: str, output_path: str = None) -> list:
    """Contour detection for element boundaries."""
    img = cv2.imread(image_path)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    _, binary = cv2.threshold(gray, 127, 255, cv2.THRESH_BINARY)
    
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    
    if output_path:
        result = img.copy()
        cv2.drawContours(result, contours, -1, (0, 255, 0), 2)
        cv2.imwrite(output_path, result)
    
    return contours


def analyze_layout(image_path: str) -> dict:
    """
    Analyze UI layout: detect major structural elements.
    Returns bounding boxes of significant UI regions.
    """
    img = cv2.imread(image_path)
    h, w = img.shape[:2]
    
    # Edge detection
    edges = detect_edges(image_path)
    
    # Find contours
    contours = detect_contours(image_path)
    
    # Filter significant contours (large enough to be UI elements)
    significant = []
    for cnt in contours:
        x, y, w_c, h_c = cv2.boundingRect(cnt)
        area = w_c * h_c
        if area > (h * w * 0.001):  # At least 0.1% of image
            significant.append({"x": x, "y": y, "width": w_c, "height": h_c, "area": area})
    
    # Sort by area (largest first)
    significant.sort(key=lambda e: e["area"], reverse=True)
    
    return {
        "image_size": {"width": w, "height": h},
        "elements_detected": len(significant),
        "top_elements": significant[:10],
        "edge_density": float(np.mean(edges > 0))
    }


if __name__ == "__main__":
    import sys, json
    if len(sys.argv) < 2:
        print("Usage: python edge_detect.py <image_path> [--layout]")
        sys.exit(1)
    
    if "--layout" in sys.argv:
        layout = analyze_layout(sys.argv[1])
        print(json.dumps(layout, indent=2))
    else:
        edges = detect_edges(sys.argv[1], sys.argv[1].replace(".", "_edges.") if "." in sys.argv[1] else sys.argv[1] + "_edges")
        print(f"Edge detection complete")
