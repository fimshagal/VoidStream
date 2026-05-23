// Smoke-test для всіх трьох форматів зібраної бібліотеки.
// Запуск:  node tools/check-consume.mjs
//
// Інстанс створюється БЕЗ опцій — це означає що активується повний
// дефолтний набір джерел. Планувальник стартує автоматично, але:
//   1. Перший fetch має короткий jitter [0, 1500ms); подальші — у вікні
//      5..15 хв.
//   2. Викликає setTimeout(...).unref() у Node, тому процес виходить
//      одразу після завершення тіла тесту, без очікування таймера.
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

    const h = stream.hex();
    assert.match(h, /^[0-9a-f]{64}$/, `${label}: hex()`);

    const h2 = stream.hex({ bytes: 8 });
    assert.match(h2, /^[0-9a-f]{16}$/, `${label}: hex({bytes: 8})`);

    // Legacy alias — має повертати те саме, що hex().
    const hAlias = stream.hash({ bytes: 8 });
    assert.match(hAlias, /^[0-9a-f]{16}$/, `${label}: hash() alias`);

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
    // прихованим `mix()`. Зараз salt не приймається: hex() — чистий
    // read-only снімок. Перевіряємо, що salt не змінює довжину виходу.
    const hSalt = stream.hex({ bytes: 16, salt: "ignored" });
    assert.match(
        hSalt,
        /^[0-9a-f]{32}$/,
        `${label}: hex({bytes, salt}) — salt має ігноруватись`,
    );

    // Rejection sampling: int(0, 4) має давати рівномірний розподіл.
    // 10k draws — chi-square не робимо, але кожен bucket має з'явитись.
    const buckets = [0, 0, 0, 0];
    for (let t = 0; t < 10_000; t++) {
        const idx = stream.int(0, 4);
        buckets[idx]++;
    }
    for (const count of buckets) {
        assert.ok(count > 0, `${label}: int(0,4) rejection sampling — empty bucket`);
    }

    // Sugar-методи: pick / chance / shuffle.
    const palette = ["a", "b", "c", "d"];
    for (let k = 0; k < 8; k++) {
        const v = stream.pick(palette);
        assert.ok(palette.includes(v), `${label}: pick must return element from input`);
    }
    assert.throws(
        () => stream.pick([]),
        RangeError,
        `${label}: pick([]) must throw`,
    );

    assert.equal(stream.chance(0), false, `${label}: chance(0) === false`);
    assert.equal(stream.chance(1), true, `${label}: chance(1) === true`);
    assert.equal(stream.chance(-0.5), false, `${label}: chance(<0) === false`);
    assert.equal(stream.chance(1.5), true, `${label}: chance(>1) === true`);
    assert.equal(typeof stream.chance(0.5), "boolean", `${label}: chance(0.5) is boolean`);
    assert.throws(() => stream.chance(NaN), RangeError, `${label}: chance(NaN) throws`);
    assert.throws(() => stream.chance(Infinity), RangeError, `${label}: chance(Inf) throws`);

    const src = [1, 2, 3, 4, 5];
    const srcCopy = src.slice();
    const shuffled = stream.shuffle(src);
    assert.equal(shuffled.length, src.length, `${label}: shuffle preserves length`);
    assert.deepEqual(
        shuffled.slice().sort((x, y) => x - y),
        src.slice().sort((x, y) => x - y),
        `${label}: shuffle preserves multiset`,
    );
    assert.deepEqual(src, srcCopy, `${label}: shuffle must not mutate input`);
    assert.equal(stream.shuffle([]).length, 0, `${label}: shuffle([]) === []`);

    // Coverage: щойно сконструйований інстанс ще не отримав жодного
    // tick-у (setTimeout-и unref'нуті і Node вийде до їх firing-у).
    // Тому coverage має бути рівно 0 — типобезпечно і у валідному
    // діапазоні. Будь-яке інше значення тут — баг.
    assert.equal(typeof stream.coverage, "number", `${label}: coverage is number`);
    assert.equal(
        stream.coverage,
        0,
        `${label}: fresh instance must have coverage === 0 before any tick`,
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
// `hex()` має тип лише з `bytes?:` — без `salt`. Перевіряємо, що в
// сигнатурі hex немає поля `salt`.
const hexSig = optsDts.match(/hex\([^)]*\)/);
assert.ok(hexSig, ".d.ts: hex() signature missing");
assert.ok(
    !hexSig[0].includes("salt"),
    `.d.ts: hex() must not accept 'salt', got: ${hexSig[0]}`,
);
// hash() лишається як alias — перевіряємо що він є.
assert.ok(optsDts.includes("hash("), ".d.ts: hash() alias must remain");

