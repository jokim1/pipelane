Append a dated lesson to this repo's local CLAUDE.md so it accretes across sessions (both Claude and Codex read it).

1. Take the lesson text from the arguments after `/lesson`. If none was given, ask the user for the one-line lesson and stop.
2. Open `CLAUDE.md` at the repo root. If it has no `<!-- pipelane:lessons:entries:end -->` marker, the managed Lessons block is not provisioned yet — tell the user to run `/pipelane setup` (`--yes` to apply) first, then stop without editing.
3. Insert a single new line immediately BEFORE the `<!-- pipelane:lessons:entries:end -->` marker (entries stay newest-last), formatted exactly:
   `- <YYYY-MM-DD>: <lesson>`
   Use today's date. Keep it to one line. Do not edit, reorder, or rewrite any existing entries or the instruction prose above the entries region.
4. Confirm to the user the exact line you added.

Dedup and pruning are `/karpathy audit`'s job, not this command's.
