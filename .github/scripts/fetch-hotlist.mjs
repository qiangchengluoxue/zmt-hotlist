#!/usr/bin/env node
/*
 * 热榜抓取脚本（零依赖，跑在 GitHub Actions 免费服务器上）
 *
 * 工作方式：
 *   1. 每个平台按顺序尝试多个数据源，第一个成功的就用它
 *   2. 全部失败的平台记进 failed 列表（页面看到后不会误标"已掉榜"）
 *   3. 所有平台都失败时，直接退出、不覆盖现有 hotlist.json
 *   4. 产出格式与工作台「导入热榜 JSON」完全一致：
 *      {"date":"2026-10-25","source":"...","failed":[...],"entries":[{"platform":"微博","title":"...","heat":123,"category":""}]}
 *
 * 本地自测解析逻辑（不联网）：node scripts/fetch-hotlist.mjs --selftest
 */
import { writeFileSync } from 'node:fs';

const OUT = 'hotlist.json';
const TOPN = 10; // 每个平台取前几条

/* ---------- 网络请求（8 秒超时） ---------- */
async function jget(url, ms = 8000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: c.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        accept: 'application/json, text/plain, */*'
      }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const ct = r.headers.get('content-type') || '';
    return ct.includes('json') ? await r.json() : await r.text();
  } finally {
    clearTimeout(t);
  }
}

/* ---------- 归一化：不管源是什么 JSON 结构，都尽量挖出「标题+热度」 ---------- */
const TITLE_KEYS = ['title', 'name', 'word', 'query', 'keyword', 'hotTitle', 'desc'];
const HEAT_KEYS = ['hot', 'heat', 'hotValue', 'hotScore', 'num', 'score', 'value', 'raw', 'popular'];

function pickTitle(o) {
  for (const k of TITLE_KEYS) {
    const v = o[k];
    if (typeof v === 'string' && v.trim().length >= 4) return v.trim();
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
  if (depth > 5 || node == null || typeof node !== 'object') return out;
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
/* RSS 源（RSSHub 公共实例）解析：正则抠 <item><title> */
function parseRss(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  const re = /<item[\s>][\s\S]*?<\/item>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const tm = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/.exec(m[0]);
    if (tm) {
      const title = tm[1].replace(/<[^>]*>/g, '').trim();
      if (title.length >= 4) out.push({ title, heat: 0 });
    }
  }
  return out;
}

/* ---------- 各平台数据源（按优先级排序，第一个成功就用） ---------- */
const PLANS = [
  { cn: '微博', tries: [
    { name: 'vvhan',    url: 'https://api.vvhan.com/api/hotlist?type=weibo' },
    { name: 'oioweb',   url: 'https://api.oioweb.cn/api/common/HotList?type=weibo' },
    { name: 'gumengya', url: 'https://api.gumengya.com/Api/HotList?type=weibo' },
    { name: 'rsshub',   url: 'https://rsshub.app/weibo/search/hot', rss: true }
  ]},
  { cn: '知乎', tries: [
    { name: 'vvhan',  url: 'https://api.vvhan.com/api/hotlist?type=zhihu' },
    { name: 'rsshub', url: 'https://rsshub.app/zhihu/hotlist', rss: true }
  ]},
  { cn: '百度', tries: [
    { name: 'vvhan',  url: 'https://api.vvhan.com/api/hotlist?type=baidu' },
    { name: 'rsshub', url: 'https://rsshub.app/baidu/top', rss: true }
  ]},
  { cn: '抖音', tries: [
    { name: 'vvhan', url: 'https://api.vvhan.com/api/hotlist?type=douyin' }
  ]},
  { cn: 'B站', tries: [
    { name: 'vvhan',  url: 'https://api.vvhan.com/api/hotlist?type=bilibili' },
    { name: 'rsshub', url: 'https://rsshub.app/bilibili/hot-search', rss: true }
  ]},
  { cn: '头条', tries: [
    { name: 'vvhan', url: 'https://api.vvhan.com/api/hotlist?type=toutiao' }
  ]},
  { cn: '小红书', tries: [
    { name: 'vvhan', url: 'https://api.vvhan.com/api/hotlist?type=xhs' }
  ]}
];

async function fetchPlatform(p) {
  for (const t of p.tries) {
    try {
      const raw = await jget(t.url);
      const items = t.rss ? parseRss(raw) : normalizeAny(raw);
      if (items.length) {
        console.log(`[${p.cn}] 源 ${t.name} 成功，${items.length} 条`);
        return items.slice(0, TOPN);
      }
      console.log(`[${p.cn}] 源 ${t.name} 有响应但解析不出条目，试下一个`);
    } catch (e) {
      console.log(`[${p.cn}] 源 ${t.name} 失败：${e.message}`);
    }
  }
  return null;
}

async function main() {
  const entries = [];
  const failed = [];
  for (const p of PLANS) {
    const items = await fetchPlatform(p);
    if (items) {
      // RSS 源没有热度数值，用排名折算一个展示用热度
      items.forEach((it, i) => entries.push({
        platform: p.cn,
        title: it.title,
        heat: it.heat || Math.max(1, TOPN - i) * 1000,
        category: ''
      }));
    } else {
      failed.push(p.cn);
      console.log(`[${p.cn}] 所有源都失败`);
    }
  }
  if (!entries.length) {
    console.log('所有平台都失败，保留现有 hotlist.json 不动');
    return;
  }
  const date = new Date().toISOString().slice(0, 10);
  writeFileSync(OUT, JSON.stringify({ date, source: 'GitHub Actions 自动抓取', failed, entries }, null, 2));
  console.log(`已写入 ${OUT}：${entries.length} 条；失败平台：${failed.join(' / ') || '无'}`);
}

/* ---------- 本地自测（不联网，验证各种源结构的解析） ---------- */
function selftest() {
  const cases = [
    { name: 'vvhan 风格',   payload: { success: true, data: [{ name: '测试热点甲', hot: 123456 }, { name: '测试热点乙', hot: 99999 }] } },
    { name: 'oioweb 风格',  payload: { code: 200, result: [{ title: '测试热点丙', hotValue: 54321 }] } },
    { name: '深层嵌套',      payload: { data: { list: [{ word: '测试热点丁', hotScore: 777 }] } } },
    { name: 'items 风格',   payload: { items: [{ query: '测试热点戊', num: 555 }] } },
    { name: 'RSS',          payload: '<rss><channel><item><title><![CDATA[测试热点己]]></title></item><item><title>测试热点庚</title></item></channel></rss>', rss: true }
  ];
  let pass = 0;
  cases.forEach(c => {
    const got = c.rss ? parseRss(c.payload) : normalizeAny(c.payload);
    const ok = got.length >= 1 && got[0].title.includes('测试热点');
    console.log((ok ? 'PASS' : 'FAIL') + ' ' + c.name + ' → ' + JSON.stringify(got[0] || null));
    if (ok) pass++;
  });
  console.log(`自测结果：${pass}/${cases.length}`);
  if (pass !== cases.length) process.exit(1);
}

if (process.argv.includes('--selftest')) { selftest(); process.exit(0); }
main();
