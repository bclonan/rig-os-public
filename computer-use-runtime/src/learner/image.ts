import { inflateSync } from "node:zlib";

export type ImageCrop = { x: number; y: number; width: number; height: number };
function crc32(bytes: Buffer) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++)
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function paeth(a: number, b: number, c: number) {
  const p = a + b - c,
    x = Math.abs(p - a),
    y = Math.abs(p - b),
    z = Math.abs(p - c);
  return x <= y && x <= z ? a : y <= z ? b : c;
}

// Bounded RGB/RGBA PNG subset used by the native and Playwright capture ports.
// Unsupported palettes, bit depths and interlacing abstain instead of producing black pixels.
export function screenshotTensor(
  bytes: Buffer,
  crop?: ImageCrop,
): Float32Array {
  if (
    bytes.length > 16 * 1024 * 1024 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw new Error("Invalid or oversized learning screenshot");
  let width = 0,
    height = 0,
    channels = 0,
    ended = false;
  const compressed: Buffer[] = [];
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length) throw new Error("Truncated learning PNG");
    const length = bytes.readUInt32BE(offset),
      end = offset + 12 + length;
    if (end > bytes.length) throw new Error("Truncated learning PNG chunk");
    const name = bytes.toString("ascii", offset + 4, offset + 8),
      data = bytes.subarray(offset + 8, end - 4);
    if (
      crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)
    )
      throw new Error("Learning PNG checksum mismatch");
    if (name === "IHDR") {
      if (offset !== 8 || length !== 13 || width)
        throw new Error("Invalid learning PNG header");
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      channels = data[9] === 2 ? 3 : data[9] === 6 ? 4 : 0;
      if (
        !width ||
        !height ||
        width > 8192 ||
        height > 8192 ||
        (width * channels + 1) * height > 64 * 1024 * 1024 ||
        data[8] !== 8 ||
        !channels ||
        data[10] ||
        data[11] ||
        data[12]
      )
        throw new Error("Unsupported learning PNG encoding");
    } else if (name === "IDAT") {
      if (!width || ended) throw new Error("Invalid learning PNG ordering");
      compressed.push(data);
    } else if (name === "IEND") {
      if (length || end !== bytes.length)
        throw new Error("Invalid learning PNG trailer");
      ended = true;
    } else if (name[0] === name[0].toUpperCase())
      throw new Error("Unsupported critical learning PNG chunk");
    offset = end;
  }
  if (!ended || !compressed.length) throw new Error("Incomplete learning PNG");
  const stride = width * channels,
    expected = (stride + 1) * height;
  const filtered = inflateSync(Buffer.concat(compressed), {
    maxOutputLength: expected,
  });
  if (filtered.length !== expected)
    throw new Error("Invalid learning PNG scanlines");
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = filtered[y * (stride + 1)];
    if (filter > 4) throw new Error("Unsupported learning PNG filter");
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x,
        left = x >= channels ? raw[index - channels] : 0,
        above = y ? raw[index - stride] : 0,
        diagonal = y && x >= channels ? raw[index - stride - channels] : 0;
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? above
              : filter === 3
                ? Math.floor((left + above) / 2)
                : paeth(left, above, diagonal);
      raw[index] = (filtered[y * (stride + 1) + x + 1] + predictor) & 255;
    }
  }
  const region = crop || { x: 0, y: 0, width, height };
  if (
    Object.values(region).some((n) => !Number.isInteger(n)) ||
    region.x < 0 ||
    region.y < 0 ||
    region.width < 1 ||
    region.height < 1 ||
    region.x + region.width > width ||
    region.y + region.height > height
  )
    throw new Error("Learning crop escapes the captured target");
  const tensor = new Float32Array(3072);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) {
      const sx = region.x + Math.floor(((x + 0.5) * region.width) / 32),
        sy = region.y + Math.floor(((y + 0.5) * region.height) / 32);
      for (let channel = 0; channel < 3; channel++)
        tensor[channel * 1024 + y * 32 + x] =
          raw[(sy * width + sx) * channels + channel] / 255;
    }
  return tensor;
}
