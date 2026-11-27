import fs from "node:fs";
import { PMTiles } from "pmtiles";

const file = fs.openSync("data/buildings.pmtiles", "r");
const source = {
  getKey() {
    return "local-buildings";
  },
  getBytes(offset, length) {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(file, buf, 0, length, offset);
    return Promise.resolve({ data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + n) });
  },
};
const p = new PMTiles(source);
const header = await p.getHeader();
console.log("header:", { minZoom: header.minZoom, maxZoom: header.maxZoom, tiles: header.numTiles, addressedTiles: header.numAddressedTiles });

const lon = 37.62, lat = 55.75;
const n = 2 ** 15;
for (const z of [8, 9, 10, 11, 12, 13, 14, 15, 16]) {
  const scale = 2 ** (15 - z);
  const x = Math.floor(((lon + 180) / 360) * 2 ** z);
  const y = Math.floor((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2 * 2 ** z);
  try {
    const t = await p.getZxy(z, x, y);
    console.log(`z${z} x${x} y${y}:`, t ? (t.data.byteLength / 1024).toFixed(0) + " KB" : "empty");
  } catch (e) {
    console.log(`z${z}: err`, String(e).slice(0, 80));
  }
}
