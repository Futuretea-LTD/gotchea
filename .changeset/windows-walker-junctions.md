---
"gotchea-core": patch
---

On Windows, `scan` no longer follows directory junctions when it lists files through `git ls-files`. A junction that points to an ancestor used to produce an endless `loop/loop/...` listing.
