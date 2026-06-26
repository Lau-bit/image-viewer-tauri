"""Generate a high-res (1024x1024) app icon source for the image viewer.

Drawn at 4x supersampling and downscaled with LANCZOS for smooth, crisp edges.
Run `npm run tauri icon icons/app-icon-source.png` afterwards to produce the
multi-resolution .ico + all PNG sizes.
"""
from PIL import Image, ImageDraw, ImageFilter

S = 4              # supersample factor
N = 1024           # final size
B = N * S          # working size

def p(v):
    return int(round(v * S))

img = Image.new("RGBA", (B, B), (0, 0, 0, 0))

# --- rounded app tile with a vertical blue gradient ---
top = (44, 160, 246)   # #2ca0f6
bot = (0, 86, 165)     # #0056a5
grad = Image.new("RGB", (1, B))
for y in range(B):
    t = y / (B - 1)
    grad.putpixel((0, y), (
        int(top[0] + (bot[0] - top[0]) * t),
        int(top[1] + (bot[1] - top[1]) * t),
        int(top[2] + (bot[2] - top[2]) * t),
    ))
grad = grad.resize((B, B))
tile_mask = Image.new("L", (B, B), 0)
ImageDraw.Draw(tile_mask).rounded_rectangle(
    [p(40), p(40), p(984), p(984)], radius=p(200), fill=255)
img.paste(grad, (0, 0), tile_mask)

# --- soft drop shadow under the photo card ---
shadow = Image.new("RGBA", (B, B), (0, 0, 0, 0))
ImageDraw.Draw(shadow).rounded_rectangle(
    [p(206), p(286), p(818), p(792)], radius=p(52), fill=(0, 30, 60, 110))
shadow = shadow.filter(ImageFilter.GaussianBlur(p(14)))
img = Image.alpha_composite(img, shadow)

# --- white photo card ---
ImageDraw.Draw(img).rounded_rectangle(
    [p(206), p(262), p(818), p(766)], radius=p(50), fill=(255, 255, 255, 255))

# --- photo content (sky, sun, mountains), clipped to a rounded rect ---
ix0, iy0, ix1, iy1 = 236, 292, 788, 736
iw, ih = p(ix1 - ix0), p(iy1 - iy0)

def ipt(x, y):
    return (p(x - ix0), p(y - iy0))

inner = Image.new("RGBA", (iw, ih), (0, 0, 0, 0))
ind = ImageDraw.Draw(inner)

# sky gradient
sky_top = (208, 236, 255)
sky_bot = (170, 214, 248)
for yy in range(ih):
    t = yy / (ih - 1)
    ind.line([(0, yy), (iw, yy)], fill=(
        int(sky_top[0] + (sky_bot[0] - sky_top[0]) * t),
        int(sky_top[1] + (sky_bot[1] - sky_top[1]) * t),
        int(sky_top[2] + (sky_bot[2] - sky_top[2]) * t),
        255,
    ))

# sun with soft glow
sx, sy = ipt(662, 386)
glow = Image.new("RGBA", (iw, ih), (0, 0, 0, 0))
ImageDraw.Draw(glow).ellipse(
    [sx - p(86), sy - p(86), sx + p(86), sy + p(86)], fill=(255, 214, 92, 150))
glow = glow.filter(ImageFilter.GaussianBlur(p(18)))
inner = Image.alpha_composite(inner, glow)
ind = ImageDraw.Draw(inner)
r = p(48)
ind.ellipse([sx - r, sy - r, sx + r, sy + r], fill=(255, 206, 72, 255))

# mountains (back lighter, front darker)
ind.polygon([ipt(ix0, iy1), ipt(430, 506), ipt(742, iy1)], fill=(122, 180, 226, 255))
ind.polygon([ipt(372, iy1), ipt(606, 560), ipt(ix1, iy1)], fill=(38, 118, 188, 255))

# clip to rounded corners and paste onto card
imask = Image.new("L", (iw, ih), 0)
ImageDraw.Draw(imask).rounded_rectangle(
    [0, 0, iw - 1, ih - 1], radius=p(30), fill=255)
img.paste(inner, (p(ix0), p(iy0)), imask)

out = img.resize((N, N), Image.LANCZOS)
out.save("src-tauri/icons/app-icon-source.png")
print("wrote src-tauri/icons/app-icon-source.png", out.size, out.mode)
