#!/usr/bin/env node
/*
 * 热榜抓取脚本 v2（跑在 GitHub Actions 免费服务器上）
 *
 * v2 为什么重写：
 *   v1 用的国内聚合 API（vvhan / oioweb / gumengya）和 RSSHub 公共实例，
 *   从 GitHub 海外服务器全部连不上（实测连接超时），已移除。
 *   v2 只保留「海外服务器验证可连」的官方接口（2026-10-25 本地实测通过）：
 *     百度热搜  top.baidu.com/api/board        （主：pc 端；备：wise 端）
 *     头条热榜  toutiao.com/hot-event/hot-board（官方热榜接口）
 *     B站热搜   api.bilibili.com/search/square  （主：热搜；备：全站排行榜）
 *   微博 / 知乎 / 抖音 / 小红书 的接口对海外 IP 有封锁
 *   （微博 302 登录墙、知乎 403、抖音空响应、小红书需签名），
 *   暂时无法自动抓取 —— 会记入 failed，工作台显示"抓取失败"，不会误判"掉榜"。
 *
 * 输出 hotlist.json 里附带 debug 字段（每个数据源的成败和报错），
 * 工作台导入时自动忽略该字段；排查问题时直接看这个文件即可。
 *
 * 本地自测（不联网验证解析）：node fetch-hotlist.mjs --selftest
 */
import { writeFileSync } from 'node:fs';

const OUT = 'hotlist.json';
const TOPN = 10; // 每个平台取前几条
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/* ---------- 网络请求（8 秒超时） ---------- */
async function jget(url, ms = 8000, referer) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const headers = { 'user-agent': UA, accept: 'application/json, text/plain, */*' };
    if (referer) headers.referer = referer;
    const r = await fetch(url, { signal: c.signal, headers });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const ct = r.headers.get('content-type') || '';
    return ct.includes('json') ? await r.json() : await r.text();
  } finally {
    clearTimeout(t);
  }
}

/* ---------- 通用兜底解析：不管什么 JSON 结构，尽量挖「标题+热度」 ---------- */
const TITLE_KEYS = ['title', 'name', 'word', 'query', 'keyword', 'hotTitle', 'desc', 'Title'];
const HEAT_KEYS = ['hot', 'heat', 'hotValue', 'hotScore', 'num', 'score', 'value', 'raw', 'popular', 'HotValue', 'heat_score'];

