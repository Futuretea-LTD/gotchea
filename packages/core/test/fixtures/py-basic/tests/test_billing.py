"""Excluded by default (tests/, test_*.py); included with includeTests=true."""
from app.models import User
from app.services.billing import BillingService


def test_total():
    service = BillingService()
    inv = service.invoice(User("Ada", "ada@example.com"), [("tea", 3, 2)])
    assert inv.total() == 6
