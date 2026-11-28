import { BufferGeometry, Float32BufferAttribute, MathUtils, Texture, Vector3 } from "three";

export function landMarkers(geometry: BufferGeometry, map: Texture, count: number) {
  const canvas = document.createElement("canvas");
  const image = map.image as HTMLImageElement | ImageBitmap;
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;

  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const positions = geometry.getAttribute("position");
  const uv = geometry.getAttribute("uv");
  const index = geometry.getIndex();
  const triangleCount = Math.floor((index?.count ?? positions.count) / 3);
  const vertex = (offset: number) => index?.getX(offset) ?? offset;
  const cumulativeArea = new Float64Array(triangleCount);
  const a = new Vector3(), b = new Vector3(), c = new Vector3(), edge = new Vector3();
  let area = 0;

  for (let triangle = 0; triangle < triangleCount; triangle++) {
    const offset = triangle * 3;
    a.fromBufferAttribute(positions, vertex(offset));
    b.fromBufferAttribute(positions, vertex(offset + 1));
    c.fromBufferAttribute(positions, vertex(offset + 2));
    area += b.sub(a).cross(c.sub(a)).length() / 2;
    cumulativeArea[triangle] = area;
  }

  if (!area) return null;
  const points: number[] = [];
  const seeds: number[] = [];
  for (let attempt = 0; seeds.length < count && attempt < count * 100; attempt++) {
    const ticket = Math.random() * area;
    let lo = 0;
    let hi = triangleCount - 1;
    while (lo < hi) {
      const middle = Math.floor((lo + hi) / 2);
      if (cumulativeArea[middle] <= ticket) lo = middle + 1;
      else hi = middle;
    }

    const i = vertex(lo * 3), j = vertex(lo * 3 + 1), k = vertex(lo * 3 + 2);
    const r = Math.sqrt(Math.random());
    const t = Math.random();
    const wa = 1 - r, wb = r * (1 - t), wc = r * t;
    const u = uv.getX(i) * wa + uv.getX(j) * wb + uv.getX(k) * wc;
    const v = uv.getY(i) * wa + uv.getY(j) * wb + uv.getY(k) * wc;
    const col = MathUtils.clamp(Math.floor(u * canvas.width), 0, canvas.width - 1);
    const row = MathUtils.clamp(Math.floor((map.flipY ? 1 - v : v) * canvas.height), 0, canvas.height - 1);
    const pixel = (row * canvas.width + col) * 4;
    const [red, green, blue] = pixels.subarray(pixel, pixel + 3);
    if (blue > red + 6 && blue > green + 6) continue;

    a.fromBufferAttribute(positions, i);
    b.fromBufferAttribute(positions, j);
    c.fromBufferAttribute(positions, k);
    // Positions are local to the mesh so the point cloud inherits its scale and tilt.
    edge.copy(a).multiplyScalar(wa).addScaledVector(b, wb).addScaledVector(c, wc).multiplyScalar(1.012);
    points.push(edge.x, edge.y, edge.z);
    seeds.push(Math.random());
  }

  const markers = new BufferGeometry();
  markers.setAttribute("position", new Float32BufferAttribute(points, 3));
  markers.setAttribute("seed", new Float32BufferAttribute(seeds, 1));
  return markers;
}
