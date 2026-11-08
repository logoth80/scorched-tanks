# Renders favicon.png + apple-touch-icon.png from the SAME geometry as
# favicon.svg (the game's player-1 red tank, 80-unit design space).
from PIL import Image, ImageDraw

def render(size):
    SS = 4
    S = size * SS / 80.0
    img = Image.new('RGBA', (size * SS, size * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    def rr(x, y, w, h, r, fill):
        d.rounded_rectangle([x * S, y * S, (x + w) * S, (y + h) * S], radius=r * S, fill=fill)
    def circ(cx, cy, r, fill):
        d.ellipse([(cx - r) * S, (cy - r) * S, (cx + r) * S, (cy + r) * S], fill=fill)
    # tracks + rivets
    rr(10, 53, 60, 15, 6, (34, 36, 42, 255))
    for k in (-24, -12, 0, 12, 24):
        circ(40 + k, 60.5, 4, (0, 0, 0, 89))
    # hull (player red)
    rr(13, 35, 54, 18, 6, (224, 69, 58, 255))
    # turret
    rr(31, 29, 24, 12, 4.5, (126, 31, 24, 255))
    # barrel at 60°, round caps
    d.line([40 * S, 41 * S, 61 * S, 4.6 * S], fill=(126, 31, 24, 255), width=int(round(8 * S)))
    circ(40, 41, 4, (126, 31, 24, 255))
    circ(61, 4.6, 4, (126, 31, 24, 255))
    return img.resize((size, size), Image.LANCZOS)

render(64).save('favicon.png')
render(180).save('apple-touch-icon.png')
print('ok')
