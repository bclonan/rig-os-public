"""Pinned action contract only. These tests do not claim an OSWorld/WAA VM score."""
import pathlib
import sys
import unittest
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "sdk" / "python"))
from benchmark_adapter import BenchmarkAgent, CoordinatorProcessBridge


class MapperTests(unittest.TestCase):
    def test_private_bridge_rejects_foreign_binding_and_unverified_terminal_status(self):
        bound = {"id": "action", "runId": "run", "host": "host", "session": "session",
                 "deadline": time.time() * 1000 + 10000, "operation": "click", "args": {"x": 1, "y": 2}}
        CoordinatorProcessBridge.validate_action(bound, "host", "session")
        for changed in ({**bound, "host": "foreign"}, {**bound, "session": "foreign"},
                        {**bound, "deadline": 0}, {**bound, "id": None},
                        {"operation": "done", "runId": "run", "phase": "model_claimed"},
                        {"operation": "click", "runId": "run", "args": {"x": 1, "y": 2}}):
            with self.assertRaises(ValueError):
                CoordinatorProcessBridge.validate_action(changed, "host", "session")
        CoordinatorProcessBridge.validate_action({"operation": "done", "runId": "run", "phase": "verified"}, "host", "session")
    def test_runtime_key_field_and_chord_translation(self):
        self.assertEqual(BenchmarkAgent.map_action({"operation": "key", "args": {"key": "Control+Shift+S"}}),
                         {"action_type": "HOTKEY", "keys": ["ctrl", "shift", "s"]})
        self.assertEqual(BenchmarkAgent.map_action({"operation": "key", "args": {"key": "ArrowLeft"}}),
                         {"action_type": "PRESS", "key": "left"})
        for value in (None, "Control+Control+S", "exec(code)", "Control+", "é"):
            with self.assertRaises(ValueError):
                BenchmarkAgent.map_action({"operation": "key", "args": {"key": value}})

    def test_runtime_scroll_amount_maps_to_pinned_signed_dx_dy(self):
        for amount, dy in ((120, 1), (-240, -2), (1, 1), (1200, 10)):
            self.assertEqual(BenchmarkAgent.map_action({"operation": "scroll", "args": {"amount": amount}}),
                             {"action_type": "SCROLL", "dx": 0, "dy": dy})
        for value in (0, 1201, 1.5, True, "120"):
            with self.assertRaises(ValueError):
                BenchmarkAgent.map_action({"operation": "scroll", "args": {"amount": value}})

    def test_drag_delivers_start_move_then_absolute_destination(self):
        drag = {"operation": "drag", "args": {"x": 14, "y": 25, "dx": 230, "dy": 190}}
        self.assertEqual(BenchmarkAgent.map_actions(drag), [
            {"action_type": "MOVE_TO", "x": 14, "y": 25},
            {"action_type": "DRAG_TO", "x": 230, "y": 190},
        ])
        with self.assertRaisesRegex(ValueError, "start move"):
            BenchmarkAgent.map_action(drag)

    def test_track_privacy_pending_action_identity_and_literal_text(self):
        class Bridge:
            def reset(self, host, session):
                self.calls = []
            def next_action(self, instruction, observation, pending, host, session):
                self.calls.append((observation, pending))
                return {"id": "bound-1", "operation": "drag", "args": {"x": 1, "y": 2, "dx": 3, "dy": 4}}
        bridge = Bridge()
        agent = BenchmarkAgent(bridge, "host", "session", "pixel")
        agent.reset()
        _, actions = agent.predict("Move authorized item", {"screenshot": b"contract only", "reward": 1,
            "done": True, "task_config": {"answer": "private"}, "evaluator": "private", "accessibility_tree": "secret"})
        self.assertEqual(len(actions), 2)
        agent.predict("Move authorized item", {"screenshot": b"contract only"})
        self.assertEqual(set(bridge.calls[0][0]), {"screenshot"})
        self.assertIsNone(bridge.calls[0][1])
        self.assertEqual(bridge.calls[1][1], "bound-1")
        self.assertEqual(BenchmarkAgent.map_action({"operation": "type", "args": {"text": "literal $(not executed)"}}),
                         {"action_type": "TYPING", "text": "literal $(not executed)"})


if __name__ == "__main__":
    unittest.main()
