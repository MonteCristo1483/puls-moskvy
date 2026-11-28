"use client";

// Слой «Погода и ветер» (S2). Данные — Open-Meteo напрямую из браузера
// (ADR-001), здесь плашка времени и источника. Сам ветер рисует отдельный слой
// «Поток ветра» (atmosphere/): частицы летят туда, куда дует ветер, по данным
// из общего стека (layers/weather-store.ts) — второй запрос не нужен.
// В разметку компонент вставляет хост слоёв (layers/host.tsx) по реестру,
// поэтому map.tsx про устройство слоя не знает.
//
// S4: если в URL выбран час (`?t=HH:MM`), плашка берёт значения этого часа из
// того же часового ряда, что пришёл с «текущей» погодой — второго запроса нет.
// Плашка честно пишет «факт» (час уже прошёл) или «прогноз».
import { useEffect, useRef, useState } from "react";
import type * as maplibregl from "maplibre-gl";
import { Pill } from "./design";
import {
  fetchWeather,
  looksOffline,
  WEATHER_MOVE_THRESHOLD_DEG,
  WEATHER_REFRESH_MS,
  weatherAt,
  weatherClock,
  weatherKind,
  type WeatherSnapshot,
  type WeatherValues,
} from "./live-weather";
import { moscowClockMinutes } from "./solar";
import { weatherStore } from "./layers/weather-store";

// Пока карта не готова, погоду всё равно показываем — по центру Москвы.
const FALLBACK_CENTER: [number, number] = [37.6173, 55.7558]; // [lon, lat]

function formatNumber(value: number): string {
  return value.toFixed(1).replace(".", ",").replace("-", "−");
}

/** Порог «осадков нет»: ниже 0,05 мм Open-Meteo отдаёт следы, а не осадки. */
const PRECIP_MIN_MM = 0.05;

export type PrecipKind = "none" | "rain" | "sleet" | "snow";

const PRECIP_LABELS: Record<PrecipKind, string> = {
  none: "без осадков",
  rain: "дождь",
  sleet: "мокрый снег",
  snow: "снег",
};

/**
 * Есть ли сейчас осадки и в каком виде. Вид — по температуре модели
 * (Open-Meteo), а не по прибору: ≥ +1 °C — дождь, от −1 до +1 °C — мокрый
 * снег, ниже −1 °C — снег. Это ответ «есть ли дождь/снег», а не замер.
 */
export function precipitationKind(
  temperatureC: number,
  precipitationMm: number,
): PrecipKind {
  if (precipitationMm < PRECIP_MIN_MM) return "none";
  if (temperatureC >= 1) return "rain";
  if (temperatureC >= -1) return "sleet";
  return "snow";
}

