"""Genera el icono 1024x1024 de la app (sin transparencia, sin dependencias externas)."""
import struct
import sys
import zlib
from pathlib import Path

SIZE = 1024
SHIELD = [(.5, .14), (.82, .25), (.78, .58), (.5, .88), (.22, .58), (.18, .25)]
INNER = [(.5, .24), (.72, .32), (.69, .56), (.5, .78), (.31, .56), (.28, .32)]


def inside(x, y, poly):
    hit = False
    for i in range(len(poly)):
        (x1, y1), (x2, y2) = poly[i], poly[i - 1]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            hit = not hit
    return hit


def pixel(x, y):
    u, v = x / SIZE, y / SIZE
    top, bottom = (120, 186, 230), (24, 93, 141)
    bg = tuple(int(top[i] + (bottom[i] - top[i]) * v) for i in range(3))
    if inside(u, v, INNER):
        return (24, 93, 141)
    if inside(u, v, SHIELD):
        return (255, 255, 255)
    return bg


def main(path):
    rows = bytearray()
    for y in range(SIZE):
        rows.append(0)
        for x in range(SIZE):
            rows.extend(pixel(x + .5, y + .5))
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b"")
    Path(path).write_bytes(png)
    print("icono generado en", path)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "Sources/Assets.xcassets/AppIcon.appiconset/AppIcon.png")
