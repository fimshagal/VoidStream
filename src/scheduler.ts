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
     * custom у Chaos.
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
    /** Затримка перед першим fetch-ом після start(). За замовчуванням — 5 хв. */
    initialDelayMs?: number;
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
 * Це критично для тестів і скриптів, які створюють Chaos: інакше
 * Node висне на 5 хв, чекаючи перший плановий fetch, якого ми не хочемо.
 */
function unrefTimer(t: ReturnType<typeof setTimeout>): void {
    const handle = t as unknown as { unref?: () => void };
    if (typeof handle?.unref === "function") handle.unref();
}

/**
 * Фоновий планувальник, який раз на ~5..15 хв обирає випадкове джерело
 * і витягує з нього порцію ентропії. Не має публічного API — Chaos
 * створює його у конструкторі і ніколи не зупиняє.
 */
export class Scheduler {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private inflight = false;
    private readonly minMs: number;
    private readonly maxMs: number;
    private readonly initialMs: number;

    constructor(private readonly opts: SchedulerOptions) {
        this.minMs = Math.max(FIVE_MIN, opts.minIntervalMs ?? FIVE_MIN);
        this.maxMs = Math.max(this.minMs, opts.maxIntervalMs ?? FIFTEEN_MIN);
        this.initialMs = Math.max(0, opts.initialDelayMs ?? FIVE_MIN);
    }

    /**
     * Запускає планувальник. Викликається з конструктора Chaos.
     * Defensive guard: якщо джерел все ж нема (на практиці не буває,
     * бо Chaos завжди передає принаймні дефолтний набір), мовчки
     * нічого не робимо.
     */
    start(): void {
        if (this.opts.sources.length === 0) return;
        if (this.timer !== null) return;
        this.scheduleIn(this.initialMs);
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
            this.scheduleAnother();
        }
    }

    private scheduleAnother(): void {
        const range = this.maxMs - this.minMs;
        const delay = this.minMs + Math.random() * range;
        this.scheduleIn(delay);
    }

    private pickSource(): EntropySource {
        const s = this.opts.sources;
        const idx = Math.floor(Math.random() * s.length);
        return s[idx]!;
    }
}

