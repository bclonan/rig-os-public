"""Owned descriptor-scoring controller. No pretrained encoder or remote inference."""
import torch
from torch import nn

class Controller(nn.Module):
    def __init__(self):
        super().__init__()
        self.visual = nn.Sequential(nn.Conv2d(3, 12, 3, padding=1), nn.ReLU(), nn.AdaptiveAvgPool2d((4,4)), nn.Flatten(), nn.Linear(192,24),nn.ReLU())
        self.history = nn.GRU(12, 24, batch_first=True)
        self.query = nn.Sequential(nn.Linear(48,32),nn.ReLU(),nn.Linear(32,8))
        self.descriptor = nn.Linear(8,8,bias=False)
        self.predicate = nn.Linear(48,3)
        self.recovery = nn.Linear(48,4)
        self.outcome = nn.Linear(48,2)
    def forward(self, image, history, candidates):
        visual = self.visual(image)
        _, hidden = self.history(history)
        state = torch.cat([visual,hidden[-1]],dim=1)
        query = self.query(state)
        scores = (self.descriptor(candidates)*query[:,None,:]).sum(dim=-1)
        return scores, self.predicate(state), self.recovery(state), torch.sigmoid(self.outcome(state))
