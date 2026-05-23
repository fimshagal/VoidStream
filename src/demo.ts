import { VoidStream } from "./index";

/**
 * Демо ловить тільки те, що ліба сама вирішує сказати назовні:
 *   - значення з її API;
 *   - повідомлення з console.warn префіксом "[voidstream]".
 *
 * Жодна мережева подія, джерело чи розклад тут не відображаються —
 * така політика самої бібліотеки. Кнопка "show sample warning"
 * емітить синтетичний console.warn з префіксом "[voidstream]", щоб
 * показати, як виглядають справжні warn-и у реальному житті
 * (через те що 5-хв floor планувальника робить ловіння реальних
 * warn-ів під час короткої демо-сесії малоймовірним).
 */

const NOISE_COLS = 32;
const NOISE_ROWS = 16;
const AUTO_SHUFFLE_MS = 1500;
const WARN_PREFIX = "[voidstream]";

const $ = <T extends Element>(sel: string): T => {
    const el = document.querySelector<T>(sel);
    if (!el) throw new Error(`missing element: ${sel}`);
    return el;
};

const els = {
    output: $("#output"),
    messages: $<HTMLOListElement>("#messages"),
    noiseCanvas: $<HTMLDivElement>("#noise-canvas"),
    sampleWarning: $<HTMLButtonElement>("#btn-sample-warning"),
    shuffle: $<HTMLButtonElement>("#btn-shuffle"),
    autoshuffle: $<HTMLButtonElement>("#btn-autoshuffle"),
};

// --- Перехоплювач console.warn ---------------------------------------
//
// Це робиться ДО створення VoidStream, щоб не пропустити ранні попередження.

interface LibMessage {
    time: number;
    text: string;
}

const messages: LibMessage[] = [];
const MESSAGE_LIMIT = 30;
const ORIGINAL_WARN = console.warn.bind(console);

console.warn = (...args: unknown[]): void => {
    const text = args.map(stringifyArg).join(" ");
    if (text.startsWith(WARN_PREFIX)) {
        messages.unshift({ time: Date.now(), text });
        if (messages.length > MESSAGE_LIMIT) messages.length = MESSAGE_LIMIT;
        renderMessages();
    }
    ORIGINAL_WARN(...args);
};

function stringifyArg(a: unknown): string {
    if (typeof a === "string") return a;
    try {
        return JSON.stringify(a);
    } catch {
        return String(a);
    }
}

// --- Основний інстанс ліби -------------------------------------------

const stream = new VoidStream();

// --- API-плейграунд ---------------------------------------------------

document.querySelectorAll<HTMLButtonElement>("[data-op]").forEach((btn) => {
    btn.addEventListener("click", () => runOp(btn.dataset.op as string));
});

function runOp(op: string): void {
    let label = op;
    let value: unknown;
    try {
        switch (op) {
            case "int":
                label = "int()";
                value = stream.int();
                break;
            case "int-range":
                label = "int(0, 100)";
                value = stream.int(0, 100);
                break;
            case "unit":
                label = "unit()";
                value = stream.unit();
                break;
            case "float":
                label = "float(-10, 10)";
                value = stream.float(-10, 10);
                break;
            case "bytes":
                label = "bytes(16)";
                value = stream.bytes(16);
                break;
            case "vec2i":
                label = "intVec(2, 0, 256)";
                value = stream.intVec(2, 0, 256);
                break;
            case "vec3f":
                label = "floatVec(3, -1, 1)";
                value = stream.floatVec(3, -1, 1);
                break;
            case "vec4i":
                label = "intVec(4, 0, 100)";
                value = stream.intVec(4, 0, 100);
                break;
            case "mat2i":
                label = "intMatrix(2, 2, 0, 9)";
                value = stream.intMatrix(2, 2, 0, 9);
                break;
            case "mat3f":
                label = "floatMatrix(3, 3)";
                value = stream.floatMatrix(3, 3);
                break;
            case "hash":
                label = "hash()";
                value = stream.hash();
                break;
            case "hash-bytes":
                label = "hash({ bytes: 16 })";
                value = stream.hash({ bytes: 16 });
                break;
            default:
                value = "(unknown op)";
        }
        showOutput(label, formatValue(value));
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        showOutput(`${label} → error`, msg);
    }
}

function showOutput(label: string, value: string): void {
    els.output.innerHTML = "";
    const labelEl = document.createElement("span");
    labelEl.className = "label";
    labelEl.textContent = `${label} →`;
    els.output.appendChild(labelEl);
    els.output.appendChild(document.createTextNode("\n" + value));
}

