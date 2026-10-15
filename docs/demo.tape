# gotchea demo: init → scan → map → quiz → map on a small fixture repo.
#
# Record from the repository root (needs vhs >= 0.8 for `Wait`):
#
#   ANTHROPIC_API_KEY=... vhs docs/demo.tape
#
# The key is used only by the hidden `generate` step, which writes the questions the quiz
# needs; its output is never shown. Progress goes to a throwaway GOTCHEA_HOME, so your real
# ~/.gotchea is untouched. The quiz answers are picked blindly, so a run may pass or fail.
#
# To record against a local build before gotchea is on npm:
#
#   pnpm build && GOTCHEA_BIN=$PWD/packages/cli/dist/index.js ANTHROPIC_API_KEY=... vhs docs/demo.tape
#
# The hidden setup then routes `npx gotchea …` to that build.

Output docs/demo.gif

Require git
Require node
Require npx

Set Shell "bash"
Set FontSize 16
Set Width 1200
Set Height 760
Set Padding 20
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms
Set WindowBar Colorful

# ---- setup (not recorded) ----
Hide
Type "export PS1='$ ' GOTCHEA_HOME=$(mktemp -d) DEMO=$(mktemp -d)/acme-math" Enter
Type `npx() { if [ -n "$GOTCHEA_BIN" ] && [ "$1" = gotchea ]; then shift; node "$GOTCHEA_BIN" "$@"; else command npx "$@"; fi; }` Enter
Type "cp -R packages/cli/test/fixtures/small-repo $DEMO && cd $DEMO" Enter
Type "git init -q && git add -A && git -c user.name=demo -c user.email=demo@example.com commit -qm init" Enter
# Warm the npx cache so the first visible command doesn't stall on a download.
Type `[ -n "$GOTCHEA_BIN" ] || command npx -y gotchea --version >/dev/null` Enter
Wait@120s /\$\s*$/
Type "clear" Enter
Show

# ---- init + scan ----
Type "npx gotchea init"
Sleep 400ms
Enter
Wait@30s /\$\s*$/
Sleep 2s

Type "npx gotchea scan"
Sleep 400ms
Enter
Wait@30s /\$\s*$/
Sleep 2s

# ---- map: every chunk is grey, there are no questions yet ----
Type "clear" Enter
Type "npx gotchea map"
Sleep 400ms
Enter
Wait@30s /\$\s*$/
Sleep 3s

# ---- generate questions for src/math.ts (not recorded) ----
Hide
Type "npx gotchea generate --chunk src/math.ts >/dev/null 2>&1; clear" Enter
Wait@180s /\$\s*$/
Show

# ---- quiz: arrow keys + Enter pick an option ----
Type "npx gotchea quiz src/math.ts --count 3"
Sleep 400ms
Enter
Wait+Screen@30s /Question 1 of 3/
Sleep 3s
Down
Sleep 600ms
Enter
Wait+Screen@15s /Question 2 of 3/
Sleep 4s
Enter
Wait+Screen@15s /Question 3 of 3/
Sleep 4s
Down
Sleep 400ms
Down
Sleep 600ms
Enter
Wait+Screen@30s /Quiz complete/
Sleep 6s

# ---- map again: src/math.ts now has a color ----
Type "clear" Enter
Type "npx gotchea map src"
Sleep 400ms
Enter
Wait@30s /\$\s*$/
Sleep 4s
