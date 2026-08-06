# -*- coding: utf-8 -*-
"""定位头像上半部(头部)里的嘴/眼。仅开发期估算用。"""
import sys
from PIL import Image

path = sys.argv[1] if len(sys.argv) > 1 else r"d:\项目\陪伴交流系统\my-ai-companion\demo\avatar.png"
img = Image.open(path).convert("RGB")
W, H = img.size
px = img.load()
CUT = int(H * 0.55)  # 只看上 55%（头部区域）

def is_skin(r, g, b):
    return r > 90 and g > 40 and b > 30 and r > g > b and (r - b) > 25

minx, miny, maxx, maxy = W, CUT, 0, 0
for y in range(0, CUT, 1):
    for x in range(0, W, 1):
        r, g, b = px[x, y]
        if is_skin(r, g, b):
            if x < minx: minx = x
            if x > maxx: maxx = x
            if y < miny: miny = y
            if y > maxy: maxy = y

print("head_skin_box: minx=%d miny=%d maxx=%d maxy=%d" % (minx, miny, maxx, maxy))
if maxx <= minx:
    print("NO_HEAD"); sys.exit(0)

# 在头部框内按行统计“暗色像素”(r,g,b 都低)，用来找眼线和嘴
def dark_score(x, y):
    r, g, b = px[x, y]
    return (r + g + b) < 300 and max(r, g, b) - min(r, g, b) < 60  # 近似灰暗

fh = maxy - miny
# 嘴：脸下半部；眼：脸上半部。按行统计暗像素数，找峰值
for label, y0, y1 in (("EYE", miny + int(fh*0.35), miny + int(fh*0.55)),
                      ("MOUTH", miny + int(fh*0.62), miny + int(fh*0.85))):
    best_row, best_n = -1, 0
    for y in range(y0, y1):
        n = sum(1 for x in range(minx, maxx, 2) if dark_score(x, y))
        if n > best_n:
            best_n, best_row = n, y
    print("%s: row=%d  n=%d  y_pct=%.1f%%" % (label, best_row, best_n, best_row / H * 100))

print("face_center_x_pct=%.1f%%" % (((minx + maxx) / 2) / W * 100))