export default function WeatherLayer({
  visible,
  minutes,
}: {
  visible: boolean;
  /** Выбранный час таймлайна, минуты от полуночи; null — живой режим. */
  minutes: number | null;
}) {
  const mapRef = useRef<maplibregl.Map | null>(null);
  const lastCenterRef = useRef<[number, number] | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [snapshot, setSnapshot] = useState<WeatherSnapshot | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");

  const hour = minutes === null ? null : weatherAt(snapshot, minutes);
  const values: WeatherValues | null = hour ?? snapshot;

  // Эффекты детей выполняются раньше эффекта родителя, поэтому карту не
  // «ждём по порядку», а ищем в window.__map (map.tsx выставляет её сразу
  // после создания).
  useEffect(() => {
    const readMap = () =>
      (window as unknown as { __map?: maplibregl.Map }).__map ?? null;
    const existing = readMap();
    if (existing) {
      mapRef.current = existing;
      setMapReady(true);
      return;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      const map = readMap();
      if (map) {
        mapRef.current = map;
        setMapReady(true);
        window.clearInterval(timer);
        return;
      }
      if (Date.now() - startedAt > 20_000) window.clearInterval(timer);
    }, 120);
    return () => window.clearInterval(timer);
  }, []);

  // Данные: первый запрос, обновление раз в 15 минут и повторный запрос,
  // когда центр карты сместился больше чем на ~0.05°.
  useEffect(() => {
    if (!visible) return;
    const load = (force: boolean) => {
      const map = mapRef.current;
      const center = map
        ? { lon: map.getCenter().lng, lat: map.getCenter().lat }
        : { lon: FALLBACK_CENTER[0], lat: FALLBACK_CENTER[1] };
      const previous = lastCenterRef.current;
      const moved =
        previous === null ||
        Math.abs(previous[0] - center.lon) >= WEATHER_MOVE_THRESHOLD_DEG ||
        Math.abs(previous[1] - center.lat) >= WEATHER_MOVE_THRESHOLD_DEG;
      if (!force && !moved) return;
      lastCenterRef.current = [center.lon, center.lat];

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      void fetchWeather(center.lat, center.lon, {
        signal: controller.signal,
        force,
      })
        .then((data) => {
          if (controller.signal.aborted) return;
          setSnapshot(data);
          setStatus("ok");
          // Общий стек погоды: другие слои читают снимок без второго запроса.
          weatherStore.publish(data);
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          // Данные не стираем: плашка покажет последнее известное время.
          setStatus("error");
        });
    };

    load(true);
    const timer = window.setInterval(() => load(true), WEATHER_REFRESH_MS);
    const map = mapRef.current;
    const onMoveEnd = () => load(false);
    map?.on("moveend", onMoveEnd);
    return () => {
      window.clearInterval(timer);
      map?.off("moveend", onMoveEnd);
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [visible, mapReady]);

  if (!visible) return null;

  const stale = status === "error";
  const clock = hour
    ? weatherClock(hour.time)
    : snapshot
      ? weatherClock(snapshot.time)
      : null;
  // «Факт» / «прогноз» только для выбранного часа: у текущей погоды время
  // и так фактическое.
  const kind =
    hour !== null && minutes !== null
      ? weatherKind(minutes, Math.floor(moscowClockMinutes(Date.now())))
      : null;
  // Осадки: явный ответ «есть ли сейчас дождь/снег» вместо молчания или
  // голых «0,4 мм». Вид — по температуре модели (см. precipitationKind).
  const precipKind: PrecipKind | null = values
    ? precipitationKind(values.temperatureC, values.precipitationMm)
    : null;
  const precipLine =
    precipKind === null
      ? ""
      : precipKind === "none"
        ? PRECIP_LABELS.none
        : `${PRECIP_LABELS[precipKind]} ${formatNumber(
            values?.precipitationMm ?? 0,
          )} мм`;
  const valueLine = values
    ? `${values.temperatureC > 0 ? "+" : ""}${formatNumber(
        values.temperatureC,
      )} °C · ветер ${formatNumber(values.windSpeedMs)} м/с · ${precipLine}`
    : status === "loading"
      ? "Погода · загрузка…"
      : "Погода недоступна";
  const sourceLine = values
    ? `Данные на ${clock} · Open-Meteo${kind ? ` · ${kind}` : ""}${
        stale ? (looksOffline() ? " · нет сети" : " · данные устарели") : ""
      }`
    : status === "loading"
      ? "Open-Meteo"
      : "нет сети · Open-Meteo";

  return (
    <Pill
      data-weather-pill="1"
      data-weather-status={status}
      data-weather-temp={values ? values.temperatureC.toFixed(2) : undefined}
      data-weather-wind={values ? values.windSpeedMs.toFixed(2) : undefined}
      data-weather-time={
        hour ? hour.time : snapshot ? snapshot.time : undefined
      }
      data-weather-clock={clock ?? undefined}
      data-weather-kind={kind ?? undefined}
      data-weather-precip={precipKind ?? undefined}
      data-weather-precip-mm={
        precipKind === null || precipKind === "none" || !values
          ? undefined
          : values.precipitationMm.toFixed(2)
      }
      role="status"
      title="Погода и ветер: Open-Meteo, данные CC BY 4.0. Частицы показывают, куда дует ветер; обновление раз в 15 минут."
      // S10: на телефоне нижняя строка отдана лицензиям (футер-строка), поэтому
      // стопка плашек начинается выше: погода — 3.4rem, тени — 6.6rem,
      // таймлайн — 10.4rem. На десктопе всё осталось как было.
      className="absolute bottom-[3.4rem] left-3 z-20 md:bottom-2"
    >
      <span className="text-13 font-semibold leading-none">{valueLine}</span>
      <span
        className={`text-105 leading-none ${
          stale ? "font-medium text-warn" : "text-ink-2"
        }`}
      >
        {sourceLine}
      </span>
    </Pill>
  );
}
