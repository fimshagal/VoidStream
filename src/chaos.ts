import { Xoshiro128ss } from "./prng";
import { Scheduler } from "./scheduler";
import {
    defaultSources,
    isBuiltinSource,
    type EntropySource,
} from "./sources/index";
import { concatBytes, encodeString, timingBytes, toHex } from "./utils";

export type VecLen = 1 | 2 | 3 | 4;

/**
 * Параметри Chaos.
 *
 * Свідомо мінімальні. ЄДИНЕ, що можна додавати — це власні джерела
 * ентропії ПОВЕРХ стандартного набору. Вимкнути дефолтні джерела
 * або замінити їх неможливо — це частина гарантій ліби: пул завжди
 * харчується з відомого нам набору, а кастомні джерела можуть лише
 * додавати, а не відбирати.
 *
 * Тайминги планувальника, інтервали, затримки, колбеки, прапорці
 * auto-start, ручки життєвого циклу — все це навмисно ВІДСУТНЄ і
 * є внутрішньою деталлю реалізації. Єдиний канал назовні, крім
 * випадкових значень — `console.warn` з префіксом `[chaos]`, коли
 * пул не вдається оновити.
 */
export interface ChaosOptions {
    /**
     * Додаткові кастомні джерела, які потрапляють у пул паралельно
     * з вбудованими. Не замінює і не вимикає дефолтні — лише
     * розширює. `[]` (або відсутність опції) означає "жодних
     * додаткових", а не "вимкнути збір".
     */
    sources?: EntropySource[];
}

/** Скільки невдач підряд тригерять console.warn про "stale pool". */
const REPEATED_FAILURE_THRESHOLD = 3;

/**
 * Chaos — фасад над пулом ентропії та PRNG.
 *
 * Контракт:
 *   1. Конструктор синхронно засіває пул локальною ентропією
 *      (`crypto.getRandomValues` + контекст середовища) і одразу
 *      запускає фоновий планувальник.
 *   2. У фоні раз на 5..15 хв пул довишивається з кількох публічних
 *      джерел відкритих даних. Список джерел і таймінги назовні
 *      не повідомляються.
 *   3. Усі методи отримання значень працюють синхронно над поточним
 *      станом PRNG.
 *   4. Якщо щось іде не так — лише `console.warn` з префіксом
 *      `[chaos]`. Жодного публічного способу зупинити, перевірити
 *      або форсувати оновлення немає.
 */
export class Chaos {
    private readonly prng = new Xoshiro128ss();
    private readonly scheduler: Scheduler;

    // Внутрішні лічильники для одноразових warn-ів. Жодне з цих полів
    // не доступне ззовні і не впливає на API.
    private consecutiveFailures = 0;
    private everSucceeded = false;
    private warnedAboutInitialFailure = false;
    private warnedAboutRepeatedFailure = false;
    private warnedAboutWeakBootstrap = false;

    constructor(opts: ChaosOptions = {}) {
        this.bootstrap();
        // Дефолтні джерела завжди йдуть першими і завжди присутні.
        // Кастомні (якщо є) додаються поверх — споживач НЕ може ні
        // вимкнути, ні підмінити вбудовані. Це частина гарантій
        // black-box-моделі: пул завжди харчується з відомого нам
        // набору; ззовні можна лише розширювати.
        const customSources = opts.sources ?? [];
        this.scheduler = new Scheduler({
            sources: [...defaultSources(), ...customSources],
            onEntropy: (bytes) => this.handleRefreshSuccess(bytes),
            onError: (err, source) => this.handleRefreshFailure(err, source),
        });
        this.scheduler.start();
    }

    // --- Bootstrap і прийом ентропії (приватні) -----------------------

    private bootstrap(): void {
        const seed = new Uint8Array(32);
        let usedStrongSource = false;
        if (typeof crypto !== "undefined" && crypto.getRandomValues) {
            crypto.getRandomValues(seed);
            usedStrongSource = true;
        } else {
            for (let i = 0; i < seed.length; i += 8) {
                const t = timingBytes();
                for (let j = 0; j < 8 && i + j < seed.length; j++) {
                    seed[i + j] = t[j] ?? 0;
                }
            }
        }
        const env = encodeString(this.environmentString());
        this.prng.seed(concatBytes(seed, env, timingBytes()));

        if (!usedStrongSource && !this.warnedAboutWeakBootstrap) {
            console.warn(
                "[chaos] crypto.getRandomValues is unavailable; pool bootstrapped from timing only — entropy is weak",
            );
            this.warnedAboutWeakBootstrap = true;
        }
    }

    private environmentString(): string {
        const parts: string[] = [];
        if (typeof navigator !== "undefined") {
            parts.push(navigator.userAgent ?? "");
            parts.push(navigator.language ?? "");
            try {
                parts.push(Intl.DateTimeFormat().resolvedOptions().timeZone ?? "");
            } catch {
                // intl can throw in stripped environments; ignored
            }
        }
        if (typeof screen !== "undefined") {
            parts.push(`${screen.width}x${screen.height}x${screen.colorDepth}`);
        }
        parts.push(String(performance.now()));
        parts.push(String(Date.now()));
        return parts.join("|");
    }

    private handleRefreshSuccess(bytes: Uint8Array): void {
        this.prng.seed(bytes);
        this.consecutiveFailures = 0;
        this.everSucceeded = true;
        // Скидаємо прапор "вже попереджав", щоб наступна серія невдач
        // дала свіжий warn замість тиші.
        this.warnedAboutRepeatedFailure = false;
    }

