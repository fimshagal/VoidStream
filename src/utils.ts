/** Hex-представлення для масиву байтів. */
export function toHex(bytes: Uint8Array): string {
    let out = "";
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i]!;
        out += (b < 16 ? "0" : "") + b.toString(16);
    }
    return out;
}

/** UTF-8 байти зі строки. */
export function encodeString(s: string): Uint8Array {
    return new TextEncoder().encode(s);
}

/** Склеює масиви байтів у один новий буфер. */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
    let len = 0;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    let off = 0;
    for (const p of parts) {
        out.set(p, off);
        off += p.length;
    }
    return out;
}

/**
 * Сирі байти від таймерів. `performance.now()` дає sub-ms точність,
 * `Date.now()` — wall clock. Разом — 16 байтів додаткової
 * ентропії, унікальної для моменту виклику.
 */
export function timingBytes(): Uint8Array {
    const buf = new Float64Array(2);
    buf[0] = performance.now();
    buf[1] = Date.now();
    return new Uint8Array(buf.buffer.slice(0));
}

/** Безпечне обмеження довжини UTF-8 строки. */
export function clampText(text: string, maxBytes: number): string {
    if (text.length <= maxBytes) return text;
    return text.slice(0, maxBytes);
}
