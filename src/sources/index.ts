import { coingecko } from "./coingecko";
import { githubEvents } from "./github";
import { localContext } from "./localContext";
import { nasaEonet } from "./nasaEonet";
import { openMeteo } from "./openMeteo";
import type { EntropySource } from "./types";
import { usgsEarthquakes } from "./usgs";

/**
 * Built-in джерела зберігаємо як module-level singleton-и і реєструємо
 * їхні референси у WeakSet. Це дає змогу за O(1) у Chaos з'ясувати,
 * чи прийшов source від нас, чи від користувача — БЕЗ модифікації
 * самих source-об'єктів (жодних маркер-полів типу `__builtin: true`,
 * жодних брендованих типів у `EntropySource` — щоб імплементори
 * власних джерел не бачили в типах нічого зайвого).
 */
const BUILTIN_SOURCES: readonly EntropySource[] = [
    usgsEarthquakes,
    openMeteo,
    coingecko,
    nasaEonet,
    githubEvents,
    // Не-мережеве, локальне джерело: завжди доступне, маленький payload,
    // тому природно вкладає менше "ваги" у пул, ніж мережеві.
    localContext,
];

const BUILTIN_SET = new WeakSet<EntropySource>();
for (const s of BUILTIN_SOURCES) BUILTIN_SET.add(s);

/**
 * Дефолтний набір джерел. Можна замінювати свій список через ChaosOptions.sources,
 * або просто додавати свої реалізації EntropySource поряд із цими.
 */
export function defaultSources(): EntropySource[] {
    return [...BUILTIN_SOURCES];
}

/**
 * Внутрішній хелпер: повертає true, якщо `source` — це один із наших
 * вбудованих об'єктів (порівняння за reference через WeakSet).
 * Свідомо не експортується з публічного `src/index.ts` — потрібно
 * лише `Chaos`, щоб розрізняти, як трактувати помилку refresh-у.
 */
export function isBuiltinSource(source: EntropySource): boolean {
    return BUILTIN_SET.has(source);
}

export type { EntropySource };
