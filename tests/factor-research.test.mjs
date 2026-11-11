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

test('signals return explainable multi-dimensional scores from real quote and daily bars', async () => {
  const originalFetch = globalThis.fetch;
  const fields = Array.from({ length: 60 }, () => ''); fields[1] = '测试股份'; fields[3] = '20'; fields[4] = '19.5'; fields[30] = '20261111150000'; fields[32] = '2.56'; fields[38] = '3.2'; fields[57] = '25000';
  const bars = Array.from({ length: 1000 }, (_, index) => { const date = new Date(Date.UTC(2024, 0, 2 + index)); const close = 10 + index * 0.03; return [date.toISOString().slice(0, 10), close.toFixed(3), close.toFixed(3), (close * 1.01).toFixed(3), (close * 0.99).toFixed(3), String(100000 + index * 1000)]; });
  globalThis.fetch = async input => {
    const url = new URL(input);
    if (url.hostname === 'qt.gtimg.cn') return new Response(`v_sz000001="${fields.join('~')}"`);
    if (url.hostname === 'web.ifzq.gtimg.cn') return Response.json({ code: 0, data: { sz000001: { day: bars } } });
    throw new Error(`unexpected provider ${url.hostname}`);
  };
  try {
    const response = await handleApiRequest(new Request('http://localhost/api/signals?codes=000001'));
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.scoreMethod.total, 100);
    assert.deepEqual(payload.scoreMethod.dimensions, { trend: 25, momentum: 20, volume: 15, riskControl: 20, liquidity: 10, dataQuality: 10 });
    const item = payload.items[0];
    assert.equal(item.dataPoints, 1000);
    assert.deepEqual(Object.keys(item.scoreBreakdown), ['trend', 'momentum', 'volume', 'riskControl', 'liquidity', 'dataQuality']);
    assert.equal(item.score, Object.values(item.scoreBreakdown).reduce((sum, value) => sum + value, 0));
    assert.match(item.reason, /SMA|动量|成交量/);
    assert.ok(item.riskReason);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('data source status endpoint probes actual response shapes from the current server environment', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = new URL(input);
    if (url.hostname === 'qt.gtimg.cn') return new Response('v_sh600519="1~贵州茅台~600519~100~99"');
    if (url.hostname === 'push2his.eastmoney.com') return Response.json({ data: { klines: [] } });
    if (url.hostname === 'web.ifzq.gtimg.cn') {
      const ticker = url.searchParams.get('param').split(',')[0];
      return Response.json({ code: 0, data: { [ticker]: url.pathname.includes('/fqkline/') ? { qfqday: [] } : { day: [] } } });
    }
    if (url.hostname === 'money.finance.sina.com.cn') return Response.json([]);
    throw new Error(`unexpected provider ${url.hostname}`);
  };
  try {
    const response = await handleApiRequest(new Request('http://localhost/api/data-status?code=600519'));
    const report = await response.json();
    assert.equal(response.status, 200);
    assert.equal(report.providers.length, 5);
    assert.ok(report.providers.every(provider => provider.ok), JSON.stringify(report.providers));
  } finally {
    globalThis.fetch = originalFetch;
  }
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
    assert.equal(new Date(`${tencentWindows[0][2]}T00:00:00Z`).getTime() + 24 * 60 * 60 * 1000, new Date(`${tencentWindows[1][1]}T00:00:00Z`).getTime());
    assert.equal(new Date(`${tencentWindows[1][2]}T00:00:00Z`).getTime() + 24 * 60 * 60 * 1000, new Date(`${tencentWindows[2][1]}T00:00:00Z`).getTime());

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

test('factor research uses Sina daily bars when Tencent history endpoints are blocked', async () => {
  const originalFetch = globalThis.fetch;
  const payload = Array.from({ length: 1000 }, (_, index) => {
    const date = new Date(Date.UTC(2022, 0, 3 + index * 2));
    const close = 8 + index * 0.01;
    return { day: date.toISOString().slice(0, 10), open: close.toFixed(3), high: (close * 1.02).toFixed(3), low: (close * 0.98).toFixed(3), close: close.toFixed(3), volume: String(100000 + index) };
  });
  globalThis.fetch = async input => {
    const url = new URL(input);
    if (url.hostname === 'push2his.eastmoney.com' || url.hostname === 'web.ifzq.gtimg.cn') return new Response('blocked', { status: url.hostname === 'push2his.eastmoney.com' ? 520 : 501 });
    assert.equal(url.hostname, 'money.finance.sina.com.cn');
    return Response.json(payload);
  };
  try {
    const response = await handleApiRequest(new Request('http://localhost/api/factor-research?codes=001330&factor=momentum20&frequency=monthly&horizon=5&start=2024-01-01&end=2026-10-30'));
    const report = await response.json();
    assert.equal(response.status, 200, JSON.stringify(report));
    assert.equal(report.universe.loaded, 1);
    assert.match(report.quality.source, /新浪未复权备用/);
    assert.equal(report.quality.historyChecks['001330'].adjusted, false);
    assert.match(report.quality.priceType, /未复权/);

    const backtestResponse = await handleApiRequest(new Request('http://localhost/api/backtest?codes=001330&start=2024-01-01&end=2026-10-30&fast=10&slow=30'));
    const backtest = await backtestResponse.json();
    assert.equal(backtestResponse.status, 200, JSON.stringify(backtest));
    assert.equal(backtest.priceType, '未复权');
    assert.match(backtest.source, /新浪未复权备用/);
    assert.match(backtest.warnings.join('；'), /未复权日线/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('factor report flags a requested period that exceeds Sina recent-history coverage', async () => {
  const originalFetch = globalThis.fetch;
  const payload = Array.from({ length: 1023 }, (_, index) => {
    const date = new Date(Date.UTC(2023, 0, 2 + index * 2));
    const close = 8 + index * 0.01;
    return { day: date.toISOString().slice(0, 10), open: close.toFixed(3), high: (close * 1.02).toFixed(3), low: (close * 0.98).toFixed(3), close: close.toFixed(3), volume: String(100000 + index) };
  });
  globalThis.fetch = async input => {
    const url = new URL(input);
    if (url.hostname === 'push2his.eastmoney.com' || url.hostname === 'web.ifzq.gtimg.cn') return new Response('blocked', { status: 520 });
    if (url.hostname === 'money.finance.sina.com.cn') return Response.json(payload);
    throw new Error(`unexpected provider ${url.hostname}`);
  };
  try {
    const response = await handleApiRequest(new Request('http://localhost/api/factor-research?codes=001330&factor=momentum20&frequency=monthly&horizon=5&start=2021-01-01&end=2025-12-31'));
    const report = await response.json();
    assert.equal(response.status, 200, JSON.stringify(report));
    assert.equal(report.quality.historyCoverage.gaps[0].actualStart, '2023-01-02');
    assert.match(report.quality.limitations.join('；'), /1023 根日线/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('factor research normalizes mixed provider inputs to one unadjusted basis', async () => {
  const originalFetch = globalThis.fetch;
  let failSecondCode = false;
  const makeTencentBars = (start, end) => {
    const rows = []; const cursor = new Date(`${start}T00:00:00Z`); const finish = new Date(`${end}T00:00:00Z`); let index = 0;
    while (cursor <= finish) {
      if (cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6) {
        const date = cursor.toISOString().slice(0, 10); const close = 10 + index * 0.01 + Math.sin(index / 13) * 0.1;
        rows.push([date, close.toFixed(3), close.toFixed(3), (close * 1.01).toFixed(3), (close * 0.99).toFixed(3), String(100000 + index)]);
        index += 1;
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return rows;
  };
  globalThis.fetch = async input => {
    const url = new URL(input);
    if (url.hostname === 'push2his.eastmoney.com') {
      if (url.searchParams.get('secid') === '1.600000') {
        const from = url.searchParams.get('beg'), to = url.searchParams.get('end'); const rows = makeTencentBars(`${from.slice(0, 4)}-${from.slice(4, 6)}-${from.slice(6)}`, `${to.slice(0, 4)}-${to.slice(4, 6)}-${to.slice(6)}`);
        return Response.json({ data: { klines: rows.map(row => `${row[0]},${row[1]},${row[2]},${row[3]},${row[4]},${row[5]},1,0,0,0,0`) } });
      }
      return new Response('blocked', { status: 520 });
    }
    if (url.hostname === 'web.ifzq.gtimg.cn') {
      const [ticker, , start, end] = url.searchParams.get('param').split(',');
      const empty = failSecondCode && ticker === 'sz000001';
      const bars = empty ? [] : makeTencentBars(start, end);
      if (url.pathname.includes('/fqkline/')) return Response.json({ code: 0, data: { [ticker]: ticker === 'sz000001' && !empty ? { day: bars } : { qfqday: bars } } });
      return Response.json({ code: 0, data: { [ticker]: { day: bars } } });
    }
    if (url.hostname === 'money.finance.sina.com.cn') return Response.json([]);
    throw new Error(`unexpected provider ${url.hostname}`);
  };
  try {
    const factorResponse = await handleApiRequest(new Request('http://localhost/api/factor-research?codes=600000,000001&factor=momentum20&frequency=monthly&horizon=5&start=2024-01-01&end=2026-10-30'));
    const factor = await factorResponse.json();
    assert.equal(factorResponse.status, 200, JSON.stringify(factor));
    assert.match(factor.quality.source, /腾讯未复权备用/);
    assert.ok(Object.values(factor.quality.historyChecks).every(item => item.adjusted === false));
    assert.doesNotMatch(factor.quality.limitations.join('；'), /混用了前复权与未复权/);

    failSecondCode = true;
    const backtestResponse = await handleApiRequest(new Request('http://localhost/api/backtest?codes=600000,000001&start=2025-01-01&end=2026-10-30&fast=10&slow=30'));
    const backtest = await backtestResponse.json();
    assert.equal(backtestResponse.status, 200, JSON.stringify(backtest));
    assert.equal(backtest.failedCodes[0].code, '000001');
    assert.ok(Math.abs(backtest.finalValue - backtest.initial) < 0.01);
    assert.match(backtest.warnings.join('；'), /对应资金保留为现金/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
