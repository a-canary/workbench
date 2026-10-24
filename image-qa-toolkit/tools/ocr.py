"""
OCR wrapper with multi-engine fallback.
Priority: qwen3.8-27B native -> PaddleOCR -> Tesseract
"""
import os
import subprocess


def ocr_paddle(image_path: str, lang: str = "en") -> str:
    """Use PaddleOCR for high-accuracy OCR."""
    try:
        from paddleocr import PaddleOCR
        ocr = PaddleOCR(use_angle_cls=True, lang=lang, use_gpu=False)
        result = ocr.ocr(image_path, cls=True)
        
        text_lines = []
        for line in result:
            if line:
                for word_info in line:
                    text, _ = word_info
                    text_lines.append(text)
        return "\n".join(text_lines)
    except ImportError:
        raise RuntimeError("paddleocr not installed. Run: pip install paddleocr paddlepaddle")


def ocr_tesseract(image_path: str, lang: str = "eng") -> str:
    """Use Tesseract as CPU fallback."""
    try:
        result = subprocess.run(
            ["tesseract", image_path, "stdout", "-l", lang],
            capture_output=True, text=True, timeout=30
        )
        return result.stdout.strip()
    except FileNotFoundError:
        raise RuntimeError("tesseract not installed. Run: apt install tesseract-ocr")


def ocr_vlm(image_path: str, prompt: str = "Extract all visible text from this image exactly as shown. Include button labels, headings, body text, and any other readable text. Do not add or omit text.") -> str:
    """
    Use qwen3.8-27B vision capability for OCR.
    Best for UI screenshots with mixed content.
    
    Requires OPENAI_API_KEY and OPENAI_BASE_URL set to qwen endpoint.
    """
    import base64
    from openai import OpenAI
    
    client = OpenAI()
    
    with open(image_path, "rb") as f:
        image_data = base64.b64encode(f.read()).decode()
    
    response = client.chat.completions.create(
        model="qwen3.8-27b",
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{image_data}"}}
                ]
            }
        ],
        max_tokens=2000
    )
    
    return response.choices[0].message.content.strip()


def ocr(image_path: str, engine: str = "vlm", lang: str = "en") -> str:
    """
    Unified OCR interface with engine selection.
    
    Args:
        image_path: Path to image file
        engine: "vlm" (qwen3.8-27B), "paddle", or "tesseract"
        lang: Language code
    
    Returns:
        Extracted text
    """
    if engine == "vlm":
        return ocr_vlm(image_path)
    elif engine == "paddle":
        return ocr_paddle(image_path, lang)
    elif engine == "tesseract":
        return ocr_tesseract(image_path, lang)
    else:
        raise ValueError(f"Unknown OCR engine: {engine}")


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: python ocr.py <image_path> [engine]")
        sys.exit(1)
    
    engine = sys.argv[2] if len(sys.argv) > 2 else "vlm"
    text = ocr(sys.argv[1], engine)
    print(text)
