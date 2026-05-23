// Smoke-test для всіх трьох форматів зібраної бібліотеки.
// Запуск:  node tools/check-consume.mjs
//
// Інстанс створюється БЕЗ опцій — це означає що активується повний
// дефолтний набір джерел. Планувальник стартує автоматично, але:
//   1. Має 5-хв initial delay перед першим fetch-ом.
//   2. Викликає setTimeout(...).unref() у Node, тому процес виходить
//      одразу після завершення тіла тесту, без очікування 5 хв.
// Жодного мережевого запиту під час тесту не відбувається.
//
// `sources: []` навмисно НЕ передаємо — у нової семантики `sources`
// це означає "жодних додаткових кастомних", а не "вимкнути збір"
// (дефолтні неможливо вимкнути ззовні — це гарантія ліби).

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

const require = createRequire(import.meta.url);

function checkSurface(label, Chaos) {
    const chaos = new Chaos();

    assert.equal(typeof chaos.int(), "number", `${label}: int()`);
    const i = chaos.int(0, 100);
    assert.ok(i >= 0 && i < 100, `${label}: int(0,100) out of range -> ${i}`);

    const u = chaos.unit();
    assert.ok(u >= 0 && u < 1, `${label}: unit() out of range -> ${u}`);

    const f = chaos.float(-10, 10);
    assert.ok(f >= -10 && f < 10, `${label}: float(-10,10) out of range -> ${f}`);

    const b = chaos.bytes(16);
    assert.ok(b instanceof Uint8Array && b.length === 16, `${label}: bytes(16)`);

    const v3 = chaos.floatVec(3, -1, 1);
    assert.equal(v3.length, 3, `${label}: floatVec(3) length`);
    v3.forEach((n) => assert.ok(n >= -1 && n < 1, `${label}: floatVec range`));

    const m = chaos.intMatrix(2, 3, 0, 9);
    assert.equal(m.length, 2);
    assert.equal(m[0].length, 3);

    const h = chaos.hash();
    assert.match(h, /^[0-9a-f]{64}$/, `${label}: hash hex`);

    const h2 = chaos.hash({ salt: "abc", bytes: 8 });
    assert.match(h2, /^[0-9a-f]{16}$/, `${label}: hash salt/bytes`);

    // Чорний ящик: жодного публічного методу для керування або
    // інтроспекції життєвого циклу планувальника не існує.
    for (const banned of [
        "start",
        "stop",
        "isRunning",
        "isDegraded",
        "getStats",
        "getSources",
        "pull",
    ]) {
        assert.equal(
            chaos[banned],
            undefined,
            `${label}: '${banned}' must not be on Chaos instance`,
        );
    }

    chaos.mix("user-salt");

    console.log(`  ok  ${label}`);
}

console.log("smoke-test: dist/lib bundles");

const esm = await import("../dist/lib/chaos.js");
assert.ok(esm.Chaos, "ESM: Chaos missing");
// SCHEDULER_FLOOR_MS і подібні tuning-константи, defaultSources,
// окремі імена вбудованих джерел — нічого з цього не повинно текти
// назовні. Дефолти контролюємо ми, і споживач їх ніяк не торкається.
for (const banned of [
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
checkSurface("ESM (chaos.js)", esm.Chaos);

const cjs = require("../dist/lib/chaos.cjs");
assert.ok(cjs.Chaos, "CJS: Chaos missing");
checkSurface("CJS (chaos.cjs)", cjs.Chaos);

const umd = require("../dist/lib/chaos.umd.cjs");
assert.ok(umd.Chaos, "UMD: Chaos missing");
checkSurface("UMD (chaos.umd.cjs)", umd.Chaos);

// .d.ts повинні не мати .ts-суфіксів у шляхах і не світити приватні типи.
const dts = await readFile(new URL("../dist/lib/types/index.d.ts", import.meta.url), "utf8");
assert.ok(dts.includes('export { Chaos } from "./chaos"'), ".d.ts: Chaos export");
const badImport = dts.match(/from\s+"[^"]*\.ts"/);
assert.equal(badImport, null, `.d.ts must not reference .ts paths, got: ${badImport?.[0]}`);
assert.ok(!dts.includes("ChaosStats"), ".d.ts must not re-export ChaosStats");
assert.ok(!dts.includes("EntropyEvent"), ".d.ts must not re-export EntropyEvent");

// Перевіримо що в типах chaos.d.ts (тобто публічний фасад) немає
// прибраних полів і навіть жодних натяків на колбеки чи ручне
// керування життєвим циклом.
//
// Назви приватних полів TypeScript включає в .d.ts як
// `private readonly scheduler;` (без типу і без двокрапки), тому
// regex для опцій матчить саме декларацію `name?:` / `name:` —
// приватні поля проходять повз нього.
const optsDts = await readFile(
    new URL("../dist/lib/types/chaos.d.ts", import.meta.url),
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
const bannedTypes = ["ChaosSchedulerTuning"];
for (const name of bannedTypes) {
    assert.ok(
        !optsDts.includes(name),
        `.d.ts must not expose type '${name}'`,
    );
}
const bannedMethods = ["start(", "stop(", "isRunning(", "isDegraded("];
for (const m of bannedMethods) {
    assert.ok(
        !optsDts.includes(m),
        `.d.ts must not expose method '${m})' on the public Chaos surface`,
    );
}

console.log("all good");
