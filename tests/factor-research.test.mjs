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
