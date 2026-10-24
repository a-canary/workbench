"""
WCAG color contrast checker.
Pure math implementation - no dependencies.
"""
from typing import Tuple


def luminance(rgb: Tuple[int, int, int]) -> float:
    """Calculate relative luminance of an RGB color (0-1)."""
    r, g, b = [x / 255.0 for x in rgb]
    r = r / 12.92 if r <= 0.04045 else ((r + 0.055) / 1.055) ** 2.4
    g = g / 12.92 if g <= 0.04045 else ((g + 0.055) / 1.055) ** 2.4
    b = b / 12.92 if b <= 0.04045 else ((b + 0.055) / 1.055) ** 2.4
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast_ratio(fg: Tuple[int, int, int], bg: Tuple[int, int, int]) -> float:
    """Calculate WCAG contrast ratio between foreground and background colors."""
    l1 = luminance(fg)
    l2 = luminance(bg)
    lighter = max(l1, l2)
    darker = min(l1, l2)
    return (lighter + 0.05) / (darker + 0.05)


def wcag_check(fg: Tuple[int, int, int], bg: Tuple[int, int, int]) -> dict:
    """
    Check WCAG compliance for a foreground/background color pair.
    
    Returns:
        dict with keys: aa, aa_large, aaa, aaa_large, ratio
    """
    ratio = contrast_ratio(fg, bg)
    return {
        "aa": ratio >= 4.5,
        "aa_large": ratio >= 3.0,
        "aaa": ratio >= 7.0,
        "aaa_large": ratio >= 4.5,
        "ratio": round(ratio, 1)
    }


def hex_to_rgb(hex_color: str) -> Tuple[int, int, int]:
    """Convert hex color string to RGB tuple."""
    hex_color = hex_color.lstrip('#')
    return (
        int(hex_color[0:2], 16),
        int(hex_color[2:4], 16),
        int(hex_color[4:6], 16)
    )


if __name__ == "__main__":
    import sys, json
    
    if len(sys.argv) >= 3:
        fg = hex_to_rgb(sys.argv[1])
        bg = hex_to_rgb(sys.argv[2])
        result = wcag_check(fg, bg)
        print(json.dumps(result, indent=2))
    else:
        print("Usage: python contrast.py <fg_hex> <bg_hex>")
        print("Example: python contrast.py #ffffff #34495e")
