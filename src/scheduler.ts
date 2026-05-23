import type { EntropySource } from "./sources/types";

export interface SchedulerOptions {
    /** Список джерел; порожній масив фактично вимикає фоновий збір. */
    sources: EntropySource[];
    /** Викликається коли черговий fetch завершився успішно. */
    onEntropy: (bytes: Uint8Array, source: EntropySource) => void;
    /**
     * Викликається при помилці джерела. Прокидаємо повний source-об'єкт
     * (а не лише його name), щоб споживач коллбеку міг ідентифікувати
     * джерело за reference — це потрібно для розрізнення built-in vs
     * custom у VoidStream.
     */
    onError?: (err: unknown, source: EntropySource) => void;
    /**
     * Нижня межа інтервалу між послідовними викликами (мс).
     * Жорсткий floor: 5 хвилин — це обмеження зменшує навантаження
     * на безкоштовні API та робить тік-моменти "розкиданими".
     */
    minIntervalMs?: number;
    /** Верхня межа інтервалу між викликами (мс). */
    maxIntervalMs?: number;
    /**
     * Джерело випадковості для ВНУТРІШНІХ рішень планувальника:
     *   - скільки чекати до наступного fetch-у,
     *   - яке джерело тягнути цього разу,
     *   - наскільки відкладається перший fetch після start().
     *
     * Очікується функція, що повертає float у [0, 1). Якщо не задано
     * — fallback на `Math.random`, але це шлях "захиститись від
     * NPE", а не задумка. У реальному використанні VoidStream передає
     * сюди тяг із власного xoshiro-PRNG, який уже засіяний з
     * `crypto.getRandomValues`. Це означає, що самі моменти оновлень
     * пулу неможливо передбачити навіть знаючи час інстанціювання
     * VoidStream: вони визначаються тим же шумом, який ліба роздає клієнту.
     */
    random?: () => number;
}

const FIVE_MIN = 5 * 60 * 1000;
const FIFTEEN_MIN = 15 * 60 * 1000;

/**
 * `setTimeout` у Node повертає об'єкт `Timeout` з методом `.unref()`, який
 * прибирає таймер з лічильника подій runtime — тобто Node-процес зможе
 * вийти, навіть якщо ще є невиконаний таймер. У браузері `setTimeout`
 * повертає number, і ця операція не потрібна (там цикл подій тримається
 * сторінкою, а не таймером).
 *
 * Це критично для тестів і скриптів, які створюють VoidStream: інакше
 * Node висне до першого планового fetch-у, якого ми не хочемо.
 */
function unrefTimer(t: ReturnType<typeof setTimeout>): void {
    const handle = t as unknown as { unref?: () => void };
    if (typeof handle?.unref === "function") handle.unref();
}

/**
 * Фоновий планувальник, який раз на ~5..15 хв обирає випадкове джерело
 * і витягує з нього порцію ентропії. Не має публічного API — VoidStream
 * створює його у конструкторі і ніколи не зупиняє.
 *
 * Усі "ймовірні" рішення (затримка наступного тіку, вибір джерела)
 * тягнуться через `opts.random()`, який у production підключений до
 * пулу самої VoidStream. Перший fetch так само призначається на випадковий
 * момент у [minMs, maxMs] — без фіксованої "стартової" константи,
 * щоб не давати спостерігачеві опорної точки на кшталт "точно через
 * 5 хв після завантаження сторінки".
 */
export class Scheduler {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private inflight = false;
    private readonly minMs: number;
    private readonly maxMs: number;

    constructor(private readonly opts: SchedulerOptions) {
        this.minMs = Math.max(FIVE_MIN, opts.minIntervalMs ?? FIVE_MIN);
        this.maxMs = Math.max(this.minMs, opts.maxIntervalMs ?? FIFTEEN_MIN);
    }

    /**
     * Запускає планувальник. Викликається з конструктора VoidStream.
     * Defensive guard: якщо джерел все ж нема (на практиці не буває,
     * бо VoidStream завжди передає принаймні дефолтний набір), мовчки
     * нічого не робимо.
     */
    start(): void {
        if (this.opts.sources.length === 0) return;
        if (this.timer !== null) return;
        this.scheduleIn(this.randomDelay());
    }

    /**
     * Float у [0, 1) для внутрішніх рішень. Тягнемо з PRNG, який нам
     * передає VoidStream. Math.random — лише запасний шлях для defensive
     * defaults, у штатній роботі сюди не доходимо.
     */
    private next01(): number {
        return this.opts.random ? this.opts.random() : Math.random();
    }

    /** Випадкова затримка у [minMs, maxMs). */
    private randomDelay(): number {
        const range = this.maxMs - this.minMs;
        return this.minMs + this.next01() * range;
    }

    private scheduleIn(ms: number): void {
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.tick();
        }, ms);
        unrefTimer(this.timer);
    }

    private async tick(): Promise<void> {
        if (this.inflight) return;
        this.inflight = true;
        const src = this.pickSource();
        try {
            const bytes = await src.fetch();
            this.opts.onEntropy(bytes, src);
        } catch (err) {
            this.opts.onError?.(err, src);
        } finally {
            this.inflight = false;
            this.scheduleIn(this.randomDelay());
        }
    }

    private pickSource(): EntropySource {
        const s = this.opts.sources;
        const idx = Math.floor(this.next01() * s.length);
        return s[idx]!;
    }
}
