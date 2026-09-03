import json
import os
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import send_reminder as local
import send_reminder_cloud as cloud


def sample_menu():
    def meal(name, protein):
        return {
            "name": name,
            "ingredients": ["大米 10g"],
            "steps": ["煮熟"],
            "note": "",
            "protein": protein,
        }

    return {
        "start_date": "2026-01-01",
        "breakfast_porridge": [meal("粥", "肉")],
        "breakfast_pancake": [meal("饼", "蛋")],
        "lunch": [meal("面", "鱼")],
    }


class FixedDate(date):
    @classmethod
    def today(cls):
        return cls(2026, 9, 2)


class ReminderTests(unittest.TestCase):
    def test_menu_json_has_required_nonempty_fields(self):
        with (ROOT / "menu.json").open(encoding="utf-8") as handle:
            menu = json.load(handle)
        date.fromisoformat(menu["start_date"])
        for section in ("breakfast_porridge", "breakfast_pancake", "lunch"):
            self.assertTrue(menu[section], section)
            for meal in menu[section]:
                self.assertTrue(meal.get("name"), section)
                self.assertTrue(meal.get("ingredients"), meal.get("name"))
                self.assertTrue(meal.get("steps"), meal.get("name"))
                self.assertIn("protein", meal)

    def test_empty_meal_list_is_reported(self):
        meal, error = local.pick_balanced([], date(2026, 1, 1), date(2026, 1, 2), set())
        self.assertIsNone(meal)
        self.assertEqual(error, "菜单列表为空")
        meal, error = cloud.pick_balanced([], date(2026, 1, 1), date(2026, 1, 2), set())
        self.assertIsNone(meal)
        self.assertEqual(error, "菜单列表为空")

    def test_wecom_chunks_never_exceed_byte_limit(self):
        message = "短段落\n\n" + "辅" * 2500 + "\n\n结束"
        parts = local.split_for_wecom(message, max_bytes=2000)
        self.assertGreater(len(parts), 1)
        self.assertEqual("".join(parts).replace("\n\n", ""), message.replace("\n\n", ""))
        self.assertTrue(all(len(part.encode("utf-8")) <= 2000 for part in parts))

    def test_no_channel_does_not_mark_sent(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            state_path = os.path.join(temp_dir, "state.json")
            config = {"webhook_url": "", "sendkeys": [], "servings": 1}
            with mock.patch.object(local, "STATE_PATH", state_path), \
                 mock.patch.object(local, "date", FixedDate), \
                 mock.patch.object(local, "load_json", side_effect=[config, sample_menu()]), \
                 mock.patch.object(local.sys, "argv", ["send_reminder.py"]):
                self.assertEqual(local.main(), 0)
            self.assertFalse(os.path.exists(state_path))

    def test_failed_send_does_not_mark_sent(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            state_path = os.path.join(temp_dir, "state.json")
            config = {"webhook_url": "", "sendkeys": ["key"], "servings": 1}
            with mock.patch.object(local, "STATE_PATH", state_path), \
                 mock.patch.object(local, "date", FixedDate), \
                 mock.patch.object(local, "load_json", side_effect=[config, sample_menu()]), \
                 mock.patch.object(local, "send_serverchan", side_effect=RuntimeError("network")), \
                 mock.patch.object(local.sys, "argv", ["send_reminder.py"]):
                self.assertEqual(local.main(), 1)
            self.assertFalse(os.path.exists(state_path))

    def test_successful_send_marks_sent(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            state_path = os.path.join(temp_dir, "state.json")
            config = {"webhook_url": "", "sendkeys": ["key"], "servings": 1}
            with mock.patch.object(local, "STATE_PATH", state_path), \
                 mock.patch.object(local, "date", FixedDate), \
                 mock.patch.object(local, "load_json", side_effect=[config, sample_menu()]), \
                 mock.patch.object(local, "send_serverchan", return_value={"code": 0}), \
                 mock.patch.object(local.sys, "argv", ["send_reminder.py"]):
                self.assertEqual(local.main(), 0)
            with open(state_path, encoding="utf-8") as handle:
                self.assertEqual(json.load(handle)["last_sent"], "2026-09-03")


if __name__ == "__main__":
    unittest.main()
