"""Tiny inventory module."""


class Inventory:
    def __init__(self):
        self.items = {}

    def add(self, name, count=1):
        if count <= 0:
            raise ValueError("count must be positive")
        self.items[name] = self.items.get(name, 0) + count

    def total(self):
        return sum(self.items.values())