    private handleRefreshFailure(err: unknown, source: EntropySource): void {
        // Для КАСТОМНИХ джерел (тих, що передав сам користувач) — завжди
        // іменний warn з причиною. Це його код / його endpoint, він має
        // повне право знати, що саме і чому впало.
        //
        // Лічильник consecutiveFailures і генеричні warn-и при цьому НЕ
        // чіпаємо — вони задумані як "загальний порядок" для дефолтних
        // джерел, які зсередини бібліотеки. Привертати до дефолтів
        // супер-увагу свідомо не хочемо.
        if (!isBuiltinSource(source)) {
            const reason = err instanceof Error ? err.message : String(err);
            console.warn(
                `[chaos] custom entropy source "${source.name}" failed to refresh: ${reason}`,
            );
            return;
        }

        // Дефолтне джерело: лише генерична логіка, без імен.
        this.consecutiveFailures++;

        if (!this.everSucceeded && !this.warnedAboutInitialFailure) {
            console.warn(
                "[chaos] entropy refresh failed before any network source could be reached — pool is operating on local entropy only",
            );
            this.warnedAboutInitialFailure = true;
            return;
        }

        if (
            this.consecutiveFailures >= REPEATED_FAILURE_THRESHOLD &&
            !this.warnedAboutRepeatedFailure
        ) {
            console.warn(
                `[chaos] entropy refresh failed ${this.consecutiveFailures} times in a row — pool may be stale`,
            );
            this.warnedAboutRepeatedFailure = true;
        }
    }

    // --- Публічний API: тільки те, що виробляє значення ---------------

    /** Влити власну ентропію (наприклад, користувацький salt). */
    mix(data: string | Uint8Array): void {
        const bytes = typeof data === "string" ? encodeString(data) : data;
        this.prng.seed(bytes);
    }

    /** N сирих байтів. */
    bytes(n: number): Uint8Array {
        if (!Number.isInteger(n) || n < 0) {
            throw new RangeError("bytes(n): n must be a non-negative integer");
        }
        return this.prng.nextBytes(n);
    }

    /** Float у [0, 1). */
    unit(): number {
        return this.prng.nextUnit();
    }

    /** Випадкове ціле у [min, max). За замовчуванням — [0, 2^32). */
    int(min = 0, max = 0x1_0000_0000): number {
        if (!Number.isFinite(min) || !Number.isFinite(max)) {
            throw new RangeError("int(min, max): finite numbers required");
        }
        const lo = Math.ceil(min);
        const hi = Math.floor(max);
        if (hi <= lo) {
            throw new RangeError(`int(min, max): max (${max}) must be > min (${min})`);
        }
        return lo + Math.floor(this.unit() * (hi - lo));
    }

    /** Float у [min, max). За замовчуванням — [0, 1). */
    float(min = 0, max = 1): number {
        if (!Number.isFinite(min) || !Number.isFinite(max)) {
            throw new RangeError("float(min, max): finite numbers required");
        }
        if (max <= min) {
            throw new RangeError(`float(min, max): max (${max}) must be > min (${min})`);
        }
        return min + this.unit() * (max - min);
    }

    /** Вектор довжини n (1..4) з цілих чисел. */
    intVec(n: VecLen, min = 0, max = 0x1_0000_0000): number[] {
        assertVecLen(n);
        const out: number[] = new Array(n);
        for (let i = 0; i < n; i++) out[i] = this.int(min, max);
        return out;
    }

    /** Вектор довжини n (1..4) з float-ів. */
    floatVec(n: VecLen, min = 0, max = 1): number[] {
        assertVecLen(n);
        const out: number[] = new Array(n);
        for (let i = 0; i < n; i++) out[i] = this.float(min, max);
        return out;
    }

    /** Матриця rows×cols з цілих чисел. */
    intMatrix(rows: number, cols: number, min = 0, max = 0x1_0000_0000): number[][] {
        assertMatrixDims(rows, cols);
        const out: number[][] = new Array(rows);
        for (let r = 0; r < rows; r++) {
            const row: number[] = new Array(cols);
            for (let c = 0; c < cols; c++) row[c] = this.int(min, max);
            out[r] = row;
        }
        return out;
    }

    /** Матриця rows×cols з float-ів. */
    floatMatrix(rows: number, cols: number, min = 0, max = 1): number[][] {
        assertMatrixDims(rows, cols);
        const out: number[][] = new Array(rows);
        for (let r = 0; r < rows; r++) {
            const row: number[] = new Array(cols);
            for (let c = 0; c < cols; c++) row[c] = this.float(min, max);
            out[r] = row;
        }
        return out;
    }

    /**
     * Hex-хеш, побудований із поточного пулу ентропії.
     * Якщо передати `salt`, він заздалегідь вливається у стан PRNG —
     * це робить вихід функцією від (поточний шум, salt).
     */
    hash(opts: { bytes?: number; salt?: string } = {}): string {
        const len = opts.bytes ?? 32;
        if (!Number.isInteger(len) || len <= 0) {
            throw new RangeError("hash({bytes}): bytes must be a positive integer");
        }
        if (opts.salt) this.mix(opts.salt);
        return toHex(this.prng.nextBytes(len));
    }
}

function assertVecLen(n: number): asserts n is VecLen {
    if (n !== 1 && n !== 2 && n !== 3 && n !== 4) {
        throw new RangeError(`vec length must be 1, 2, 3 or 4 (got ${n})`);
    }
}

function assertMatrixDims(rows: number, cols: number): void {
    if (!Number.isInteger(rows) || rows < 1) {
        throw new RangeError(`matrix rows must be a positive integer (got ${rows})`);
    }
    if (!Number.isInteger(cols) || cols < 1) {
        throw new RangeError(`matrix cols must be a positive integer (got ${cols})`);
    }
}
