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
 * Параметри VoidStream.
 *
 * Свідомо мінімальні. ЄДИНЕ, що можна додавати — це власні джерела
 * ентропії ПОВЕРХ стандартного набору. Вимкнути дефолтні джерела
 * або замінити їх неможливо — це частина гарантій ліби: пул завжди
 * харчується з відомого нам набору, а кастомні джерела можуть лише
 * додавати, а не відбирати.
 *
 * Тайминги планувальника, інтервали, затримки, колбеки, прапорці
 * auto-start, ручки життєвого циклу — все це навмисно ВІДСУТНЄ і
 * є внутрішньою деталлю реалізації. Так само свідомо НЕМАЄ методу
 * для домішування довільних даних у пул ззовні: жодного `mix()`,
 * `feed()`, `seed()` після конструктора. Єдиний канал входу — це
 * джерела (вбудовані + ваші кастомні, додані під час `new VoidStream(...)`).
 * Єдиний канал виходу, крім випадкових значень — `console.warn`
 * з префіксом `[voidstream]`, коли пул не вдається оновити.
 */
export interface VoidStreamOptions {
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
 * VoidStream — фасад над пулом ентропії та PRNG.
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
 *   4. Жодного способу домішати дані в пул ззовні: тільки через
 *      власні джерела, передані під час конструювання.
 *   5. Якщо щось іде не так — лише `console.warn` з префіксом
 *      `[voidstream]`. Жодного публічного способу зупинити,
 *      перевірити або форсувати оновлення немає.
 */
export class VoidStream {
    private readonly prng = new Xoshiro128ss();
    private readonly scheduler: Scheduler;

    // Внутрішні лічильники для одноразових warn-ів. Жодне з цих полів
    // не доступне ззовні і не впливає на API.
    private consecutiveFailures = 0;
    private everSucceeded = false;
    private warnedAboutInitialFailure = false;
    private warnedAboutRepeatedFailure = false;
    private warnedAboutWeakBootstrap = false;

    // Відстеження покриття джерел: тримаємо референси на ті джерела,
    // що хоча б раз успішно доставили байти. Використовується тільки
    // публічним геттером `coverage`. WeakSet недоречно — нам потрібен
    // `.size`, а Set<EntropySource> працює за reference (source-об'єкти
    // — модульні singleton-и, тому ідентичність стабільна).
    private readonly deliveredSources = new Set<EntropySource>();
    private readonly totalSourcesCount: number;

