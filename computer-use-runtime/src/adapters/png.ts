import { deflateSync } from "node:zlib";

export function bitmapChangedRegion(
  before: Buffer,
  after: Buffer,
): { x: number; y: number; width: number; height: number } | undefined {
  if (
    before.length !== after.length ||
    before.length < 54 ||
    before.toString("ascii", 0, 2) !== "BM" ||
    after.toString("ascii", 0, 2) !== "BM" ||
    !before.subarray(10, 34).equals(after.subarray(10, 34))
  )
    throw new Error(
      "Region comparison requires matching raw bitmap dimensions",
    );
  const width = after.readInt32LE(18),
    signedHeight = after.readInt32LE(22),
    height = Math.abs(signedHeight),
    offset = after.readUInt32LE(10);
  if (
    width < 1 ||
    height < 1 ||
    width > 8192 ||
    height > 8192 ||
    after.readUInt16LE(28) !== 32 ||
    after.readUInt32LE(30) !== 0 ||
    offset + width * height * 4 > after.length
  )
    throw new Error("Invalid bitmap region comparison");
  let left = width,
    right = -1,
    top = height,
    bottom = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at =
        offset + ((signedHeight < 0 ? y : height - 1 - y) * width + x) * 4;
      if (
        before[at] !== after[at] ||
        before[at + 1] !== after[at + 1] ||
        before[at + 2] !== after[at + 2]
      ) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
  return right < 0
    ? undefined
    : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

// The private Win32 bridge returns an uncompressed 32-bit BGR bitmap.
// Encode it as PNG for browser previews and local vision providers.
export function bitmapToPng(
  b: Buffer,
  crop?: { x: number; y: number; width: number; height: number },
): Buffer {
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    if (!crop) return b;
    else
      throw new Error("A scoped native crop requires the raw bitmap capture");
  if (
    b.length < 54 ||
    b.toString("ascii", 0, 2) !== "BM" ||
    b.readUInt16LE(28) !== 32 ||
    b.readUInt32LE(30) !== 0
  )
    throw new Error("Unsupported native screenshot format");
  const width = b.readInt32LE(18),
    signedHeight = b.readInt32LE(22),
    height = Math.abs(signedHeight),
    offset = b.readUInt32LE(10);
  if (
    width < 1 ||
    height < 1 ||
    width > 8192 ||
    height > 8192 ||
    offset + width * height * 4 > b.length
  )
    throw new Error("Invalid native screenshot dimensions");
  const region = crop || { x: 0, y: 0, width, height };
  if (
    Object.values(region).some((value) => !Number.isInteger(value)) ||
    region.x < 0 ||
    region.y < 0 ||
    region.width < 1 ||
    region.height < 1 ||
    region.x + region.width > width ||
    region.y + region.height > height
  )
    throw new Error("Native image crop escapes the captured target");
  const raw = Buffer.alloc((region.width * 3 + 1) * region.height);
  for (let y = 0; y < region.height; y++) {
    for (let x = 0; x < region.width; x++) {
      const src =
        offset +
        ((signedHeight < 0 ? region.y + y : height - 1 - region.y - y) * width +
          region.x +
          x) *
          4;
      const dst = y * (region.width * 3 + 1) + 1 + x * 3;
      raw[dst] = b[src + 2];
      raw[dst + 1] = b[src + 1];
      raw[dst + 2] = b[src];
    }
  }
  function chunk(type: string, data: Buffer) {
    const name = Buffer.from(type),
      payload = Buffer.concat([name, data]);
    let crc = 0xffffffff;
    for (const byte of payload) {
      crc ^= byte;
      for (let i = 0; i < 8; i++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4),
      checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, payload, checksum]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(region.width);
  header.writeUInt32BE(region.height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
