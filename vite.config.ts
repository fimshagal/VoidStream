import { defineConfig } from "vite";

/**
 * Конфіг для білда демо-сторінки. Точка входу — index.html, як завжди у Vite.
 * Окремо від ліб-конфіга (vite.lib.config.ts), щоб два білди не конфліктували
 * за outDir і щоб демо тягнуло src напряму, не залежачи від dist/lib.
 */
export default defineConfig({
    root: ".",
    build: {
        target: "es2022",
        outDir: "dist/demo",
        emptyOutDir: true,
        sourcemap: true,
    },
    server: {
        port: 5173,
        host: "127.0.0.1",
    },
});