function pickTitle(o) {
  for (const k of TITLE_KEYS) {
    const v = o[k];
    if (typeof v === 'string' && v.trim().length >= 2) return v.trim();
  }
  return null;
}
function pickHeat(o) {
  for (const k of HEAT_KEYS) {
    const n = Number(o[k]);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  return 0;
}
function findArrays(node, depth = 0, out = []) {
  if (depth > 6 || node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) { out.push(node); return out; }
  for (const k in node) findArrays(node[k], depth + 1, out);
  return out;
}
function normalizeAny(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const seen = new Set();
  const res = [];
  findArrays(payload).forEach(arr => {
    arr.forEach(it => {
      if (!it || typeof it !== 'object') return;
      const t = pickTitle(it);
      if (!t || t.length > 60 || seen.has(t)) return;
      seen.add(t);
      res.push({ title: t, heat: pickHeat(it) });
    });
  });
  return res;
}

/* ---------- 各平台专用解析器 ---------- */
// B站热搜：data.trending.list[] → keyword / heat_score
function parseBilibiliHot(d) {
  const list = (d && d.data && d.data.trending && d.data.trending.list) || [];
  return list.map(x => ({ title: String(x.keyword || x.show_name || '').trim(), heat: Number(x.heat_score) || 0 }))
             .filter(x => x.title.length >= 2);
}
// B站全站排行榜（备用源）：data.list[] → title / stat.view
function parseBilibiliRank(d) {
  const list = (d && d.data && d.data.list) || [];
  return list.map(x => ({ title: String(x.title || '').trim(), heat: Number(x.stat && x.stat.view) || 0 }))
             .filter(x => x.title.length >= 2);
}
// 百度热搜 pc：data.cards[component=hotList].content[] → word / hotScore（字符串）
function parseBaiduPc(d) {
  const cards = (d && d.data && d.data.cards) || [];
  const card = cards.find(c => c.component === 'hotList') || cards.find(c => Array.isArray(c.content));
  const items = (card && card.content) || [];
  return items.map(x => ({ title: String(x.word || '').trim(), heat: Number(x.hotScore) || 0 }))
             .filter(x => x.title.length >= 2);
}
// 百度热搜 wise（备用源）：data.cards[0].content[0].content[] → word
function parseBaiduWise(d) {
  const first = ((d && d.data && d.data.cards) || [])[0] || {};
  const inner = ((first.content || [])[0] || {}).content || [];
  return inner.map(x => ({ title: String(x.word || '').trim(), heat: Number(x.hotScore) || 0 }))
             .filter(x => x.title.length >= 2);
}
// 头条热榜：data[] → Title / HotValue（字符串）
function parseToutiao(d) {
  const items = (d && Array.isArray(d.data)) ? d.data : [];
  return items.map(x => ({ title: String(x.Title || '').trim(), heat: Number(x.HotValue) || 0 }))
             .filter(x => x.title.length >= 2);
}

/* ---------- 平台计划 ---------- */
const PLANS = [
  { cn: '百度', tries: [
    { name: 'baidu-pc',    url: 'https://top.baidu.com/api/board?platform=pc&tab=realtime',   parse: parseBaiduPc },
    { name: 'baidu-wise',  url: 'https://top.baidu.com/api/board?platform=wise&tab=realtime', parse: parseBaiduWise }
  ]},
  { cn: '头条', tries: [
    { name: 'toutiao-board', url: 'https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc', parse: parseToutiao }
  ]},
  { cn: 'B站', tries: [
    { name: 'bili-hot',     url: 'https://api.bilibili.com/x/web-interface/search/square?limit=50',      parse: parseBilibiliHot },
    { name: 'bili-ranking', url: 'https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all',   parse: parseBilibiliRank }
  ]},
  // 以下平台接口对海外 IP 封锁，暂无自动源 —— 记入 failed，工作台显示"抓取失败"
  { cn: '微博',   tries: [] },
  { cn: '知乎',   tries: [] },
  { cn: '抖音',   tries: [] },
  { cn: '小红书', tries: [] }
];

async function fetchPlatform(p, debug) {
  for (const t of p.tries) {
    try {
      const raw = await jget(t.url);
      let items = t.parse(raw);
      if (!items.length && raw && typeof raw === 'object') items = normalizeAny(raw); // 结构变了就通用挖
      if (items.length) {
        // 没有热度数值的源，按排名折算一个展示用热度
        items.forEach((it, i) => { if (!it.heat) it.heat = Math.max(1, TOPN - i) * 1000; });
        console.log(`[${p.cn}] 源 ${t.name} 成功，${items.length} 条`);
        debug.push({ platform: p.cn, source: t.name, ok: true, count: items.length });
        return items.slice(0, TOPN);
      }
      console.log(`[${p.cn}] 源 ${t.name} 有响应但解析不出条目，试下一个`);
      debug.push({ platform: p.cn, source: t.name, ok: false, error: '解析不出条目' });
    } catch (e) {
      console.log(`[${p.cn}] 源 ${t.name} 失败：${e.message}`);
      debug.push({ platform: p.cn, source: t.name, ok: false, error: e.message });
    }
  }
  return null;
}

async function main() {
  const entries = [];
  const failed = [];
  const debug = [];
  const startedAt = new Date().toISOString();
  for (const p of PLANS) {
    const items = await fetchPlatform(p, debug);
    if (items) {
      items.forEach(it => entries.push({ platform: p.cn, title: it.title, heat: it.heat, category: '' }));
    } else {
      failed.push(p.cn);
      const why = p.tries.length ? '所有源都失败' : '接口对海外IP封锁，暂无自动源';
      debug.push({ platform: p.cn, source: '-', ok: false, error: why });
      console.log(`[${p.cn}] 无数据（${why}）`);
    }
  }
  if (!entries.length) {
    console.log('所有平台都失败，保留现有 hotlist.json 不动');
    return;
  }
  const date = new Date().toISOString().slice(0, 10);
  const payload = {
    date,
    source: 'GitHub Actions 自动抓取',
    failed,
    entries,
    debug: { startedAt, finishedAt: new Date().toISOString(), results: debug }
  };
  writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log(`已写入 ${OUT}：${entries.length} 条；失败平台：${failed.join(' / ') || '无'}`);
}

/* ---------- 本地自测（不联网，验证各平台解析器） ---------- */
function selftest() {
  const cases = [
    { name: 'B站热搜',   parse: parseBilibiliHot,
      payload: { code: 0, data: { trending: { list: [{ keyword: '测试热点甲', show_name: '测试热点甲', heat_score: 123456 }, { keyword: '测试热点乙', heat_score: 999 } ] } } } },
    { name: 'B站排行榜', parse: parseBilibiliRank,
      payload: { code: 0, data: { list: [{ title: '测试视频丙', stat: { view: 888888 } }] } } },
    { name: '百度pc',    parse: parseBaiduPc,
      payload: { data: { cards: [{ component: 'tabTextList', content: [] }, { component: 'hotList', content: [{ word: '测试热点丁', hotScore: '7711975' }] }] } } },
    { name: '百度wise',  parse: parseBaiduWise,
      payload: { data: { cards: [{ content: [{ content: [{ word: '测试热点戊', hotScore: '555' }] }] }] } } },
    { name: '头条',      parse: parseToutiao,
      payload: { data: [{ Title: '测试热点己', HotValue: '12975424' }, { Title: '测试热点庚', HotValue: '888' }] } },
    { name: '通用兜底',  parse: normalizeAny,
      payload: { success: true, data: [{ name: '测试热点辛', hot: 777 }] } }
  ];
  let pass = 0;
  cases.forEach(c => {
    const got = c.parse(c.payload);
    const ok = got.length >= 1 && got[0].title.includes('测试');
    console.log((ok ? 'PASS' : 'FAIL') + ' ' + c.name + ' → ' + JSON.stringify(got[0] || null));
    if (ok) pass++;
  });
  console.log(`自测结果：${pass}/${cases.length}`);
  if (pass !== cases.length) process.exit(1);
}

if (process.argv.includes('--selftest')) { selftest(); process.exit(0); }
main();
