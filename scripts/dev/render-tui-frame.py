"""把 framegen 输出的 ANSI 帧渲染成 PNG（README 截图）。

用法（依赖 Pillow + fonttools；字体用 Windows 自带的 Cascadia Mono / 雅黑 / Segoe UI Symbol）：

    cd src/tui && go run ./cmd/framegen > /tmp/frame.ansi
    python scripts/dev/render-tui-frame.py /tmp/frame.ansi assets/tui.png
"""
import re
import sys
import unicodedata

from PIL import Image, ImageDraw, ImageFont
from fontTools.ttLib import TTFont

BG = "#1e1e2e"       # catppuccin bg（src/tui/internal/style/palette.go）
FG = "#cdd6f4"
SCALE = 2

# 覆盖优先级：ASCII/制表符用编程等宽字体；CJK 用雅黑；剩余符号用 Segoe UI Symbol。
FONT_FILES = [
    "C:/Windows/Fonts/CascadiaMono.ttf",
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/seguisym.ttf",
]

SGR = re.compile(r"\x1b\[([0-9;]*)m")


def parse_ansi(line, default_fg, default_bg):
    """返回 [(text, fg, bg, bold)]。"""
    spans = []
    fg, bg, bold = default_fg, None, False
    pos = 0
    for m in SGR.finditer(line):
        if m.start() > pos:
            spans.append((line[pos:m.start()], fg, bg, bold))
        codes = [int(c) for c in m.group(1).split(";") if c != ""]
        i = 0
        while i < len(codes):
            c = codes[i]
            if c == 0:
                fg, bg, bold = default_fg, None, False
            elif c == 1:
                bold = True
            elif c == 2:
                fg = "#6c7086"  # dim
            elif c == 22:
                bold = False
            elif c == 39:
                fg = default_fg
            elif c == 49:
                bg = None
            elif c == 7:
                fg, bg = (bg or default_bg), fg
            elif c == 27:
                fg, bg = default_fg, None
            elif c in (38, 48) and i + 1 < len(codes):
                if codes[i + 1] == 2 and i + 4 < len(codes):
                    r, g, b = codes[i + 2:i + 5]
                    color = f"#{r:02x}{g:02x}{b:02x}"
                    if c == 38:
                        fg = color
                    else:
                        bg = color
                    i += 4
                elif codes[i + 1] == 5 and i + 2 < len(codes):
                    i += 2
            i += 1
        pos = m.end()
    if pos < len(line):
        spans.append((line[pos:], fg, bg, bold))
    return spans


def is_wide(ch):
    return unicodedata.east_asian_width(ch) in ("W", "F")


def load_fonts(size):
    fonts = []
    for path in FONT_FILES:
        f = TTFont(path, fontNumber=0)
        cmap = f.getBestCmap()
        fonts.append((path, cmap, ImageFont.truetype(path, size)))
    return fonts


def pick(fonts, ch, bold, prefer_cjk):
    order = fonts[::-1] if prefer_cjk else fonts
    for path, cmap, font in order:
        if ord(ch) in cmap:
            return font, path
    return fonts[0][2], fonts[0][0]


def main(src, dst):
    raw = open(src, encoding="utf-8").read().splitlines()
    size = 15 * SCALE
    fonts = load_fonts(size)
    cell_w = round(fonts[0][2].getlength("M"))
    line_h = round(size * 1.45)
    pad = 14 * SCALE

    cols = max(
        sum(2 if is_wide(ch) else 1 for text, *_ in parse_ansi(line, FG, BG) for ch in text)
        for line in raw
    )
    width = cols * cell_w + pad * 2
    height = len(raw) * line_h + pad * 2

    img = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(img)

    for row, line in enumerate(raw):
        top = pad + row * line_h
        baseline = top + round(size * 1.05)
        col = 0
        for text, fg, bg, bold in parse_ansi(line, FG, BG):
            start = col
            if bg:
                for ch in text:
                    col += 2 if is_wide(ch) else 1
                draw.rectangle([pad + start * cell_w, top, pad + col * cell_w - 1, top + line_h - 2], fill=bg)
                col = start
            for ch in text:
                w = 2 if is_wide(ch) else 1
                if ch != " ":
                    font, _ = pick(fonts, ch, bold, is_wide(ch))
                    draw.text(
                        (pad + col * cell_w, baseline),
                        ch,
                        font=font,
                        fill=fg,
                        anchor="ls",
                        stroke_width=1 if bold else 0,
                        stroke_fill=fg,
                    )
                col += w

    img.save(dst)
    print(f"{dst}  {img.size[0]}x{img.size[1]}  cols={cols} lines={len(raw)}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
