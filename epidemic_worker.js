// ============================================================
// 北京疫情动态提醒 —— Cloudflare Worker（独立，与辅食提醒分开）
// 每 5 分钟检索「北京 + 病种」的最新新闻（Google News / Bing 新闻兜底），
// 新链接一经发现就推送；NEWS_STATE KV 负责持久去重。
// 运行在 Cloudflare 边缘（非大陆网络），可访问境外新闻源。
//
// 部署后手动触发测试：带 Authorization: Bearer <TRIGGER_TOKEN> 请求 GET /run_epidemic
// 病种范围：官方通报、流感/甲流/乙流、新冠、支原体/RSV/腺病毒、诺如、其他儿科传染病
//
// ⚠️ 免责：这是新闻自动检索的"尽力而为"预警，非官方疫情通报。
//    权威信息请以北京卫健委 / 中国疾控官方渠道为准。
// ============================================================

const CITY = "北京";
const OFFICIAL_REPORTS_URL = "https://jkj.beijing.gov.cn/zwgk/zfxxgk/fdzdgknr/crbxx/";

// 每个病种组独立检索，避免关键词互相稀释
const DISEASE_GROUPS = [
  { key: "官方通报", q: "法定传染病 OR 传染病报告 OR 疾病监测" },
  { key: "流感",   q: "流感 OR 甲流 OR 乙流" },
  { key: "新冠",   q: "新冠 OR 奥密克戎 OR 新冠病毒" },
  { key: "支原体RSV", q: "支原体 OR 呼吸道合胞 OR RSV OR 腺病毒" },
  { key: "诺如",   q: "诺如" },
  { key: "其他儿科", q: "手足口 OR 百日咳 OR 猩红热 OR 水痘 OR 流感样病例" },
];

const HISTORICAL_BACKFILL = {
  key: "backfill:2026-08",
  label: "2026年8月",
  after: "2026-08-01",
  before: "2026-09-01",
  startMs: Date.parse("2026-08-01T00:00:00+08:00"),
  endMs: Date.parse("2026-09-01T00:00:00+08:00"),
};

// 回看 24 小时可以容忍新闻源延迟收录，已发送链接由 KV 过滤。
const LOOKBACK_HOURS = 24;
const SEEN_TTL_SECONDS = 14 * 24 * 3600;
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

// 按病种组查新闻：先 Google News，失败退 Bing。
// 传入 after/before 时使用新闻搜索的日期语法，并在本地再次严格校验发布时间。
async function fetchGroupNews(city, group, range = {}) {
  const dateQuery = range.after && range.before
    ? ` after:${range.after} before:${range.before}`
    : "";
  const query = encodeURIComponent(`${city} (${group.q})${dateQuery}`);
  const googleUrl = `https://news.google.com/rss/search?q=${query}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`;
  const bingUrl = `https://www.bing.com/news/search?q=${query}&format=rss`;

  let xml = await fetchText(googleUrl);
  if (!xml) xml = await fetchText(bingUrl);
  if (!xml) return { items: [], sourceOk: false };
  const items = parseRss(xml);

  const startMs = range.startMs ?? Date.now() - LOOKBACK_HOURS * 3600000;
  const endMs = range.endMs ?? Date.now();
  const fresh = items
    .filter(i => i.pubDate && i.pubDate >= startMs && i.pubDate < endMs)
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
  return { items: deduped, sourceOk: true };
}

// 北京市疾病预防控制局的传染病信息列表是首选官方源，不依赖新闻聚合收录。
async function fetchOfficialReports(range = {}) {
  const html = await fetchText(OFFICIAL_REPORTS_URL);
  if (!html) return { items: [], sourceOk: false };

  const startMs = range.startMs ?? Date.now() - LOOKBACK_HOURS * 3600000;
  const endMs = range.endMs ?? Date.now();
  const items = [];
  const liRe = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
  let match;
  while ((match = liRe.exec(html)) !== null) {
    const block = match[1];
    const hrefM = block.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/i);
    const titleM = block.match(/<a\b[^>]*title=["']([^"']+)["'][^>]*>/i);
    const dateM = block.match(/<span[^>]*>\s*(\d{4}-\d{2}-\d{2})\s*<\/span>/i);
    if (!hrefM || !titleM || !dateM) continue;
    const pubDate = Date.parse(dateM[1] + "T00:00:00+08:00");
    if (!Number.isFinite(pubDate) || pubDate < startMs || pubDate >= endMs) continue;
    items.push({
      title: stripHtml(titleM[1]),
      link: new URL(hrefM[1], OFFICIAL_REPORTS_URL).href,
      pubDate,
      group: "官方通报",
    });
  }
  return { items, sourceOk: true };
}

async function seenKey(link) {
  const bytes = new TextEncoder().encode(link);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
  return "news:" + hex;
}

