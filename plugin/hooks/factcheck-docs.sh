#!/bin/sh
# PostToolUse hook (Write|Edit): after Claude writes Markdown, nudge it to
# fact-check the new prose against the Minerval claim graph and warn about
# high-confidence contradicted claims.
#
# Opt-in and off by default — assess_text is a metered call, and most edits
# assert nothing checkable. Enable with:  export MINERVAL_FACTCHECK_HOOK=1
set -eu

case "${MINERVAL_FACTCHECK_HOOK:-}" in
  1|true|yes) ;;
  *) exit 0 ;;
esac

input=$(cat)

# The edited file's path, from the PostToolUse payload's tool_input.
if command -v jq >/dev/null 2>&1; then
  file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')
else
  file_path=$(printf '%s' "$input" |
    sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' |
    head -n 1)
fi

# Only prose files are worth a metered fact-check pass.
case "$file_path" in
  *.md|*.mdx|*.markdown|*.rst|*.txt) ;;
  *) exit 0 ;;
esac

cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "Minerval fact-check (opt-in hook): you just wrote prose to ${file_path}. If the new text asserts disputable facts about the world, run it through the Minerval MCP tool assess_text and warn the user about any claim the graph holds as contradicted or unsupported with high confidence (respect stance: 'denies' inverts the reading). Be conservative: surface only egregious problems, cite each flagged claim's page_url, and stay silent if the text asserts nothing checkable — do not re-check text you already checked this session."
  }
}
EOF
