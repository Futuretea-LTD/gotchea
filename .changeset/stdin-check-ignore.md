---
"gotchea-core": patch
"gotchea": patch
---

`gotchea init` now sees every git ignore rule when it checks that `.gotchea/` can be committed: nested `.gitignore` files, `.git/info/exclude` and the global `core.excludesFile`. The paths go to `git check-ignore` on stdin, because current git rejects `-z` without `--stdin`. If git fails for any reason other than "not a repository", init prints a warning before it falls back to the root `.gitignore`.
