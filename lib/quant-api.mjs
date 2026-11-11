import { FACTOR_DEFINITIONS, buildFactorResearch } from './factor-research.mjs';

let universeCache = { at: 0, rows: [] };
const jsonHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function market(code) { return code.startsWith('6') ? 'sh' : code.startsWith('8') || code.startsWith('4') ? 'bj' : 'sz'; }
function validCode(code) { return /^\d{6}$/.test(code || ''); }
function badRequest(message) { return Object.assign(new Error(message), { status: 400 }); }
function json(res, data, status = 200) { res.writeHead(status, jsonHeaders); res.end(JSON.stringify(data)); }
function number(fields, index) { const n = Number(fields[index]); return Number.isFinite(n) ? n : null; }
async function fetchRetry(url, options = {}, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
      if (response.ok) return response;
      lastError = new Error(`上游接口返回 ${response.status}`);
      if ([401, 403, 404, 405, 501].includes(response.status)) break;
    } catch (error) { lastError = error; }
    if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)));
  }
  throw lastError || new Error('上游接口连接失败');
}
function withTimeout(promise, milliseconds, message = '请求超时') {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
function parseQuote(raw, code) {
  const match = raw.match(/="([^\"]*)"/); if (!match) throw new Error('腾讯行情返回为空');
  const fields = match[1].split('~'); const price = Number(fields[3]); if (!Number.isFinite(price) || price <= 0) throw new Error(`股票 ${code} 行情无效`);
  const previous = Number(fields[4]); const change = Number(fields[32]); const book = { asks: [], bids: [] };
  for (let i = 0; i < 5; i += 1) { book.asks.push({ price: number(fields, 19 + i * 2), volumeLots: number(fields, 20 + i * 2) }); book.bids.push({ price: number(fields, 9 + i * 2), volumeLots: number(fields, 10 + i * 2) }); }
  return { code, market: market(code).toUpperCase(), name: (fields[1] || `A股 ${code}`).replace(/\s+/g, ''), price, previous, change: Number.isFinite(change) ? change : (price / previous - 1) * 100, open: number(fields, 5), volumeLots: number(fields, 6), outerVolumeLots: number(fields, 7), innerVolumeLots: number(fields, 8), high: number(fields, 33), low: number(fields, 34), turnoverRate: number(fields, 38), pe: number(fields, 39), amplitude: number(fields, 43), marketCapYi: number(fields, 44), floatMarketCapYi: number(fields, 45), pb: number(fields, 49), turnoverWan: number(fields, 57), book, time: fields[30] || '', source: '腾讯行情' };
}
async function fetchQuote(code) { const ticker = `${market(code)}${code}`; const response = await fetch(`https://qt.gtimg.cn/q=${ticker}`, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://gu.qq.com/' } }); if (!response.ok) throw new Error(`腾讯报价接口返回 ${response.status}`); return parseQuote(new TextDecoder('gb18030').decode(await response.arrayBuffer()), code); }
async function fetchQuotes(codes) { const clean = [...new Set(codes.filter(validCode))].slice(0, 100); if (!clean.length) return []; const tickers = clean.map(code => `${market(code)}${code}`).join(','); const response = await fetchRetry(`https://qt.gtimg.cn/q=${tickers}`, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://gu.qq.com/' } }); const raw = new TextDecoder('gb18030').decode(await response.arrayBuffer()); return clean.map(code => { try { const start = raw.indexOf(`v_${market(code)}${code}=`); return parseQuote(start >= 0 ? raw.slice(start) : '', code); } catch { return null; } }).filter(Boolean); }
async function fetchHistory(code) {
  const end = new Date();
  const endText = `${end.getFullYear()}-${String(end.getMonth()+1).padStart(2,'0')}-${String(end.getDate()).padStart(2,'0')}`;
  const history = await fetchUnadjustedDailyHistory(code, '2010-01-01', endText);
  return { code, rows: history.rows.map(row => [row.date, row.open, row.close, row.high, row.low, row.volume]), source: history.source, diagnostics: history.diagnostics };
}
function dateText(date) { return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`; }
function validDate(value) { if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false; const date = new Date(`${value}T00:00:00Z`); return Number.isFinite(date.getTime()) && dateText(date) === value; }
function researchStartDate(start, lookback = 400) { const date = new Date(`${start}T00:00:00Z`); date.setUTCDate(date.getUTCDate() - lookback); return dateText(date); }
function chinaDateText(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  return `${parts.find(item => item.type === 'year').value}-${parts.find(item => item.type === 'month').value}-${parts.find(item => item.type === 'day').value}`;
}
function previousDateText(value) { const date = new Date(`${value}T00:00:00Z`); date.setUTCDate(date.getUTCDate() - 1); return dateText(date); }
async function fetchEastmoneyResearchHistory(code, start, end) {
  const secid = `${code.startsWith('6') ? 1 : 0}.${code}`;
  const fields = 'f51%2Cf52%2Cf53%2Cf54%2Cf55%2Cf56%2Cf57%2Cf58%2Cf59%2Cf60%2Cf61';
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=1&beg=${start.replaceAll('-', '')}&end=${end.replaceAll('-', '')}&lmt=5000&fields1=f1%2Cf2%2Cf3%2Cf4%2Cf5%2Cf6&fields2=${fields}`;
  const response = await fetchRetry(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://quote.eastmoney.com/' } });
  const payload = await response.json(); const lines = payload?.data?.klines;
  if (!Array.isArray(lines)) throw new Error('东方财富未返回前复权日线');
  const inRange = lines.map(line => { const [date, open, close, high, low, volume, amount, amplitude, changePct, change, turnover] = line.split(','); return { date, open: Number(open), close: Number(close), high: Number(high), low: Number(low), volume: Number(volume), amount: Number(amount), amplitude: Number(amplitude), changePct: Number(changePct), change: Number(change), turnover: Number(turnover) }; }).filter(row => row.date >= start && row.date <= end);
  const validRows = inRange.filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && row.open > 0 && row.close > 0 && row.high >= row.low && row.low > 0 && [row.open, row.close, row.high, row.low, row.volume].every(Number.isFinite));
  if (validRows.length >= 5000 && validRows[0].date > start) throw new Error('东方财富日线达到单次查询上限，无法覆盖所选完整区间');
  const wasSorted = validRows.every((row, index) => index === 0 || validRows[index - 1].date <= row.date); const unique = new Map(); validRows.forEach(row => unique.set(row.date, row)); const rows = [...unique.values()].sort((a, b) => a.date.localeCompare(b.date)); const extremeMoves = [];
  for (let i = 1; i < rows.length; i += 1) { const change = rows[i].close / rows[i - 1].close - 1; if (Math.abs(change) > 0.25) extremeMoves.push({ date: rows[i].date, change: Number((change * 100).toFixed(2)) }); }
  return { rows, source: '东方财富前复权', diagnostics: { source: '东方财富', adjusted: true, returnedBars: inRange.length, validBars: rows.length, invalidBars: inRange.length - validRows.length, duplicateDates: validRows.length - unique.size, sourceWasChronological: wasSorted, extremeDailyMoves: extremeMoves.length, extremeMoveExamples: extremeMoves.slice(0, 5), firstDate: rows[0]?.date || null, lastDate: rows.at(-1)?.date || null } };
}
async function fetchTencentAdjustedHistory(code, start, end) {
  if (!validDate(start) || !validDate(end) || start >= end) throw new Error('腾讯前复权日线查询区间无效');
  const ticker = `${market(code)}${code}`; const windows = []; const finalDate = new Date(`${end}T00:00:00Z`); let cursor = new Date(`${start}T00:00:00Z`);
  while (cursor < finalDate) { const finish = new Date(cursor); finish.setUTCFullYear(finish.getUTCFullYear() + 2); if (finish > finalDate) finish.setTime(finalDate.getTime()); windows.push([dateText(cursor), dateText(finish)]); cursor = new Date(finish); cursor.setUTCDate(cursor.getUTCDate() + 1); }
  const lines = []; const emptyWindows = [];
  for (const [from, to] of windows) {
    const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${ticker},day,${from},${to},640,qfq`;
    const response = await fetchRetry(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://gu.qq.com/' } }); const payload = await response.json(); const stock = payload?.data?.[ticker]; const rows = stock?.qfqday;
    if (Array.isArray(rows)) {
      if (rows.length) lines.push(...rows);
      else emptyWindows.push({ start: from, end: to });
      continue;
    }
    if (payload?.code === 0 && stock && Array.isArray(stock.day) && stock.day.length === 0) { emptyWindows.push({ start: from, end: to }); continue; }
    throw new Error(`腾讯未返回 ${code} 的前复权日线（返回代码：${payload?.code ?? '无'}；数据键：${Object.keys(payload?.data || {}).join(',') || '无'}）`);
  }
  const byDate = new Map(); let invalidBars = 0; let validCount = 0; let sourceWasChronological = true; let previousDate = '';
  for (const line of lines) {
    const [date, open, close, high, low, volume] = Array.isArray(line) ? line : typeof line === 'string' ? line.split(',') : [];
    const row = { date, open: Number(open), close: Number(close), high: Number(high), low: Number(low), volume: Number(volume), amount: null };
    if (date < start || date > end) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !(row.open > 0 && row.close > 0 && row.low > 0 && row.high >= row.low) || ![row.open, row.close, row.high, row.low, row.volume].every(Number.isFinite)) { invalidBars += 1; continue; }
    if (previousDate && date < previousDate) sourceWasChronological = false; previousDate = date; validCount += 1;
    byDate.set(date, row);
  }
  const rows = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (!rows.length) throw new Error(`腾讯在 ${start} 至 ${end} 没有 ${code} 的前复权日线；所选区间可能早于上市日期`);
  const extremeMoves = [];
  for (let i = 1; i < rows.length; i += 1) { const change = rows[i].close / rows[i - 1].close - 1; if (Math.abs(change) > 0.25) extremeMoves.push({ date: rows[i].date, change: Number((change * 100).toFixed(2)) }); }
  return { rows, source: '腾讯前复权备用', diagnostics: { source: '腾讯备用', adjusted: true, returnedBars: lines.length, validBars: rows.length, emptyWindows, invalidBars, duplicateDates: validCount - byDate.size, sourceWasChronological, extremeDailyMoves: extremeMoves.length, extremeMoveExamples: extremeMoves.slice(0, 5), firstDate: rows[0].date, lastDate: rows.at(-1).date } };
}
async function fetchTencentRawHistory(code, start, end) {
  if (!validDate(start) || !validDate(end) || start >= end) throw new Error('腾讯未复权日线查询区间无效');
  const ticker = `${market(code)}${code}`; const windows = []; const finalDate = new Date(`${end}T00:00:00Z`); let cursor = new Date(`${start}T00:00:00Z`);
  while (cursor < finalDate) { const finish = new Date(cursor); finish.setUTCFullYear(finish.getUTCFullYear() + 2); if (finish > finalDate) finish.setTime(finalDate.getTime()); windows.push([dateText(cursor), dateText(finish)]); cursor = new Date(finish); cursor.setUTCDate(cursor.getUTCDate() + 1); }
  const lines = []; const emptyWindows = [];
  for (const [from, to] of windows) {
    const url = `https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=${ticker},day,${from},${to},640`;
    const response = await fetchRetry(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://gu.qq.com/' } }); const payload = await response.json(); const stock = payload?.data?.[ticker]; const rows = stock?.day;
    if (!Array.isArray(rows)) throw new Error(`腾讯未返回 ${code} 的未复权日线（返回代码：${payload?.code ?? '无'}）`);
    if (rows.length) lines.push(...rows); else emptyWindows.push({ start: from, end: to });
  }
  const rows = lines.map(line => Array.isArray(line) ? line : typeof line === 'string' ? line.split(',') : []).map(([date, open, close, high, low, volume]) => ({ date, open: Number(open), close: Number(close), high: Number(high), low: Number(low), volume: Number(volume), amount: null })).filter(row => row.date >= start && row.date <= end && /^\d{4}-\d{2}-\d{2}$/.test(row.date) && row.open > 0 && row.close > 0 && row.low > 0 && row.high >= row.low && [row.open, row.close, row.high, row.low, row.volume].every(Number.isFinite));
  const byDate = new Map(rows.map(row => [row.date, row])); const sorted = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (!sorted.length) throw new Error(`腾讯在 ${start} 至 ${end} 没有 ${code} 的未复权日线；所选区间可能早于上市日期`);
  return { rows: sorted, source: '腾讯未复权备用', diagnostics: { source: '腾讯未复权备用', adjusted: false, returnedBars: lines.length, validBars: sorted.length, emptyWindows, invalidBars: lines.length - rows.length, duplicateDates: rows.length - byDate.size, sourceWasChronological: true, extremeDailyMoves: 0, firstDate: sorted[0].date, lastDate: sorted.at(-1).date } };
}
async function fetchSinaDailyHistory(code, start, end) {
  if (!validDate(start) || !validDate(end) || start >= end) throw new Error('新浪日线查询区间无效');
  const ticker = `${market(code)}${code}`;
  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${ticker}&scale=240&ma=no&datalen=1023`;
  const response = await fetchRetry(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://finance.sina.com.cn/' } }); const text = await response.text(); let payload;
  try { payload = JSON.parse(text); } catch { const left = text.indexOf('('); const right = text.lastIndexOf(')'); if (left >= 0 && right > left) payload = JSON.parse(text.slice(left + 1, right)); }
  if (!Array.isArray(payload)) throw new Error(`新浪未返回 ${code} 的日线`);
  const parsed = payload.map(item => ({ date: item.day, open: Number(item.open), close: Number(item.close), high: Number(item.high), low: Number(item.low), volume: Number(item.volume), amount: Number(item.amount ?? item.turnover) })).filter(row => row.date >= start && row.date <= end && validDate(row.date) && row.open > 0 && row.close > 0 && row.low > 0 && row.high >= row.low && [row.open, row.close, row.high, row.low, row.volume].every(Number.isFinite));
  const byDate = new Map(parsed.map(row => [row.date, row])); const rows = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (!rows.length) throw new Error(`新浪在 ${start} 至 ${end} 没有 ${code} 的日线；可用历史范围为 ${payload[0]?.day || '未知'} 至 ${payload.at(-1)?.day || '未知'}`);
  return { rows, source: '新浪未复权备用', diagnostics: { source: '新浪未复权备用', adjusted: false, returnedBars: payload.length, validBars: rows.length, invalidBars: payload.length - parsed.length, duplicateDates: parsed.length - byDate.size, sourceWasChronological: payload.every((item, index) => index === 0 || item.day >= payload[index - 1].day), extremeDailyMoves: 0, firstDate: rows[0].date, lastDate: rows.at(-1).date, limitedToLatestBars: payload.length >= 1023 } };
}
async function fetchAdjustedDailyHistory(code, start, end) {
  let eastmoneyError; let tencentAdjustedError; let tencentRawError;
  try { const history = await fetchEastmoneyResearchHistory(code, start, end); if (history.rows.length) return history; eastmoneyError = new Error('东方财富返回空日线'); }
  catch (error) { eastmoneyError = error; }
  try { const history = await fetchTencentAdjustedHistory(code, start, end); history.diagnostics.fallbackReason = eastmoneyError.message; return history; }
  catch (error) { tencentAdjustedError = error; }
  try { const history = await fetchTencentRawHistory(code, start, end); history.diagnostics.fallbackReason = `${eastmoneyError.message}；腾讯前复权：${tencentAdjustedError.message}`; return history; }
  catch (error) { tencentRawError = error; }
  try { const history = await fetchSinaDailyHistory(code, start, end); history.diagnostics.fallbackReason = `${eastmoneyError.message}；腾讯前复权：${tencentAdjustedError.message}；腾讯未复权：${tencentRawError.message}`; return history; }
  catch (error) { throw new Error(`东方财富失败：${eastmoneyError.message}；腾讯前复权失败：${tencentAdjustedError.message}；腾讯未复权失败：${tencentRawError.message}；新浪备用失败：${error.message}`); }
}
async function fetchUnadjustedDailyHistory(code, start, end) {
  let tencentError;
  try { return await fetchTencentRawHistory(code, start, end); } catch (error) { tencentError = error; }
  try { const history = await fetchSinaDailyHistory(code, start, end); history.diagnostics.fallbackReason = `腾讯未复权：${tencentError.message}`; return history; }
  catch (error) { throw new Error(`统一未复权数据源失败。腾讯：${tencentError.message}；新浪：${error.message}`); }
}
async function runFactorResearch(params) {
  const rawCodes = [...new Set((params.codes || '').split(',').map(value => value.trim()).filter(Boolean))];
  const invalidCodes = rawCodes.filter(code => !validCode(code));
  if (invalidCodes.length) throw badRequest(`股票代码必须是六位数字：${invalidCodes.join(', ')}`);
  if (rawCodes.length > 40) throw badRequest('因子研究一次最多支持 40 只股票');
  const requested = rawCodes;
  const codes = requested.length ? requested : signalCandidates.slice(0, 12);
  const latestCompleteDate = previousDateText(chinaDateText());
  const requestedEnd = params.end || latestCompleteDate;
  const end = requestedEnd > latestCompleteDate ? latestCompleteDate : requestedEnd;
  const start = params.start || dateText(new Date(Date.now() - 3 * 365 * 24 * 60 * 60 * 1000));
  if (!validDate(start) || !validDate(end) || start >= end) throw badRequest('研究开始日期和结束日期无效，且开始日期必须早于结束日期');
  const factor = String(params.factor || 'momentum20');
  const definition = FACTOR_DEFINITIONS.find(item => item.name === factor);
  if (!definition) throw badRequest('请选择有效的研究因子');
  const frequency = params.frequency || 'monthly';
  if (!['monthly', 'weekly'].includes(frequency)) throw badRequest('调仓频率只支持每周或每月');
  const historyStart = researchStartDate(start, Math.max(400, definition.lookback * 4));
  const rawCostBps = params.costBps == null || params.costBps === '' ? 25 : Number(params.costBps);
  if (!Number.isFinite(rawCostBps)) throw badRequest('单边成本必须是有效数字');
  const costBps = Math.min(500, Math.max(0, rawCostBps));
  const rawSplit = params.split == null || params.split === '' ? 0.7 : Number(params.split);
  const split = Math.min(0.9, Math.max(0.5, Number.isFinite(rawSplit) ? rawSplit : 0.7));
  const rawValidationShare = params.validationShare == null || params.validationShare === '' ? 0.15 : Number(params.validationShare);
  if (!Number.isFinite(rawValidationShare)) throw badRequest('验证期占比必须是有效数字');
  const validationShare = Math.min(0.25, Math.max(0.1, rawValidationShare));
  const rawHorizon = params.horizon == null || params.horizon === '' ? 20 : Number(params.horizon);
  if (!Number.isInteger(rawHorizon) || rawHorizon < 1 || rawHorizon > 120) throw badRequest('前瞻收益期必须是 1 到 120 的整数');
  const horizon = rawHorizon;
  const seriesByCode = new Map(); const historyChecks = {}; const failedCodes = []; let nextCode = 0;
  const worker = async () => { while (nextCode < codes.length) { const code = codes[nextCode++]; try { const history = await fetchAdjustedDailyHistory(code, historyStart, end); if (history.rows.length) { seriesByCode.set(code, history.rows); historyChecks[code] = history.diagnostics; } else failedCodes.push({ code, error: '所选区间没有可用前复权日线' }); } catch (error) { failedCodes.push({ code, error: error.message }); } } };
  await Promise.all(Array.from({ length: Math.min(2, codes.length) }, worker));
  if (!seriesByCode.size) throw new Error(`所有历史数据源都无法获取日线。${failedCodes.slice(0, 3).map(item => `${item.code}: ${item.error}`).join('；')}`);
  if (new Set(Object.values(historyChecks).map(item => item.adjusted === false ? '未复权' : '前复权')).size > 1) {
    const consistentRows = new Map(); const consistentChecks = {}; const consistentFailures = []; let rawIndex = 0;
    const rawWorker = async () => { while (rawIndex < codes.length) { const code = codes[rawIndex++]; try { const history = await fetchUnadjustedDailyHistory(code, historyStart, end); consistentRows.set(code, history.rows); consistentChecks[code] = history.diagnostics; } catch (error) { consistentFailures.push({ code, error: error.message }); } } };
    await Promise.all(Array.from({ length: Math.min(2, codes.length) }, rawWorker));
    if (consistentFailures.length) throw new Error(`当前股票无法获得统一的价格复权口径，已停止因子检验以避免横截面不可比：${consistentFailures.slice(0, 3).map(item => `${item.code}: ${item.error}`).join('；')}`);
    seriesByCode.clear(); consistentRows.forEach((rows, code) => seriesByCode.set(code, rows));
    Object.keys(historyChecks).forEach(code => delete historyChecks[code]); Object.assign(historyChecks, consistentChecks);
    failedCodes.length = 0;
  }
  const calendar = [...new Set([...seriesByCode.values()].flatMap(rows => rows.map(row => row.date)))].sort();
  const report = buildFactorResearch({ seriesByCode, calendar, factor, start, end, frequency, horizon, costBps, split, validationShare });
  report.universe.requested = codes.length; report.universe.loaded = seriesByCode.size; report.universe.failedCodes = failedCodes;
  const checks = Object.values(historyChecks); report.quality.historyChecks = historyChecks; report.quality.dataQualitySummary = { invalidBars: checks.reduce((sum, item) => sum + item.invalidBars, 0), duplicateDates: checks.reduce((sum, item) => sum + item.duplicateDates, 0), nonChronologicalSources: checks.filter(item => !item.sourceWasChronological).length, extremeDailyMoves: checks.reduce((sum, item) => sum + item.extremeDailyMoves, 0) };
  report.quality.limitations.push('A 股融券受限，最高组减最低组是预测能力研究统计，不代表可直接实施的空头组合');
  if (report.quality.dataQualitySummary.invalidBars || report.quality.dataQualitySummary.duplicateDates || report.quality.dataQualitySummary.extremeDailyMoves) report.quality.limitations.push('数据质量检查发现异常日线；异常明细见报告，极端涨跌仅提示并未自动剔除');
  report.parameters.requestedEnd = requestedEnd; report.parameters.effectiveEnd = end; report.parameters.latestCompleteDate = latestCompleteDate;
  const sources = [...new Set(checks.map(item => item.source))]; report.quality.source = sources.join(' + ') + ' 前复权日线';
  const adjustmentModes = new Set(checks.map(item => item.adjusted === false ? '未复权' : '前复权'));
  report.factor.source = report.quality.source;
  if (adjustmentModes.has('前复权')) report.quality.limitations.push('前复权序列可能按后来公司行为追溯调整历史价格，平台未保存历史数据版本快照');
  if (adjustmentModes.has('未复权')) {
    report.quality.source = sources.join(' + ') + ' · 未复权日线';
    report.factor.source = report.quality.source;
    report.quality.priceType = '未复权收盘价；公司行动可能造成价格跳变，收益不等同于含分红总回报';
    report.quality.limitations.push('因公开数据源回退，部分或全部行情为未复权价格；公司行动日可能形成非经济性收益跳变，请优先检查逐日数据后解读结果');
  }
  if (seriesByCode.size < 5) report.quality.limitations.push(`当前只载入 ${seriesByCode.size} 只股票；Rank IC、分组收益等截面统计至少需要 3 只股票，建议至少使用 5 只以获得较稳健的研究结果`);
  const coverageGaps = Object.entries(historyChecks).flatMap(([code, item]) => {
    const gap = item.firstDate && item.firstDate > start ? { code, requestedStart: start, actualStart: item.firstDate } : null;
    return gap ? [gap] : [];
  });
  report.quality.historyCoverage = { requestedStart: start, requestedEnd: end, gaps: coverageGaps };
  if (coverageGaps.length) report.quality.limitations.push(`部分股票未覆盖请求起始日期 ${start}，最早实际数据晚于所选日期：${coverageGaps.map(item => `${item.code} 从 ${item.actualStart} 开始`).join('；')}${checks.some(item => item.limitedToLatestBars) ? '；新浪备用接口仅提供最近 1023 根日线' : ''}`);
  const staleHistory = Object.entries(historyChecks).filter(([, item]) => item.lastDate && item.lastDate < end && (new Date(`${end}T00:00:00Z`) - new Date(`${item.lastDate}T00:00:00Z`)) > 7 * 24 * 60 * 60 * 1000);
  if (staleHistory.length) report.quality.limitations.push(`部分股票的最新可用日线早于请求结束日期 ${end}：${staleHistory.map(([code, item]) => `${code} 截至 ${item.lastDate}`).join('；')}`);
  const partialHistory = Object.entries(historyChecks).filter(([, item]) => item.emptyWindows?.length);
  if (partialHistory.length) report.quality.limitations.push(`部分股票在所选区间内没有早期日线，可能是尚未上市；实际覆盖日期见下方数据区间：${partialHistory.map(([code, item]) => `${code} ${item.firstDate} 至 ${item.lastDate}`).join('；')}`);
  report.metadata.dataVersion = `${sources.join('+')}-${adjustmentModes.values().next().value || '行情'}-${historyStart}-${end}-${new Date().toISOString().slice(0, 10)}`;
  return report;
}
async function fetchUniverse() {
  if (Date.now() - universeCache.at < 20_000 && universeCache.rows.length) return universeCache.rows;
  const headers = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.cninfo.com.cn/' };
  const szResponse = await fetchRetry('https://www.cninfo.com.cn/new/data/szse_stock.json', { headers });
  if (!szResponse.ok) throw new Error(`深交所股票目录返回 ${szResponse.status}`);
  const sz = await szResponse.json();
  const rows = (sz.stockList || []).filter(item => item.category === 'A股').map(item => ({ code: item.code, name: item.zwjc, market: market(item.code).toUpperCase(), industry: '未分类' }));
  const shResponse = await fetchRetry('https://www.sse.com.cn/js/common/ssesuggestdata.js', { headers: { ...headers, Referer: 'https://www.sse.com.cn/' } });
  if (!shResponse.ok) throw new Error(`上交所股票目录返回 ${shResponse.status}`);
  const script = await shResponse.text();
  const seen = new Set(rows.map(row => row.code));
  const shPattern = /val:\"(6(?:00|01|03|05|88|89)\d{3})\",val2:\"([^\"]*)\"/g;
  for (const match of script.matchAll(shPattern)) { if (!seen.has(match[1])) { rows.push({ code: match[1], name: match[2], market: 'SH', industry: '未分类' }); seen.add(match[1]); } }
  universeCache = { at: Date.now(), rows: rows.sort((a, b) => a.code.localeCompare(b.code)) };
  return universeCache.rows;
}
function metrics(rows, quote = null, source = '') {
  const closes = rows.map(row => Number(row[2])).filter(Number.isFinite);
  if (!closes.length) return { momentum5: null, momentum20: null, momentum60: null, volatility20: null, signal: '观察', strength: 1, score: 0, scoreBreakdown: { trend: 0, momentum: 0, volume: 0, riskControl: 0, liquidity: 0, dataQuality: 0 }, reason: '历史数据不足', riskReason: '无法评估风险' };
  const last = closes.at(-1); const avg = n => closes.slice(-n).reduce((a, b) => a + b, 0) / Math.min(n, closes.length); const ret = n => closes.length > n ? (last / closes.at(-n - 1) - 1) * 100 : null; const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const daily = closes.slice(-61).map((v, i, a) => i ? v / a[i - 1] - 1 : null).filter(Number.isFinite); const recentDaily = daily.slice(-20); const mean = recentDaily.length ? recentDaily.reduce((a, b) => a + b, 0) / recentDaily.length : 0;
  const vol = recentDaily.length > 1 ? Math.sqrt(Math.max(0, recentDaily.reduce((a, b) => a + b * b, 0) / recentDaily.length - mean ** 2)) * Math.sqrt(250) * 100 : null;
  const momentum5 = ret(5); const momentum20 = ret(20); const momentum60 = ret(60); const sma20 = avg(20); const sma60 = avg(60); const previousSma20 = closes.length > 30 ? closes.slice(-30, -10).reduce((a, b) => a + b, 0) / 20 : sma20; const sma20Slope = previousSma20 ? (sma20 / previousSma20 - 1) * 100 : 0;
  const trend = clamp((last > sma20 ? 8 : 0) + (last > sma60 ? 8 : 0) + (sma20 > sma60 ? 5 : 0) + (sma20Slope > 0 ? 4 : 0), 0, 25);
  const momentum = clamp((momentum5 == null ? 0 : momentum5 > 3 ? 6 : momentum5 > 0 ? 4 : 0) + (momentum20 == null ? 0 : momentum20 > 8 ? 8 : momentum20 > 0 ? 5 : 0) + (momentum60 == null ? 0 : momentum60 > 15 ? 6 : momentum60 > 0 ? 4 : 0), 0, 20);
  const volumes = rows.map(row => Number(row[5])).filter(Number.isFinite); const latestVolume = volumes.at(-1); const volumeAvg20 = volumes.length ? volumes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, volumes.length) : null; const volumeRatio = latestVolume && volumeAvg20 ? latestVolume / volumeAvg20 : null; const volume = clamp((volumeRatio == null ? 0 : volumeRatio >= 0.8 && volumeRatio <= 2.5 ? 7 : volumeRatio > 2.5 ? 4 : 2) + (last > closes.at(-2) && volumeRatio != null && volumeRatio >= 1 ? 5 : 0) + (volumeRatio != null && volumeRatio >= 0.8 ? 3 : 0), 0, 15);
  const trailingHigh = Math.max(...closes.slice(-60)); const drawdown = trailingHigh ? (last / trailingHigh - 1) * 100 : null; const extremeMoves = daily.filter(change => Math.abs(change) > 0.1).length; const riskControl = clamp((vol == null ? 0 : vol <= 20 ? 8 : vol <= 35 ? 6 : vol <= 50 ? 3 : 0) + (drawdown == null ? 0 : drawdown >= -10 ? 6 : drawdown >= -20 ? 4 : drawdown >= -35 ? 2 : 0) + (extremeMoves <= 1 ? 6 : extremeMoves <= 3 ? 3 : 0), 0, 20);
  const turnoverWan = Number(quote?.turnoverWan); const turnoverRate = Number(quote?.turnoverRate); const liquidity = clamp(Number.isFinite(turnoverWan) && turnoverWan > 0 ? (turnoverWan >= 100000 ? 7 : turnoverWan >= 20000 ? 6 : turnoverWan >= 5000 ? 4 : turnoverWan >= 1000 ? 2 : 1) + (Number.isFinite(turnoverRate) && turnoverRate >= 0.5 && turnoverRate <= 12 ? 3 : 0) : (Number.isFinite(turnoverRate) && turnoverRate >= 0.5 && turnoverRate <= 12 ? 5 : 1), 0, 10);
  const sourceQuality = /东方财富|腾讯前复权/.test(source) ? 10 : /腾讯未复权/.test(source) ? 8 : /新浪/.test(source) ? 6 : 3; const dataQuality = Math.round(clamp((closes.length >= 500 ? 7 : closes.length >= 250 ? 5 : closes.length >= 120 ? 3 : closes.length >= 60 ? 1 : 0) + sourceQuality * 0.3, 0, 10)); const score = Math.round(trend + momentum + volume + riskControl + liquidity + dataQuality);
  const reasons = []; const riskReasons = [];
  if (last > sma20 && last > sma60) reasons.push('价格同时站上 SMA20/SMA60'); else if (last <= sma20) reasons.push('价格低于 SMA20');
  if (momentum20 != null) reasons.push(`20日动量 ${momentum20.toFixed(1)}%`);
  if (volumeRatio != null && volumeRatio >= 1) reasons.push(`量比 ${volumeRatio.toFixed(1)}x 确认`); else reasons.push('成交量未确认');
  if (vol != null) riskReasons.push(`年化波动率 ${vol.toFixed(1)}%${vol > 50 ? '偏高' : '可控'}`); if (drawdown != null) riskReasons.push(`距60日高点回撤 ${drawdown.toFixed(1)}%${drawdown < -20 ? '偏深' : ''}`); if (!riskReasons.length) riskReasons.push('波动与回撤无法评估');
  const signal = dataQuality < 5 ? '观察' : score >= 72 && riskControl >= 10 ? '买入' : score <= 38 || (trend <= 8 && momentum <= 8) ? '卖出' : '观察'; const strength = score >= 82 ? 5 : score >= 70 ? 4 : score >= 55 ? 3 : score >= 40 ? 2 : 1;
  return { momentum5, momentum20, momentum60, volatility20: vol, drawdown60: drawdown, volumeRatio, signal, strength, score, scoreBreakdown: { trend: Math.round(trend), momentum: Math.round(momentum), volume: Math.round(volume), riskControl: Math.round(riskControl), liquidity: Math.round(liquidity), dataQuality }, reason: reasons.join(' · '), riskReason: riskReasons.join(' · '), sma20, sma60 };
}
const signalCandidates = ['600519','300750','000858','601318','600036','002594','601888','600276','000333','000651','601012','600900','601899','600030','300059','002415','600309','603259','688981','688041','601127','000568','600028','601398','601288','600938','601857','600048','601088'];
async function makeSignals(codes, strategy = 'trend') {
  const selected = [...new Set((codes.length ? codes : signalCandidates).filter(validCode))].slice(0, 20);
  const end = new Date(); const start = new Date(end); start.setMonth(end.getMonth() - 18);
  const dateText = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const items = await Promise.all(selected.map(async code => { try { const [quoteResult, historyResult] = await Promise.allSettled([withTimeout(fetchQuote(code), 8000, '腾讯实时行情超时'), withTimeout(fetchUnadjustedDailyHistory(code, dateText(start), dateText(end)), 18000, '历史日线获取超时')]); if (quoteResult.status !== 'fulfilled') return null; const quote = quoteResult.value; const history = historyResult.status === 'fulfilled' ? historyResult.value : null; const rows = history?.rows?.map(row => [row.date, row.open, row.close, row.high, row.low, row.volume]) || []; const stats = metrics(rows, quote, history?.source || ''); return { ...quote, ...stats, dataPoints: rows.length, dataSource: history?.source || `不可用：${historyResult.reason?.message || '历史日线请求失败'}`, strategy: strategy === 'lowvol' ? '低波动筛选 · 多维评分' : '趋势评分 · 多维评分', time: quote.time }; } catch { return null; } }));
  return items.filter(Boolean).sort((a, b) => (b.score || 0) - (a.score || 0));
}
async function fetchEastmoneyKline(code, period = '101', adjust = '1', limit = 500) {
  const secid = `${code.startsWith('6') ? 1 : 0}.${code}`;
  const klt = ['101','102','103','1','5','15','30','60'].includes(String(period)) ? String(period) : '101';
  const fqt = ['0','1','2'].includes(String(adjust)) ? String(adjust) : '1';
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=${klt}&fqt=${fqt}&beg=0&end=20500101&lmt=${Math.min(5000,Math.max(20,Number(limit)||500))}&fields1=f1%2Cf2%2Cf3%2Cf4%2Cf5%2Cf6&fields2=f51%2Cf52%2Cf53%2Cf54%2Cf55%2Cf56%2Cf57%2Cf58%2Cf59%2Cf60%2Cf61`;
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://quote.eastmoney.com/' } });
  if (!response.ok) throw new Error(`东方财富历史行情返回 ${response.status}`);
  const payload = await response.json(); const data = payload?.data;
  if (!data?.klines) throw new Error('东方财富没有返回该股票的K线数据');
  const rows = data.klines.map(line => { const [date,open,close,high,low,volume,amount,amplitude,changePct,change,turnover] = line.split(','); return { date, open:Number(open), close:Number(close), high:Number(high), low:Number(low), volume:Number(volume), amount:Number(amount), amplitude:Number(amplitude), changePct:Number(changePct), change:Number(change), turnover:Number(turnover) }; });
  return { code, name:data.name, period:klt, adjust:fqt, source:'东方财富', rows };
}
async function fetchAnnouncements(code) {
  const url = `https://np-anotice-stock.eastmoney.com/api/security/ann?cb=qp&ann_type=A&client_source=web&stock_list=${code}&page_index=1&page_size=30&sr=-1`;
  const response = await fetch(url, { headers: { 'User-Agent':'Mozilla/5.0', Referer:`https://data.eastmoney.com/notices/stock/${code}.html` } });
  if (!response.ok) throw new Error(`东方财富公告接口返回 ${response.status}`);
  const raw = await response.text(); const left = raw.indexOf('('); const right = raw.lastIndexOf(')');
  if (left < 0 || right <= left) throw new Error('东方财富公告接口返回格式异常');
  const payload = JSON.parse(raw.slice(left + 1, right));
  const items = (payload?.data?.list || []).map(item => ({ title:item.title_ch || item.title || '未命名公告', time:item.notice_date || item.display_time || '', category:item.columns?.[0]?.column_name || '公司公告', source:'东方财富', url:`https://data.eastmoney.com/notices/detail/${code}/${item.art_code}.html` }));
  return { code, source:'东方财富公告', items };
}
async function probeDataSources(code) {
  const ticker = `${market(code)}${code}`; const today = chinaDateText(); const previous = previousDateText(today);
  const probes = [
    ['tencent-quote', '腾讯实时行情', `https://qt.gtimg.cn/q=${ticker}`, async response => parseQuote(new TextDecoder('gb18030').decode(await response.arrayBuffer()), code).price > 0],
    ['eastmoney-adjusted', '东方财富前复权', `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${code.startsWith('6') ? 1 : 0}.${code}&klt=101&fqt=1&beg=${today.replaceAll('-', '')}&end=${today.replaceAll('-', '')}&lmt=5&fields1=f1%2Cf2%2Cf3%2Cf4%2Cf5%2Cf6&fields2=f51%2Cf52%2Cf53%2Cf54%2Cf55%2Cf56%2Cf57%2Cf58%2Cf59%2Cf60%2Cf61`, async response => Array.isArray((await response.json())?.data?.klines)],
    ['tencent-adjusted', '腾讯前复权', `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${ticker},day,${previous},${today},20,qfq`, async response => { const data = (await response.json())?.data?.[ticker]; return Array.isArray(data?.qfqday); }],
    ['tencent-raw', '腾讯未复权', `https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=${ticker},day,${previous},${today},20`, async response => Array.isArray((await response.json())?.data?.[ticker]?.day)],
    ['sina-raw', '新浪未复权', `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${ticker}&scale=240&ma=no&datalen=2`, async response => Array.isArray(await response.json())],
  ];
  const results = await Promise.all(probes.map(async ([id, name, url, read]) => {
    const startedAt = Date.now();
    try {
      const referer = id.startsWith('sina') ? 'https://finance.sina.com.cn/' : id.startsWith('eastmoney') ? 'https://quote.eastmoney.com/' : 'https://gu.qq.com/';
      const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: referer }, signal: AbortSignal.timeout(8000) });
      if (!response.ok) return { id, name, ok: false, status: response.status, error: `上游接口返回 ${response.status}`, latencyMs: Date.now() - startedAt };
      const ok = await read(response);
      return { id, name, ok: Boolean(ok), status: response.status, error: ok ? '' : '接口可连接，但未返回预期字段', latencyMs: Date.now() - startedAt };
    } catch (error) { return { id, name, ok: false, status: null, error: error.message || '连接失败', latencyMs: Date.now() - startedAt }; }
  }));
  return { code, checkedAt: new Date().toISOString(), providers: results };
}
function sma(values, index, length) { const start = Math.max(0, index - length + 1); const sample = values.slice(start, index + 1); return sample.reduce((a, b) => a + b, 0) / sample.length; }
function indicatorSeries(rows, descriptor) {
  const key = descriptor?.name || 'close'; const period = Math.max(2, Math.min(500, Number(descriptor?.period) || 20));
  const closes = rows.map(row => row.close); const highs = rows.map(row => row.high); const lows = rows.map(row => row.low); const volumes = rows.map(row => row.volume);
  if (key === 'close') return closes; if (key === 'open') return rows.map(row => row.open); if (key === 'high') return highs; if (key === 'low') return lows; if (key === 'volume') return volumes;
  if (key === 'sma' || key === 'volumeSma') { const values = key === 'sma' ? closes : volumes; return values.map((_, i) => i + 1 < period ? null : values.slice(i - period + 1, i + 1).reduce((a,b) => a + b, 0) / period); }
  if (key === 'ema') { const out = Array(rows.length).fill(null); const alpha = 2 / (period + 1); let value = null; for (let i = 0; i < rows.length; i += 1) { value = value === null ? closes[i] : closes[i] * alpha + value * (1 - alpha); if (i >= period - 1) out[i] = value; } return out; }
  if (key === 'rsi') { const out = Array(rows.length).fill(null); for (let i = period; i < rows.length; i += 1) { let gain = 0; let loss = 0; for (let j = i - period + 1; j <= i; j += 1) { const change = closes[j] - closes[j - 1]; if (change > 0) gain += change; else loss -= change; } const avgGain = gain / period; const avgLoss = loss / period; out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss); } return out; }
  if (key === 'momentum') return closes.map((value, i) => i < period ? null : (value / closes[i - period] - 1) * 100);
  if (key === 'highest' || key === 'lowest') { const source = key === 'highest' ? highs : lows; return source.map((_, i) => i + 1 < period ? null : (key === 'highest' ? Math.max : Math.min)(...source.slice(i - period + 1, i + 1))); }
  if (key === 'breakoutHigh' || key === 'breakoutLow') { const source = key === 'breakoutHigh' ? highs : lows; return source.map((_, i) => i < period ? null : (key === 'breakoutHigh' ? Math.max : Math.min)(...source.slice(i - period, i))); }
  if (key === 'bollUpper' || key === 'bollLower') return closes.map((_, i) => { if (i + 1 < period) return null; const sample = closes.slice(i - period + 1, i + 1); const mean = sample.reduce((a,b) => a+b, 0) / period; const sd = Math.sqrt(sample.reduce((a,b) => a + (b-mean) ** 2, 0) / period); return mean + (key === 'bollUpper' ? 2 : -2) * sd; });
  if (key === 'atr') return rows.map((_, i) => { if (i + 1 < period) return null; const tr = rows.slice(i-period+1, i+1).map((row, offset) => { const idx = i-period+1+offset; const prev = idx ? closes[idx-1] : row.close; return Math.max(row.high-row.low, Math.abs(row.high-prev), Math.abs(row.low-prev)); }); return tr.reduce((a,b)=>a+b,0)/period; });
  if (key === 'macd' || key === 'macdSignal') { const ema = (length) => { const values = []; const alpha = 2/(length+1); for (let i=0,v=closes[0]; i<closes.length; i+=1) { v = i ? closes[i]*alpha+v*(1-alpha) : closes[i]; values.push(v); } return values; }; const fast=ema(12), slow=ema(26), line=fast.map((v,i)=>v-slow[i]); if(key==='macd') return line; const out=[]; const alpha=2/(9+1); for(let i=0,v=line[0];i<line.length;i+=1){v=i?line[i]*alpha+v*(1-alpha):line[i];out.push(v);} return out; }
  return Array(rows.length).fill(null);
}
function compareRule(rule, i, seriesCache) {
  const series = descriptor => { const key = `${descriptor.name}:${descriptor.period || 0}`; if (!seriesCache.has(key)) seriesCache.set(key, indicatorSeries(seriesCache.rows, descriptor)); return seriesCache.get(key); };
  const leftSeries = series(rule.left || { name: 'close' }); const rightSpec = rule.right || { type: 'value', value: 0 }; const rightSeries = rightSpec.type === 'indicator' ? series(rightSpec) : null;
  const left = leftSeries[i]; const right = rightSeries ? rightSeries[i] : Number(rightSpec.value); if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  const previousLeft = i ? leftSeries[i-1] : null; const previousRight = rightSeries ? rightSeries[i-1] : right;
  if (rule.op === 'crossUp') return Number.isFinite(previousLeft) && Number.isFinite(previousRight) && left > right && previousLeft <= previousRight;
  if (rule.op === 'crossDown') return Number.isFinite(previousLeft) && Number.isFinite(previousRight) && left < right && previousLeft >= previousRight;
  if (rule.op === 'lt') return left < right; if (rule.op === 'lte') return left <= right; if (rule.op === 'gte') return left >= right; if (rule.op === 'eq') return left === right; return left > right;
}
function matchesRules(rules, join, i, seriesCache) { if (!Array.isArray(rules) || !rules.length) return false; const results = rules.map(rule => compareRule(rule, i, seriesCache)); return join === 'any' ? results.some(Boolean) : results.every(Boolean); }
async function runBacktest(code, params) {
  const start = params.start || ''; const end = params.end || '';
  if (start && !validDate(start)) throw badRequest('回测开始日期无效');
  if (end && !validDate(end)) throw badRequest('回测结束日期无效');
  if (start && end && start >= end) throw badRequest('回测开始日期必须早于结束日期');
  const latestCompleteDate = previousDateText(chinaDateText()); const effectiveEnd = end && end < latestCompleteDate ? end : latestCompleteDate;
  const lookback = Math.max(400, Number(params.slow) || 60, Number(params.atrPeriod) || 14) + 100;
  const historyStart = start ? researchStartDate(start, lookback) : '2010-01-01';
  const history = params._historyMode === 'raw' ? await fetchUnadjustedDailyHistory(code, historyStart, effectiveEnd) : await fetchAdjustedDailyHistory(code, historyStart, effectiveEnd); const rows = history.rows;
  const firstMatch = rows.findIndex(row => !start || row.date >= start);
  const first = firstMatch < 0 ? rows.length : firstMatch;
  const lastMatch = end ? rows.findLastIndex(row => row.date <= end) : rows.length - 1;
  const last = lastMatch;
  if (last < first || !rows.length) throw new Error(`${code} 在所选日期内没有可用日线`);
  const initial = Number(params.initial) > 0 ? Number(params.initial) : 1000000;
  const fast = Math.max(2, Number(params.fast) || 20); const slow = Math.max(fast + 1, Number(params.slow) || 60);
  const parsePercent = (key, fallback) => { const raw = params[key]; const value = raw == null || raw === '' ? fallback : Number(raw); if (!Number.isFinite(value)) throw badRequest(`${key} 必须是有效数字`); return Math.max(0, value) / 100; };
  const commission = parsePercent('commission', 0.025); const stampTax = parsePercent('stampTax', 0.05); const slippage = parsePercent('slippage', 0.1);
  const maxPosition = Math.min(1, Math.max(0.01, Number(params.maxPosition || params.position || 95) / 100));
  const stopLoss = Math.max(0, Number(params.stopLoss || 0) / 100); const atrPeriod = Math.max(2, Math.min(100, Number(params.atrPeriod) || 14)); const atrMultiplier = Math.max(0, Math.min(20, Number(params.atrMultiplier) || 0)); const atrSeries = indicatorSeries(rows, { name: 'atr', period: atrPeriod }); const frequency = String(params.frequency || 'daily');
  const strategy = String(params.strategy || 'trend'); let spec = null; try { spec = params.spec ? JSON.parse(params.spec) : null; } catch { throw new Error('策略条件格式无效，请重新保存策略'); } let cash = initial; let shares = 0; let entry = 0; let peakHigh = 0; let wins = 0; let losses = 0; let grossProfit = 0; let grossLoss = 0; let pending = null; const trades = []; const equity = [];
  const closes = rows.map(row => row.close);
  const seriesCache = new Map(); seriesCache.rows = rows;
  const canRebalance = i => frequency === 'weekly' ? (i === 0 || new Date(`${rows[i].date}T00:00:00Z`).getUTCDay() === 1) : frequency === 'monthly' ? (i === 0 || rows[i].date.slice(0, 7) !== rows[i - 1].date.slice(0, 7)) : true;
  const closeTrade = (row, forced = false, exitPrice = null, reason = '') => { if (!shares) return; const fill = (Number.isFinite(exitPrice) ? exitPrice : row.open) * (1 - slippage); const proceeds = fill * shares * (1 - commission - stampTax); const pnl = proceeds - entry * shares; cash += proceeds; trades.push({ date: row.date, side: forced ? '卖出（期末）' : '卖出', price: fill, qty: shares, pnl, reason }); if (pnl >= 0) { wins += 1; grossProfit += pnl; } else { losses += 1; grossLoss += Math.abs(pnl); } shares = 0; entry = 0; peakHigh = 0; };
  for (let i = 0; i <= last; i += 1) {
    const row = rows[i];
    if (pending && i >= first) { const fill = row.open * (1 + slippage); const qty = Math.floor((cash * maxPosition) / (fill * (1 + commission)) / 100) * 100; if (pending === 'buy' && !shares && qty > 0) { cash -= fill * qty * (1 + commission); shares = qty; entry = fill; peakHigh = fill; trades.push({ date: row.date, side: '买入', price: fill, qty }); } else if (pending === 'sell' && shares) closeTrade(row, false, row.open, '策略离场'); pending = null; }
    if (shares && i > first) { const fixedStop = stopLoss > 0 ? entry * (1 - stopLoss) : 0; const atrStop = atrMultiplier > 0 && Number.isFinite(atrSeries[i - 1]) ? peakHigh - atrSeries[i - 1] * atrMultiplier : 0; const activeStop = Math.max(fixedStop, atrStop); if (activeStop > 0 && row.low <= activeStop) { const fill = row.open <= activeStop ? row.open : activeStop; closeTrade(row, false, fill, atrStop >= fixedStop && atrStop > 0 ? `ATR${atrPeriod}×${atrMultiplier}移动止损` : '固定止损'); } else peakHigh = Math.max(peakHigh, row.high); }
    const fastAvg = sma(closes, i, fast); const slowAvg = sma(closes, i, slow); const prevFast = i ? sma(closes, i - 1, fast) : fastAvg; const prevSlow = i ? sma(closes, i - 1, slow) : slowAvg; const momentum = i >= fast ? (closes[i] / closes[i - fast] - 1) * 100 : null;
    const recent = closes.slice(Math.max(0, i - 20), i + 1); const returns = recent.slice(1).map((v,j) => v / recent[j] - 1); const variance = returns.length > 1 ? returns.reduce((a,b) => a + b * b, 0) / returns.length - Math.pow(returns.reduce((a,b) => a + b, 0) / returns.length, 2) : 0; const volatility = Math.sqrt(Math.max(0, variance)) * Math.sqrt(250) * 100;
    let buy = false; let sell = false;
    if (i >= Math.max(slow, first) && canRebalance(i)) { if (spec && Array.isArray(spec.entry) && spec.entry.length) { buy = matchesRules(spec.entry, spec.entryJoin, i, seriesCache); sell = matchesRules(spec.exit || [], spec.exitJoin, i, seriesCache); } else if (strategy === 'reversal') { buy = momentum !== null && momentum < -5 && prevFast <= prevSlow && fastAvg > slowAvg; sell = momentum !== null && momentum > 5; } else if (strategy === 'lowvol') { buy = volatility < 35 && closes[i] > slowAvg && prevFast <= prevSlow; sell = volatility > 50 || closes[i] < fastAvg; } else { buy = fastAvg > slowAvg && prevFast <= prevSlow; sell = fastAvg < slowAvg && prevFast >= prevSlow; } if (buy && !shares) pending = 'buy'; if (sell && shares) pending = 'sell'; }
    if (i >= first) equity.push({ date: row.date, value: cash + shares * row.close });
  }
  if (shares) { const lastRow = rows[last]; closeTrade({ ...lastRow, open: lastRow.close }, true); const point = equity.at(-1); if (point) point.value = cash; }
  const values = equity.map(row => row.value); const finalValue = cash; let peak = initial; let maxDrawdown = 0; values.forEach(value => { peak = Math.max(peak, value); maxDrawdown = Math.min(maxDrawdown, value / peak - 1); }); const totalReturn = finalValue / initial - 1; const years = Math.max(1 / 250, values.length / 250); const annual = Math.pow(Math.max(0.0001, finalValue / initial), 1 / years) - 1; const daily = values.slice(1).map((value, i) => value / values[i] - 1).filter(Number.isFinite); const mean = daily.reduce((a,b) => a + b, 0) / Math.max(1, daily.length); const std = Math.sqrt(daily.reduce((a,b) => a + (b - mean) ** 2, 0) / Math.max(1, daily.length));
  const benchmarkReturn = rows[last].open > 0 ? (rows[last].close / rows[first].open - 1) * 100 : null;
  const warnings = ['研究限制：当前未包含历史退市股票池、公告时点和停牌/涨跌停成交约束，仍有幸存者偏差与成交可实现性风险'];
  if (history.diagnostics.adjusted === false) warnings.push('本次使用未复权日线；公司行动日可能出现非经济性价格跳变');
  if (start && new Date(`${rows[first].date}T00:00:00Z`) - new Date(`${start}T00:00:00Z`) > 7 * 24 * 60 * 60 * 1000) warnings.push(`所选开始日 ${start} 早于可用数据，实际回测从 ${rows[first].date} 开始`);
  if (history.diagnostics.limitedToLatestBars && start && rows[first].date > start) warnings.push(`备用行情仅返回最近 ${history.diagnostics.returnedBars} 根日线，所选区间从 ${rows[first].date} 才有数据`);
  if (new Date(`${effectiveEnd}T00:00:00Z`) - new Date(`${rows[last].date}T00:00:00Z`) > 7 * 24 * 60 * 60 * 1000) warnings.push(`请求结束日为 ${effectiveEnd}，最新可用日线为 ${rows[last].date}，结果未覆盖最近区间`);
  return { code, strategy, initial, finalValue, totalReturn: totalReturn * 100, annual: annual * 100, maxDrawdown: maxDrawdown * 100, sharpe: std ? mean / std * Math.sqrt(250) : 0, benchmarkReturn, excessReturn: benchmarkReturn === null ? null : totalReturn * 100 - benchmarkReturn, winRate: (wins + losses) ? wins / (wins + losses) * 100 : 0, profitFactor: grossLoss ? grossProfit / grossLoss : (grossProfit ? Infinity : 0), tradeCount: trades.length, equity, trades: trades.slice(-100).map(trade => ({ ...trade, dataSource: history.source })), dataPoints: values.length, priceType: history.diagnostics.adjusted === false ? '未复权' : '前复权', warnings, source: `${history.source}（${rows[first].date} 至 ${rows[last].date}；未含最近未完成交易日）`, parameters: { start: start || rows[first].date, end: effectiveEnd, requestedStart: start || null, actualStart: rows[first].date, actualEnd: rows[last].date, requestedEnd: end || null, fast, slow, commission: commission * 100, stampTax: stampTax * 100, slippage: slippage * 100, frequency, maxPosition: maxPosition * 100, stopLoss: stopLoss * 100, atrPeriod, atrMultiplier } };
}
async function mapLimit(items, limit, mapper) {
  const results = Array(items.length); let next = 0;
  const worker = async () => { while (true) { const index = next++; if (index >= items.length) return; try { results[index] = { status: 'fulfilled', value: await mapper(items[index], index) }; } catch (reason) { results[index] = { status: 'rejected', reason }; } } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker)); return results;
}
async function runPortfolioBacktest(codes, params) {
  const clean = [...new Set(codes.filter(validCode))].slice(0, 20);
  if (clean.length <= 1) return runBacktest(clean[0] || '600519', params);
  const initial = Number(params.initial) > 0 ? Number(params.initial) : 1000000; const allocation = initial / clean.length;
  const load = async mode => { const settled = await mapLimit(clean, 3, code => runBacktest(code, { ...params, ...(mode ? { _historyMode: mode } : {}), initial: allocation })); return { results: settled.filter(item => item.status === 'fulfilled').map(item => item.value), failed: settled.map((item, index) => item.status === 'rejected' ? { code: clean[index], error: item.reason?.message || '回测失败' } : null).filter(Boolean) }; };
  let loaded = await load(null); let results = loaded.results;
  if (new Set(results.map(item => item.priceType)).size > 1) { loaded = await load('raw'); results = loaded.results; }
  if (!results.length) throw new Error(`组合中没有股票完成回测：${loaded.failed.slice(0, 3).map(item => `${item.code}: ${item.error}`).join('；')}`);
  const dates = [...new Set(results.flatMap(item => item.equity.map(row => row.date)))].sort();
  const cashReserve = allocation * loaded.failed.length;
  const equity = dates.map(date => ({ date, value: cashReserve + results.reduce((sum, item) => { const point = item.equity.find(row => row.date === date); if (point) return sum + point.value; const previous = item.equity.findLast(row => row.date < date); return sum + (previous?.value ?? item.initial); }, 0) }));
  const finalValue = equity.at(-1)?.value || initial;
  const maxDrawdown = equity.reduce((dd, row, index) => {
    const high = Math.max(initial, ...equity.slice(0, index + 1).map(item => item.value));
    return Math.min(dd, row.value / high - 1);
  }, 0);
  const totalReturn = (finalValue / initial - 1) * 100;
  const portfolioReturns = equity.slice(1).map((row, index) => row.value / equity[index].value - 1).filter(Number.isFinite);
  const averageReturn = portfolioReturns.reduce((sum, value) => sum + value, 0) / Math.max(1, portfolioReturns.length);
  const returnStdDev = Math.sqrt(portfolioReturns.reduce((sum, value) => sum + (value - averageReturn) ** 2, 0) / Math.max(1, portfolioReturns.length));
  const trades = results.flatMap(item => item.trades.map(trade => ({ ...trade, code: item.code }))).sort((a, b) => a.date.localeCompare(b.date));
  const sources = [...new Set(results.map(item => item.source.split('（')[0]))];
  return {
    code: clean.join(','), codes: clean, strategy: params.strategy, initial, finalValue, totalReturn,
    annual: (Math.pow(Math.max(0.0001, finalValue / initial), 250 / Math.max(1, dates.length)) - 1) * 100,
    maxDrawdown: maxDrawdown * 100,
    sharpe: returnStdDev ? averageReturn / returnStdDev * Math.sqrt(250) : 0,
    benchmarkReturn: results.reduce((sum, item) => sum + (item.benchmarkReturn || 0), 0) / clean.length,
    excessReturn: results.reduce((sum, item) => sum + (item.excessReturn || 0), 0) / clean.length,
    winRate: results.reduce((sum, item) => sum + item.winRate, 0) / results.length,
    profitFactor: results.reduce((sum, item) => sum + item.profitFactor, 0) / results.length,
    tradeCount: trades.length, equity, trades: trades.slice(-100), dataPoints: Math.min(...results.map(item => item.dataPoints)),
    source: `${sources.join(' + ')} · 等资金分仓组合`, priceType: new Set(results.map(item => item.priceType)).size === 1 ? results[0].priceType : '混合', warnings: [...new Set([...results.flatMap(item => item.warnings || []), ...loaded.failed.map(item => `${item.code} 未完成回测，${item.error}；对应资金保留为现金`)])], failedCodes: loaded.failed,
  };
}
async function fetchKlineWithFallback(code, period, adjust, limit) {
  try { return await fetchEastmoneyKline(code, period, adjust, limit); }
  catch (error) {
    if (String(period || '101') !== '101') throw error;
    const history = await fetchHistory(code);
    const rows = history.rows.map(row => { const [date, open, close, high, low, volume, amount] = row; return { date, open: Number(open), close: Number(close), high: Number(high), low: Number(low), volume: Number(volume), amount: Number(amount), amplitude: null, changePct: null, change: null, turnover: null }; });
    return { code, name: `A股 ${code}`, period: '101', adjust: '0', source: '腾讯真实日线（东方财富暂不可用时回退）', rows: rows.slice(-Math.min(5000, Math.max(20, Number(limit) || 500))) };
  }
}

async function api(res, url) {
  const code = url.searchParams.get('code') || '';
  try {
    if (url.pathname === '/api/quote' && validCode(code)) return json(res, await fetchQuote(code));
    if (url.pathname === '/api/history' && validCode(code)) return json(res, await fetchHistory(code));
    if (url.pathname === '/api/eastmoney/kline' && validCode(code)) return json(res, await fetchKlineWithFallback(code, url.searchParams.get('period'), url.searchParams.get('adjust'), url.searchParams.get('limit')));
    if (url.pathname === '/api/eastmoney/announcements' && validCode(code)) return json(res, await fetchAnnouncements(code));
    if (url.pathname === '/api/quotes') return json(res, { items: await fetchQuotes((url.searchParams.get('codes') || '').split(',') ) });
    if (url.pathname === '/api/data-status') { const probeCode = validCode(code) ? code : '600519'; return json(res, await probeDataSources(probeCode)); }
    if (url.pathname === '/api/factors') return json(res, { items: FACTOR_DEFINITIONS, source: 'QuantPilot 因子定义' });
    if (url.pathname === '/api/factor-research') return json(res, await runFactorResearch(Object.fromEntries(url.searchParams)));
    if (url.pathname === '/api/signals') return json(res, { items: await makeSignals((url.searchParams.get('codes') || '').split(',').filter(validCode), url.searchParams.get('strategy') || 'trend'), source: '腾讯实时快照 + 多源真实日线', scoreMethod: { version: 'multi-factor-v1', total: 100, dimensions: { trend: 25, momentum: 20, volume: 15, riskControl: 20, liquidity: 10, dataQuality: 10 }, thresholds: { buy: '总分 >= 72 且风控分 >= 10', sell: '总分 <= 38，或趋势分 <= 8 且动量分 <= 8', observe: '数据质量分 < 5 时强制观察' }, unavailable: ['估值', '财务质量', '行业暴露', '历史退市股票池', '真实市场冲击与容量'] }, scannedAt: new Date().toISOString() });
    if (url.pathname === '/api/backtest') { const params = Object.fromEntries(url.searchParams); const requestedCodes = [...new Set((params.codes || code).split(',').map(value => value.trim()).filter(Boolean))]; const invalidCodes = requestedCodes.filter(value => !validCode(value)); if (invalidCodes.length) throw badRequest(`股票代码必须是六位数字：${invalidCodes.join(', ')}`); if (!requestedCodes.length) throw badRequest('请提供有效股票代码或策略池'); if (requestedCodes.length > 20) throw badRequest('回测一次最多支持 20 只股票'); return json(res, await runPortfolioBacktest(requestedCodes, params)); }
    if (url.pathname === '/api/universe') { const all = await fetchUniverse(); const query = (url.searchParams.get('query') || '').trim().toLowerCase(); const page = Math.max(1, Number(url.searchParams.get('page') || 1)); const pageSize = Math.min(100, Math.max(10, Number(url.searchParams.get('pageSize') || 50))); const filtered = query ? all.filter(row => row.code.includes(query) || row.name.toLowerCase().includes(query) || row.industry.toLowerCase().includes(query)) : all; const selected = filtered.slice((page - 1) * pageSize, page * pageSize); let live = []; let liveError = ''; if (url.searchParams.get('live') !== '0') { try { live = await fetchQuotes(selected.map(row => row.code)); } catch (error) { liveError = error.message; } } const liveMap = new Map(live.map(row => [row.code, row])); const items = selected.map(row => ({ ...row, ...(liveMap.get(row.code) || {}) })); return json(res, { total: filtered.length, page, pageSize, source: '上交所/深交所股票目录 + 腾讯实时快照', updatedAt: universeCache.at, liveCount: live.length, liveError, items }); }
    return json(res, { error: '接口不存在' }, 404);
  } catch (error) { return json(res, { error: error.message || '行情服务暂不可用' }, error.status || 502); }
}

export async function handleApiRequest(request) {
  let status = 200;
  let headers = {};
  let body = '';
  const sink = {
    writeHead(nextStatus, nextHeaders) { status = nextStatus; headers = nextHeaders || {}; },
    end(nextBody = '') { body = nextBody; },
  };
  await api(sink, new URL(request.url));
  return new Response(body, { status, headers });
}

export function handleHealthRequest() {
  return Response.json({ ok: true, service: 'quantpilot', time: new Date().toISOString() }, { headers: { 'cache-control': 'no-store' } });
}
