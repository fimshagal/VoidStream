# voidstream

> Black-box entropy library — randomness with provenance you don't have to look at.

`voidstream` keeps a pool of entropy that is bootstrapped from
`crypto.getRandomValues` and then continuously, silently refreshed in the
background from a hidden set of public open-data endpoints (no less often
than once every 5 minutes). Consumers get a tiny synchronous API for drawing
random values; they do **not** get to see which sources are used, when fetches
happen, what they returned, or how many bytes the pool currently holds.

When something goes wrong (network refresh keeps failing, or the bootstrap
fell back to weak local entropy) the library uses `console.warn` with a
`[voidstream]` prefix. Nothing else leaks.

- Zero runtime dependencies
- TypeScript types out of the box
- ESM / CJS / UMD bundles
- Synchronous draw API, async background collection
- Network behaviour is intentionally opaque
- One built-in non-network source: passive local user-input + environment
  snapshot, so even fully offline the pool keeps getting a slow drip of
  hard-to-predict bytes (pointer/scroll/key timing, screen, heap stats)
- **No way to push data into the pool from the outside.** The only legal
  ingress is custom sources passed at construction; there is no `mix()`,
  `feed()`, or `seed()` method.

## Install

```bash
npm install voidstream
```

Or include via UMD directly in a page:

```html
<script src="https://unpkg.com/voidstream"></script>
<script>
  const stream = new VoidStream.VoidStream();
  console.log(stream.unit());
</script>
```

## Usage

```ts
import { VoidStream } from "voidstream";

const stream = new VoidStream();

stream.int();                  // random uint32
stream.int(0, 100);            // integer in [0, 100)
stream.unit();                 // float in [0, 1)
stream.float(-10, 10);         // float in [min, max)
stream.bytes(16);              // Uint8Array of length 16

stream.intVec(3);              // [int, int, int]
stream.floatVec(4, -1, 1);     // 4 floats in [-1, 1)
stream.intMatrix(3, 3);        // 3x3 ints
stream.floatMatrix(2, 4);      // 2x4 floats

stream.hash();                 // 64-char hex string (32 random bytes)
stream.hash({ bytes: 16 });    // 32-char hex string (16 random bytes)
```

That is the **entire** public surface. There is no `start()`, `stop()`,
`isRunning()`, `isDegraded()`, `getStats()`, `getSources()`, `pull()`,
`mix()` or per-fetch callback — by design. The instance starts refreshing
in the background the moment it is constructed and keeps doing so for the
lifetime of the page/process. The only thing the lib can possibly say back
to you, besides random values, is a `console.warn`.

If you need to combine the lib's randomness with your own salt/identifier,
do it *after* drawing — e.g. derive your own salted hash from
`stream.bytes(n)` plus your data. The pool itself is intentionally
unreachable from the outside.

## Health signals

The library is silent in normal operation. It writes to `console.warn`
(prefix `[voidstream]`) only when it has something genuine to report.

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

If **you** added a source via `new VoidStream({ sources: [...] })` and that
source ever throws or rejects, the lib emits a dedicated warning **every
time** it fails, naming the source and including the error reason:

```
[voidstream] custom entropy source "wikipedia/pi" failed to refresh: HTTP 503 service unavailable
```

These custom failures do **not** count toward the generic
`pool may be stale` counter — that counter is for the built-in path. If
your custom source is the only one you provided and it keeps failing, you
will see a stream of named warnings, which tells you exactly what to look
at without needing the generic signals.

If you want programmatic visibility into any of this, intercept
`console.warn` yourself and filter on the `[voidstream]` prefix — the demo in
this repo does exactly that.

## The local source

One of the built-in sources is non-network: it passively buffers `mousemove`,
`click`, `keydown` (timing only — no key codes), `touchmove`, `scroll`, and
`wheel` events, plus a small snapshot of the local environment
(`navigator.hardwareConcurrency`, `deviceMemory`, screen dimensions,
`performance.memory` heap stats where available, current time).

It is intentionally the **lowest-impact** source in the default set: it
returns only tens of bytes per refresh while the network sources return
hundreds-to-thousands. Since the PRNG mixes bytes proportionally to
payload size, the local source feeds the pool gently — but it always
feeds. Even fully offline, the pool keeps moving.

Privacy is preserved on purpose: only event *timing* is recorded for
`keydown`. Pointer coordinates stay in memory and are never sent anywhere.
In Node / SSR (no `window` / `document`) the source simply skips listener
attachment and returns env + timing bytes on each refresh.

## Custom sources

You can **add** your own entropy sources on top of the built-in set, but
only at construction time. After `new VoidStream(...)` returns there is
no way to register more sources, remove sources, or otherwise change the
shape of the pool. You also **cannot** replace, disable, or even
introspect the built-ins — they are controlled exclusively by the
library, on purpose. This is what makes the network behaviour a black
box you can trust without auditing.

```ts
import { VoidStream, type EntropySource } from "voidstream";

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
const stream = new VoidStream({ sources: [wikipediaPi] });
```

Things to keep in mind:

- `sources: []` (or omitting the option entirely) means **no custom
  sources to add**. It does **not** disable the default pool refresh —
  there is no public way to do that.
- If your custom source throws or rejects, the lib emits a dedicated
  named warning every time (see *Custom sources* under "Health signals"
  above). Built-in failures stay generic.
- Custom sources are registered at construction only. There is no way
  to add or swap sources later — the pool's input set is frozen for the
  lifetime of the instance.
- There is intentionally **no** way to tune refresh intervals, initial
  delays, or anything else about the scheduler from the outside. Those
  are internal details that may change between minor versions. Adding
  your own sources is the only knob.
- The scheduler's own timing (when the next refresh happens, which source
  is picked) is drawn from the **same pool** the lib hands out — not from
  `Math.random`. After the constructor's `crypto.getRandomValues` bootstrap,
  every subsequent scheduling decision is a function of the noise the lib
  has already collected, so an external observer cannot predict when the
  pool will be touched next even if they know exactly when the instance
  was constructed.

## Build

```bash
npm install
npm run build:lib       # produces dist/lib/voidstream.{js,cjs,umd.cjs} + types/
npm run build:demo      # produces dist/demo/ (static site)
npm run build           # runs both above + typecheck
npm run dev             # demo dev server on http://127.0.0.1:5173
```

The library output lives in `dist/lib/`:

```
dist/lib/
  voidstream.js          ESM bundle (obfuscated)
  voidstream.cjs         CommonJS bundle (obfuscated)
  voidstream.umd.cjs     UMD bundle (obfuscated, global name: VoidStream)
  types/
    index.d.ts           type entry point
    ...                  matching .d.ts for each source file
```

All three runtime bundles are run through
[`javascript-obfuscator`](https://github.com/javascript-obfuscator/javascript-obfuscator)
at build time: identifier mangling, string array with base64 + rotation +
shuffle, dead code injection, control flow flattening. The public surface
(`VoidStream`, `VoidStreamOptions`, `VecLen`, `EntropySource`) and the
`[voidstream]` `console.warn` contract are preserved by design; everything
else is opaque. Source maps are intentionally **not** emitted.

To publish, remove `"private": true` from `package.json` and run `npm publish`.

## License

MIT
