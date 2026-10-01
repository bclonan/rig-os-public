"""V4 controller with a conditional nonlinear outcome and cost head.

The V3 controller concatenates independent image and history encoders then uses
a linear outcome head. That makes its outcome logit additive in visual state
and the proposed action. V4 can learn their interaction without changing the
selection, predicate or recovery heads, or importing private evaluator truth.
"""
from torch import nn
from model import Controller as BaseController


class Controller(BaseController):
    def __init__(self):
        super().__init__()
        self.outcome = nn.Sequential(nn.Linear(48, 32), nn.ReLU(), nn.Linear(32, 2))
