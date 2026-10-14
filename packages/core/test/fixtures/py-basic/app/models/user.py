"""User model."""
from dataclasses import dataclass, field

from ..util.text import slugify


@dataclass
class Address:
    """A postal address."""

    street: str
    city: str
    country: str = "NL"

    def one_line(self):
        return f"{self.street}, {self.city} ({self.country})"


class User:
    """A registered user."""

    def __init__(self, name, email, address=None):
        self.name = name
        self.email = email
        self.address = address
        self.tags = []

    @property
    def handle(self):
        """URL-safe handle derived from the name."""
        return slugify(self.name)

    def add_tag(self, tag):
        # Tags are unique and lowercase.
        tag = tag.strip().lower()
        if tag and tag not in self.tags:
            self.tags.append(tag)
        return self.tags

    def is_local(self):
        return self.address is not None and self.address.country == "NL"

    class Meta:
        table = "users"
        ordering = ["name"]
