// Солнце над Москвой (S3): азимут/высота и восход/закат.
//
// Чистый модуль без DOM и без зависимостей — его гоняют тесты в Node
// (`e2e/solar.spec.ts`) и сверка с Open-Meteo, поэтому никакого `window`.
// Алгоритм — NOAA Solar Calculator (Meeus/NOAA): средняя долгота, истинная
// аномалия, видимая долгота, наклон эклиптики, уравнение времени. Часовой
// пояс — Europe/Moscow (UTC+3 без перехода на летнее время с 2014 года).
//
// Азимут отсчитывается от севера по часовой стрелке (0° = N, 90° = E,
// 180° = S, 270° = W). Высота — геометрическая (без рефракции); для теней
// это правильная величина, а для восхода/заката отдельно берётся стандартный
// зенит 90.833° (рефракция 34′ + видимый радиус Солнца 16′).

export const MOSCOW_UTC_OFFSET_MINUTES = 180;

// Стандартный зенит восхода/заката: Солнце на видимом горизонте.
// Решая высоту ровно 0°, получаем на ~4 минуты позже — поэтому фиксируем
// зенит 90.833°, как в NOAA и Open-Meteo.
export const SUNRISE_ZENITH_DEG = 90.833;

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;
const MINUTES_PER_DAY = 1440;
const JULIAN_UNIX_EPOCH = 2_440_587.5;
const JULIAN_J2000 = 2_451_545;

export type SunPosition = {
  /** Азимут от севера по часовой стрелке, 0–360°. */
  azimuthDeg: number;
  /** Высота над горизонтом, −90…90°. */
  altitudeDeg: number;
  /** Склонение Солнца, −23.44…23.44°. */
  declinationDeg: number;
  /** Часовой угол, −180…180° (отрицательный — до полудня). */
  hourAngleDeg: number;
  /** Уравнение времени, минуты (истинное − среднее солнечное время). */
  equationOfTimeMin: number;
};

export type SunTimes = {
  sunrise: Date | null;
  sunset: Date | null;
  solarNoon: Date;
  /** Минуты от местной полуночи, 0…1440; null — солнце не восходит/не садится. */
  sunriseMinutes: number | null;
  sunsetMinutes: number | null;
  solarNoonMinutes: number;
  polar: "none" | "polar-day" | "polar-night";
};

type SolarParams = {
  /** Склонение, радианы. */
  declinationRad: number;
  /** Уравнение времени, минуты. */
  equationOfTimeMin: number;
};

function normalizeDegrees(value: number): number {
  const wrapped = value % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`solar: некорректное значение ${name}: ${value}`);
  }
}

function toMs(when: Date | number): number {
  return typeof when === "number" ? when : when.getTime();
}

/**
 * Склонение и уравнение времени по моменту времени (NOAA).
 * Внутренняя функция: обе величины считаются из одного юлианского века.
 */
function solarParams(instantMs: number): SolarParams {
  const julianDay = instantMs / MS_PER_DAY + JULIAN_UNIX_EPOCH;
  const t = (julianDay - JULIAN_J2000) / 36525;

  const meanLongitude = normalizeDegrees(
    280.46646 + t * (36000.76983 + t * 0.0003032),
  );
  const meanAnomalyDeg = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);

  const m = meanAnomalyDeg * RAD;
  const equationOfCenter =
    Math.sin(m) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * m) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * m) * 0.000289;

  const trueLongitude = meanLongitude + equationOfCenter;
  // Видимая долгота: поправка на нутацию и аберрацию.
  const omega = 125.04 - 1934.136 * t;
  const apparentLongitude =
    trueLongitude - 0.00569 - 0.00478 * Math.sin(omega * RAD);

  const meanObliquity =
    23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliquity = meanObliquity + 0.00256 * Math.cos(omega * RAD);

  const declinationRad = Math.asin(
    clamp(Math.sin(obliquity * RAD) * Math.sin(apparentLongitude * RAD), -1, 1),
  );

  // Уравнение времени, минуты (NOAA): y = tan²(ε/2).
  const y = Math.tan((obliquity * RAD) / 2) ** 2;
  const l0 = meanLongitude * RAD;
  const equationOfTimeMin =
    4 *
    DEG *
    (y * Math.sin(2 * l0) -
      2 * eccentricity * Math.sin(m) +
      4 * eccentricity * y * Math.sin(m) * Math.cos(2 * l0) -
      0.5 * y * y * Math.sin(4 * l0) -
      1.25 * eccentricity * eccentricity * Math.sin(2 * m));

  return { declinationRad, equationOfTimeMin };
}

