// Local benchmark runner — drives both inferno-next and Ripple via Playwright.
// Times each of the eight js-framework-benchmark operations and prints a table.
// Uses page.evaluate(() => el.click()) to fire clicks SYNCHRONOUSLY inside the page,
// bypassing the per-click CDP mouse-simulation IPC overhead (~10ms/click).
//
// Usage: node benchmarks/run.mjs [iterations]    (default 8)
// Both dev servers (5174 ripple, 5175 inferno-next) must already be running.

import { chromium } from 'playwright';

const ITER = parseInt(process.argv[2] || '8', 10);
const ROW_COUNT = 1000;

const TARGETS = process.env.TARGETS
  ? JSON.parse(process.env.TARGETS)
  : [
      { name: 'inferno-next', url: 'http://localhost:5175/', ready: '#run' },
      { name: 'ripple',       url: 'http://localhost:5174/', ready: '#run' },
    ];

const OPS = [
  { name: 'run',      pre: 'empty', click: '#run'      },
  { name: 'replace',  pre: 'rows',  click: '#run'      },
  { name: 'update',   pre: 'rows',  click: '#update'   },
  { name: 'select',   pre: 'rows',  click: 'tbody tr:nth-child(5) td:nth-child(2) a'  },
  { name: 'swap',     pre: 'rows',  click: '#swaprows' },
  { name: 'remove',   pre: 'rows',  click: 'tbody tr:nth-child(5) td:nth-child(3) a'  },
  { name: 'runlots',  pre: 'empty', click: '#runlots'  },
  { name: 'clear',    pre: 'rows',  click: '#clear'    },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ensureState(page, pre) {
  if (pre === 'empty') {
    await page.evaluate(() => {
      const btn = document.getElementById('clear');
      if (btn) btn.click();
    });
  } else if (pre === 'rows') {
    const cnt = await page.evaluate(() => document.querySelectorAll('tbody tr').length);
    if (cnt !== ROW_COUNT) {
      await page.evaluate(() => document.getElementById('run').click());
      await page.waitForFunction(
        (n) => document.querySelectorAll('tbody tr').length === n,
        ROW_COUNT,
        { timeout: 5000 }
      );
    }
  }
  await sleep(20);
}

async function timeClick(page, sel) {
  return await page.evaluate(async (sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error('selector not found: ' + sel);
    const t0 = performance.now();
    el.click();
    await new Promise(r => requestAnimationFrame(r));
    await new Promise(r => setTimeout(r, 0));
    return performance.now() - t0;
  }, sel);
}

async function runTarget(t) {
  const browser = await chromium.launch({ headless: true, args: ['--disable-extensions'] });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(t.url, { waitUntil: 'load' });
  await page.waitForSelector(t.ready, { timeout: 10000 });

  // Warmup — let JIT settle.
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => document.getElementById('run').click());
    await sleep(120);
    await page.evaluate(() => document.getElementById('clear').click());
    await sleep(80);
  }

  const results = {};
  for (const op of OPS) {
    const samples = [];
    for (let i = 0; i < ITER; i++) {
      await ensureState(page, op.pre);
      const dt = await timeClick(page, op.click);
      samples.push(dt);
      await sleep(60);
    }
    samples.sort((a, b) => a - b);
    const median = samples[samples.length >> 1];
    const min = samples[0];
    results[op.name] = { median, min, samples };
  }

  await browser.close();
  return results;
}

(async () => {
  const all = {};
  for (const t of TARGETS) {
    console.error(`Running ${t.name} (${t.url}) × ${ITER}…`);
    all[t.name] = await runTarget(t);
  }

  const cols = TARGETS.map(t => t.name);
  const W = 26;
  console.log();
  console.log('Op       | ' + cols.map(c => c.padEnd(W)).join('| '));
  console.log('---------+-' + cols.map(() => '-'.repeat(W)).join('+-'));
  for (const op of OPS) {
    const row = [op.name.padEnd(8)];
    for (const c of cols) {
      const r = all[c][op.name];
      row.push((`${r.median.toFixed(2)} (min ${r.min.toFixed(2)})`).padEnd(W));
    }
    console.log(row.join('| '));
  }

  // Pairwise ratio: print each non-ripple target vs ripple.
  const ripple = all['ripple'];
  if (ripple) {
    console.log();
    for (const t of TARGETS) {
      if (t.name === 'ripple') continue;
      const r = all[t.name];
      console.log(`${t.name} / ripple ratio (median; <1 means ${t.name} faster):`);
      for (const op of OPS) {
        const ratio = r[op.name].median / ripple[op.name].median;
        const tag = ratio < 0.95 ? '++ faster' : ratio < 1.05 ? '== ~equal' : '-- slower';
        console.log(`  ${op.name.padEnd(8)} ${ratio.toFixed(2)}x  ${tag}`);
      }
      console.log();
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
