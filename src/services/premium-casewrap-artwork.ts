import sharp from 'sharp';

export async function extendPremiumCasewrapArtwork(
  artwork: Buffer,
  size: number,
  panelWidth: number,
  panelHeight: number,
) {
  const width = Math.max(size, panelWidth);
  const height = Math.max(size, panelHeight);
  const left = Math.floor((width - size) / 2);
  const top = Math.floor((height - size) / 2);
  const last = size - 1;
  const channels = 3;
  const square = await sharp(artwork)
    .resize(size, size)
    .toColourspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer();
  const edges = Buffer.alloc(width * height * channels);

  // Seed the blur with boundary pixels only, including beneath the square that will mask it.
  for (let y = 0; y < height; y++) {
    const relativeY = y - top;
    const clampedY = Math.min(last, Math.max(0, relativeY));
    for (let x = 0; x < width; x++) {
      const relativeX = x - left;
      let edgeX = Math.min(last, Math.max(0, relativeX));
      let edgeY = clampedY;
      if (edgeX === relativeX && edgeY === relativeY) {
        if (Math.min(edgeX, last - edgeX) < Math.min(edgeY, last - edgeY)) {
          edgeX = edgeX < size / 2 ? 0 : last;
        } else {
          edgeY = edgeY < size / 2 ? 0 : last;
        }
      }
      const source = (edgeY * size + edgeX) * channels;
      const target = (y * width + x) * channels;
      edges[target] = square.readUInt8(source);
      edges[target + 1] = square.readUInt8(source + 1);
      edges[target + 2] = square.readUInt8(source + 2);
    }
  }

  const raw = { width, height, channels } as const;
  const panel = await sharp(edges, { raw })
    .blur(Math.max(0.3, size / 96))
    .raw()
    .toBuffer();
  for (let y = 0; y < size; y++) {
    square.copy(
      panel,
      ((top + y) * width + left) * channels,
      y * size * channels,
      (y + 1) * size * channels,
    );
  }

  return sharp(panel, { raw }).png().toBuffer();
}
