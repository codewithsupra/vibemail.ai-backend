# VibeMail Engine — Atomic Build Sequence

Each unit below must be verified before moving to the next.

1. **Provider abstraction interface** — defines the data-access/provider contract the rest of the system builds against. *Verified:* TypeScript compiles clean and the interface defines all required methods.
2. **Gmail OAuth layer with token persistence listener** — handles the OAuth exchange and persists Google tokens. *Verified:* OAuth completes, tokens are stored, refresh works without mismatch.
3. **Sync and read layer** — performs the initial message sync and read-state handling. *Verified:* initial sync fetches 50 messages and objects match the contract model.
4. **Pub/Sub webhook receiver** — handles incoming Gmail push notifications. *Verified:* a notification fetches the correct delta through history ID.
5. **Send layer** — sends messages through Gmail on behalf of an authenticated user. *Verified:* a message sends successfully through Gmail for an authenticated user.
6. **Vercel API function entry points** — exposes the four core endpoints. *Verified:* all four endpoints respond correctly in local preview.
7. **Integration tests** — exercises the full system end to end. *Verified:* the full suite passes with no skipped tests against live Supabase.