/**
 * Положение Солнца в момент времени и точке. Возвращает азимут (от севера),
 * высоту, склонение, часовой угол и уравнение времени.
 */
export function sunPosition(
  when: Date | number,
  latitude: number,
  longitude: number,
): SunPosition {
  const ms = toMs(when);
  assertFinite(ms, "время");
  assertFinite(latitude, "широта");
  assertFinite(longitude, "долгота");

  const { declinationRad, equationOfTimeMin } = solarParams(ms);

  // Минуты от полуночи UTC.
  const utcMinutes =
    ((((ms % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY) / MS_PER_MINUTE);
  // Истинное солнечное время (NOAA): UTC + уравнение времени + 4 мин/градус.
  const trueSolarTimeMin = utcMinutes + equationOfTimeMin + 4 * longitude;
  const hourAngleDeg = trueSolarTimeMin / 4 - 180;

  const latRad = latitude * RAD;
  const hourAngleRad = hourAngleDeg * RAD;
  const cosZenith =
    Math.sin(latRad) * Math.sin(declinationRad) +
    Math.cos(latRad) * Math.cos(declinationRad) * Math.cos(hourAngleRad);
  const altitudeDeg = Math.asin(clamp(cosZenith, -1, 1)) * DEG;

  // Азимут от юга (Meeus), затем +180° → от севера по часовой стрелке.
  const azimuthFromSouth =
    Math.atan2(
      Math.sin(hourAngleRad),
      Math.cos(hourAngleRad) * Math.sin(latRad) -
        Math.tan(declinationRad) * Math.cos(latRad),
    ) * DEG;

  return {
    azimuthDeg: normalizeDegrees(azimuthFromSouth + 180),
    altitudeDeg,
    declinationDeg: declinationRad * DEG,
    hourAngleDeg,
    equationOfTimeMin,
  };
}

/**
 * Восход и закат для местной (московской) календарной даты, в которую попадает
 * `when`. Решаем высоту Солнца = стандартный зенит 90.833°; при полярном дне
 * или ночи возвращаем null и метку `polar`. EoT и склонение уточняются на
 * моменте восхода и заката (две итерации), поэтому время не «плывёт».
 */
export function sunriseSunset(
  when: Date | number,
  latitude: number,
  longitude: number,
  options: { tzOffsetMinutes?: number; zenithDeg?: number } = {},
): SunTimes {
  const ms = toMs(when);
  assertFinite(ms, "время");
  assertFinite(latitude, "широта");
  assertFinite(longitude, "долгота");
  if (Math.abs(latitude) > 89.9) {
    throw new RangeError("solar: широта должна быть в пределах ±89.9°");
  }

  const tzOffset = options.tzOffsetMinutes ?? MOSCOW_UTC_OFFSET_MINUTES;
  const zenithDeg = options.zenithDeg ?? SUNRISE_ZENITH_DEG;
  const latRad = latitude * RAD;

  // Местная календарная дата: сдвигаем момент на смещение пояса.
  const local = new Date(ms + tzOffset * MS_PER_MINUTE);
  const localMidnightUtc = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
  );
  // Солнечный полдень ищем для местного полудня (12:00 по поясу).
  const localNoonMs = localMidnightUtc + 12 * 60 * MS_PER_MINUTE - tzOffset * MS_PER_MINUTE;

  let params = solarParams(localNoonMs);
  const solarNoonUtcMin = 720 - 4 * longitude - params.equationOfTimeMin;

  const cosHourAngle = (azimuthlessZenithCosine(zenithDeg, latRad, params.declinationRad));
  if (!Number.isFinite(cosHourAngle)) {
    throw new RangeError("solar: не удалось посчитать часовой угол");
  }

  const solarNoon = new Date(localMidnightUtc + solarNoonUtcMin * MS_PER_MINUTE);
  const solarNoonMinutes = normalizeMinutes(solarNoonUtcMin + tzOffset);

  if (cosHourAngle >= 1) {
    // Солнце не доходит до зенита восхода: полярная ночь.
    return {
      sunrise: null,
      sunset: null,
      solarNoon,
      sunriseMinutes: null,
      sunsetMinutes: null,
      solarNoonMinutes,
      polar: "polar-night",
    };
  }
  if (cosHourAngle <= -1) {
    return {
      sunrise: null,
      sunset: null,
      solarNoon,
      sunriseMinutes: null,
      sunsetMinutes: null,
      solarNoonMinutes,
      polar: "polar-day",
    };
  }

  let hourAngleDeg = Math.acos(cosHourAngle) * DEG;
  let sunriseUtcMin = solarNoonUtcMin - 4 * hourAngleDeg;
  let sunsetUtcMin = solarNoonUtcMin + 4 * hourAngleDeg;

  // Две итерации: EoT и склонение на моменте восхода, а не полудня.
  for (let pass = 0; pass < 2; pass += 1) {
    params = solarParams(localMidnightUtc + sunriseUtcMin * MS_PER_MINUTE);
    const noon = 720 - 4 * longitude - params.equationOfTimeMin;
    const cosSunrise = azimuthlessZenithCosine(
      zenithDeg,
      latRad,
      params.declinationRad,
    );
    if (cosSunrise >= 1 || cosSunrise <= -1) break;
    hourAngleDeg = Math.acos(cosSunrise) * DEG;
    sunriseUtcMin = noon - 4 * hourAngleDeg;
    sunsetUtcMin = noon + 4 * hourAngleDeg;
  }

  return {
    sunrise: new Date(localMidnightUtc + sunriseUtcMin * MS_PER_MINUTE),
    sunset: new Date(localMidnightUtc + sunsetUtcMin * MS_PER_MINUTE),
    solarNoon,
    sunriseMinutes: normalizeMinutes(sunriseUtcMin + tzOffset),
    sunsetMinutes: normalizeMinutes(sunsetUtcMin + tzOffset),
    solarNoonMinutes,
    polar: "none",
  };
}

/** cos(часового угла) для зенита, широты и склонения. */
function azimuthlessZenithCosine(
  zenithDeg: number,
  latitudeRad: number,
  declinationRad: number,
): number {
  return (
    (Math.cos(zenithDeg * RAD) -
      Math.sin(latitudeRad) * Math.sin(declinationRad)) /
    (Math.cos(latitudeRad) * Math.cos(declinationRad))
  );
}

/** Минуты от местной полуночи (0…1440) для момента времени. */
export function moscowClockMinutes(when: Date | number): number {
  return normalizeMinutes(
    (toMs(when) + MOSCOW_UTC_OFFSET_MINUTES * MS_PER_MINUTE) / MS_PER_MINUTE,
  );
}

function normalizeMinutes(value: number): number {
  const wrapped = value % MINUTES_PER_DAY;
  return wrapped < 0 ? wrapped + MINUTES_PER_DAY : wrapped;
}

/** «14:05» из минут от полуночи. */
export function formatClock(minutes: number): string {
  const total = Math.round(normalizeMinutes(minutes));
  const hours = Math.floor(total / 60) % 24;
  const rest = total % 60;
  const pad = (value: number) => (value < 10 ? `0${value}` : String(value));
  return `${pad(hours)}:${pad(rest)}`;
}

/** «14:05» по московскому времени для момента. */
export function moscowClock(when: Date | number): string {
  return formatClock(moscowClockMinutes(when));
}

/**
 * Момент (Date) с московским временем `minutes` на календарной дате,
 * в которую попадает `reference`. Так `?t=14:00` не зависит от пояса машины.
 */
export function moscowInstantAt(minutes: number, reference: Date | number): Date {
  const refMs = toMs(reference);
  assertFinite(refMs, "время");
  const local = new Date(refMs + MOSCOW_UTC_OFFSET_MINUTES * MS_PER_MINUTE);
  const localMidnightUtc = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
  );
  const localMidnight = localMidnightUtc - MOSCOW_UTC_OFFSET_MINUTES * MS_PER_MINUTE;
  return new Date(localMidnight + normalizeMinutes(minutes) * MS_PER_MINUTE);
}

/** «14:00» / «9:5» из query-параметра `?t=`; null, если формат не тот. */
export function parseClockParam(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}
