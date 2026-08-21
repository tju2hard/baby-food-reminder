#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
辅食制作提醒 —— 云端版（GitHub Actions）
每天 14:00（北京时间）在云端运行，与本地 Mac 无关，Mac 关机/休眠也能准点发送。
通过 Server酱(方糖) 批量推送到多个微信。
SendKey 从环境变量 WEIXIN_SENDKEYS 读取（GitHub Secrets，逗号分隔多个）。
"""

import json
import os
import re
import urllib.parse
from datetime import date, datetime, timedelta, timezone

MENU_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "menu.json")

WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]

BEIJING_TZ = timezone(timedelta(hours=8))


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def pick_balanced(meals, start_date, tomorrow, used_proteins):
    """取菜单里满足营养搭配的菜：蛋白源不重复。"""
    n = len(meals)
    delta = (tomorrow - start_date).days
    if delta < 0:
        return None, "菜单还没到开餐日"
    for i in range(n):
        meal = meals[(delta + i) % n]
        protein = meal.get("protein", "")
        if protein and protein in used_proteins:
            continue
        return meal, None
    return meals[delta % n], None


def _parse_ingredient(item):
    """解析单个食材为 (名称, 数量, 单位)。非标准格式（适量/少许/分数等）返回 None。"""
    item = item.strip()
    m = re.match(
        r"^(.+?)\s+(\d+(?:\.\d+)?)\s*([a-zA-Zgml]+|个|只|片|棵|块|根|朵|勺|瓣)?$",
        item,
    )
    if m:
        return m.group(1).strip(), float(m.group(2)), (m.group(3) or "").strip()
    return None


def aggregate_ingredients(meals):
    """汇总多餐食材：同名称同单位自动累加数量；特殊量(适量/分数等)原样列出。"""
    merged = {}
    special = []
    for meal in meals:
        for item in meal.get("ingredients", []):
            parsed = _parse_ingredient(item)
            if parsed is None:
                special.append(item)
                continue
            name, qty, unit = parsed
            key = (name, unit)
            merged[key] = merged.get(key, 0) + qty
    lines = []
    for (name, unit), qty in merged.items():
        lines.append("  ☐ %s %s%s" % (name, "%g" % qty, unit))
    for s in special:
        lines.append("  ☐ %s" % s)
    return lines


def _meal_block(meal, title):
    lines = [title, "🥕 食材："]
    for item in meal["ingredients"]:
        lines.append("  • %s" % item)
    steps = meal.get("steps", [])
    if steps:
        lines.append("👩‍🍳 做法：")
        for i, step in enumerate(steps, 1):
            lines.append("  %d. %s" % (i, step))
    note = meal.get("note", "").strip()
    if note:
        lines.append("💡 %s" % note)
    return lines


def format_message(porridge, pancake, lunch_meal, tomorrow):
    date_str = f"{tomorrow.month}月{tomorrow.day}日 {WEEKDAYS[tomorrow.weekday()]}"
    lines = ["🍚 明日辅食提醒（%s）" % date_str, ""]

    lines += ["🛒 明日备料清单："]
    lines += aggregate_ingredients([porridge, pancake, lunch_meal])
    lines += ["", "— — — —"]

    lines += ["🍳 早上"]
    lines += _meal_block(porridge, "🥣 %s" % porridge["name"])
    lines += ["", "　　┈ 配 ┈"]
    lines += _meal_block(pancake, "🥞 %s" % pancake["name"])
    lines += ["", "— — — —"]
    lines += _meal_block(lunch_meal, "🍜 下午 · %s" % lunch_meal["name"])
    lines += ["", "—— 来自宝宝的辅食管家"]
    return "\n".join(lines)


def send_serverchan(sendkey, title, content):
    url = "https://sctapi.ftqq.com/%s.send" % sendkey
    data = urllib.parse.urlencode(
        {"title": title, "desp": content, "tags": "辅食提醒"}
    ).encode("utf-8")
    req = urllib.request.Request(url, data=data)
    with urllib.request.urlopen(req, timeout=10) as resp:
        result = json.loads(resp.read().decode("utf-8"))
    if result.get("code") != 0:
        raise RuntimeError("发送失败: %s" % result)
    return result


def main():
    # 用北京时间（GitHub Actions 默认 UTC）
    now = datetime.now(BEIJING_TZ).date()
    tomorrow = now + timedelta(days=1)

    menu = load_json(MENU_PATH)
    start_date = date.fromisoformat(menu["start_date"])

    used = set()
    porridge, por_err = pick_balanced(menu["breakfast_porridge"], start_date, tomorrow, used)
    if porridge:
        used.add(porridge.get("protein", ""))
    pancake, pan_err = pick_balanced(menu["breakfast_pancake"], start_date, tomorrow, used)
    if pancake:
        used.add(pancake.get("protein", ""))
    lunch_meal, lunch_err = pick_balanced(menu["lunch"], start_date, tomorrow, used)
    if por_err or pan_err or lunch_err:
        print("[跳过] 菜单未就绪: %s %s %s" % (por_err or "", pan_err or "", lunch_err or ""))
        return 1

    message = format_message(porridge, pancake, lunch_meal, tomorrow)

    proteins = [p.get("protein", "") for p in (porridge, pancake, lunch_meal)]
    if all(proteins):
        message += "\n\n🥩 搭配自检：早/午/晚蛋白源 %s，当天三顿不重复" % "、".join(proteins)
    else:
        message += "\n\n🥩 搭配自检：今天蛋白源已覆盖（部分菜品无突出蛋白源）"

    message += "\n\n🛒 打开可勾选清单：https://tju2hard.github.io/baby-food-reminder/list/\n（若微信打不开，点右上角···→在浏览器中打开，或添加到主屏幕）"

    servings = int(os.environ.get("SERVINGS", "1") or 1)
    babies = os.environ.get("BABIES", "").strip()
    if servings > 1:
        tag = babies if babies else "双份"
        message += "\n\n👶👶 本菜单为 %s 双份量，请按此备料" % tag

    title = "明日辅食提醒 · %s" % message.splitlines()[0].replace("🍚 明日辅食提醒（", "").rstrip("）")

    sendkeys = [s.strip() for s in os.environ.get("WEIXIN_SENDKEYS", "").split(",") if s.strip()]
    if not sendkeys:
        print("[失败] 未配置 WEIXIN_SENDKEYS")
        return 1

    ok = 0
    for idx, sendkey in enumerate(sendkeys, 1):
        try:
            send_serverchan(sendkey, title, message)
            ok += 1
            print("[成功] 第 %d 个接收者 (%s...)" % (idx, sendkey[:8]))
        except Exception as e:
            print("[失败] 第 %d 个接收者: %s" % (idx, e))
    print("[完成] %s 月 %s 日辅食提醒，成功 %d/%d" % (tomorrow.month, tomorrow.day, ok, len(sendkeys)))
    return 0 if ok > 0 else 1


if __name__ == "__main__":
    import sys
    import urllib.request
    sys.exit(main())
