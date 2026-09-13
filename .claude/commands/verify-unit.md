Run the build-unit verification checks below. This command is **report-only** — do not fix, edit, or stage anything, no matter what the checks find. Report your findings after running all three checks; do not stop early on the first failure.

## Check 1: Typecheck

Run:

```bash
npx tsc --noEmit
```

Report whether it exits 0. If it does not, list every type error reported (file, line, message).

## Check 2: Tests

Run:

```bash
npm test
```

Report the pass count and fail count. If any tests failed, list each failure's test name and failure message.

## Check 3: Diff scope

Run:

```bash
git diff --name-only
```

List every modified file. Compare this list against the expected scope of the current build unit (the unit currently being worked per `BUILD_SEQUENCE.md`, and the ownership boundaries in `CLAUDE.md`'s two-session architecture — e.g. a server-logic-session unit should not touch `migrations/` or `types/`, a schema-session unit should not touch `src/db/`). Flag any file outside that expected scope.

If you cannot confidently determine the current build unit's expected scope, say so explicitly rather than guessing, and still list the modified files for the user to judge.

## Verdict

End your report with exactly one of:

- `UNIT VERIFIED` — if Check 1 exits 0, Check 2 has zero failures, and Check 3 found no files outside expected scope.
- `UNIT FAILED` — followed by the specific check(s) that failed and why, if any of the above is not true.
