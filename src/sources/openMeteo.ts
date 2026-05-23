import type { EntropySource } from "./types";
import { clampText, concatBytes, encodeString, timingBytes } from "../utils";

/**
 * Метеодані Open-Meteo на випадковій точці планети.
 * Параметри запиту самі по собі додають ентропії (через випадкові координати),
 * а тіло відповіді дає погоду у момент дзвінка.
 *
 * Координати тут генеруються через таймінги, щоб не використовувати
 * Math.random як джерело "невидимої" ентропії.
 */
function pickLatLon(): { lat: number; lon: number } {
    const t = performance.now();
    const a = (Math.sin(t * 12.9898) * 43758.5453) % 1;
    const b = (Math.sin(t * 78.233) * 12345.6789) % 1;
    return {
        lat: +((a < 0 ? a + 1 : a) * 180 - 90).toFixed(3),
        lon: +((b < 0 ? b + 1 : b) * 360 - 180).toFixed(3),
    };
}

export const openMeteo: EntropySource = {
    name: "open-meteo",
    label: "Open-Meteo — random spot weather",
    async fetch(): Promise<Uint8Array> {
        const { lat, lon } = pickLatLon();
        const url = `https://api.open-meteo.com/v1/forecast`
            + `?latitude=${lat}&longitude=${lon}`
            + `&current=temperature_2m,wind_speed_10m,wind_direction_10m,relative_humidity_2m,surface_pressure,cloud_cover`
            + `&past_days=1`;
        const t0 = performance.now();
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`open-meteo: HTTP ${res.status}`);
        const text = await res.text();
        const dt = performance.now() - t0;
        return concatBytes(
            encodeString(clampText(text, 8192)),
            encodeString(`|${lat},${lon}|${dt}|`),
            timingBytes(),
        );
    },
};
