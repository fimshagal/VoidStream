import type { EntropySource } from "./types";
import { clampText, concatBytes, encodeString, timingBytes } from "../utils";

/**
 * Публічний стрім подій GitHub — пуші, форки, коментарі. Постійно оновлюється,
 * має широку базу шуму (id-шники, sha-комітів, тексти). Ліміт без авторизації:
 * 60 запитів/год, чого вистачає для інтервалу >= 5 хв.
 */
export const githubEvents: EntropySource = {
    name: "github/events",
    label: "GitHub — public events",
    async fetch(): Promise<Uint8Array> {
        const url = "https://api.github.com/events?per_page=30";
        const t0 = performance.now();
        const res = await fetch(url, {
            cache: "no-store",
            headers: { Accept: "application/vnd.github+json" },
        });
        if (!res.ok) throw new Error(`github: HTTP ${res.status}`);
        const text = await res.text();
        const dt = performance.now() - t0;
        return concatBytes(
            encodeString(clampText(text, 8192)),
            encodeString(`|${dt}|`),
            timingBytes(),
        );
    },
};
