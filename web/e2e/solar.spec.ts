import { test, expect } from "@playwright/test";
import {
  formatClock,
  moscowClockMinutes,
  moscowInstantAt,
  parseClockParam,
  sunPosition,
  sunriseSunset,
} from "../app/solar";
import {
  buildingShadow,
  dissolveShadows,
  MAX_SHADOW_LENGTH_M,
  MIN_SHADOW_ALTITUDE_DEG,
  shadowOffset,
  type ShadowMultiPolygon,
} from "../app/shadows";

// S3: солнечная математика без браузера. Никаких page/WebGL — чистые функции
// из app/solar.ts и app/shadows.ts. Внешние эталоны — независимые источники:
//   * восход/закат — Open-Meteo daily (Europe/Moscow) на 2026-11-27;
//   * азимут/высота — JPL Horizons, observer table (apparent AZ/EL),
//     CENTER=coord@399, SITE_COORD='37.6208,55.7539,0.15'.

const DATE = new Date(Date.UTC(2026, 10, 27, 9, 0)); // 12:00 MSK
const TOLERANCE_MIN = 15;

const MOSCOW_POINTS = [
  { name: "Красная площадь", lat: 55.7539, lon: 37.6208, rise: 8 * 60 + 28, set: 16 * 60 + 6 },
  { name: "Пресня", lat: 55.7601, lon: 37.565, rise: 8 * 60 + 28, set: 16 * 60 + 6 },
  { name: "ВДНХ", lat: 55.8266, lon: 37.6377, rise: 8 * 60 + 27, set: 16 * 60 + 5 },
  { name: "Воробьёвы горы", lat: 55.7103, lon: 37.545, rise: 8 * 60 + 27, set: 16 * 60 + 6 },
  { name: "Тушино", lat: 55.829, lon: 37.44, rise: 8 * 60 + 28, set: 16 * 60 + 6 },
] as const;

// JPL Horizons, apparent azimuth/elevation (градусы) для Красной площади.
const HORIZONS = [
  { clock: "10:00", utcHour: 7, azimuth: 147.9932, altitude: 7.7981 },
  { clock: "14:00", utcHour: 11, azimuth: 204.27, altitude: 10.0351 },
  { clock: "19:00", utcHour: 16, azimuth: 266.2294, altitude: -23.3591 },
] as const;

test("Солнце: восход/закат совпадает с Open-Meteo (±15 мин) в 5 точках Москвы", () => {
  for (const point of MOSCOW_POINTS) {
    const times = sunriseSunset(DATE, point.lat, point.lon);
    expect(times.polar, point.name).toBe("none");
    expect(times.sunriseMinutes, point.name).not.toBeNull();
    expect(times.sunsetMinutes, point.name).not.toBeNull();
    if (times.sunriseMinutes === null || times.sunsetMinutes === null) continue;
    const riseDelta = Math.abs(times.sunriseMinutes - point.rise);
    const setDelta = Math.abs(times.sunsetMinutes - point.set);
    expect(riseDelta, `${point.name}: восход ${formatClock(times.sunriseMinutes)}`).toBeLessThanOrEqual(TOLERANCE_MIN);
    expect(setDelta, `${point.name}: закат ${formatClock(times.sunsetMinutes)}`).toBeLessThanOrEqual(TOLERANCE_MIN);
    // Свежее окно сравнения: у нас реально ≤2 мин, но порог приёмки — 15.
    expect(riseDelta).toBeLessThan(5);
    expect(setDelta).toBeLessThan(5);
  }
});

test("Солнце: азимут и высота совпадают с JPL Horizons (10:00/14:00/19:00)", () => {
  for (const reference of HORIZONS) {
    const when = new Date(Date.UTC(2026, 10, 27, reference.utcHour, 0));
    const sun = sunPosition(when, 55.7539, 37.6208);
    expect(Math.abs(sun.azimuthDeg - reference.azimuth), `${reference.clock} азимут`).toBeLessThan(0.5);
    expect(Math.abs(sun.altitudeDeg - reference.altitude), `${reference.clock} высота`).toBeLessThan(0.5);
  }
});

test("Солнце: в 19:00 в ноябре солнце уже под горизонтом — теней нет", () => {
  const when = new Date(Date.UTC(2026, 10, 27, 16, 0));
  const sun = sunPosition(when, 55.7539, 37.6208);
  expect(sun.altitudeDeg).toBeLessThan(0);
  expect(shadowOffset(30, sun)).toBeNull();
});

