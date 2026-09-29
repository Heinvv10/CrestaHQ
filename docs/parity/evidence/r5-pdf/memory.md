# R5 — PDF render cost on velo-server

Measured 2026-09-29 on velo-server (32 cores, 126 GB RAM, ~46 GB available at
the time), Node v22.23.1, `@react-pdf/renderer` 4.5.1, rendering the fixture
report (`src/lib/prospecting/report-pdf.fixture.ts`, 7 sections, 2 A4 pages,
no logo) with:

    NODE_OPTIONS=--expose-gc pnpm dlx tsx --tsconfig scripts/prospecting/tsconfig.render.json \
      scripts/prospecting/render-report-pdf.tsx 20

```
pdf bytes: 10359
gc exposed: yes
rss before first render: 121.4 MB, after: 155.0 MB (first render 226 ms, heap +8.5 MB retained)
20 further renders: median 97 ms, max 191 ms
peak rss: 163.3 MB; peak heap growth within one render: 5.5 MB
rss after 20 renders + gc: 163.3 MB
```

Reading it:

- **One render costs ~5–8 MB of heap and ~100 ms** once warm. RSS does not
  grow across 20 renders after the first (no leak visible at this scale).
- **The first render in a process costs ~34 MB RSS and ~0.2–0.4 s**: loading
  react-pdf, yoga and the standard fonts. That is paid once per server
  process, not per request.
- An earlier run on the same box (3 renders) read 435 ms for the first render
  and 278 ms median — the box is shared with other runners, so expect that
  spread.

What bounds it in production: the route's per-IP (10 / 10 min) and per-share
(30 / hour) limits. They bound the rate, not strict concurrency; at ~8 MB per
in-flight render, even 50 renders at once is ~400 MB on a box with tens of GB
free, so no separate concurrency cap was added.

Not measured: a report with a large agency logo (the logo is capped by
`publicFetch`'s 5 MB body limit and embedded once per render), and the
render inside the Next standalone server rather than under tsx.
