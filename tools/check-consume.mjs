// Smoke-test для всіх трьох форматів зібраної бібліотеки.
// Запуск:  node tools/check-consume.mjs
//
// Інстанс створюється БЕЗ опцій — це означає що активується повний
// дефолтний набір джерел. Планувальник стартує автоматично, але:
//   1. Має 5..15 хв initial delay перед першим fetch-ом.
//   2. Викликає setTimeout(...).unref() у Node, тому процес виходить
//      одразу після завершення тіла тесту, без очікування.
// Жодного мережевого запиту під час тесту не відбувається.
//
// `sources: []` навмисно НЕ передаємо — у нової семантики `sources`
// це означає "жодних додаткових кастомних", а не "вимкнути збір"
// (дефолтні неможливо вимкнути ззовні — це гарантія ліби).

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

const require = createRequire(import.meta.url);

function checkSurface(label, VoidStream) {
    const stream = new VoidStream();

    assert.equal(typeof stream.int(), "number", `${label}: int()`);
    const i = stream.int(0, 100);
    assert.ok(i >= 0 && i < 100, `${label}: int(0,100) out of range -> ${i}`);

    const u = stream.unit();
    assert.ok(u >= 0 && u < 1, `${label}: unit() out of range -> ${u}`);

    const f = stream.float(-10, 10);
    assert.ok(f >= -10 && f < 10, `${label}: float(-10,10) out of range -> ${f}`);

    const b = stream.bytes(16);
    assert.ok(b instanceof Uint8Array && b.length === 16, `${label}: bytes(16)`);

    const v3 = stream.floatVec(3, -1, 1);
    assert.equal(v3.length, 3, `${label}: floatVec(3) length`);
    v3.forEach((n) => assert.ok(n >= -1 && n < 1, `${label}: floatVec range`));

    const m = stream.intMatrix(2, 3, 0, 9);
    assert.equal(m.length, 2);
    assert.equal(m[0].length, 3);

    const h = stream.hash();
    assert.match(h, /^[0-9a-f]{64}$/, `${label}: hash hex`);

    const h2 = stream.hash({ bytes: 8 });
    assert.match(h2, /^[0-9a-f]{16}$/, `${label}: hash bytes`);

    // Чорний ящик: жодного публічного методу для керування, інтроспекції
    // або ЗОВНІШНЬОГО ДОМІШУВАННЯ ентропії не існує. `mix`, `feed`,
    // `seed` свідомо прибрані — ентропія входить лише через джерела.
    for (const banned of [
        "start",
        "stop",
        "isRunning",
        "isDegraded",
        "getStats",
        "getSources",
        "pull",
        "mix",
        "feed",
        "seed",
    ]) {
        assert.equal(
            stream[banned],
            undefined,
            `${label}: '${banned}' must not be on VoidStream instance`,
        );
    }

    // `hash({ salt })` колись існував і домішував salt у пул — це було
    // прихованим `mix()`. Зараз salt не приймається: hash() — чистий
    // read-only снімок. Перевіряємо, що salt не змінює довжину виходу
    // і не спричиняє жодного зайвого ефекту, який залежав би від нього.
    const hSalt = stream.hash({ bytes: 16, salt: "ignored" });
    assert.match(
        hSalt,
        /^[0-9a-f]{32}$/,
        `${label}: hash({bytes, salt}) — salt має ігноруватись`,
    );

    console.log(`  ok  ${label}`);
}

console.log("smoke-test: dist/lib bundles");

const esm = await import("../dist/lib/voidstream.js");
assert.ok(esm.VoidStream, "ESM: VoidStream missing");
// Старі імена бренду, tuning-константи, defaultSources, окремі імена
// вбудованих джерел — нічого з цього не повинно текти назовні.
for (const banned of [
    "Chaos",
    "ChaosOptions",
    "ChaosStats",
    "EntropyEvent",
    "SCHEDULER_FLOOR_MS",
    "Scheduler",
    "defaultSources",
    "isBuiltinSource",
    "coingecko",
    "githubEvents",
    "nasaEonet",
    "openMeteo",
    "usgsEarthquakes",
    "localContext",
]) {
    assert.equal(esm[banned], undefined, `ESM: '${banned}' must not be exported`);
}
checkSurface("ESM (voidstream.js)", esm.VoidStream);

const cjs = require("../dist/lib/voidstream.cjs");
assert.ok(cjs.VoidStream, "CJS: VoidStream missing");
checkSurface("CJS (voidstream.cjs)", cjs.VoidStream);

const umd = require("../dist/lib/voidstream.umd.cjs");
assert.ok(umd.VoidStream, "UMD: VoidStream missing");
checkSurface("UMD (voidstream.umd.cjs)", umd.VoidStream);

