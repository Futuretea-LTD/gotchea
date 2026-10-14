"""Text helpers: many tiny functions so the chunker merges them into groups.

Docstrings count as comments, so they do not add to the LOC of a chunk.
"""
import re

_SLUG_RE = re.compile(r"[^a-z0-9]+")


def slugify(value):
    """Lowercase, dash-separated identifier."""
    lowered = value.strip().lower()
    dashed = _SLUG_RE.sub("-", lowered)
    trimmed = dashed.strip("-")
    if not trimmed:
        return "untitled"
    return trimmed


def capitalize(value):
    if not value:
        return value
    head = value[0].upper()
    tail = value[1:]
    return head + tail


def camel_case(value):
    parts = [p for p in re.split(r"[-_\s]+", value) if p]
    if not parts:
        return ""
    head = parts[0].lower()
    rest = [capitalize(p.lower()) for p in parts[1:]]
    return head + "".join(rest)


def snake_case(value):
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", value)
    words = [w for w in re.split(r"[\s\-]+", spaced) if w]
    lowered = [w.lower() for w in words]
    joined = "_".join(lowered)
    return joined


def truncate(value, limit):
    """Cut `value` to `limit` characters, adding an ellipsis."""
    limit = max(1, limit)
    if len(value) <= limit:
        return value
    cut = value[: limit - 1]
    return cut + "…"


def pad_left(value, width, fill=" "):
    if len(fill) != 1:
        raise ValueError("fill must be one character")
    missing = width - len(value)
    if missing <= 0:
        return value
    return fill * missing + value


def pad_right(value, width, fill=" "):
    if len(fill) != 1:
        raise ValueError("fill must be one character")
    missing = width - len(value)
    if missing <= 0:
        return value
    return value + fill * missing


def is_blank(value):
    if value is None:
        return True
    stripped = value.strip()
    return len(stripped) == 0


def count_occurrences(haystack, needle):
    if not needle:
        return 0
    count = 0
    index = haystack.find(needle)
    while index != -1:
        count += 1
        index = haystack.find(needle, index + len(needle))
    return count


def strip_tags(value):
    without = re.sub(r"<[^>]*>", "", value)
    collapsed = re.sub(r"\s+", " ", without)
    trimmed = collapsed.strip()
    return trimmed


def escape_html(value):
    out = value.replace("&", "&amp;")
    out = out.replace("<", "&lt;")
    out = out.replace(">", "&gt;")
    out = out.replace('"', "&quot;")
    return out.replace("'", "&#39;")


def initials(name):
    parts = [p for p in name.split() if p]
    if not parts:
        return ""
    letters = [p[0].upper() for p in parts]
    return "".join(letters[:3])


def mask_email(email):
    at = email.find("@")
    if at <= 1:
        return email
    local = email[:at]
    domain = email[at:]
    return local[0] + "*" * (len(local) - 1) + domain


def pluralize(word, count):
    if count == 1:
        return word
    if word.endswith("y") and word[-2:-1] not in "aeiou":
        return word[:-1] + "ies"
    return word + "s"


def ordinal(n):
    if 11 <= n % 100 <= 13:
        return f"{n}th"
    suffixes = {1: "st", 2: "nd", 3: "rd"}
    suffix = suffixes.get(n % 10, "th")
    return f"{n}{suffix}"


def format_money(amount, currency="EUR"):
    """Two decimals, thousands separated by commas."""
    negative = amount < 0
    text = f"{abs(amount):,.2f} {currency}"
    if negative:
        return "-" + text
    return text


def starts_with_any(value, prefixes):
    for prefix in prefixes:
        if value.startswith(prefix):
            return True
    return False


def ensure_suffix(value, suffix):
    if not suffix:
        return value
    if value.endswith(suffix):
        return value
    return value + suffix


def remove_prefix(value, prefix):
    if not prefix:
        return value
    if value.startswith(prefix):
        return value[len(prefix):]
    return value


def squish(value):
    lines = value.split("\n")
    trimmed = [line.strip() for line in lines]
    non_empty = [line for line in trimmed if line]
    return " ".join(non_empty)


def hash_code(value):
    h = 0
    for ch in value:
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    if h >= 0x80000000:
        h -= 0x100000000
    return h


def random_id(length, seed):
    alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
    state = seed
    out = []
    for _ in range(length):
        state = (state * 1103515245 + 12345) % 2147483648
        out.append(alphabet[state % len(alphabet)])
    return "".join(out)


def split_lines(value):
    normalized = value.replace("\r\n", "\n").replace("\r", "\n")
    parts = normalized.split("\n")
    if parts and parts[-1] == "":
        parts.pop()
    return parts


def indent(value, spaces):
    pad = " " * max(0, spaces)
    out = [pad + line if line else line for line in split_lines(value)]
    return "\n".join(out)


def word_wrap(value, width):
    """Longer than mergeBelowLoc: breaks the run of tiny helpers."""
    limit = max(1, width)
    words = [w for w in value.split() if w]
    lines = []
    current = ""
    for word in words:
        if not current:
            current = word
            continue
        if len(current) + 1 + len(word) <= limit:
            current = current + " " + word
            continue
        lines.append(current)
        current = word
    if current:
        lines.append(current)
    if not lines:
        lines.append("")
    return lines


def reverse(value):
    chars = list(value)
    chars.reverse()
    joined = "".join(chars)
    return joined


def compare_ignore_case(a, b):
    left = a.lower()
    right = b.lower()
    if left < right:
        return -1
    return 1 if left > right else 0


def dedent_all(value):
    lines = split_lines(value)
    widths = [len(l) - len(l.lstrip()) for l in lines if l.strip()]
    if not widths:
        return value
    cut = min(widths)
    return "\n".join(l[cut:] for l in lines)


def collapse_spaces(value):
    parts = value.split()
    joined = " ".join(parts)
    if not joined:
        return ""
    return joined


def first_word(value):
    parts = value.split()
    if not parts:
        return ""
    word = parts[0]
    return word.strip(".,;:!?")


def last_word(value):
    parts = value.split()
    if not parts:
        return ""
    word = parts[-1]
    return word.strip(".,;:!?")


def title_case(value):
    small = {"a", "an", "the", "of", "and"}
    words = value.split()
    out = []
    for i, word in enumerate(words):
        out.append(word if i > 0 and word in small else capitalize(word))
    return " ".join(out)
