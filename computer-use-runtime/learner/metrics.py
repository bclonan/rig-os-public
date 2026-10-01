"""Refuse an accuracy or error metric with no independently known targets."""
def require_known_labels(**masks):
    missing = [name for name, mask in masks.items() if not bool(mask.any())]
    if missing:
        raise ValueError('Cannot measure empty known-label subsets: ' + ', '.join(missing))
