/**
 * Render the fixture report PDF (R5) for evidence and measure what one render
 * costs on this machine. Nothing is read from or written to Firestore.
 *
 *   NODE_OPTIONS=--expose-gc pnpm dlx tsx --tsconfig scripts/prospecting/tsconfig.render.json \
 *     scripts/prospecting/render-report-pdf.tsx [runs=20] [out.pdf]
 *
 * (The render tsconfig only switches JSX to the automatic runtime; the app
 * build uses Next's.)
 * --expose-gc lets each heap delta be taken after a collection.
 */
import { writeFileSync } from "node:fs";
import { renderToBuffer } from "@react-pdf/renderer";
import { ReportPdfDocument } from "@/lib/prospecting/report-pdf-document";
import { FIXTURE_PUBLIC_REPORT } from "@/lib/prospecting/report-pdf.fixture";
import { reportStory } from "@/lib/prospecting/report-story";

const runs = Number(process.argv[2] ?? 20);
const out = process.argv[3] ?? "docs/parity/evidence/r5-pdf/example-report.pdf";
const gc = (globalThis as { gc?: () => void }).gc;
const mb = (n: number) => (n / 1024 / 1024).toFixed(1);

async function render(): Promise<Buffer> {
  const story = reportStory(FIXTURE_PUBLIC_REPORT);
  return renderToBuffer(
    <ReportPdfDocument story={story} logo={null} bookUrl={`https://crm.example.com${story.bookHref}`} />,
  );
}

async function main() {
  // The first render loads fonts and modules; measure it on its own.
  gc?.();
  const rss0 = process.memoryUsage().rss;
  const heap0 = process.memoryUsage().heapUsed;
  let t = performance.now();
  const first = await render();
  const firstMs = performance.now() - t;
  const firstRss = process.memoryUsage().rss;
  writeFileSync(out, first);

  let peakRss = firstRss;
  let peakHeapDelta = 0;
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    gc?.();
    const before = process.memoryUsage().heapUsed;
    t = performance.now();
    await render();
    times.push(performance.now() - t);
    const m = process.memoryUsage();
    peakRss = Math.max(peakRss, m.rss);
    peakHeapDelta = Math.max(peakHeapDelta, m.heapUsed - before);
  }
  gc?.();
  times.sort((a, b) => a - b);
  const report = [
    `pdf bytes: ${first.length}`,
    `gc exposed: ${gc ? "yes" : "no"}`,
    `rss before first render: ${mb(rss0)} MB, after: ${mb(firstRss)} MB (first render ${firstMs.toFixed(0)} ms, heap +${mb(process.memoryUsage().heapUsed - heap0)} MB retained)`,
    `${runs} further renders: median ${times[Math.floor(times.length / 2)]!.toFixed(0)} ms, max ${times[times.length - 1]!.toFixed(0)} ms`,
    `peak rss: ${mb(peakRss)} MB; peak heap growth within one render: ${mb(peakHeapDelta)} MB`,
    `rss after ${runs} renders + gc: ${mb(process.memoryUsage().rss)} MB`,
  ].join("\n");
  process.stdout.write(`${report}\n`);
}

void main();
