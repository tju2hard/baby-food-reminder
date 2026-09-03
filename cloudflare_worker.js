// ============================================================
// 宝宝辅食提醒 —— Cloudflare Worker（准点版）
// Cron: 每天 06:00 UTC = 北京时间 14:00，Cloudflare 分钟级准点。
// 依赖：
//   - 仓库 menu.json 为公开（从 raw.githubusercontent 读取）
//   - Secret WEIXIN_SENDKEYS = 逗号分隔的 Server酱 SendKey
// 部署后：带 Authorization: Bearer <TRIGGER_TOKEN> 请求 GET /run 可手动测试。
// Secret TRIGGER_TOKEN 用于防止公开端点被他人触发。
// ============================================================

const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const MENU_URLS = [
  "https://raw.githubusercontent.com/tju2hard/baby-food-reminder/main/menu.json",
  "https://cdn.jsdelivr.net/gh/tju2hard/baby-food-reminder@main/menu.json",
];
const LIST_URL = "https://tju2hard.github.io/baby-food-reminder/list/";
const SERVINGS = 2;
const BABIES = ["加加", "玥玥"];

// ---- 工具 ----
function fmtDate(d) {
  // d 为"北京时刻"的 Date；取 UTC 分量（因已 +8h）
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const wd = WEEK[d.getUTCDay()];
  return { ym: m + "月" + day + "日", wd };
}

function pickBalanced(meals, delta, used) {
  if (!Array.isArray(meals) || meals.length === 0) return null;
  const n = meals.length;
  for (let i = 0; i < n; i++) {
    const meal = meals[(delta + i) % n];
    const p = meal.protein || "";
    if (p && used.has(p)) continue;
    return meal;
  }
  return meals[delta % n];
}

// 食材汇总（跨餐同名合并）
function aggregate(meals) {
  const merged = {};
  const special = [];
  for (const meal of meals) {
    for (const item of meal.ingredients) {
      const m = item.trim().match(/^(.+?)\s+(\d+(?:\.\d+)?)\s*([a-zA-Zgml]+|个|只|片|棵|块|根|朵|勺|瓣)?$/);
      if (!m) { special.push(item); continue; }
      const name = m[1].trim(), unit = m[3] || "", qty = parseFloat(m[2]);
      const key = name + "|" + unit;
      if (!merged[key]) merged[key] = { name, unit, qty: 0 };
      merged[key].qty += qty;
    }
  }
  const lines = [];
  for (const k in merged) {
    const v = merged[k];
    lines.push("  ☐ " + v.name + " " + (Number.isInteger(v.qty) ? v.qty : v.qty.toFixed(1)) + v.unit);
  }
  for (const s of special) lines.push("  ☐ " + s);
  return lines;
}

function mealBlock(meal, title) {
  const lines = [title, "🥕 食材："];
  for (const i of meal.ingredients) lines.push("  • " + i);
  if (meal.steps && meal.steps.length) {
    lines.push("👩‍🍳 做法：");
    meal.steps.forEach((s, idx) => lines.push("  " + (idx + 1) + ". " + s));
  }
  if (meal.note) lines.push("💡 " + meal.note);
  return lines;
}

