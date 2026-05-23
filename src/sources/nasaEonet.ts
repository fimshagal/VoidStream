import type { EntropySource } from "./types";
import { clampText, concatBytes, encodeString, timingBytes } from "../utils";

/**
 * NASA EONET — стрічка природних явищ (пожежі, шторми, вулкани).
 * Без API-ключа, CORS відкритий.
 */
export const nasaEonet: EntropySource = {
    name: "nasa/eonet",
    label: "NASA EONET — natural events",
    async fetch(): Promise<Uint8Array> {
        const url = "https://eonet.gsfc.nasa.gov/api/v3/events?limit=30&status=open";
        const t0 = performance.now();
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`nasa-eonet: HTTP ${res.status}`);
        const text = await res.text();
        const dt = performance.now() - t0;
        return concatBytes(
            encodeString(clampText(text, 8192)),
            encodeString(`|${dt}|`),
            timingBytes(),
        );
    },
};
