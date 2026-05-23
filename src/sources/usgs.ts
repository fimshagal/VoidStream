import type { EntropySource } from "./types";
import { clampText, concatBytes, encodeString, timingBytes } from "../utils";

/**
 * Сейсмічна стрічка USGS — координати, магнітуди та timestamp всіх землетрусів
 * за останню годину. CORS відкритий, ключ не потрібен.
 */
export const usgsEarthquakes: EntropySource = {
    name: "usgs/earthquakes",
    label: "USGS — earthquakes (last hour)",
    async fetch(): Promise<Uint8Array> {
        const t0 = performance.now();
        const res = await fetch(
            "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson",
            { cache: "no-store" },
        );
        if (!res.ok) throw new Error(`usgs: HTTP ${res.status}`);
        const text = await res.text();
        const dt = performance.now() - t0;
        return concatBytes(
            encodeString(clampText(text, 8192)),
            encodeString(`|${dt}|`),
            timingBytes(),
        );
    },
};
