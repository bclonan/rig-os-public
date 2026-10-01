"""Execute exact measurement functions without trainer setup or optimization."""
import ast
import importlib.util
import math
from pathlib import Path
import unittest

try:
    import torch
except ImportError:
    torch = None

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('learner_metrics', root / 'learner/metrics.py')
metrics = importlib.util.module_from_spec(spec)
spec.loader.exec_module(metrics)


class MeasuredModel:
    def __call__(self, image, history, candidates):
        count = image.shape[0]
        return (torch.tensor([[2., 0.]]).repeat(count, 1), torch.ones(count, 2),
                torch.tensor([[0., 0., 0., 2.]]).repeat(count, 1), torch.zeros(count, 2))


@unittest.skipUnless(torch is not None, 'Optional installed PyTorch measurement runtime')
class LearnerMetricsTests(unittest.TestCase):
    def measure(self, version):
        tree = ast.parse((root / f'learner/followup_v{version}_train.py').read_text())
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'measure')
        environment = {'torch': torch, 'require_known_labels': metrics.require_known_labels,
                       'training': [{'candidateEligible': [True, True]}] * 2,
                       'validation': [{'candidateEligible': [True, True]}] * 2}
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(root / f'learner/followup_v{version}_train.py'), 'exec'), environment)
        return environment['measure']

    def values(self, version):
        values = [torch.zeros(2, 3, 8, 8), torch.zeros(2, 4, 12), torch.zeros(2, 2, 8),
                  torch.zeros(2, dtype=torch.int64), torch.ones(2, 2),
                  torch.full((2,), 3, dtype=torch.int64), torch.zeros(2, 2), torch.ones(2, 2)]
        values.append(torch.zeros(2, 8))
        return values

    def test_measurement_rejects_each_empty_known_subset(self):
        for version in (2, 3, 4):
            measure = self.measure(version)
            for name in ('selection', 'predicates', 'clarification', 'outcome', 'cost'):
                with self.subTest(version=version, subset=name):
                    values = self.values(version)
                    if name == 'selection': values[3].fill_(-1)
                    if name == 'predicates': values[4].fill_(-1)
                    if name == 'clarification': values[5].fill_(0)
                    if name == 'outcome': values[7][:, 0] = 0
                    if name == 'cost': values[7][:, 1] = 0
                    with self.assertRaisesRegex(ValueError, name):
                        measure(MeasuredModel(), values)

    def test_known_metrics_are_finite_and_counted(self):
        for version in (2, 3, 4):
            with self.subTest(version=version):
                result = self.measure(version)(MeasuredModel(), self.values(version))
                self.assertTrue(all(math.isfinite(value) for value in result.values()))
                for name in ('selectionLabels', 'clarificationLabels', 'knownOutcomeLabels', 'knownCostLabels'):
                    self.assertEqual(result[name], 2)
                self.assertEqual(result['predicateLabels'], 4)

    def test_v1_validation_guard_runs_before_seed_output(self):
        tree = ast.parse((root / 'learner/followup_train.py').read_text())
        guard = next(node for node in tree.body if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name) and node.value.func.id == 'require_known_labels')
        seed_loop = next(node for node in tree.body if isinstance(node, ast.For) and isinstance(node.target, ast.Name) and node.target.id == 'seed')
        self.assertLess(guard.lineno, seed_loop.lineno)
        environment = {'require_known_labels': metrics.require_known_labels, 'v': [None, None, None, torch.full((2,), -1)]}
        with self.assertRaisesRegex(ValueError, 'validation_selection'):
            exec(compile(ast.Module(body=[guard], type_ignores=[]), 'v1-validation-guard', 'exec'), environment)


if __name__ == '__main__':
    unittest.main()
