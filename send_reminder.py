#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
辅食制作提醒
每天 14:00 提醒明日辅食：吃什么 + 需要准备的食材
通过 Server酱(方糖) 推送到微信
"""

import json
import os
import re
import sys
import urllib.parse
from datetime import date, timedelta
from urllib import request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")
MENU_PATH = os.path.join(BASE_DIR, "menu.json")
STATE_PATH = os.path.join(BASE_DIR, "state.json")

WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def pick_meal(meals, start_date, tomorrow):
    """按日期轮换取菜：发完一轮从头开始。"""
    if not meals:
        return None, "菜单列表为空"
    delta = (tomorrow - start_date).days
    if delta < 0:
        return None, f"菜单从 {start_date} 开始，还没到开餐日"
    index = delta % len(meals)
    return meals[index], None


def pick_balanced(meals, start_date, tomorrow, used_proteins):
    """取菜单里满足营养搭配的菜：蛋白源不重复（空蛋白视为无冲突）。"""
    n = len(meals)
    if n == 0:
        return None, "菜单列表为空"
    delta = (tomorrow - start_date).days
    if delta < 0:
        return None, "菜单还没到开餐日"
    for i in range(n):
        meal = meals[(delta + i) % n]
        protein = meal.get("protein", "")
        if protein and protein in used_proteins:
            continue  # 蛋白撞车，跳过，取下一道
        return meal, None
    # 全部撞车，退化为轮换取今天这道
    return meals[delta % n], None


def was_sent(day):
    """返回指定日期是否已经成功发送；损坏的状态文件按未发送处理。"""
    if not os.path.exists(STATE_PATH):
        return False
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            state = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        print("[警告] 无法读取发送状态，将继续尝试发送: %s" % exc)
        return False
    return state.get("last_sent") == day


def mark_sent(day):
    """仅在实际发送成功后，原子地记录已发送日期。"""
    state = {"last_sent": day}
    temp_path = STATE_PATH + ".tmp"
    with open(temp_path, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(temp_path, STATE_PATH)


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
    """生成一餐的文本块，title 形如 '🥣 南瓜小米粥'。"""
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
    lines += [
        "",
        "🛒 打开可勾选清单：https://tju2hard.github.io/baby-food-reminder/list/",
        "（若微信打不开，点右上角···→在浏览器中打开，或添加到主屏幕）",
        "",
        "— — — —",
    ]

    lines += ["🍳 早上"]
    lines += _meal_block(porridge, "🥣 %s" % porridge["name"])
    lines += ["", "　　┈ 配 ┈"]
    lines += _meal_block(pancake, "🥞 %s" % pancake["name"])
    lines += ["", "— — — —"]
    lines += _meal_block(lunch_meal, "🍜 下午 · %s" % lunch_meal["name"])

    lines += ["", "—— 来自宝宝的辅食管家"]
    return "\n".join(lines)


def send_serverchan(sendkey, title, content):
    """通过 Server酱(方糖) 推送消息到微信。"""
    url = "https://sctapi.ftqq.com/%s.send" % sendkey
    data = urllib.parse.urlencode(
        {"title": title, "desp": content, "tags": "辅食提醒"}
    ).encode("utf-8")
    req = request.Request(url, data=data)
    with request.urlopen(req, timeout=10) as resp:
        result = json.loads(resp.read().decode("utf-8"))
    if result.get("code") != 0:
        raise RuntimeError("发送失败: %s" % result)
    return result


def send_wecom(webhook_url, message):
    """发送文本消息到企业微信群机器人。长消息自动按段落拆成多条（每条≤2000字节）。"""
    for part in split_for_wecom(message):
        payload = json.dumps(
            {"msgtype": "text", "text": {"content": part}},
            ensure_ascii=False,
        ).encode("utf-8")
        req = request.Request(
            webhook_url,
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        with request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read().decode("utf-8"))
        if result.get("errcode") != 0:
            raise RuntimeError("企业微信发送失败: %s" % result)


def split_for_wecom(message, max_bytes=2000):
    """按空行分段，合并进多个消息块，每块不超过 max_bytes 字节。"""
    if max_bytes <= 0:
        raise ValueError("max_bytes 必须大于 0")

    def split_oversized(text):
        """按 UTF-8 字节安全拆分单个超长段落，不截断多字节字符。"""
        chunks, current, current_len = [], [], 0
        for char in text:
            char_len = len(char.encode("utf-8"))
            if current and current_len + char_len > max_bytes:
                chunks.append("".join(current))
                current, current_len = [], 0
            current.append(char)
            current_len += char_len
        if current:
            chunks.append("".join(current))
        return chunks

    blocks = [b for b in message.split("\n\n") if b.strip()]
    parts, current, current_len = [], [], 0
    for block in blocks:
        raw_block_len = len(block.encode("utf-8"))
        if raw_block_len > max_bytes:
            if current:
                parts.append("\n\n".join(current))
                current, current_len = [], 0
            parts.extend(split_oversized(block))
            continue

        block_bytes = raw_block_len + (2 if current else 0)
        if current and current_len + block_bytes > max_bytes:
            parts.append("\n\n".join(current))
            current, current_len = [], 0
            block_bytes = raw_block_len
        current.append(block)
        current_len += block_bytes
    if current:
        parts.append("\n\n".join(current))
    return parts


def main():
    preview = "--preview" in sys.argv

    config = load_json(CONFIG_PATH)
    menu = load_json(MENU_PATH)

    start_date = date.fromisoformat(menu["start_date"])
    tomorrow = date.today() + timedelta(days=1)

    # 营养搭配自检 + 自动避重：三顿蛋白源不重复
    used = set()
    porridge, por_err = pick_balanced(menu["breakfast_porridge"], start_date, tomorrow, used)
    used.add(porridge.get("protein", "")) if porridge else None
    pancake, pan_err = pick_balanced(menu["breakfast_pancake"], start_date, tomorrow, used)
    used.add(pancake.get("protein", "")) if pancake else None
    lunch_meal, lunch_err = pick_balanced(menu["lunch"], start_date, tomorrow, used)
    if por_err or pan_err or lunch_err:
        print("[跳过] 菜单未就绪: %s %s %s" % (por_err or "", pan_err or "", lunch_err or ""))
        return 0

    message = format_message(porridge, pancake, lunch_meal, tomorrow)

    # 搭配自检说明：三顿蛋白源
    proteins = [p.get("protein", "") for p in (porridge, pancake, lunch_meal)]
    if all(proteins):
        message += "\n\n🥩 搭配自检：粥/小饼/下午蛋白源 %s，三项不重复" % "、".join(proteins)
    else:
        message += "\n\n🥩 搭配自检：今天蛋白源已覆盖（部分菜品无突出蛋白源）"

    servings = int(config.get("servings", 1) or 1)
    babies = config.get("babies") or []
    if servings > 1:
        tag = "、".join(babies) if babies else "双份"
        message += "\n\n👶👶 本菜单为 %s 双份量，请按此备料" % tag

    if preview:
        print("===== 预览消息（未发送）=====")
        print(message)
        return 0

    webhook_url = (config.get("webhook_url") or "").strip()
    sendkeys = [s.strip() for s in (config.get("sendkeys") or []) if s.strip()]
    if not webhook_url and not sendkeys:
        print("[跳过] 未配置 webhook_url 或 sendkeys，请先在 config.json 填写")
        return 0

    # 只有具备发送通道时才检查状态；状态只在实际发送成功后写入。
    day_str = tomorrow.strftime("%Y-%m-%d")
    if was_sent(day_str):
        print("[跳过] %s 的提醒今天已发送过，避免重复" % day_str)
        return 0

    if webhook_url:
        try:
            send_wecom(webhook_url, message)
        except Exception as exc:
            print("[失败] 企业微信发送失败: %s" % exc)
            return 1
        mark_sent(day_str)
        print("[成功] 已发送到企业微信群 %s 月 %s 日的辅食提醒" % (tomorrow.month, tomorrow.day))
        return 0

    title = "明日辅食提醒 · %s" % message.splitlines()[0].replace("🍚 明日辅食提醒（", "").rstrip("）")
    ok = 0
    for idx, sendkey in enumerate(sendkeys, 1):
        try:
            send_serverchan(sendkey, title, message)
            ok += 1
            print("[成功] 已发送给第 %d 个接收者 (%s)" % (idx, sendkey[:8] + "..."))
        except Exception as e:
            print("[失败] 第 %d 个接收者 (%s): %s" % (idx, sendkey[:8] + "...", e))
    print("[完成] %s 月 %s 日辅食提醒，成功 %d/%d 位接收者" % (tomorrow.month, tomorrow.day, ok, len(sendkeys)))
    if ok == len(sendkeys):
        mark_sent(day_str)
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
