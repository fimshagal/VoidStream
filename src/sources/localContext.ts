import { concatBytes, encodeString, timingBytes } from "../utils";
import type { EntropySource } from "./types";

/**
 * `localContext` — єдине з вбудованих джерел НЕ-мережевого типу.
 * Мета-джерело: збирає те, що відбувається ЛОКАЛЬНО у середовищі
 * виконання, без жодних HTTP-запитів.
 *
 * Що накопичується (пасивно, через `passive: true` обробники, тому
 * жодного скрол-джанку чи події не блокуємо):
 *   - mousemove   — координати курсора (нижні байти)
 *   - click       — координати + кнопка
 *   - keydown     — ЛИШЕ timing події (БЕЗ keyCode / без key — privacy)
 *   - touchmove   — координати першого пальця
 *   - scroll      — поточні scrollX/Y
 *   - wheel       — deltaX/Y
 * + знімок локального оточення на момент fetch-у: hardwareConcurrency,
 *   deviceMemory, maxTouchPoints, language, розмір екрану, heap-розмір
 *   (`performance.memory` де доступний).
 *
 * Priority / impact: source свідомо повертає МАЛИЙ payload (типово
 * 80–160 байт у браузері, ~30–60 у Node) проти кілобайтів у мережевих.
 * `Xoshiro128ss.seed` робить XOR-mix + 8 next()-рознесень на кожні
 * 16 байтів, тому маленький payload = менша "вага" у пулі. Це
 * відповідає задумці: локальне джерело завжди є, але мережеві
 * домінують, коли вони доступні.
 *
 * Privacy: нічого з зібраного не дублюється у мережу і не виходить
 * за межі поточного процесу. Подія натискання клавіші реєструється
 * лише як timing-impulse — текст користувача не збирається.
 *
 * SSR/Node-safe: якщо `window`/`document` відсутні, обробники просто
 * не приєднуються, і `fetch()` повертає env + timing.
 */

const MAX_BUFFER_BYTES = 64;
const SAMPLE_THROTTLE_MS = 50;

const buffer = new Uint8Array(MAX_BUFFER_BYTES);
let writePos = 0;
let fill = 0;
let lastSampleAt = 0;
let listenersAttached = false;

function nowMs(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function lo(n: number): number {
    return (n | 0) & 0xff;
}

function hi(n: number): number {
    return ((n | 0) >>> 8) & 0xff;
}

function pushByte(b: number): void {
    buffer[writePos] = b & 0xff;
    writePos = (writePos + 1) % MAX_BUFFER_BYTES;
    if (fill < MAX_BUFFER_BYTES) fill++;
}

function pushBytes(arr: Uint8Array): void {
    for (let i = 0; i < arr.length; i++) pushByte(arr[i]!);
}

function snapshotBuffer(): Uint8Array {
    if (fill === 0) return new Uint8Array(0);
    const out = new Uint8Array(fill);
    let r = (writePos - fill + MAX_BUFFER_BYTES) % MAX_BUFFER_BYTES;
    for (let i = 0; i < fill; i++) {
        out[i] = buffer[r]!;
        r = (r + 1) % MAX_BUFFER_BYTES;
    }
    fill = 0;
    writePos = 0;
    return out;
}

/**
 * Семплює подію: timing-байти йдуть завжди, додаткові — від колбеку
 * конкретної події. Дросель 50 мс уберігає від спаму на mousemove.
 */
function sample(extras?: number[]): void {
    const now = nowMs();
    if (now - lastSampleAt < SAMPLE_THROTTLE_MS) return;
    lastSampleAt = now;
    pushBytes(timingBytes());
    if (extras) for (const e of extras) pushByte(e);
}

function attachListeners(): void {
    if (listenersAttached) return;
    if (typeof window === "undefined" || typeof document === "undefined") return;
    listenersAttached = true;

    const opts: AddEventListenerOptions = { passive: true, capture: false };

    document.addEventListener(
        "mousemove",
        (e) => sample([lo(e.clientX), hi(e.clientX), lo(e.clientY), hi(e.clientY)]),
        opts,
    );

    document.addEventListener(
        "click",
        (e) => sample([lo(e.clientX), lo(e.clientY), lo(e.button)]),
        opts,
    );

    // Свідомо без e.key / e.keyCode — записуємо лише сам факт події.
    document.addEventListener("keydown", () => sample(), opts);

    document.addEventListener(
        "touchmove",
        (e) => {
            const t = e.touches[0];
            if (!t) return;
            sample([lo(t.clientX), lo(t.clientY)]);
        },
        opts,
    );

    window.addEventListener(
        "scroll",
        () => {
            const x = (window.scrollX || 0) >>> 0;
            const y = (window.scrollY || 0) >>> 0;
            sample([lo(x), hi(x), lo(y), hi(y)]);
        },
        opts,
    );

    window.addEventListener("wheel", (e) => sample([lo(e.deltaX), lo(e.deltaY)]), opts);
}

attachListeners();

function localEnvironment(): Uint8Array {
    const parts: string[] = [];
    if (typeof navigator !== "undefined") {
        parts.push(String(navigator.hardwareConcurrency ?? ""));
        const nav = navigator as {
            deviceMemory?: number;
            maxTouchPoints?: number;
        };
        parts.push(String(nav.deviceMemory ?? ""));
        parts.push(String(nav.maxTouchPoints ?? ""));
        parts.push(navigator.language ?? "");
    }
    if (typeof screen !== "undefined") {
        parts.push(`${screen.width}x${screen.height}x${screen.colorDepth}`);
        parts.push(`${screen.availWidth}x${screen.availHeight}`);
    }
    const perfMem = (
        performance as {
            memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number };
        }
    ).memory;
    if (perfMem) {
        parts.push(`${perfMem.usedJSHeapSize ?? 0}/${perfMem.totalJSHeapSize ?? 0}`);
    }
    parts.push(String(Date.now()));
    return encodeString(parts.join("|"));
}

export const localContext: EntropySource = {
    name: "local-context",
    label: "user input + local environment",
    async fetch() {
        const events = snapshotBuffer();
        const env = localEnvironment();
        const t = timingBytes();
        return concatBytes(events, env, t);
    },
};