// Самообслуговування scheduler-а: він НЕ повинен звертатися до Math.random,
// а перший fetch має призначатися на короткий jitter [0, 1500ms), а не
// чекати 5+ хв як раніше. Підміняємо Math.random на трап і setTimeout
// на спостерігач, створюємо два інстанси і перевіряємо:
//   1. Math.random жодного разу не викликана.
//   2. Кожен інстанс викликав setTimeout — це стартова затримка.
//   3. Початкова затримка лежить у вікні [0, INITIAL_MAX_MS).
//   4. Дві незалежні VoidStream-сутності отримують РІЗНІ стартові затримки
//      — це доводить, що значення тягнеться з пулу, а не зі статичної
//      константи.
{
    const INITIAL_MAX_MS = 1500;

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
                typeof d === "number" && d >= 0 && d < INITIAL_MAX_MS,
                `initial scheduler delay ${d} ms must be in [0, ${INITIAL_MAX_MS}) — first fetch should be fast`,
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
    console.log(`  ok  initial fetch is scheduled fast (jittered <1500ms) from voidstream pool`);
}

// Після першого tick-у при coverage < 50% наступна затримка — warmup
// (2..10 с), не довгий steady-інтервал.
{
    const WARMUP_MIN = 2_000;
    const WARMUP_MAX = 10_000;

    const origSetTimeout = globalThis.setTimeout;
    const origFetch = globalThis.fetch;
    const allDelays = [];
    let firedFirst = false;

    globalThis.setTimeout = (fn, ms) => {
        allDelays.push(ms);
        if (!firedFirst) {
            firedFirst = true;
            queueMicrotask(() => {
                try { fn(); } catch { /* swallow */ }
            });
        }
        return { unref() {} };
    };
    globalThis.fetch = async () => new Response("stub-data-" + Date.now(), { status: 200 });

    try {
        const s = new esm.VoidStream();

        for (let i = 0; i < 200 && allDelays.length < 2; i++) {
            await Promise.resolve();
        }
        if (allDelays.length < 2) {
            await new Promise((r) => origSetTimeout(r, 50));
        }

        const subsequent = allDelays.slice(1);
        assert.ok(
            subsequent.length >= 1,
            `expected scheduler to plan at least one follow-up tick; got delays ${JSON.stringify(allDelays)}`,
        );
        assert.ok(
            s.coverage > 0 && s.coverage < 0.5,
            `expected warmup coverage after one tick, got ${s.coverage}`,
        );
        for (const d of subsequent) {
            assert.ok(
                typeof d === "number" && d >= WARMUP_MIN && d < WARMUP_MAX,
                `warmup scheduler delay ${d} ms must be in [${WARMUP_MIN}, ${WARMUP_MAX}) while coverage < 50%`,
            );
        }
    } finally {
        globalThis.setTimeout = origSetTimeout;
        globalThis.fetch = origFetch;
    }
    console.log(`  ok  warmup interval (2..10s) while coverage < 50%`);
}

// Поки coverage < 60% планувальник тягне лише з ще не доставлених
// джерел — не застрягає на повторному localContext (~17%).
{
    const origSetTimeout = globalThis.setTimeout;
    const origFetch = globalThis.fetch;

    globalThis.setTimeout = (fn, _ms) => {
        queueMicrotask(() => {
            try { fn(); } catch { /* swallow */ }
        });
        return { unref() {} };
    };
    globalThis.fetch = async () => new Response("stub-" + Date.now(), { status: 200 });

    try {
        const s = new esm.VoidStream();
        // 6 built-in sources; localContext не використовує fetch. Даємо
        // час на кілька послідовних tick-ів (async fetch + seedMix).
        for (let i = 0; i < 400; i++) {
            await Promise.resolve();
        }
        await new Promise((r) => origSetTimeout(r, 100));

        assert.ok(
            s.coverage >= 0.6,
            `expected coverage >= 60% after probing undelivered sources (got ${s.coverage})`,
        );
    } finally {
        globalThis.setTimeout = origSetTimeout;
        globalThis.fetch = origFetch;
    }
    console.log(`  ok  undelivered sources prioritized until coverage >= 60%`);
}

console.log("all good");
