import zlib, struct, math, os

def write_png(path, size, pixels):
    """pixels: list of (r,g,b) rows top->bottom of size rows"""
    def chunk(t, data):
        c = t + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
    raw = b''
    for row in pixels:
        raw += b'\x00' + b''.join(struct.pack('BBB', r, g, b) for r, g, b in row)
    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 9))
    png += chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)

def render(size):
    bg_r, bg_g, bg_b = 10, 10, 12
    radius = size * 0.22
    cx, cy = size * 0.5, size * 0.46
    ri = size * 0.30
    c1 = (99, 108, 255)   # indigo
    c2 = (0, 172, 238)    # cyan
    c3 = (255, 96, 192)   # pink
    rows = []
    for y in range(size):
        row = []
        for x in range(size):
            # rounded rect background
            dx = max(abs(x - size/2) - (size/2 - radius), 0.0)
            dy = max(abs(y - size/2) - (size/2 - radius), 0.0)
            d = math.hypot(dx, dy)
            if d > radius:
                row.append((bg_r, bg_g, bg_b))
                continue
            # orb gradient
            dist = math.hypot(x - cx, y - cy) / ri
            t = min(dist, 1.0)
            top_center = math.hypot(x - cx, y - (cy - ri*0.75)) / (ri*0.75)
            r = int(c1[0] + (c2[0]-c1[0]) * min(top_center,1))
            g = int(c1[1] + (c2[1]-c1[1]) * min(top_center,1))
            b = int(c1[2] + (c2[2]-c1[2]) * min(top_center,1))
            # pink blend at bottom
            if y > cy + ri*0.15:
                fb = min((y - (cy + ri*0.15)) / (ri*0.85), 1)
                r = int(r + (c3[0]-r) * fb)
                g = int(g + (c3[1]-g) * fb)
                b = int(b + (c3[2]-b) * fb)
            if dist > 1:
                a = 1 - max(dist - 1, 0)
                a = min(max(a, 0), 1) * 0.9
                # outside orb, blend into bg
                r = int(bg_r + (r-bg_r)*a); g = int(bg_g + (g-bg_g)*a); b = int(bg_b + (b-bg_b)*a)
            row.append((r, g, b))
        rows.append(row)
    return rows

os.makedirs('icons', exist_ok=True)
write_png('icons/icon-512.png', 512, render(512))
write_png('icons/icon-192.png', 192, render(192))
write_png('icons/apple-touch-icon.png', 180, render(180))
print('done')