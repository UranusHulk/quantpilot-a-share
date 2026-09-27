let universeCache = { at: 0, rows: [] };
const jsonHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function market(code) { return code.startsWith('6') ? 'sh' : code.startsWith('8') || code.startsWith('4') ? 'bj' : 'sz'; }
function validCode(code) { return /^\d{6}$/.test(code || ''); }
function json(res, data, status = 200) { res.writeHead(status, jsonHeaders); res.end(JSON.stringify(data)); }
function number(fields, index) { const n = Number(fields[index]); return Number.isFinite(n) ? n : null; }
async function fetchRetry(url, options = {}, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
      if (response.ok) return response;
      lastError = new Error(`上游接口返回 ${response.status}`);
    } catch (error) { lastError = error; }
    if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
  }
  throw lastError || new Error('上游接口连接失败');
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
async function fetchHistorySegment(code, start, end) {
  const ticker = `${market(code)}${code}`;
  // fqkline/get is intermittently blocked by Tencent WAF. The public kline endpoint
  // is stable and returns the same real OHLCV daily records (without adjustment).
  const endpoint = `https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=${ticker},day,${start},${end},640`;
  const response = await fetch(endpoint, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://gu.qq.com/' } });
  if (!response.ok) throw new Error(`腾讯历史行情接口返回 ${response.status}`);
  const data = await response.json();
  if (data?.code !== 0) throw new Error(`腾讯历史行情接口异常：${data?.msg || '未知错误'}`);
  return data?.data?.[ticker]?.day || [];
}
async function fetchHistory(code) {
  const end = new Date();
  const endText = `${end.getFullYear()}-${String(end.getMonth()+1).padStart(2,'0')}-${String(end.getDate()).padStart(2,'0')}`;
  const windows = []; for (let year = 2010; year < end.getFullYear(); year += 2) windows.push([String(year) + '-01-01', String(Math.min(year + 2, end.getFullYear())) + '-01-01']); windows.push([String(Math.max(2010, end.getFullYear() - 1)) + '-01-01', endText]);
  const chunks = await Promise.all(windows.map(([start, finish]) => fetchHistorySegment(code, start, finish)));
  const map = new Map();
  chunks.flat().forEach(row => { if (Array.isArray(row) && row[0]) map.set(row[0], row); });
  return { code, rows: [...map.values()].sort((a,b)=>String(a[0]).localeCompare(String(b[0]))), source: '腾讯真实日线（未复权）', windows: windows.length };
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
function metrics(rows) {
  const closes = rows.map(row => Number(row[2])).filter(Number.isFinite);
  if (!closes.length) return { momentum5: null, momentum20: null, momentum60: null, volatility20: null, signal: '观察', strength: 1, score: 0, reason: '历史数据不足' };
  const last = closes.at(-1); const avg = n => closes.slice(-n).reduce((a, b) => a + b, 0) / Math.min(n, closes.length); const ret = n => closes.length > n ? (last / closes.at(-n - 1) - 1) * 100 : null;
  const daily = closes.slice(-21).map((v, i, a) => i ? v / a[i - 1] - 1 : null).filter(Number.isFinite); const mean = daily.length ? daily.reduce((a, b) => a + b, 0) / daily.length : 0;
  const vol = daily.length > 1 ? Math.sqrt(Math.max(0, daily.reduce((a, b) => a + b * b, 0) / daily.length - mean ** 2)) * Math.sqrt(250) * 100 : null;
  const momentum5 = ret(5); const momentum20 = ret(20); const momentum60 = ret(60); const sma20 = avg(20); const sma60 = avg(60); let score = 0; const reasons = [];
  if (last > sma20) { score += 25; reasons.push('站上SMA20'); } else reasons.push('低于SMA20');
  if (last > sma60) { score += 20; reasons.push('站上SMA60'); }
  if (momentum20 !== null && momentum20 > 0) { score += 20; reasons.push('20日动量为正'); } else if (momentum20 !== null) reasons.push('20日动量为负');
  if (momentum60 !== null && momentum60 > 0) { score += 20; reasons.push('60日趋势向上'); }
  if (vol !== null && vol < 45) { score += 15; reasons.push('波动率适中'); } else if (vol !== null && vol >= 70) reasons.push('波动率偏高');
  const signal = score >= 70 ? '买入' : score < 35 ? '卖出' : '观察'; const strength = Math.min(5, Math.max(1, Math.round(score / 20)));
  return { momentum5, momentum20, momentum60, volatility20: vol, signal, strength, score, reason: reasons.slice(0, 3).join(' · '), sma20, sma60 };
}
const signalCandidates = ['600519','300750','000858','601318','600036','002594','601888','600276','000333','000651','601012','600900','601899','600030','300059','002415','600309','603259','688981','688041','601127','000568','600028','601398','601288','600938','601857','600048','601088'];
async function makeSignals(codes, strategy = 'trend') {
  const selected = [...new Set((codes.length ? codes : signalCandidates).filter(validCode))].slice(0, 20);
  const end = new Date(); const start = new Date(end); start.setFullYear(end.getFullYear() - 3);
  const dateText = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const items = await Promise.all(selected.map(async code => { try { const [quoteResult, historyResult] = await Promise.allSettled([fetchQuote(code), fetchHistorySegment(code, dateText(start), dateText(end))]); if (quoteResult.status !== 'fulfilled') return null; const quote = quoteResult.value; const rows = historyResult.status === 'fulfilled' ? historyResult.value : []; const stats = metrics(rows); return { ...quote, ...stats, dataPoints: rows.length, strategy: strategy === 'lowvol' ? '低波动筛选 · 日线' : '趋势评分 · 日线', time: quote.time }; } catch { return null; } }));
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
  const history = await fetchHistory(code);
  const start = params.start || ''; const end = params.end || '';
  const rows = history.rows.map(row => ({ date: row[0], open: Number(row[1]), close: Number(row[2]), high: Number(row[3]), low: Number(row[4]) })).filter(row => Number.isFinite(row.close) && Number.isFinite(row.open));
  const firstMatch = rows.findIndex(row => !start || row.date >= start);
  const first = firstMatch < 0 ? rows.length : firstMatch;
  const lastMatch = end ? rows.findLastIndex(row => row.date <= end) : rows.length - 1;
  const last = lastMatch;
  if (last < first || !rows.length) throw new Error(`${code} 在所选日期内没有可用日线`);
  const initial = Number(params.initial) > 0 ? Number(params.initial) : 1000000;
  const fast = Math.max(2, Number(params.fast) || 20); const slow = Math.max(fast + 1, Number(params.slow) || 60);
  const commission = Math.max(0, Number(params.commission) || 0.025) / 100; const stampTax = Math.max(0, Number(params.stampTax) || 0.05) / 100; const slippage = Math.max(0, Number(params.slippage) || 0.1) / 100;
  const maxPosition = Math.min(1, Math.max(0.01, Number(params.maxPosition || params.position || 95) / 100));
  const stopLoss = Math.max(0, Number(params.stopLoss || 0) / 100); const frequency = String(params.frequency || 'daily');
  const strategy = String(params.strategy || 'trend'); let spec = null; try { spec = params.spec ? JSON.parse(params.spec) : null; } catch { throw new Error('策略条件格式无效，请重新保存策略'); } let cash = initial; let shares = 0; let entry = 0; let wins = 0; let losses = 0; let grossProfit = 0; let grossLoss = 0; let pending = null; const trades = []; const equity = [];
  const closes = rows.map(row => row.close);
  const seriesCache = new Map(); seriesCache.rows = rows;
  const canRebalance = i => frequency === 'weekly' ? (i === 0 || new Date(rows[i].date).getDay() === 1) : frequency === 'monthly' ? (i === 0 || rows[i].date.slice(0, 7) !== rows[i - 1].date.slice(0, 7)) : true;
  const closeTrade = (row, forced = false) => { if (!shares) return; const fill = row.open * (1 - slippage); const proceeds = fill * shares * (1 - commission - stampTax); const pnl = proceeds - entry * shares; cash += proceeds; trades.push({ date: row.date, side: forced ? '卖出（期末）' : '卖出', price: fill, qty: shares, pnl }); if (pnl >= 0) { wins += 1; grossProfit += pnl; } else { losses += 1; grossLoss += Math.abs(pnl); } shares = 0; entry = 0; };
  for (let i = 0; i <= last; i += 1) {
    const row = rows[i];
    if (pending && i >= first) { const fill = row.open * (1 + slippage); const qty = Math.floor((cash * maxPosition) / (fill * (1 + commission)) / 100) * 100; if (pending === 'buy' && !shares && qty > 0) { cash -= fill * qty * (1 + commission); shares = qty; entry = fill; trades.push({ date: row.date, side: '买入', price: fill, qty }); } else if (pending === 'sell' && shares) closeTrade(row); pending = null; }
    if (shares && stopLoss > 0 && row.low <= entry * (1 - stopLoss) && i > first) closeTrade({ ...row, open: entry * (1 - stopLoss) });
    const fastAvg = sma(closes, i, fast); const slowAvg = sma(closes, i, slow); const prevFast = i ? sma(closes, i - 1, fast) : fastAvg; const prevSlow = i ? sma(closes, i - 1, slow) : slowAvg; const momentum = i >= fast ? (closes[i] / closes[i - fast] - 1) * 100 : null;
    const recent = closes.slice(Math.max(0, i - 20), i + 1); const returns = recent.slice(1).map((v,j) => v / recent[j] - 1); const variance = returns.length > 1 ? returns.reduce((a,b) => a + b * b, 0) / returns.length - Math.pow(returns.reduce((a,b) => a + b, 0) / returns.length, 2) : 0; const volatility = Math.sqrt(Math.max(0, variance)) * Math.sqrt(250) * 100;
    let buy = false; let sell = false;
    if (i >= Math.max(slow, first) && canRebalance(i)) { if (spec && Array.isArray(spec.entry) && spec.entry.length) { buy = matchesRules(spec.entry, spec.entryJoin, i, seriesCache); sell = matchesRules(spec.exit || [], spec.exitJoin, i, seriesCache); } else if (strategy === 'reversal') { buy = momentum !== null && momentum < -5 && prevFast <= prevSlow && fastAvg > slowAvg; sell = momentum !== null && momentum > 5; } else if (strategy === 'lowvol') { buy = volatility < 35 && closes[i] > slowAvg && prevFast <= prevSlow; sell = volatility > 50 || closes[i] < fastAvg; } else { buy = fastAvg > slowAvg && prevFast <= prevSlow; sell = fastAvg < slowAvg && prevFast >= prevSlow; } if (buy && !shares) pending = 'buy'; if (sell && shares) pending = 'sell'; }
    if (i >= first) equity.push({ date: row.date, value: cash + shares * row.close });
  }
  if (shares) { const lastRow = rows[last]; closeTrade({ ...lastRow, open: lastRow.close }, true); const point = equity.at(-1); if (point) point.value = cash; }
  const values = equity.map(row => row.value); const finalValue = cash; let peak = initial; let maxDrawdown = 0; values.forEach(value => { peak = Math.max(peak, value); maxDrawdown = Math.min(maxDrawdown, value / peak - 1); }); const totalReturn = finalValue / initial - 1; const years = Math.max(1 / 250, values.length / 250); const annual = Math.pow(Math.max(0.0001, finalValue / initial), 1 / years) - 1; const daily = values.slice(1).map((value, i) => value / values[i] - 1).filter(Number.isFinite); const mean = daily.reduce((a,b) => a + b, 0) / Math.max(1, daily.length); const std = Math.sqrt(daily.reduce((a,b) => a + (b - mean) ** 2, 0) / Math.max(1, daily.length));
  return { code, strategy, initial, finalValue, totalReturn: totalReturn * 100, annual: annual * 100, maxDrawdown: maxDrawdown * 100, sharpe: std ? mean / std * Math.sqrt(250) : 0, winRate: (wins + losses) ? wins / (wins + losses) * 100 : 0, profitFactor: grossLoss ? grossProfit / grossLoss : (grossProfit ? Infinity : 0), tradeCount: trades.length, equity, trades: trades.slice(-100), dataPoints: values.length, source: history.source, parameters: { fast, slow, commission: commission * 100, stampTax: stampTax * 100, slippage: slippage * 100, frequency, maxPosition: maxPosition * 100, stopLoss: stopLoss * 100 } };
}
async function runPortfolioBacktest(codes, params) { const clean = [...new Set(codes.filter(validCode))].slice(0, 20); if (clean.length <= 1) return runBacktest(clean[0] || '600519', params); const initial = Number(params.initial) > 0 ? Number(params.initial) : 1000000; const results = await Promise.all(clean.map(code => runBacktest(code, { ...params, initial: initial / clean.length }))); const dates = [...new Set(results.flatMap(item => item.equity.map(row => row.date)))].sort(); const equity = dates.map(date => ({ date, value: results.reduce((sum,item) => sum + (item.equity.find(row => row.date === date)?.value ?? item.initial), 0) })); const finalValue = equity.at(-1)?.value || initial; const peak = equity.reduce((p,row) => Math.max(p,row.value), initial); const maxDrawdown = equity.reduce((dd,row,index) => { const high = Math.max(initial,...equity.slice(0,index+1).map(x=>x.value)); return Math.min(dd,row.value/high-1)},0); const totalReturn=(finalValue/initial-1)*100; const trades=results.flatMap(item=>item.trades.map(t=>({...t,code:item.code}))).sort((a,b)=>a.date.localeCompare(b.date)); return { code: clean.join(','), codes: clean, strategy: params.strategy, initial, finalValue, totalReturn, annual: (Math.pow(Math.max(.0001,finalValue/initial),250/Math.max(1,dates.length))-1)*100, maxDrawdown:maxDrawdown*100, sharpe: results.reduce((sum,item)=>sum+item.sharpe,0)/results.length, winRate: results.reduce((sum,item)=>sum+item.winRate,0)/results.length, profitFactor: results.reduce((sum,item)=>sum+item.profitFactor,0)/results.length, tradeCount: trades.length, equity, trades: trades.slice(-100), dataPoints: Math.min(...results.map(item=>item.dataPoints)), source:'腾讯真实日线 · 策略池组合' }; }
async function fetchKlineWithFallback(code, period, adjust, limit) {
  try { return await fetchEastmoneyKline(code, period, adjust, limit); }
  catch (error) {
    if (String(period || '101') !== '101') throw error;
    const history = await fetchHistory(code);
    const rows = history.rows.map(row => { const [date, open, close, high, low, volume, amount] = row; return { date, open: Number(open), close: Number(close), high: Number(high), low: Number(low), volume: Number(volume), amount: Number(amount), amplitude: null, changePct: null, change: null, turnover: null }; });
    return { code, name: `A股 ${code}`, period: '101', adjust: '0', source: '腾讯真实日线（东方财富暂不可用时回退）', rows: rows.slice(-Math.min(5000, Math.max(20, Number(limit) || 500))) };
  }
}

async function api(res, url) { const code = url.searchParams.get('code') || ''; try { if (url.pathname === '/api/quote' && validCode(code)) return json(res, await fetchQuote(code)); if (url.pathname === '/api/history' && validCode(code)) return json(res, await fetchHistory(code)); if (url.pathname === '/api/eastmoney/kline' && validCode(code)) return json(res, await fetchKlineWithFallback(code, url.searchParams.get('period'), url.searchParams.get('adjust'), url.searchParams.get('limit'))); if (url.pathname === '/api/eastmoney/announcements' && validCode(code)) return json(res, await fetchAnnouncements(code)); if (url.pathname === '/api/quotes') return json(res, { items: await fetchQuotes((url.searchParams.get('codes') || '').split(',') ) }); if (url.pathname === '/api/signals') return json(res, { items: await makeSignals((url.searchParams.get('codes') || '').split(',').filter(validCode), url.searchParams.get('strategy') || 'trend'), source: '腾讯实时快照 + 腾讯真实日线', scannedAt: new Date().toISOString() }); if (url.pathname === '/api/backtest') { const params = Object.fromEntries(url.searchParams); const codes = (params.codes || code).split(',').filter(validCode); if (!codes.length) throw new Error('请提供有效股票代码或策略池'); return json(res, await runPortfolioBacktest(codes, params)); } if (url.pathname === '/api/universe') { const all = await fetchUniverse(); const query = (url.searchParams.get('query') || '').trim().toLowerCase(); const page = Math.max(1, Number(url.searchParams.get('page') || 1)); const pageSize = Math.min(100, Math.max(10, Number(url.searchParams.get('pageSize') || 50))); const filtered = query ? all.filter(row => row.code.includes(query) || row.name.toLowerCase().includes(query) || row.industry.toLowerCase().includes(query)) : all; const selected = filtered.slice((page - 1) * pageSize, page * pageSize); let live = []; let liveError = ''; if (url.searchParams.get('live') !== '0') { try { live = await fetchQuotes(selected.map(row => row.code)); } catch (error) { liveError = error.message; } } const liveMap = new Map(live.map(row => [row.code, row])); const items = selected.map(row => ({ ...row, ...(liveMap.get(row.code) || {}) })); return json(res, { total: filtered.length, page, pageSize, source: '上交所/深交所股票目录 + 腾讯实时快照', updatedAt: universeCache.at, liveCount: live.length, liveError, items }); } json(res, { error: '接口不存在' }, 404); } catch (error) { json(res, { error: error.message || '行情服务暂不可用' }, 502); } }

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
