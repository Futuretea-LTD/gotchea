"""Billing service: imports models and text helpers through relative imports."""
from ..models.user import User
from ..util import text
from ..util.text import format_money, slugify


class Invoice:
    def __init__(self, user, lines):
        self.user = user
        self.lines = list(lines)

    def total(self):
        amount = 0
        for _, price, qty in self.lines:
            if qty <= 0:
                continue
            amount += price * qty
        return amount

    def reference(self):
        return f"INV-{slugify(self.user.name)}-{len(self.lines)}"


class BillingService:
    """Creates invoices and renders them."""

    def __init__(self, currency="EUR"):
        self.currency = currency
        self.invoices = []

    def invoice(self, user: User, lines):
        if not isinstance(user, User):
            raise TypeError("user must be a User")
        inv = Invoice(user, lines)
        self.invoices.append(inv)
        return inv

    def render(self, inv):
        rows = [text.pad_right(name, 20) + format_money(price * qty, self.currency) for name, price, qty in inv.lines]
        rows.append(text.pad_right("total", 20) + format_money(inv.total(), self.currency))
        return "\n".join(rows)

    def outstanding(self):
        return sum(inv.total() for inv in self.invoices if inv.total() > 0)