test("Солнце: восход и закат — это высота 0.833° под горизонтом (стандартный зенит)", () => {
  const point = MOSCOW_POINTS[0];
  const times = sunriseSunset(DATE, point.lat, point.lon);
  if (!times.sunrise || !times.sunset) throw new Error("нет восхода/заката");
  const atSunrise = sunPosition(times.sunrise, point.lat, point.lon);
  const atSunset = sunPosition(times.sunset, point.lat, point.lon);
  expect(Math.abs(atSunrise.altitudeDeg + 0.833)).toBeLessThan(0.06);
  expect(Math.abs(atSunset.altitudeDeg + 0.833)).toBeLessThan(0.06);
  // Полдень между восходом и закатом.
  expect(times.solarNoonMinutes).toBeGreaterThan(times.sunriseMinutes ?? 0);
  expect(times.solarNoonMinutes).toBeLessThan(times.sunsetMinutes ?? 0);
});

test("Солнце: полярная ночь за полярным кругом — восхода/заката нет", () => {
  const murmansk = sunriseSunset(new Date(Date.UTC(2026, 11, 21, 9, 0)), 68.9585, 33.0827);
  expect(murmansk.polar).toBe("polar-night");
  expect(murmansk.sunrise).toBeNull();
  expect(murmansk.sunset).toBeNull();
});

test("Время: ?t=HH:MM разбирается, часы МСК не зависят от пояса машины", () => {
  expect(parseClockParam("14:00")).toBe(14 * 60);
  expect(parseClockParam("9:05")).toBe(9 * 60 + 5);
  expect(parseClockParam("24:00")).toBeNull();
  expect(parseClockParam("14:7")).toBeNull();
  expect(parseClockParam(null)).toBeNull();

  const reference = new Date(Date.UTC(2026, 10, 27, 0, 30));
  const at14 = moscowInstantAt(14 * 60, reference);
  expect(formatClock(moscowClockMinutes(at14))).toBe("14:00");
  expect(at14.toISOString()).toBe("2026-11-27T11:00:00.000Z");
});

test("Тени: длина = height / tan(высота), направление — от солнца", () => {
  expect(shadowOffset(0, { azimuthDeg: 180, altitudeDeg: 30 })).toBeNull();
  expect(
    shadowOffset(30, { azimuthDeg: 180, altitudeDeg: MIN_SHADOW_ALTITUDE_DEG - 0.1 }),
  ).toBeNull();

  const noon = shadowOffset(30, { azimuthDeg: 180, altitudeDeg: 45 });
  expect(noon).not.toBeNull();
  if (!noon) return;
  expect(noon.lengthM).toBeCloseTo(30, 6);
  // Солнце на юге → тень на север.
  expect(Math.abs(noon.eastM)).toBeLessThan(1e-6);
  expect(noon.northM).toBeCloseTo(30, 6);

  const east = shadowOffset(30, { azimuthDeg: 90, altitudeDeg: 45 });
  expect(east).not.toBeNull();
  if (!east) return;
  // Солнце на востоке → тень на запад.
  expect(east.eastM).toBeCloseTo(-30, 6);

  // Низкое солнце: длина режется потолком, а не улетает в бесконечность.
  const low = shadowOffset(100, { azimuthDeg: 0, altitudeDeg: 2 });
  expect(low?.lengthM).toBe(MAX_SHADOW_LENGTH_M);
});

test("Тени: оболочка контура и сдвинутой копии тянется по азимуту", () => {
  // Квадрат ~20×20 м у Красной площади.
  const lat = 55.7539;
  const lon = 37.6208;
  const d = 0.0001;
  const ring: Array<[number, number]> = [
    [lon, lat],
    [lon + d, lat],
    [lon + d, lat + d],
    [lon, lat + d],
    [lon, lat],
  ];
  const shadow = buildingShadow(ring, 30, { azimuthDeg: 180, altitudeDeg: 45 }, lat);
  expect(shadow).not.toBeNull();
  if (!shadow) return;
  const polygon = shadow[0];
  expect(polygon.length).toBeGreaterThan(0);
  const coords = polygon[0];
  let north = -Infinity;
  let south = Infinity;
  for (const [, pointLat] of coords) {
    if (pointLat > north) north = pointLat;
    if (pointLat < south) south = pointLat;
  }
  // Контур ~0.0001° широты (11 м) + тень 30 м на север.
  const spanM = (north - south) * 111132.92;
  expect(spanM).toBeGreaterThan(35);
  expect(spanM).toBeLessThan(55);
});

