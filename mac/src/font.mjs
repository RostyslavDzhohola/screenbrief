// A tiny 5x7 bitmap font for burning frame captions into the contact sheet.
// (This ffmpeg build has no drawtext filter, so captions are rendered here as raw
// grayscale strips and stacked under each thumbnail by ffmpeg.)

const G = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  '#': ['01010', '01010', '11111', '01010', '11111', '01010', '01010'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  f: ['00110', '01001', '01000', '11100', '01000', '01000', '01000'],
};

export function textWidth(text, scale) {
  return text.length * 6 * scale - scale;
}

/**
 * Render `text` into a width x height 8-bit gray buffer (light text on dark),
 * left-padded, vertically centred. Unknown characters render as blanks.
 */
export function renderLabel(text, width, height, { scale = 2, fg = 235, bg = 32, padX = 6 } = {}) {
  const buf = Buffer.alloc(width * height, bg);
  const glyphH = 7 * scale;
  const y0 = Math.max(0, Math.floor((height - glyphH) / 2));
  let x = padX;
  for (const ch of text) {
    const g = G[ch] || G[' '];
    for (let gy = 0; gy < 7; gy++) {
      for (let gx = 0; gx < 5; gx++) {
        if (g[gy][gx] !== '1') continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const px = x + gx * scale + sx;
            const py = y0 + gy * scale + sy;
            if (px >= 0 && px < width && py >= 0 && py < height) buf[py * width + px] = fg;
          }
        }
      }
    }
    x += 6 * scale;
    if (x >= width) break;
  }
  return buf;
}
