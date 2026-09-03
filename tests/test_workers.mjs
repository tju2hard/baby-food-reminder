import assert from "node:assert/strict";
import fs from "node:fs";


async function importWorker(path) {
  const source = fs.readFileSync(path, "utf8");
  return import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
}

const menu = JSON.parse(fs.readFileSync("menu.json", "utf8"));
const babyfood = (await importWorker("cloudflare_worker.js")).default;
const epidemic = (await importWorker("epidemic_worker.js")).default;

let sentBody = "";
let failedKey = "";
let newsMode = false;
let officialMode = false;
let newsPubDate = new Date();
let newsLink = "https://news.example/item-1";
let sendCount = 0;
globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  if (target.includes("menu.json")) {
    return new Response(JSON.stringify(menu), { status: 200 });
  }
  if (target.includes("sctapi.ftqq.com")) {
    sentBody = options.body || "";
    sendCount++;
    if (failedKey && target.includes("/" + failedKey + ".send")) {
      return new Response(JSON.stringify({ code: 1 }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: 0 }), { status: 200 });
  }
  if (newsMode && (target.includes("news.google.com") || target.includes("bing.com"))) {
    const rss = `<rss><channel><item><title>北京流感动态</title><link>${newsLink}</link><pubDate>${newsPubDate.toUTCString()}</pubDate></item></channel></rss>`;
    return new Response(rss, { status: 200 });
  }
  if (officialMode && target.includes("jkj.beijing.gov.cn")) {
    const html = `<ul><li><a href="./202608/t20260807_4812950.html" title="2026年7月北京市法定传染病报告情况">报告</a><span>2026-08-07</span></li></ul>`;
    return new Response(html, { status: 200 });
  }
  throw new Error("unexpected fetch: " + target);
};

const noToken = await babyfood.fetch(new Request("https://example.test/run"), {
  WEIXIN_SENDKEYS: "key",
});
assert.equal(noToken.status, 503);

const unauthorized = await babyfood.fetch(new Request("https://example.test/run"), {
  WEIXIN_SENDKEYS: "key",
  TRIGGER_TOKEN: "secret",
});
assert.equal(unauthorized.status, 401);

const authorized = await babyfood.fetch(new Request("https://example.test/run", {
  headers: { Authorization: "Bearer secret" },
}), {
  WEIXIN_SENDKEYS: "key",
  TRIGGER_TOKEN: "secret",
});
assert.equal(authorized.status, 200);
assert.equal((await authorized.json()).ok, true);
const sent = new URLSearchParams(sentBody);
assert.match(sent.get("title"), /^明日辅食提醒 · \d{1,2}月\d{1,2}日$/);

failedKey = "bad-key";
const partialFailure = await babyfood.fetch(new Request("https://example.test/run", {
  headers: { Authorization: "Bearer secret" },
}), {
  WEIXIN_SENDKEYS: "good-key,bad-key",
  TRIGGER_TOKEN: "secret",
});
assert.equal(partialFailure.status, 500);
assert.equal((await partialFailure.json()).ok, false);
failedKey = "";

const epidemicUnauthorized = await epidemic.fetch(new Request("https://example.test/run_epidemic"), {
  WEIXIN_SENDKEYS: "key",
  TRIGGER_TOKEN: "secret",
});
assert.equal(epidemicUnauthorized.status, 401);

const stateValues = new Map();
const newsState = {
  async get(key) {
    return stateValues.has(key) ? stateValues.get(key) : null;
  },
  async put(key, value) {
    stateValues.set(key, value);
  },
  async delete(key) {
    stateValues.delete(key);
  },
};

stateValues.set("simulation:pending", "1");
let scheduledPromise;
const beforeSimulationSend = sendCount;
await epidemic.scheduled({}, {
  WEIXIN_SENDKEYS: "key",
  NEWS_STATE: newsState,
}, {
  waitUntil(promise) {
    scheduledPromise = promise;
  },
});
await scheduledPromise;
assert.equal(sendCount, beforeSimulationSend + 1);
assert.equal(stateValues.has("simulation:pending"), false);
assert.equal(JSON.parse(stateValues.get("status:last_run")).type, "simulation");
assert.match(new URLSearchParams(sentBody).get("title"), /模拟/);
assert.match(new URLSearchParams(sentBody).get("desp"), /并非真实疫情/);

newsMode = true;
officialMode = true;
newsPubDate = new Date("2026-07-27T03:00:00Z");
stateValues.set("backfill:2026-08", "1");
const beforeBackfillSend = sendCount;
await epidemic.scheduled({}, {
  WEIXIN_SENDKEYS: "key",
  NEWS_STATE: newsState,
}, {
  waitUntil(promise) {
    scheduledPromise = promise;
  },
});
await scheduledPromise;
assert.equal(sendCount, beforeBackfillSend + 1);
assert.equal(stateValues.has("backfill:2026-08"), false);
assert.equal(JSON.parse(stateValues.get("status:last_run")).type, "backfill");
assert.equal(JSON.parse(stateValues.get("status:last_backfill")).hits, 1);
assert.match(new URLSearchParams(sentBody).get("title"), /历史回测/);
assert.match(new URLSearchParams(sentBody).get("desp"), /不是当前疫情提醒/);
assert.match(new URLSearchParams(sentBody).get("desp"), /法定传染病报告情况/);

officialMode = false;
newsPubDate = new Date();
newsLink = "https://news.example/item-1";
const beforeNewsSend = sendCount;
const beforeNewsSeen = [...stateValues.keys()].filter(key => key.startsWith("news:")).length;
const epidemicFirst = await epidemic.fetch(new Request("https://example.test/run_epidemic", {
  headers: { Authorization: "Bearer secret" },
}), {
  WEIXIN_SENDKEYS: "key",
  TRIGGER_TOKEN: "secret",
  NEWS_STATE: newsState,
});
assert.equal(epidemicFirst.status, 200);
assert.equal((await epidemicFirst.json()).sent, true);
assert.equal(sendCount, beforeNewsSend + 1);
assert.equal([...stateValues.keys()].filter(key => key.startsWith("news:")).length, beforeNewsSeen + 1);

const epidemicSecond = await epidemic.fetch(new Request("https://example.test/run_epidemic", {
  headers: { Authorization: "Bearer secret" },
}), {
  WEIXIN_SENDKEYS: "key",
  TRIGGER_TOKEN: "secret",
  NEWS_STATE: newsState,
});
assert.equal(epidemicSecond.status, 200);
assert.equal((await epidemicSecond.json()).sent, false);
assert.equal(sendCount, beforeNewsSend + 1);

console.log("worker tests passed");