// --- Sample warning (демо-симуляція) ---------------------------------
//
// Реальний warn з [voidstream] під час короткої демо-сесії побачити важко
// (5-хв floor планувальника). Тому кнопка просто емітить синтетичний
// console.warn з тим самим текстом, що використовує сама ліба —
// перехоплювач вище ловить його так само, як ловив би справжній.

const SAMPLE_WARNINGS = [
    `${WARN_PREFIX} entropy refresh failed before any network source could be reached — pool is operating on local entropy only`,
    `${WARN_PREFIX} entropy refresh failed 3 times in a row — pool may be stale`,
    `${WARN_PREFIX} crypto.getRandomValues is unavailable; pool bootstrapped from timing only — entropy is weak`,
    `${WARN_PREFIX} custom entropy source "my-source" failed to refresh: HTTP 503 service unavailable`,
];

let sampleIdx = 0;
els.sampleWarning.addEventListener("click", () => {
    console.warn(SAMPLE_WARNINGS[sampleIdx % SAMPLE_WARNINGS.length]);
    sampleIdx++;
});

// --- Messages panel --------------------------------------------------

function renderMessages(): void {
    els.messages.innerHTML = "";
    if (messages.length === 0) {
        const li = document.createElement("li");
        li.className = "placeholder";
        li.textContent = "no warnings — pool refreshes silently";
        els.messages.appendChild(li);
        return;
    }
    for (const m of messages.slice(0, 8)) {
        const li = document.createElement("li");
        const time = document.createElement("span");
        time.className = "time";
        time.textContent = formatClock(m.time);
        const text = document.createElement("span");
        text.className = "text";
        text.textContent = m.text;
        li.appendChild(time);
        li.appendChild(text);
        els.messages.appendChild(li);
    }
}

renderMessages();

// --- Noise field -----------------------------------------------------

const cells: HTMLDivElement[] = [];
buildNoiseGrid();
shuffleNoise();

let autoShuffleTimer: ReturnType<typeof setInterval> | null = null;

els.shuffle.addEventListener("click", () => shuffleNoise());
els.autoshuffle.addEventListener("click", () => {
    if (autoShuffleTimer) {
        clearInterval(autoShuffleTimer);
        autoShuffleTimer = null;
        els.autoshuffle.textContent = "auto: off";
    } else {
        autoShuffleTimer = setInterval(shuffleNoise, AUTO_SHUFFLE_MS);
        els.autoshuffle.textContent = "auto: on";
    }
});

function buildNoiseGrid(): void {
    els.noiseCanvas.style.setProperty("--cols", String(NOISE_COLS));
    for (let i = 0; i < NOISE_COLS * NOISE_ROWS; i++) {
        const cell = document.createElement("div");
        cell.className = "noise-cell";
        els.noiseCanvas.appendChild(cell);
        cells.push(cell);
    }
}

function shuffleNoise(): void {
    // Один bytes() запит вистачає для всієї сітки — ефективніше за
    // окремі int() виклики на кожну клітинку.
    const bytes = stream.bytes(cells.length * 3);
    for (let i = 0; i < cells.length; i++) {
        const r = bytes[i * 3] ?? 0;
        const g = bytes[i * 3 + 1] ?? 0;
        const b = bytes[i * 3 + 2] ?? 0;
        cells[i]!.style.background = `rgb(${r},${g},${b})`;
    }
}

// --- Утиліти форматування --------------------------------------------

function formatValue(value: unknown): string {
    if (value instanceof Uint8Array) {
        const hex = Array.from(value, (b) => b.toString(16).padStart(2, "0")).join(" ");
        return `Uint8Array(${value.length}) [ ${hex} ]`;
    }
    if (Array.isArray(value)) {
        const isMatrix = Array.isArray(value[0]);
        if (isMatrix) {
            return (value as number[][])
                .map((row) => row.map(formatNumber).join("  "))
                .join("\n");
        }
        return `[ ${(value as number[]).map(formatNumber).join(", ")} ]`;
    }
    if (typeof value === "number") return formatNumber(value);
    return String(value);
}

function formatNumber(n: number): string {
    if (Number.isInteger(n)) return String(n);
    return n.toFixed(6);
}

function formatClock(ms: number): string {
    const d = new Date(ms);
    const pad = (n: number) => n.toString().padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

window.addEventListener("beforeunload", () => {
    if (autoShuffleTimer) clearInterval(autoShuffleTimer);
});
