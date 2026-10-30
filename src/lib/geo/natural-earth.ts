/**
 * Tiny, dependency-free Natural Earth (I) map projection — the rounded,
 * gently-curved world projection used by the landing Buyer World Map. Ported
 * from d3-geo-projection's published polynomial so we don't have to pull in
 * d3-geo just to draw a static choropleth (matches the house "inline SVG, no
 * chart library" convention).
 *
 * `createProjection` fits the whole globe into a viewBox and returns a
 * `project(lon, lat) -> [x, y]` in that viewBox's pixel space. Both the country
 * polygons AND the city dots go through the same instance, so they always
 * align. The fit is computed analytically from a coarse lon/lat grid, so it's
 * stable regardless of which country features happen to have loaded — a dot can
 * be placed before the geometry file arrives.
 */

/** Raw Natural Earth I forward transform. Inputs in DEGREES. */
function naturalEarth1Raw(lonDeg: number, latDeg: number): [number, number] {
  const l = (lonDeg * Math.PI) / 180;
  const p = (latDeg * Math.PI) / 180;
  const p2 = p * p;
  const p4 = p2 * p2;
  const x =
    l *
    (0.8707 -
      0.131979 * p2 +
      p4 * (-0.013791 + p4 * (0.003971 * p2 - 0.001529 * p4)));
  const y =
    p *
    (1.007226 +
      p2 * (0.015085 + p4 * (-0.044475 + 0.028874 * p2 - 0.005916 * p4)));
  return [x, y];
}

export interface Projection {
  /** Project a lon/lat (degrees) to viewBox pixel coordinates. */
  project: (lon: number, lat: number) => [number, number];
  width: number;
  height: number;
}

export function createProjection(
  width: number,
  height: number,
  pad = 8,
): Projection {
  // Analytic bounds of the raw transform over the full globe, from a coarse
  // grid (extremes sit on the frame + poles; 5° sampling is more than enough).
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let lon = -180; lon <= 180; lon += 5) {
    for (let lat = -90; lat <= 90; lat += 5) {
      const [rx, ry] = naturalEarth1Raw(lon, lat);
      if (rx < minX) minX = rx;
      if (rx > maxX) maxX = rx;
      if (ry < minY) minY = ry;
      if (ry > maxY) maxY = ry;
    }
  }

  const s = Math.min(
    (width - 2 * pad) / (maxX - minX),
    (height - 2 * pad) / (maxY - minY),
  );
  const drawnW = (maxX - minX) * s;
  const drawnH = (maxY - minY) * s;
  const tx = pad + (width - 2 * pad - drawnW) / 2;
  const ty = pad + (height - 2 * pad - drawnH) / 2;

  const project = (lon: number, lat: number): [number, number] => {
    const [rx, ry] = naturalEarth1Raw(lon, lat);
    // Y is flipped: raw +y is north, SVG +y is down.
    return [tx + (rx - minX) * s, ty + (maxY - ry) * s];
  };

  return { project, width, height };
}

/**
 * Build an SVG path `d` string for a GeoJSON Polygon/MultiPolygon geometry,
 * projecting each vertex. Rings are drawn as closed subpaths.
 */
export function geometryToPath(
  geometry: { type: string; coordinates: unknown },
  project: (lon: number, lat: number) => [number, number],
): string {
  const ringToPath = (ring: number[][]): string => {
    if (ring.length === 0) return "";
    let d = "";
    for (let i = 0; i < ring.length; i++) {
      const [lon, lat] = ring[i];
      const [x, y] = project(lon, lat);
      d += `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    }
    return d + "Z";
  };

  if (geometry.type === "Polygon") {
    return (geometry.coordinates as number[][][]).map(ringToPath).join("");
  }
  if (geometry.type === "MultiPolygon") {
    return (geometry.coordinates as number[][][][])
      .map((poly) => poly.map(ringToPath).join(""))
      .join("");
  }
  return "";
}