async function filterUnseen(items, state) {
  const keyed = await Promise.all(items.map(async item => ({ item, key: await seenKey(item.link) })));
  const values = await Promise.all(keyed.map(entry => state.get(entry.key)));
  return keyed.filter((entry, index) => values[index] === null);
}

async function markSeen(entries, state) {
  await Promise.all(entries.map(entry => state.put(entry.key, String(Date.now()), {
    expirationTtl: SEEN_TTL_SECONDS,
  })));
}

async function sendServerChan(sendkey, title, desp) {
  const body = new URLSearchParams({ title, desp, tags: "疫情提醒" });
  const resp = await fetch("https://sctapi.ftqq.com/" + sendkey + ".send", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  const json = await resp.json();
  if (json.code !== 0) throw new Error("发送失败: " + JSON.stringify(json));
}

async function runSimulation(env) {
  const keys = (env.WEIXIN_SENDKEYS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!keys.length) return { ok: false, msg: "未配置 WEIXIN_SENDKEYS", simulated: true };

  const title = "🧪 疾病提醒链路演练（模拟）";
  const desp = [
    "⚠️ 这是系统模拟演练，并非真实疫情，请勿转发或恐慌。",
    "",
    "【模拟场景】假设系统刚捕捉到一条北京地区的儿童呼吸道疾病相关新闻。",
    "系统已立即完成：新闻识别 → 新旧去重 → 云端推送 → 微信提醒。",
    "",
    "✅ 如果你看到本消息，说明疾病即时提醒链路运行正常。",
    "—— 宝宝健康提醒系统",
  ].join("\n");

  let okCount = 0;
  for (const key of keys) {
    try { await sendServerChan(key, title, desp); okCount++; }
    catch (e) { console.log("演练发送失败:", key.slice(0, 8), e.message); }
  }
  return {
    ok: okCount === keys.length,
    msg: `演练推送 ${okCount}/${keys.length}`,
    sent: okCount > 0,
    simulated: true,
  };
}

function uniqueItems(items) {
  const unique = [];
  const seenLinks = new Set();
  const seenTitles = new Set();
  for (const item of items) {
    const titleKey = item.title.replace(/\s+/g, "").toLowerCase();
    if (seenLinks.has(item.link) || seenTitles.has(titleKey)) continue;
    seenLinks.add(item.link);
    seenTitles.add(titleKey);
    unique.push(item);
  }
  return unique;
}

async function sendToAll(keys, title, desp, failureLabel = "发送失败") {
  let okCount = 0;
  for (const key of keys) {
    try { await sendServerChan(key, title, desp); okCount++; }
    catch (e) { console.log(failureLabel + ":", key.slice(0, 8), e.message); }
  }
  return okCount;
}

async function runHistoricalBackfill(env) {
  const keys = (env.WEIXIN_SENDKEYS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!keys.length) return { ok: false, msg: "未配置 WEIXIN_SENDKEYS", historical: true };
  if (!env.NEWS_STATE) return { ok: false, msg: "未绑定 NEWS_STATE KV，无法安全去重", historical: true };

  const all = [];
  let availableGroups = 0;
  for (const group of DISEASE_GROUPS) {
    try {
      const result = await fetchGroupNews(CITY, group, HISTORICAL_BACKFILL);
      if (result.sourceOk) availableGroups++;
      all.push(...result.items);
    } catch (e) { /* 单组失败跳过 */ }
  }
  try {
    const official = await fetchOfficialReports(HISTORICAL_BACKFILL);
    if (official.sourceOk) availableGroups++;
    all.push(...official.items);
  } catch (e) { /* 官方源失败时继续使用聚合源 */ }

  if (!availableGroups) {
    return { ok: false, msg: "历史回测时所有新闻源均不可用", sent: false, historical: true, availableGroups };
  }
  if (!all.length) {
    return {
      ok: true,
      msg: `${HISTORICAL_BACKFILL.label}历史搜索无结果，未推送`,
      sent: false,
      historical: true,
      availableGroups,
      hits: 0,
    };
  }

  all.sort((a, b) => b.pubDate - a.pubDate);
  const unique = uniqueItems(all);
  const topEntries = (await filterUnseen(unique, env.NEWS_STATE)).slice(0, MAX_HITS);
  if (!topEntries.length) {
    return {
      ok: true,
      msg: `${HISTORICAL_BACKFILL.label}历史结果均已推送`,
      sent: false,
      historical: true,
      availableGroups,
      hits: 0,
    };
  }

  const lines = [
    `🧪 ${HISTORICAL_BACKFILL.label}疾病信息历史回测`,
    "",
    "⚠️ 这是历史回测，不是当前疫情提醒，请勿按实时消息转发。",
    "以下内容由系统从真实新闻源自动检索，用于验证捕捉、去重和推送链路：",
    "",
  ];
  for (const entry of topEntries) {
    const it = entry.item;
    const bj = new Date(it.pubDate + 8 * 3600000);
    const date = bj.getUTCFullYear() + "-" + String(bj.getUTCMonth() + 1).padStart(2, "0") + "-" + String(bj.getUTCDate()).padStart(2, "0");
    lines.push(`【${it.group}】${it.title}`);
    lines.push(`  ${date} · ${it.link}`);
  }
  lines.push("");
  lines.push("—— 历史新闻自动检索结果不等于疫情暴发结论，权威口径以官方公告为准");

  const okCount = await sendToAll(
    keys,
    `🧪 ${HISTORICAL_BACKFILL.label}疾病信息历史回测`,
    lines.join("\n"),
    "历史回测发送失败",
  );
  const ok = okCount === keys.length;
  if (ok) await markSeen(topEntries, env.NEWS_STATE);
  return {
    ok,
    msg: `历史回测推送 ${okCount}/${keys.length}`,
    sent: okCount > 0,
    historical: true,
    hits: topEntries.length,
    availableGroups,
  };
}

async function run(env) {
  const keys = (env.WEIXIN_SENDKEYS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!keys.length) return { ok: false, msg: "未配置 WEIXIN_SENDKEYS" };
  if (!env.NEWS_STATE) return { ok: false, msg: "未绑定 NEWS_STATE KV，无法安全去重" };

  // 逐组检索
  const all = [];
  let availableGroups = 0;
  for (const g of DISEASE_GROUPS) {
    try {
      const result = await fetchGroupNews(CITY, g);
      if (result.sourceOk) availableGroups++;
      all.push(...result.items);
    } catch (e) { /* 单组失败跳过 */ }
  }
  try {
    const official = await fetchOfficialReports();
    if (official.sourceOk) availableGroups++;
    all.push(...official.items);
  } catch (e) { /* 官方源失败时继续使用聚合源 */ }

  if (!availableGroups) return { ok: false, msg: "所有新闻源均不可用", sent: false, availableGroups };
  if (!all.length) return { ok: true, msg: `近${LOOKBACK_HOURS}h 无北京疫情相关新闻，未推送`, sent: false, availableGroups };

  // 汇总排序，取前 N
  all.sort((a, b) => b.pubDate - a.pubDate);
  const unique = uniqueItems(all);
  const unseen = await filterUnseen(unique, env.NEWS_STATE);
  if (!unseen.length) return { ok: true, msg: "没有新发现的北京疫情相关新闻，未推送", sent: false, availableGroups };
  const topEntries = unseen.slice(0, MAX_HITS);
  const top = topEntries.map(entry => entry.item);

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
  const ok = okCount === keys.length;
  if (ok) await markSeen(topEntries, env.NEWS_STATE);
  return { ok, msg: `推送 ${okCount}/${keys.length}`, sent: okCount > 0, hits: top.length, availableGroups };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const simulationPending = env.NEWS_STATE && await env.NEWS_STATE.get("simulation:pending");
      const backfillPending = !simulationPending && env.NEWS_STATE && await env.NEWS_STATE.get(HISTORICAL_BACKFILL.key);
      const type = simulationPending ? "simulation" : backfillPending ? "backfill" : "scan";
      const r = simulationPending
        ? await runSimulation(env)
        : backfillPending
          ? await runHistoricalBackfill(env)
          : await run(env);
      console.log(`[${type}]`, JSON.stringify(r));
      if (env.NEWS_STATE) {
        const status = JSON.stringify({
          ...r,
          type,
          at: new Date().toISOString(),
        });
        await env.NEWS_STATE.put("status:last_run", status, { expirationTtl: 7 * 24 * 3600 });
        if (type === "backfill") {
          await env.NEWS_STATE.put("status:last_backfill", status, { expirationTtl: 30 * 24 * 3600 });
        }
      }
      if (!r.ok) throw new Error(r.msg);
      if (simulationPending) await env.NEWS_STATE.delete("simulation:pending");
      if (backfillPending) await env.NEWS_STATE.delete(HISTORICAL_BACKFILL.key);
    })());
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/run_epidemic") {
      const expected = env.TRIGGER_TOKEN || "";
      const supplied = request.headers.get("Authorization") || "";
      if (!expected) {
        return new Response(JSON.stringify({ ok: false, msg: "未配置 TRIGGER_TOKEN，手动触发已禁用" }), { status: 503, headers: { "Content-Type": "application/json" } });
      }
      if (supplied !== "Bearer " + expected) {
        return new Response(JSON.stringify({ ok: false, msg: "未授权" }), { status: 401, headers: { "Content-Type": "application/json" } });
      }
      try {
        const r = await run(env);
        return new Response(JSON.stringify(r), { status: r.ok ? 200 : 500, headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, msg: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }
    return new Response("北京疫情提醒 Worker 运行中。带 Bearer Token 请求 GET /run_epidemic 可手动触发。", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  },
};
