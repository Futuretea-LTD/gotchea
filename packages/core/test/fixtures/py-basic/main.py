from app.models import User
from app.services.billing import BillingService
from app.util.text import slugify


def main():
    service = BillingService()
    user = User("Ada Lovelace", "ada@example.com")
    inv = service.invoice(user, [("tea", 3, 2)])
    print(slugify(user.name), service.render(inv))


if __name__ == "__main__":
    main()
