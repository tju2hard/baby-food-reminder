// ============================================================
// 北京疫情动态提醒 —— Cloudflare Worker（独立，与辅食提醒分开）
// 定时检索「北京 + 病种」的最新新闻（Google News / Bing 新闻兜底），
// 只在抓到【过去几小时内新出现】的相关新闻时，推送到微信。
// 运行在 Cloudflare 边缘（非大陆网络），可访问境外新闻源。
//
// 部署后手动触发测试：GET /run_epidemic
// 病种范围：流感/甲流/乙流、新冠、支原体/RSV/腺病毒、诺如、其他儿科传染病
//
// ⚠️ 免责：这是新闻自动检索的"尽力而为"预警，非官方疫情通报。
//    权威信息请以北京卫健委 / 中国疾控官方渠道为准。
// ============================================================

const CITY = "北京";

// 每个病种组独立检索，避免关键词互相稀释
const DISEASE_GROUPS = [
  { key: "流感",   q: "流感 OR 甲流 OR 乙流" },
  { key: "新冠",   q: "新冠 OR 奥密克戎 OR 新冠病毒" },
  { key: "支原体RSV", q: "支原体 OR 呼吸道合胞 OR RSV OR 腺病毒" },
  { key: "诺如",   q: "诺如" },
  { key: "其他儿科", q: "手足口 OR 百日咳 OR 猩红热 OR 水痘 OR 流感样病例" },
];

// 检索间隔(小时)：cron 每 8h 一次 → 只报最近 ~6h 的新条目，去重靠时间窗
const LOOKBACK_HOURS = 6;
// 单次最多报几条
const MAX_HITS = 6;

function beijingTimeStr() {
  const bj = new Date(Date.now() + 8 * 3600000);
  return bj.getUTCMonth() + 1 + "月" + bj.getUTCDate() + "日 " +
    String(bj.getUTCHours()).padStart(2, "0") + ":" + String(bj.getUTCMinutes()).padStart(2, "0");
}

function stripHtml(s) {
  return String(s || "").replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
}

// 抓一个 URL，返回文本；失败返回 null
async function fetchText(url) {
  try {
    const resp = await fetch(url, { cf: { cacheTtl: 0 }, headers: { "User-Agent": "Mozilla/5.0" } });
    if (!resp.ok) return null;
    return await resp.text();
  } catch (e) {
    return null;
  }
}

// 解析 RSS XML 为条目列表 {title, link, pubDate, source}
function parseRss(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const titleM = block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
    const linkM = block.match(/<link>([\s\S]*?)<\/link>/);
    const dateM = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    if (!titleM || !linkM) continue;
    items.push({
      title: stripHtml(titleM[1]),
      link: linkM[1].trim(),
      pubDate: dateM ? Date.parse(dateM[1]) : null,
    });
  }
  return items;
}

// 按病种组查新闻：先 Google News，失败退 Bing
async function fetchGroupNews(city, group) {
  const query = encodeURIComponent(city + " " + group.q);
  const googleUrl = `https://news.google.com/rss/search?q=${query}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`;
  const bingUrl = `https://www.bing.com/news/search?q=${query}&format=rss`;

  let items = parseRss(await fetchText(googleUrl) || "");
  if (!items.length) items = parseRss(await fetchText(bingUrl) || "");

  const cutoff = Date.now() - LOOKBACK_HOURS * 3600000;
  const fresh = items
    .filter(i => i.pubDate && i.pubDate >= cutoff)
    .map(i => ({ ...i, group: group.key }));

  // 同一病种组内去标题重复
  const seen = new Set();
  const deduped = [];
  for (const it of fresh) {
    const t = it.title.slice(0, 20);
    if (seen.has(t)) continue;
    seen.add(t);
    deduped.push(it);
  }
  return deduped;
}

async function sendServerChan(sendkey, title, desp) {
  const body = new URLSearchParams({ title, desp, tags: "疫情提醒" });
  const resp = await fetch("https://sctapi.ftqq.com/" + sendkey + ".send", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const json = await resp.json();
  if (json.code !== 0) throw new Error("发送失败: " + JSON.stringify(json));
}

async function run(env) {
  const keys = (env.WEIXIN_SENDKEYS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!keys.length) return { ok: false, msg: "未配置 WEIXIN_SENDKEYS" };

  // 逐组检索
  const all = [];
  for (const g of DISEASE_GROUPS) {
    try {
      const hits = await fetchGroupNews(CITY, g);
      all.push(...hits);
    } catch (e) { /* 单组失败跳过 */ }
  }

  if (!all.length) return { ok: true, msg: `近${LOOKBACK_HOURS}h 无北京疫情相关新新闻，未推送`, sent: false };

  // 汇总排序，取前 N
  all.sort((a, b) => b.pubDate - a.pubDate);
  const top = all.slice(0, MAX_HITS);

  const now = beijingTimeStr();
  const lines = ["🦠 北京疫情动态提醒（" + now + "）", ""];
  lines.push("近几小时有这些相关消息，带娃出门注意防护：");
  lines.push("");
  for (const it of top) {
    const hh = new Date(it.pubDate + 8 * 3600000);
    const hm = hh.getUTCMonth() + 1 + "/" + hh.getUTCDate() + " " + String(hh.getUTCHours()).padStart(2, "0") + ":" + String(hh.getUTCMinutes()).padStart(2, "0");
    lines.push("【" + it.group + "】" + it.title);
    lines.push("  " + hm + " · " + it.link);
  }
  lines.push("");
  lines.push("—— 来源为新闻自动检索，仅供参考，权威口径见官方公告");

  const title = "🦠 北京疫情动态";
  const desp = lines.join("\n");

  let okCount = 0;
  for (const key of keys) {
    try { await sendServerChan(key, title, desp); okCount++; }
    catch (e) { console.log("发送失败:", key.slice(0, 8), e.message); }
  }
  return { ok: okCount > 0, msg: `推送 ${okCount}/${keys.length}`, sent: okCount > 0, hits: top.length };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env).then(r => console.log("[cron-epidemic]", JSON.stringify(r))));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/run_epidemic") {
      try {
        const r = await run(env);
        return new Response(JSON.stringify(r), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, msg: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }
    return new Response("北京疫情提醒 Worker 运行中。GET /run_epidemic 手动触发。", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  },
};
