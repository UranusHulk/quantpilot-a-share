import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFactorResearch, factorValue } from '../lib/factor-research.mjs';
import { handleApiRequest } from '../lib/quant-api.mjs';

function makeRows(codeRank, length = 520) {
  return Array.from({ length }, (_, index) => {
    const date = new Date(Date.UTC(2023, 0, 1 + index)).toISOString().slice(0, 10);
    const close = 40 * Math.exp((0.0002 + codeRank * 0.00008) * index + Math.sin(index / 15 + codeRank) * 0.035);
    return { date, open: close, close, high: close * 1.01, low: close * 0.99, volume: 100000 * (1 + codeRank / 20 + Math.sin(index / 9) * 0.1) };
  });
}

test('volume factor uses only records available by the requested index', () => {
  const rows = makeRows(2);
  const beforeFutureMutation = factorValue(rows, 60, 'volume20');
  rows.fill({ ...rows.at(-1), volume: 9_999_999_999 }, 61);
  assert.equal(factorValue(rows, 60, 'volume20'), beforeFutureMutation);
});

test('report splits chronological rebalance dates and records research assumptions', () => {
  const seriesByCode = new Map(Array.from({ length: 8 }, (_, index) => [`${String(index).padStart(6, '0')}`, makeRows(index)]));
  const report = buildFactorResearch({ seriesByCode, factor: 'momentum20', start: '2023-07-01', end: '2024-03-31', frequency: 'monthly', horizon: 20, costBps: 25, split: 0.7 });
  assert.equal(report.parameters.horizon, 20);
  assert.ok(report.universe.observations > 0);
  assert.ok(report.summary.train.periods > 0);
  assert.ok(report.summary.validation.periods > 0);
  assert.ok(report.summary.outOfSample.periods > 0);
  assert.ok(report.splitDate > '2023-07-01' && report.splitDate <= '2024-03-31');
  assert.match(report.metadata.factorFormula, /close/);
  assert.match(report.quality.priceType, /前复权/);
  assert.equal(report.summary.all.timeline.length, report.summary.all.periods);
});

test('explicit zero transaction cost remains zero', () => {
  const seriesByCode = new Map(Array.from({ length: 8 }, (_, index) => [`${String(index).padStart(6, '0')}`, makeRows(index)]));
  const report = buildFactorResearch({ seriesByCode, factor: 'momentum20', start: '2023-07-01', end: '2024-03-31', frequency: 'monthly', horizon: 20, costBps: 0, split: 0.7 });
  assert.equal(report.parameters.costBps, 0);
  assert.ok(report.summary.all.averageCost === 0 || report.summary.all.averageCost === null);
});

test('opening both long and short legs incurs explicit costs', () => {
  const seriesByCode = new Map(Array.from({ length: 8 }, (_, index) => [`${String(index).padStart(6, '0')}`, makeRows(index)]));
  const report = buildFactorResearch({ seriesByCode, factor: 'momentum20', start: '2023-07-01', end: '2024-03-31', frequency: 'monthly', horizon: 20, costBps: 25, split: 0.7 });
  assert.ok(report.summary.all.averageCost > 0);
});

test('signals near the selected end date do not borrow later returns', () => {
  const seriesByCode = new Map(Array.from({ length: 8 }, (_, index) => [`${String(index).padStart(6, '0')}`, makeRows(index)]));
  const report = buildFactorResearch({ seriesByCode, factor: 'momentum20', start: '2023-07-01', end: '2023-08-01', frequency: 'monthly', horizon: 20, costBps: 0, split: 0.7 });
  assert.equal(report.universe.observations, 0);
});

test('invalid stock codes are rejected instead of silently using the default universe', async () => {
  const response = await handleApiRequest(new Request('http://localhost/api/factor-research?codes=not-a-code'));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /六位数字/);
});

test('factor research falls back to segmented Tencent adjusted daily bars when Eastmoney fails', async () => {
  const originalFetch = globalThis.fetch;
  const tencentWindows = [];
  globalThis.fetch = async input => {
    const url = new URL(input);
    if (url.hostname === 'push2his.eastmoney.com') return new Response('upstream unavailable', { status: 520 });
    assert.equal(url.hostname, 'web.ifzq.gtimg.cn');
    const [ticker, , start, end] = url.searchParams.get('param').split(',');
    tencentWindows.push([ticker, start, end]);
    if (ticker === 'sh688775' && end < '2025-06-11') return Response.json({ code: 0, data: { [ticker]: { day: [] } } });
    const bars = [];
    const barStart = ticker === 'sh688775' && start < '2025-06-11' ? '2025-06-11' : start;
    const cursor = new Date(`${barStart}T00:00:00Z`);
    const finish = new Date(`${end}T00:00:00Z`);
    let index = 0;
    while (cursor <= finish) {
      const day = cursor.getUTCDay();
      if (day !== 0 && day !== 6) {
        const date = cursor.toISOString().slice(0, 10);
        const close = 10 + index * 0.01 + Math.sin(index / 11) * 0.2;
        bars.push([date, close.toFixed(3), close.toFixed(3), (close * 1.01).toFixed(3), (close * 0.99).toFixed(3), String(100000 + index)]);
        index += 1;
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return Response.json({ code: 0, data: { [ticker]: { qfqday: bars } } });
  };

  try {
    const response = await handleApiRequest(new Request('http://localhost/api/factor-research?codes=688775&factor=momentum20&frequency=monthly&horizon=5&start=2023-11-01&end=2026-10-31'));
    const report = await response.json();
    assert.equal(response.status, 200, JSON.stringify(report));
    assert.equal(report.universe.loaded, 1);
    assert.match(report.quality.source, /腾讯备用/);
    assert.match(report.quality.historyChecks['688775'].fallbackReason, /520/);
    assert.equal(report.quality.historyChecks['688775'].firstDate, '2025-06-11');
    assert.ok(report.quality.historyChecks['688775'].validBars > 200);
    assert.equal(report.quality.historyChecks['688775'].emptyWindows.length, 1);
    assert.match(report.quality.limitations.join('；'), /688775 2025-06-11/);
    assert.equal(tencentWindows.length, 3);
    assert.equal(tencentWindows[0][2], tencentWindows[1][1]);
    assert.equal(tencentWindows[1][2], tencentWindows[2][1]);

    const portfolioResponse = await handleApiRequest(new Request('http://localhost/api/backtest?codes=600000,000001&start=2025-01-01&end=2025-12-31&fast=10&slow=30'));
    const portfolio = await portfolioResponse.json();
    assert.equal(portfolioResponse.status, 200, JSON.stringify(portfolio));
    assert.match(portfolio.source, /腾讯前复权备用/);
    assert.match(portfolio.source, /等资金分仓组合/);

    const preListingResponse = await handleApiRequest(new Request('http://localhost/api/factor-research?codes=688775&start=2022-01-01&end=2024-01-01'));
    const preListing = await preListingResponse.json();
    assert.equal(preListingResponse.status, 502);
    assert.match(preListing.error, /可能早于上市日期/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