    constructor(opts: VoidStreamOptions = {}) {
        this.bootstrap();
        // Дефолтні джерела завжди йдуть першими і завжди присутні.
        // Кастомні (якщо є) додаються поверх — споживач НЕ може ні
        // вимкнути, ні підмінити вбудовані. Це частина гарантій
        // black-box-моделі: пул завжди харчується з відомого нам
        // набору; ззовні можна лише розширювати.
        const customSources = opts.sources ?? [];
        const allSources = [...defaultSources(), ...customSources];
        this.totalSourcesCount = allSources.length;
        this.scheduler = new Scheduler({
            sources: allSources,
            onEntropy: (bytes, source) => this.handleRefreshSuccess(bytes, source),
            onError: (err, source) => this.handleRefreshFailure(err, source),
            // Самообслуговування ліби тягнеться з її ж пулу. До цього
            // моменту PRNG уже засіяний у bootstrap() з crypto.getRandomValues
            // (плюс контекст середовища і timing), тому навіть найперший
            // nextUnit() уже криптографічно сильний. Підмішування у стан
            // на кожен tick робить наступні рішення планувальника
            // функцією від щойно зібраної мережевої ентропії — тобто
            // спостерігач, який не бачив тих байтів, не може відновити
            // момент наступного оновлення.
            random: () => this.prng.nextUnit(),
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
                "[voidstream] crypto.getRandomValues is unavailable; pool bootstrapped from timing only — entropy is weak",
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

    private async handleRefreshSuccess(
        bytes: Uint8Array,
        source: EntropySource,
    ): Promise<void> {
        await this.prng.seedMix(bytes);
        this.consecutiveFailures = 0;
        this.everSucceeded = true;
        this.deliveredSources.add(source);
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
                `[voidstream] custom entropy source "${source.name}" failed to refresh: ${reason}`,
            );
            return;
        }

        // Дефолтне джерело: лише генерична логіка, без імен.
        this.consecutiveFailures++;

        if (!this.everSucceeded && !this.warnedAboutInitialFailure) {
            console.warn(
                "[voidstream] entropy refresh failed before any network source could be reached — pool is operating on local entropy only",
            );
            this.warnedAboutInitialFailure = true;
            return;
        }

        if (
            this.consecutiveFailures >= REPEATED_FAILURE_THRESHOLD &&
            !this.warnedAboutRepeatedFailure
        ) {
            console.warn(
                `[voidstream] entropy refresh failed ${this.consecutiveFailures} times in a row — pool may be stale`,
            );
            this.warnedAboutRepeatedFailure = true;
        }
    }

    // --- Публічний API: тільки те, що виробляє значення ---------------
    //
    // Свідомо НЕ маємо тут жодного методу для домішування даних у пул
    // ззовні (`mix`, `feed`, `seed` тощо). Єдиний легальний шлях
    // підкинути власну ентропію — це передати кастомне джерело під
    // час `new VoidStream({ sources: [...] })`. Так само свідомо
    // прибрали `salt` з `hex()`/`hash()` — раніше salt домішувався в PRNG,
    // що було еквівалентно `mix()`.

    /**
     * Покриття пулу: частка джерел, які хоч раз успішно доставили
     * байти, у форматі float у [0, 1].
     *
     * Інтерпретація:
     *   - `0`           — щойно після конструювання; пул живе лише
     *                     на bootstrap-ентропії (`crypto.getRandomValues`
     *                     + контекст середовища). Це безпечно для
     *                     більшості use cases, але мережевий шум сюди
     *                     ще не дотік.
     *   - проміжне      — частина джерел доставила, інші ще ні
     *                     (зазвичай через мережеві помилки чи
     *                     5..15-хв ритм планувальника).
     *   - наближається до `1` — пул отримав ентропію з усіх відомих
     *                     йому джерел і живе на повну ширину.
     *
     * Що це НЕ є:
     *   - не "скільки байт у пулі" (xoshiro має фіксований 128-бітний
     *     стан, а не байтовий буфер);
     *   - не "ентропія в бітах за Шенноном" (для цього треба було б
     *     знати справжній розподіл вхідних джерел);
     *   - не доказ того, що значення безпечні для криптографії —
     *     навіть при `coverage === 1` це все ще non-crypto PRNG.
     *
     * Імена джерел та їх кількість назовні не розкриваються — лише
     * агрегований відсоток.
     */
    get coverage(): number {
        if (this.totalSourcesCount === 0) return 0;
        return this.deliveredSources.size / this.totalSourcesCount;
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
        return lo + unbiasedInt(this.prng, hi - lo);
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
     * Випадковий елемент масиву (uniform). Кидає `RangeError` на
     * порожньому масиві — пуста вибірка завжди є помилкою програміста,
     * мовчазне `undefined` маскувало б її.
     */
    pick<T>(items: readonly T[]): T {
        if (items.length === 0) {
            throw new RangeError("pick(items): items must be non-empty");
        }
        return items[this.int(0, items.length)]!;
    }

    /**
     * Випадкове булеве з ймовірністю `p` отримати `true`.
     * `p` свідомо клампиться: `<= 0` → завжди `false`, `>= 1` → завжди
     * `true`. NaN/Infinity відхиляються RangeError-ом.
     */
    chance(p: number): boolean {
        if (!Number.isFinite(p)) {
            throw new RangeError("chance(p): p must be a finite number");
        }
        if (p <= 0) return false;
        if (p >= 1) return true;
        return this.unit() < p;
    }

    /**
     * Повертає НОВУ перетасовану копію масиву (Fisher–Yates). Вхідний
     * масив не мутується — це робить метод безпечним для readonly-входу
     * і узгоджує його з рештою API, яка завжди повертає, а не пише.
     */
    shuffle<T>(items: readonly T[]): T[] {
        const out = items.slice();
        for (let i = out.length - 1; i > 0; i--) {
            const j = this.int(0, i + 1);
            const tmp = out[i]!;
            out[i] = out[j]!;
            out[j] = tmp;
        }
        return out;
    }

    /**
     * Hex-рядок з N випадкових байтів пулу. Це **не** криптографічний
     * хеш — лише зручне текстове представлення draw-у, як `bytes(n)`
     * у hex-форматі.
     */
    hex(opts: { bytes?: number } = {}): string {
        const len = opts.bytes ?? 32;
        if (!Number.isInteger(len) || len <= 0) {
            throw new RangeError("hex({bytes}): bytes must be a positive integer");
        }
        return toHex(this.prng.nextBytes(len));
    }

    /**
     * Alias для `hex()`. Залишено для зворотної сумісності.
     * Назва навмисно misleading — це **не** SHA-256 чи інший crypto hash.
     * Prefer `hex()`.
     */
    hash(opts: { bytes?: number } = {}): string {
        return this.hex(opts);
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

const UINT32_MOD = 0x1_0000_0000;

/**
 * Uniform integer у [0, range) без modulo bias (rejection sampling).
 * Для range === 2^32 — повертає повний uint32 напряму.
 */
function unbiasedInt(prng: Xoshiro128ss, range: number): number {
    if (range <= 0) {
        throw new RangeError("unbiasedInt: range must be positive");
    }
    if (range === 1) return 0;
    if (range >= UINT32_MOD) return prng.next() >>> 0;

    const threshold = UINT32_MOD - (UINT32_MOD % range);
    let r: number;
    do {
        r = prng.next() >>> 0;
    } while (r >= threshold);
    return r % range;
}