// .d.ts повинні не мати .ts-суфіксів у шляхах і не світити приватні типи.
const dts = await readFile(new URL("../dist/lib/types/index.d.ts", import.meta.url), "utf8");
assert.ok(
    dts.includes('export { VoidStream } from "./voidstream"'),
    ".d.ts: VoidStream export",
);
assert.ok(!dts.includes("Chaos"), ".d.ts: legacy 'Chaos' name must be gone");
const badImport = dts.match(/from\s+"[^"]*\.ts"/);
assert.equal(badImport, null, `.d.ts must not reference .ts paths, got: ${badImport?.[0]}`);
assert.ok(!dts.includes("ChaosStats"), ".d.ts must not re-export ChaosStats");
assert.ok(!dts.includes("EntropyEvent"), ".d.ts must not re-export EntropyEvent");

// Перевіримо, що у типах публічного фасада нема прибраних полів і
// натяків на колбеки, ручне керування життєвим циклом, або
// зовнішнє домішування у пул.
//
// Назви приватних полів TypeScript включає у .d.ts як
// `private readonly scheduler;` (без типу і без двокрапки), тому
// regex для опцій матчить саме декларацію `name?:` / `name:` —
// приватні поля проходять повз нього.
const optsDts = await readFile(
    new URL("../dist/lib/types/voidstream.d.ts", import.meta.url),
    "utf8",
);
const bannedOptions = [
    "autoStart",
    "onEntropy",
    "onError",
    "scheduler",
    "minIntervalMs",
    "maxIntervalMs",
    "initialDelayMs",
];
for (const name of bannedOptions) {
    const re = new RegExp(String.raw`(?:^|\W)${name}\??:`, "m");
    assert.ok(
        !re.test(optsDts),
        `.d.ts must not expose '${name}?:' as a public option`,
    );
}
const bannedTypes = ["ChaosSchedulerTuning", "ChaosOptions"];
for (const name of bannedTypes) {
    assert.ok(
        !optsDts.includes(name),
        `.d.ts must not expose type '${name}'`,
    );
}
// Реальні декларації методів у .d.ts завжди починаються з пробілів
// (індент тіла класу), без зірочки JSDoc-коментаря. Це дозволяє
// відрізнити справжній метод від згадки `mix()` у текстовому
// коментарі, що документує його відсутність.
const bannedMethods = ["start", "stop", "isRunning", "isDegraded", "mix", "feed"];
for (const m of bannedMethods) {
    const re = new RegExp(String.raw`^[ \t]+(?:private |readonly )?${m}\s*\(`, "m");
    assert.ok(
        !re.test(optsDts),
        `.d.ts must not expose method '${m}()' on the public VoidStream surface`,
    );
}
// `hash()` має тип лише з `bytes?:` — без `salt`. Перевіряємо, що в
// сигнатурі hash немає поля `salt`.
const hashSig = optsDts.match(/hash\([^)]*\)/);
assert.ok(hashSig, ".d.ts: hash() signature missing");
assert.ok(
    !hashSig[0].includes("salt"),
    `.d.ts: hash() must not accept 'salt' anymore, got: ${hashSig[0]}`,
);

// Самообслуговування scheduler-а: він НЕ повинен звертатися до Math.random.
// Підміняємо Math.random на трап (кидає при виклику) і setTimeout на спостерігач,
// створюємо кілька інстансів і перевіряємо:
//   1. Math.random жодного разу не викликана.
//   2. setTimeout викликано — це стартова затримка scheduler-а.
//   3. Затримка лежить у вікні [5хв, 15хв).
//   4. Дві незалежні VoidStream-сутності отримують РІЗНІ стартові затримки
//      — це доводить, що значення тягнеться з пулу, а не зі статичної
//      константи.
{
    const FIVE_MIN = 5 * 60 * 1000;
    const FIFTEEN_MIN = 15 * 60 * 1000;

    const origMathRandom = Math.random;
    const origSetTimeout = globalThis.setTimeout;
    let mathRandomCalls = 0;
    const observedDelays = [];

    Math.random = () => {
        mathRandomCalls++;
        throw new Error(
            "scheduler reached Math.random — its decisions must come from the voidstream pool",
        );
    };
    globalThis.setTimeout = (_fn, ms) => {
        observedDelays.push(ms);
        return { unref() {} };
    };

    try {
        const a = new esm.VoidStream();
        const b = new esm.VoidStream();
        void a;
        void b;

        assert.equal(
            mathRandomCalls,
            0,
            `Math.random was called ${mathRandomCalls} time(s); PRNG-backed scheduler must not depend on it`,
        );
        assert.ok(
            observedDelays.length >= 2,
            `expected each VoidStream to schedule once; got ${observedDelays.length} setTimeout calls`,
        );
        for (const d of observedDelays) {
            assert.ok(
                typeof d === "number" && d >= FIVE_MIN && d < FIFTEEN_MIN,
                `scheduler delay ${d} ms must be in [${FIVE_MIN}, ${FIFTEEN_MIN})`,
            );
        }
        assert.notEqual(
            observedDelays[0],
            observedDelays[1],
            "two independent VoidStream instances must pick different initial delays — otherwise PRNG isn't actually feeding the scheduler",
        );
    } finally {
        Math.random = origMathRandom;
        globalThis.setTimeout = origSetTimeout;
    }
    console.log(`  ok  scheduler uses voidstream-pool randomness (no Math.random hits)`);
}

console.log("all good");
