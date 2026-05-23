# chaos

> Black-box entropy library — randomness with provenance you don't have to look at.

`chaos` keeps a pool of entropy that is bootstrapped from
`crypto.getRandomValues` and then continuously, silently refreshed in the
background from a hidden set of public open-data endpoints (no less often
than once every 5 minutes). Consumers get a tiny synchronous API for drawing
random values; they do **not** get to see which sources are used, when fetches
happen, what they returned, or how many bytes the pool currently holds.

When something goes wrong (network refresh keeps failing, or the bootstrap
fell back to weak local entropy) the library uses `console.warn` with a
`[chaos]` prefix. Nothing else leaks.

- Zero runtime dependencies
- TypeScript types out of the box
- ESM / CJS / UMD bundles
- Synchronous draw API, async background collection
- Network behaviour is intentionally opaque
- One built-in non-network source: passive local user-input + environment
  snapshot, so even fully offline the pool keeps getting a slow drip of
  hard-to-predict bytes (pointer/scroll/key timing, screen, heap stats)

## Install

```bash
npm install entropy-chaos
```

Or include via UMD directly in a page:

```html
<script src="https://unpkg.com/entropy-chaos"></script>
<script>
  const chaos = new Chaos.Chaos();
  console.log(chaos.unit());
</script>
```

## Usage

```ts
import { Chaos } from "entropy-chaos";

const chaos = new Chaos();

chaos.int();                  // random uint32
chaos.int(0, 100);            // integer in [0, 100)
chaos.unit();                 // float in [0, 1)
chaos.float(-10, 10);         // float in [min, max)
chaos.bytes(16);              // Uint8Array of length 16

chaos.intVec(3);              // [int, int, int]
chaos.floatVec(4, -1, 1);     // 4 floats in [-1, 1)
chaos.intMatrix(3, 3);        // 3x3 ints
chaos.floatMatrix(2, 4);      // 2x4 floats

chaos.hash();                 // 64-char hex string (32 random bytes)
chaos.hash({ bytes: 16, salt: "user-id" });

chaos.mix("extra entropy");   // mix arbitrary data into the pool
```

That is the **entire** public surface. There is no `start()`, `stop()`,
`isRunning()`, `isDegraded()`, `getStats()`, `getSources()`, `pull()`, or
per-fetch callback — by design. The instance starts refreshing in the
background the moment it is constructed and keeps doing so for the lifetime
of the page/process. The only thing the lib can possibly say back to you,
besides random values, is a `console.warn`.

## Health signals

The library is silent in normal operation. It writes to `console.warn`
(prefix `[chaos]`) only when it has something genuine to report.

### Built-in sources — generic, name-less warnings

For the built-in source set, the lib intentionally keeps things quiet and
**does not name** the offending source — the network behaviour is meant to
be a black box, and pointing at "USGS is down" would draw attention to
something you cannot actually control.

| When | Message |
| --- | --- |
| `crypto.getRandomValues` is unavailable at bootstrap | `pool bootstrapped from timing only — entropy is weak` |
| First refresh attempt failed and no real network entropy has arrived yet | `pool is operating on local entropy only` |
| Three or more consecutive refresh attempts failed | `pool may be stale` |

### Custom sources — always named, always immediate

If **you** added a source via `new Chaos({ sources: [...] })` and that
source ever throws or rejects, the lib emits a dedicated warning **every
time** it fails, naming the source and including the error reason:

```
[chaos] custom entropy source "wikipedia/pi" failed to refresh: HTTP 503 service unavailable
```

These custom failures do **not** count toward the generic
`pool may be stale` counter — that counter is for the built-in path. If
your custom source is the only one you provided and it keeps failing, you
will see a stream of named warnings, which tells you exactly what to look
at without needing the generic signals.

If you want programmatic visibility into any of this, intercept
`console.warn` yourself and filter on the `[chaos]` prefix — the demo in
this repo does exactly that.

## The local source

One of the built-in sources is non-network: it passively buffers `mousemove`,
`click`, `keydown` (timing only — no key codes), `touchmove`, `scroll`, and
`wheel` events, plus a small snapshot of the local environment
(`navigator.hardwareConcurrency`, `deviceMemory`, screen dimensions,
`performance.memory` heap stats where available, current time).

It is intentionally the **lowest-impact** source in the default set: it
returns only tens of bytes per refresh while the network sources return
hundreds-to-thousands. Since `Chaos`'s PRNG mixes bytes proportionally to
payload size, the local source feeds the pool gently — but it always
feeds. Even fully offline, the pool keeps moving.

Privacy is preserved on purpose: only event *timing* is recorded for
`keydown`. Pointer coordinates stay in memory and are never sent anywhere.
In Node / SSR (no `window` / `document`) the source simply skips listener
attachment and returns env + timing bytes on each refresh.

## Custom sources

You can **add** your own entropy sources on top of the built-in set.
You **cannot** replace, disable, or even introspect the built-ins — they
are controlled exclusively by the library, on purpose. This is what makes
the network behaviour a black box you can trust without auditing.

```ts
import { Chaos, type EntropySource } from "entropy-chaos";

const wikipediaPi: EntropySource = {
  name: "wikipedia/pi",
  label: "Wikipedia — pi digits",
  async fetch() {
    const res = await fetch("https://en.wikipedia.org/wiki/Pi");
    const text = await res.text();
    return new TextEncoder().encode(text.slice(0, 4096));
  },
};

// Built-ins always run. `wikipediaPi` is *added* to the pool alongside
// them — it cannot displace or silence the built-in set.
const chaos = new Chaos({ sources: [wikipediaPi] });
```

Things to keep in mind:

- `sources: []` (or omitting the option entirely) means **no custom
  sources to add**. It does **not** disable the default pool refresh —
  there is no public way to do that.
- If your custom source throws or rejects, the lib emits a dedicated
  named warning every time (see *Custom sources* under "Health signals"
  above). Built-in failures stay generic.
- There is intentionally **no** way to tune refresh intervals, initial
  delays, or anything else about the scheduler from the outside. Those
  are internal details that may change between minor versions. Adding
  your own sources is the only knob.

## Build

```bash
npm install
npm run build:lib       # produces dist/lib/chaos.{js,cjs,umd.cjs} + types/
npm run build:demo      # produces dist/demo/ (static site)
npm run build           # runs both above + typecheck
npm run dev             # demo dev server on http://127.0.0.1:5173
```

The library output lives in `dist/lib/`:

```
dist/lib/
  chaos.js          ESM bundle (obfuscated)
  chaos.cjs         CommonJS bundle (obfuscated)
  chaos.umd.cjs     UMD bundle (obfuscated, global name: Chaos)
  types/
    index.d.ts      type entry point
    ...             matching .d.ts for each source file
```

All three runtime bundles are run through
[`javascript-obfuscator`](https://github.com/javascript-obfuscator/javascript-obfuscator)
at build time: identifier mangling, string array with base64 + rotation +
shuffle, dead code injection, control flow flattening. The public surface
(`Chaos`, `ChaosOptions`, `VecLen`, `EntropySource`) and the `[chaos]`
`console.warn` contract are preserved by design; everything else is opaque.
Source maps are intentionally **not** emitted.

To publish, remove `"private": true` from `package.json` and run `npm publish`.

## License

MIT
