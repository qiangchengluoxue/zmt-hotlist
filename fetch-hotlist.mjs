#!/usr/bin/env node
/*
 * 热榜抓取脚本 v3（跑在 GitHub Actions 免费服务器上）
 *
 * v3 改动：
 *   - 数据源切换到 UAPI 免费聚合接口（uapis.cn，无需鉴权，2026-10-25 实测可用），
 *     覆盖 7 个平台：微博/知乎/抖音/小红书/B站/头条/百度
 *   - 每条数据自带原始链接（微博话题页/知乎问题页/头条文章页/B站视频页等），
 *     工作台可直接「查看 ↗」跳转
 *   - 定时：每天北京时间 8:00 / 12:00 / 20:00（UTC 0/4/12）
 *
 * 输出 hotlist.json：
 *   { date, source, failed, entries:[{platform,title,heat,url,category}], debug }
 */
import { writeFileSync } from 'node:fs';

const OUT = 'hotlist.json';
const TOPN = 10;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const PLATFORMS = [
  { cn: '微博', type: 'weibo' },
  { cn: '知乎', type: 'zhihu' },
  { cn: '抖音', type: 'douyin' },
  { cn: '小红书', type: 'xiaohongshu' },
  { cn: 'B站', type: 'bilibili' },
  { cn: '头条', type: 'toutiao' },
  { cn: '百度', type: 'baidu' }
];

async function jget(url, ms = 12000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { 'user-agent': UA, accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 热度值解析：UAPI 各平台格式不统一（"2528 万热度"/"2426688播放"/纯数字） */
function parseHeat(v) {
  if (v == null) return 0;
  const s = String(v);
  const m = s.match(/([\d.]+)\s*万/);
  if (m) return Math.round(parseFloat(m[1]) * 10000);
  const n = s.match(/[\d.]+/);
  return n ? Math.round(parseFloat(n[0])) : 0;
}

async function main() {
  const entries = [];
  const failed = [];
  const debug = [];
  const startedAt = new Date().toISOString();
  for (const p of PLATFORMS) {
    try {
      const d = await jget('https://uapis.cn/api/v1/misc/hotboard?type=' + p.type);
      const list = Array.isArray(d && d.list) ? d.list : [];
      const items = list.slice(0, TOPN).map(it => ({
        platform: p.cn,
        title: String(it.title || '').trim(),
        heat: parseHeat(it.hot_value),
        url: String(it.url || ''),
        category: ''
      })).filter(x => x.title.length >= 2);
      if (items.length) {
        console.log(`[${p.cn}] 成功，${items.length} 条（带链接 ${items.filter(x => x.url).length} 条）`);
        debug.push({ platform: p.cn, ok: true, count: items.length });
        items.forEach(x => entries.push(x));
      } else {
        console.log(`[${p.cn}] 有响应但无有效条目`);
        debug.push({ platform: p.cn, ok: false, error: '无有效条目' });
        failed.push(p.cn);
      }
    } catch (e) {
      console.log(`[${p.cn}] 失败：${e.message}`);
      debug.push({ platform: p.cn, ok: false, error: e.message });
      failed.push(p.cn);
    }
    await sleep(1200); // 轻微限速，友好一点
  }
  if (!entries.length) {
    console.log('所有平台都失败，保留现有 hotlist.json 不动');
    return;
  }
  const payload = {
    date: new Date().toISOString().slice(0, 10),
    source: 'UAPI 聚合（GitHub Actions 自动抓取）',
    failed,
    entries,
    debug: { startedAt, finishedAt: new Date().toISOString(), results: debug }
  };
  writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log(`已写入 ${OUT}：${entries.length} 条；失败平台：${failed.join(' / ') || '无'}`);
}

/* 本地自测（不写文件，只验证解析）：node fetch-hotlist.mjs --selftest */
function selftest() {
  const cases = [
    ['2528 万热度', 25280000],
    ['2426688播放', 2426688],
    ['1126671', 1126671],
    ['428.6万阅读', 4286000],
    ['', 0]
  ];
  let pass = 0;
  cases.forEach(([input, want]) => {
    const got = parseHeat(input);
    const ok = got === want;
    console.log((ok ? 'PASS' : 'FAIL') + ' parseHeat(' + JSON.stringify(input) + ') = ' + got + '（期望 ' + want + '）');
    if (ok) pass++;
  });
  console.log(`自测结果：${pass}/${cases.length}`);
  if (pass !== cases.length) process.exit(1);
}

if (process.argv.includes('--selftest')) { selftest(); process.exit(0); }
main();