test("Тени: оболочка — одна полоса от дома до конца тени (без разрыва)", () => {
  const lat = 55.7539;
  const lon = 37.6208;
  const d = 0.0002;
  const ring: Array<[number, number]> = [
    [lon, lat],
    [lon + d, lat],
    [lon + d, lat + d],
    [lon, lat + d],
    [lon, lat],
  ];
  const height = 60;
  const sun = { azimuthDeg: 204, altitudeDeg: 10 };
  const shift = shadowOffset(height, sun);
  if (!shift) throw new Error("нет смещения");

  const hullShadow = buildingShadow(ring, height, sun, lat);
  if (!hullShadow || hullShadow.length !== 1) throw new Error("нет одной тени");
  const hull = hullShadow[0][0];

  const ringArea = (vertexRing: Array<[number, number]>) => {
    let s = 0;
    for (let i = 0; i < vertexRing.length - 1; i += 1) {
      s +=
        vertexRing[i][0] * vertexRing[i + 1][1] -
        vertexRing[i + 1][0] * vertexRing[i][1];
    }
    return Math.abs(s) / 2;
  };
  const inside = (vertexRing: Array<[number, number]>, point: [number, number]) => {
    let hit = false;
    for (let i = 0, j = vertexRing.length - 2; i < vertexRing.length - 1; j = i, i += 1) {
      const [xi, yi] = vertexRing[i];
      const [xj, yj] = vertexRing[j];
      if (yi > point[1] !== yj > point[1]) {
        const x = ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi;
        if (point[0] < x) hit = !hit;
      }
    }
    return hit;
  };

  const baseCenter: [number, number] = [lon + d / 2, lat + d / 2];
  const shiftedCenter: [number, number] = [
    baseCenter[0] + shift.eastM / 62700,
    baseCenter[1] + shift.northM / 111132.92,
  ];
  // Полоса начинается у дома и доходит до дальнего конца тени.
  expect(inside(hull, baseCenter), "основание дома внутри тени").toBe(true);
  expect(inside(hull, shiftedCenter), "сдвинутая копия внутри тени").toBe(true);
  // И это именно полоса: площадь больше суммы двух копий (между ними — тело тени).
  const hullArea = ringArea(hull);
  expect(hullArea).toBeGreaterThan(ringArea(ring) * 2 * 1.5);
});

test("Тени: при солнце ниже 1.5° тень не строим (без мусора)", () => {
  expect(shadowOffset(50, { azimuthDeg: 200, altitudeDeg: 1 })).toBeNull();
  expect(shadowOffset(50, { azimuthDeg: 200, altitudeDeg: 2 })).not.toBeNull();
});

test("Тени: растворение кадра не складывает перекрытия (альфа не темнеет)", () => {
  const lat = 55.7539;
  const lon = 37.6208;
  const d = 0.0001;
  const ring: Array<[number, number]> = [
    [lon, lat],
    [lon + d, lat],
    [lon + d, lat + d],
    [lon, lat + d],
    [lon, lat],
  ];
  const sun = { azimuthDeg: 180, altitudeDeg: 45 };
  const shadow = buildingShadow(ring, 30, sun, lat);
  if (!shadow) throw new Error("тень не построилась");

  const areaDeg2 = (multi: ShadowMultiPolygon) => {
    let sum = 0;
    for (const polygon of multi) {
      for (const vertexRing of polygon) {
        let s = 0;
        for (let i = 0; i < vertexRing.length - 1; i += 1) {
          s +=
            vertexRing[i][0] * vertexRing[i + 1][1] -
            vertexRing[i + 1][0] * vertexRing[i][1];
        }
        sum += Math.abs(s) / 2;
      }
    }
    return sum;
  };

  const single = areaDeg2(dissolveShadows([shadow]));
  const doubled = areaDeg2(dissolveShadows([shadow, shadow]));
  const sumOfParts = areaDeg2([...shadow, ...shadow]);
  expect(single).toBeGreaterThan(0);
  // Два одинаковых полигона дают ровно ту же площадь, а не двойную.
  expect(doubled).toBeCloseTo(single, 12);
  expect(sumOfParts).toBeCloseTo(single * 2, 12);
});
