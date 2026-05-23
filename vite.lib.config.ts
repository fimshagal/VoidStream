import { defineConfig, type Plugin } from "vite";
import JavaScriptObfuscator from "javascript-obfuscator";

/**
 * Інлайн-плагін, який обфускує ВЖЕ зібрані output-чанки (а не сирі
 * source-модулі). Цей підхід дає найкращий результат: один загальний
 * string array на весь бандл, єдина таблиця ідентифікаторів,
 * один пул мертвого коду.
 *
 * Запускаємо в renderChunk — на той момент Rollup вже сформував
 * фінальний код (з UMD-обгорткою/__esModule/import-export), а Vite
 * ще не записав файли на диск. Повертаємо `map: null` — мапи нам
 * без потреби, бо для опублікованого артефакту ми свідомо вимикаємо
 * sourcemap (інакше обфускація сама себе зводить нанівець).
 */
/**
 * Опції з seed-ом — кожен білд буде ідентичним. Без цього обфускатор
 * генерує випадкові ідентифікатори/розкладку dead-code, через що
 * один білд може випадково "вистрелити" в UMD-несумісність, а інший —
 * ні. Зафіксований seed робить поведінку детермінованою.
 */
const COMMON_OBFUSCATOR_OPTIONS = {
    seed: 1,
    compact: true,
    simplify: true,
    identifierNamesGenerator: "mangled-shuffled" as const,
    renameGlobals: false,
    renameProperties: false,
    selfDefending: false,
    debugProtection: false,
    disableConsoleOutput: false, // console.warn — частина контракту ліби
    unicodeEscapeSequence: false,
    target: "browser" as const,
    log: false,
};

/**
 * Важка пресет — для ESM/CJS-бандлів. Включає string array, control
 * flow flattening, dead code injection. У цих форматах код не
 * загорнутий у UMD-фабрику, тому string-array-init без проблем
 * хоститься на module-scope.
 *
 * numbersToExpressions та transformObjectKeys ВИМКНЕНО — у комбі
 * зі stringArrayRotate вони ламають хеш-перевірку в `for(;;)`-ініті
 * і модуль зависає на імпорті.
 */
const HEAVY_OPTIONS = {
    ...COMMON_OBFUSCATOR_OPTIONS,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.75,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.35,
    stringArray: true,
    stringArrayEncoding: ["base64"] as const,
    stringArrayIndexShift: true,
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayWrappersCount: 2,
    stringArrayWrappersChainedCalls: true,
    stringArrayWrappersParametersMaxCount: 4,
    stringArrayWrappersType: "function" as const,
    stringArrayThreshold: 0.75,
    splitStrings: true,
    splitStringsChunkLength: 10,
    numbersToExpressions: false,
    transformObjectKeys: false,
};

/**
 * Легкий пресет — для UMD-бандлу. UMD загортає весь код у factory-
 * функцію `(function(global, factory){...})(this, function(exports){...})`.
 * Якщо ввімкнути string array з heavy-пресету, обфускатор виносить
 * init-IIFE рядкового масиву на script-scope, а функцію-декодер
 * залишає всередині фабрики — module-load падає з ReferenceError.
 *
 * Тому для UMD робимо лише identifier mangling + compact. Це все ще
 * робить код нечитабельним для людини, але не калічить UMD-обгортку.
 */
const LIGHT_OPTIONS = {
    ...COMMON_OBFUSCATOR_OPTIONS,
    controlFlowFlattening: false,
    deadCodeInjection: false,
    stringArray: false,
    splitStrings: false,
    numbersToExpressions: false,
    transformObjectKeys: false,
};

function obfuscateRenderedChunks(): Plugin {
    return {
        name: "chaos:obfuscate-rendered-chunks",
        apply: "build",
        enforce: "post",
        renderChunk(code, _chunk, outputOpts) {
            const isUmd = outputOpts.format === "umd";
            const options = isUmd ? LIGHT_OPTIONS : HEAVY_OPTIONS;
            const result = JavaScriptObfuscator.obfuscate(code, options);
            return { code: result.getObfuscatedCode(), map: null };
        },
    };
}

/**
 * Конфіг для збірки бібліотеки (без index.html демо).
 * Видає три формати:
 *   - ESM     (chaos.js)        — для bundler-ів і сучасного Node
 *   - CJS     (chaos.cjs)       — для застарілого Node / CommonJS
 *   - UMD     (chaos.umd.cjs)   — для прямого підключення через <script>
 *
 * Усі три прогоняються через javascript-obfuscator (див.
 * obfuscateRenderedChunks вище). Sourcemaps вимкнені свідомо —
 * publish-артефакт має бути непрозорим.
 *
 * `tsc -p tsconfig.lib.json` запускається після цього і кладе
 * .d.ts у dist/lib/types/. emptyOutDir тут чистить dist/lib повністю
 * саме перед vite-збіркою — тому tsc має йти ДРУГИМ кроком.
 */
export default defineConfig({
    build: {
        target: "es2022",
        outDir: "dist/lib",
        emptyOutDir: true,
        // Свідомо вимкнено: з обфускацією sourcemap фактично
        // деобфускував би код споживача. Якщо потрібен debug-білд —
        // можна додати окремий env-флаг.
        sourcemap: false,
        // esbuild-minify бігає ДО obfuscator-а (бо той у enforce:'post')
        // і виконує дешеву роботу зі стиснення whitespace/dead-statements.
        // Після того обфускатор накручує важку машинерію.
        minify: "esbuild",
        lib: {
            entry: "src/index.ts",
            name: "Chaos",
            formats: ["es", "cjs", "umd"],
            fileName: (format) => {
                switch (format) {
                    case "es":
                        return "chaos.js";
                    case "cjs":
                        return "chaos.cjs";
                    case "umd":
                        // .cjs щоб Node трактував UMD як CommonJS, попри
                        // "type": "module" у package.json. Браузерам/CDN
                        // байдуже до розширення — UMD-стандарт лишається.
                        return "chaos.umd.cjs";
                    default:
                        return `chaos.${format}.js`;
                }
            },
        },
        rollupOptions: {
            // У ліби 0 runtime-залежностей — crypto/fetch/TextEncoder
            // приходять з браузера / Node 18+. external лишаємо порожнім.
            external: [],
            output: {
                exports: "named",
            },
        },
    },
    plugins: [obfuscateRenderedChunks()],
});
