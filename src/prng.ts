/**
 * xoshiro128** — швидкий 32-бітний PRNG з 128-бітним станом.
 *
 * Чому саме він: невелика реалізація на чистих u32-операціях
 * (через `Math.imul` та `>>> 0`), без BigInt у гарячому шляху;
 * рівномірний розподіл, період 2^128 - 1. Він не є криптографічно
 * стійким, але як змішувальна функція над постійно оновлюваним
 * пулом ентропії дає синхронний доступ і добру статистичну якість.
 *
 * Стан можна "досівати" в будь-який момент через `seed(bytes)` —
 * нові байти ксоряться у 16-байтовий стан, виконується 8 викидних
 * раундів для розповсюдження.
 */

function rotl(x: number, k: number): number {
    return ((x << k) | (x >>> (32 - k))) >>> 0;
}

export class Xoshiro128ss {
    // Початковий стан — "nothing-up-my-sleeve" константи:
    // золоте перетворення + цифри числа π. Жоден з них не нульовий.
    private readonly s = new Uint32Array([
        0x9e3779b9, 0x243f6a88, 0xb7e15162, 0x85a308d3,
    ]);

    /**
     * Домішує сирі байти у стан і виконує 8 викидних раундів.
     * Безпечно викликати з будь-якою кількістю байтів, у тому числі 0.
     */
    seed(bytes: Uint8Array): void {
        if (bytes.length === 0) return;
        const view = new Uint8Array(this.s.buffer);
        for (let i = 0; i < bytes.length; i++) {
            view[i & 15] ^= bytes[i]!;
        }
        // Уникаємо повністю нульового стану (заборонений для xoshiro).
        if ((this.s[0]! | this.s[1]! | this.s[2]! | this.s[3]!) === 0) {
            this.s[0] = 1;
        }
        for (let i = 0; i < 8; i++) this.next();
    }

    /** Одне 32-бітне беззнакове ціле. */
    next(): number {
        const s = this.s;
        const result = Math.imul(rotl(Math.imul(s[1]!, 5), 7), 9) >>> 0;
        const t = (s[1]! << 9) >>> 0;
        s[2] = (s[2]! ^ s[0]!) >>> 0;
        s[3] = (s[3]! ^ s[1]!) >>> 0;
        s[1] = (s[1]! ^ s[2]!) >>> 0;
        s[0] = (s[0]! ^ s[3]!) >>> 0;
        s[2] = (s[2]! ^ t) >>> 0;
        s[3] = rotl(s[3]!, 11);
        return result;
    }

    /** Float у [0, 1) з 53-бітною мантисою (як `Math.random`). */
    nextUnit(): number {
        const hi = this.next() >>> 5; // 27 бітів
        const lo = this.next() >>> 6; // 26 бітів
        return (hi * 0x4000000 + lo) / 0x20000000000000;
    }

    /** N випадкових байтів. */
    nextBytes(n: number): Uint8Array {
        const out = new Uint8Array(n);
        let i = 0;
        while (i + 4 <= n) {
            const v = this.next();
            out[i] = v & 0xff;
            out[i + 1] = (v >>> 8) & 0xff;
            out[i + 2] = (v >>> 16) & 0xff;
            out[i + 3] = (v >>> 24) & 0xff;
            i += 4;
        }
        if (i < n) {
            const v = this.next();
            for (let s = 0; i < n; i++, s += 8) {
                out[i] = (v >>> s) & 0xff;
            }
        }
        return out;
    }
}