function buildMessage(porridge, pancake, lunch, tomorrow) {
  const d = fmtDate(tomorrow);
  const lines = [];
  lines.push("🍚 明日辅食提醒（" + d.ym + " " + d.wd + "）");
  lines.push("");
  lines.push("🛒 明日备料清单：");
  lines.push.apply(lines, aggregate([porridge, pancake, lunch]));
  lines.push("");
  lines.push("🛒 打开可勾选清单：" + LIST_URL);
  lines.push("（若微信打不开，点右上角···→在浏览器中打开，或添加到主屏幕）");
  lines.push("");
  lines.push("— — — —");
  lines.push("");
  lines.push("🍳 早上");
  lines.push.apply(lines, mealBlock(porridge, "🥣 " + porridge.name));
  lines.push("");
  lines.push("　　┈ 配 ┈");
  lines.push.apply(lines, mealBlock(pancake, "🥞 " + pancake.name));
  lines.push("");
  lines.push("— — — —");
  lines.push.apply(lines, mealBlock(lunch, "🍜 下午 · " + lunch.name));
  lines.push("");
  const proteins = [porridge, pancake, lunch].map(m => m.protein || "");
  if (proteins.every(Boolean)) {
    lines.push("🥩 搭配自检：粥/小饼/下午蛋白源 " + proteins.join("、") + "，三项不重复");
  } else {
    lines.push("🥩 搭配自检：今天蛋白源已覆盖（部分菜品无突出蛋白源）");
  }
  if (SERVINGS > 1) {
    lines.push("");
    lines.push("👶👶 本菜单为 " + BABIES.join("、") + " 双份量，请按此备料");
  }
  return lines.join("\n");
}

async function fetchMenu() {
  for (const url of MENU_URLS) {
    try {
      const resp = await fetch(url, { cf: { cacheTtl: 0 } });
      if (resp.ok) return await resp.json();
    } catch (e) { /* 尝试下一个 */ }
  }
  throw new Error("无法读取菜单文件");
}

async function sendServerChan(sendkey, title, desp) {
  const body = new URLSearchParams({ title, desp, tags: "辅食提醒" });
  const resp = await fetch("https://sctapi.ftqq.com/" + sendkey + ".send", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  const json = await resp.json();
  if (json.code !== 0) throw new Error("发送失败: " + JSON.stringify(json));
}

async function run(env) {
  const menu = await fetchMenu();
  const startParts = String(menu.start_date || "").split("-").map(Number);
  if (startParts.length !== 3 || startParts.some(n => !Number.isInteger(n))) {
    throw new Error("菜单 start_date 格式错误");
  }
  const start = new Date(Date.UTC(startParts[0], startParts[1] - 1, startParts[2]));
  if (start.getUTCFullYear() !== startParts[0] || start.getUTCMonth() !== startParts[1] - 1 || start.getUTCDate() !== startParts[2]) {
    throw new Error("菜单 start_date 不是有效日期");
  }
  const beijingToday = new Date(Date.now() + 8 * 3600000);
  beijingToday.setUTCHours(0, 0, 0, 0);
  const tomorrow = new Date(beijingToday.getTime() + 24 * 3600000);
  const delta = Math.floor((tomorrow - start) / 86400000);
  if (delta < 0) return { ok: false, msg: "菜单还没到开餐日" };

  const used = new Set();
  const porridge = pickBalanced(menu.breakfast_porridge, delta, used);
  if (porridge && porridge.protein) used.add(porridge.protein);
  const pancake = pickBalanced(menu.breakfast_pancake, delta, used);
  if (pancake && pancake.protein) used.add(pancake.protein);
  const lunch = pickBalanced(menu.lunch, delta, used);
  if (!porridge || !pancake || !lunch) return { ok: false, msg: "菜单不完整" };

  const message = buildMessage(porridge, pancake, lunch, tomorrow);
  const title = "明日辅食提醒 · " + fmtDate(tomorrow).ym;

  const keys = (env.WEIXIN_SENDKEYS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!keys.length) return { ok: false, msg: "未配置 WEIXIN_SENDKEYS" };

  let okCount = 0;
  for (const key of keys) {
    try { await sendServerChan(key, title, message); okCount++; }
    catch (e) { console.log("发送失败:", key.slice(0, 8), e.message); }
  }
  return { ok: okCount === keys.length, msg: `成功 ${okCount}/${keys.length}`, okCount };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env).then(r => {
      console.log("[cron]", JSON.stringify(r));
      if (!r.ok) throw new Error(r.msg);
    }));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/run") {
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
    return new Response("宝宝辅食提醒 Worker 运行中。带 Bearer Token 请求 GET /run 可手动触发。", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  },
};
