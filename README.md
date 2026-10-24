# 自媒体工作台 · 热榜数据仓库

这个仓库是「自媒体工作台」的热榜数据源。GitHub Actions 每天北京时间 8:00 / 20:00 自动抓取公开热榜，写入 `hotlist.json`。工作台每次打开时会自动拉取这个文件合并（你标过的「适配判断」不会丢）。

## 文件说明

| 文件 | 作用 |
|---|---|
| `.github/workflows/hotlist.yml` | 定时任务配置（每天两次，也可在网页手动触发） |
| `fetch-hotlist.mjs` | 抓取脚本（零依赖，多源互备） |
| `hotlist.json` | 抓取结果，工作台读的就是它 |

## 数据格式

```json
{
  "date": "2026-10-25",
  "source": "GitHub Actions 自动抓取",
  "failed": [],
  "entries": [
    { "platform": "微博", "title": "热点标题", "heat": 1234567, "category": "生活" }
  ]
}
```

## 在工作台里启用

设置与备份 → 热榜数据文件 → 自动更新地址，填：

```
https://raw.githubusercontent.com/你的GitHub用户名/zmt-hotlist/main/hotlist.json
```

## 手动测试抓取

仓库页面 → Actions → 热榜自动抓取 → Run workflow → 看日志里每个平台的成败。
