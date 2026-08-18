"""
Element Screenshot Example

This example demonstrates capturing screenshots of UI elements and performing OCR.

Requirements:
    pip install Pillow
"""

import asyncio
try:
    from PIL import Image
except ImportError:
    print("Please install Pillow: pip install Pillow")
    exit(1)
import terminator


async def main():
    desktop = terminator.Desktop()

    locator = desktop.locator("role:Button")
    try:
        window = await locator.first()
        print("Capturing screenshot...\n")
        screenshot = window.capture()
        print(
            f"Screenshot dimensions: {screenshot.width}x{screenshot.height}, data length: {len(screenshot.image_data)}\n"
        )

        print("Converting screenshot to PIL Image...")
        image = Image.frombytes(
            "RGBA", (screenshot.width, screenshot.height), screenshot.image_data
        )
        print("Saving screenshot to screenshot.png\n")
        image.save("screenshot.png")

        print("Performing OCR on screenshot...")
        text = await desktop.ocr_screenshot(screenshot)
        print("OCR result:\n")
        print(text)

    except Exception as e:
        print("Error:", str(e))


if __name__ == "__main__":
    asyncio.run(main())
