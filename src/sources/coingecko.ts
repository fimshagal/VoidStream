import type { EntropySource } from "./types";
import { clampText, concatBytes, encodeString, timingBytes } from "../utils";

const COINS = [
    "bitcoin",
    "ethereum",
    "monero",
    "solana",
    "dogecoin",
    "cardano",
    "polkadot",
    "litecoin",
].join(",");

/**
 * Реалтайм-ціни криптоактивів від CoinGecko — крайні десяткові розряди
 * непередбачувані й оновлюються кожні кілька секунд.
 */
export const coingecko: EntropySource = {
    name: "coingecko",
    label: "CoinGecko — crypto prices",
    async fetch(): Promise<Uint8Array> {
        const url = `https://api.coingecko.com/api/v3/simple/price`
            + `?ids=${COINS}`
            + `&vs_currencies=usd`
            + `&include_market_cap=true`
            + `&include_24hr_vol=true`
            + `&include_24hr_change=true`
            + `&include_last_updated_at=true`;
        const t0 = performance.now();
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`coingecko: HTTP ${res.status}`);
        const text = await res.text();
        const dt = performance.now() - t0;
        return concatBytes(
            encodeString(clampText(text, 8192)),
            encodeString(`|${dt}|`),
            timingBytes(),
        );
    },
};
