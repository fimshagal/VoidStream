import { Xoshiro128ss } from "./prng";
import { Scheduler } from "./scheduler";
import {
    defaultSources,
    isBuiltinSource,
    type EntropySource,
} from "./sources/index";
import { localContext } from "./sources/localContext";
import { concatBytes, encodeString, timingBytes, toHex, unrefTimer } from "./utils";

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

/** Пороги coverage для адаптивного інтервалу refresh-у. */
const COVERAGE_WARMUP_BELOW = 0.5;
const COVERAGE_STEADY_ABOVE = 0.6;

/** Поки coverage < 50% — часті tick-и для швидкого наповнення пулу. */
const DELAY_WARMUP_MIN_MS = 2_000;
const DELAY_WARMUP_MAX_MS = 10_000;

/** Перехід 50–60% — помірне уповільнення. */
const DELAY_MID_MIN_MS = 10_000;
const DELAY_MID_MAX_MS = 60_000;

/** coverage ≥ 60% — штатний довгий режим. */
const DELAY_STEADY_MIN_MS = 5 * 60_000;
const DELAY_STEADY_MAX_MS = 15 * 60_000;

/** Локальний idle-stir: `localContext` + timing, без HTTP. */
const LOCAL_STIR_MIN_MS = 1_000;
const LOCAL_STIR_MAX_MS = 3_000;

/**
 * VoidStream — фасад над пулом ентропії та PRNG.
 *
 * Контракт:
 *   1. Конструктор синхронно засіває пул локальною ентропією
 *      (`crypto.getRandomValues` + контекст середовища) і одразу
 *      запускає фоновий планувальник.
 *   2. У фоні пул довишивається з публічних джерел відкритих даних
 *      (scheduler) і паралельно з локального `localContext` (idle-stir
 *      кожні 1..3 с, без мережі). Інтервал мережевих refresh-ів
 *      адаптивний до coverage (частіше, поки < 50%; рідше від 60%).
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
    private localStirTimer: ReturnType<typeof setTimeout> | null = null;

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
    /** Усі джерела пулу (default + custom) — той самий список, що й у Scheduler. */
    private readonly sources: EntropySource[];
    private readonly totalSourcesCount: number;

    constructor(opts: VoidStreamOptions = {}) {
        this.bootstrap();
        // Дефолтні джерела завжди йдуть першими і завжди присутні.
        // Кастомні (якщо є) додаються поверх — споживач НЕ може ні
        // вимкнути, ні підмінити вбудовані. Це частина гарантій
        // black-box-моделі: пул завжди харчується з відомого нам
        // набору; ззовні можна лише розширювати.
        const customSources = opts.sources ?? [];
        this.sources = [...defaultSources(), ...customSources];
        this.totalSourcesCount = this.sources.length;
        this.scheduler = new Scheduler({
            sources: this.sources,
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
            nextDelayMs: () => this.scheduleDelayMs(),
            pickSource: () => this.pickRefreshSource(),
        });
        this.scheduler.start();
        this.startLocalStir();
    }

    /**
     * Фоновий локальний stir: `localContext.fetch()` → `seedMix`.
     * Працює паралельно з мережевим scheduler-ом, не викликає HTTP і
     * свідомо не скидає `consecutiveFailures` — інакше успішний local
     * stir маскував би серію мережевих невдач.
     */
    private startLocalStir(): void {
        if (this.localStirTimer !== null) return;
        this.scheduleLocalStir();
    }

    private scheduleLocalStir(): void {
        const range = LOCAL_STIR_MAX_MS - LOCAL_STIR_MIN_MS;
        const delay = LOCAL_STIR_MIN_MS + this.prng.nextUnit() * range;
        this.localStirTimer = setTimeout(() => {
            this.localStirTimer = null;
            void this.localStirTick();
        }, delay);
        unrefTimer(this.localStirTimer);
    }

    private async localStirTick(): Promise<void> {
        try {
            const bytes = await localContext.fetch();
            await this.prng.seedMix(bytes);
            this.deliveredSources.add(localContext);
        } catch {
            // localContext у штатному середовищі не падає
        } finally {
            this.scheduleLocalStir();
        }
    }

    /**
     * Поки coverage < 60% — тягнемо лише з джерел, що ще не доставляли
     * байти. Інакше випадковий pick часто повторює localContext (завжди
     * OK) і пул довго сидить на ~17%, без warn-ів (успіх скидає лічильник
     * невдач). Після досягнення порогу — звичайний random по всьому списку.
     */
    private pickRefreshSource(): EntropySource {
        if (this.coverage < COVERAGE_STEADY_ABOVE) {
            const pending = this.sources.filter((s) => !this.deliveredSources.has(s));
            if (pending.length > 0) {
                const idx = Math.floor(this.prng.nextUnit() * pending.length);
                return pending[idx]!;
            }
        }
        const idx = Math.floor(this.prng.nextUnit() * this.sources.length);
        return this.sources[idx]!;
    }

    /**
     * Інтервал до наступного фонового fetch-у залежно від coverage.
     * Перший tick планувальник ставить окремо (cold-start jitter).
     *
     *   coverage < 50%  → 2..10 с
     *   50% ≤ c < 60%   → 10 с..1 хв
     *   coverage ≥ 60%  → 5..15 хв
     */
    private scheduleDelayMs(): number {
        const c = this.coverage;
        let minMs: number;
        let maxMs: number;
        if (c < COVERAGE_WARMUP_BELOW) {
            minMs = DELAY_WARMUP_MIN_MS;
            maxMs = DELAY_WARMUP_MAX_MS;
        } else if (c < COVERAGE_STEADY_ABOVE) {
            minMs = DELAY_MID_MIN_MS;
            maxMs = DELAY_MID_MAX_MS;
        } else {
            minMs = DELAY_STEADY_MIN_MS;
            maxMs = DELAY_STEADY_MAX_MS;
        }
        return minMs + this.prng.nextUnit() * (maxMs - minMs);
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
     *                     на bootstrap-ентропії. Локальний idle-stir
     *                     (1..3 с) швидко додає `localContext`; coverage
     *                     може стати > 0 ще до першого мережевого tick-у.
     *   - проміжне      — частина джерел доставила; планувальник частіше
     *                     tick-ає (2..10 с), поки coverage < 50%, і
     *                     пріоритезує ще не доставлені джерела, поки < 60%
     *   - наближається до `1` — усі джерела доставили; перехід на
     *                     рідкий режим 5..15 хв (від coverage ≥ 60%)
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
