---
name: session-recall
description: Read and search this agent's other conversations on demand - find what was decided in a different window, recover detail that compaction dropped, or check what an earlier session actually changed, without loading a whole transcript into context. Use when work is split across conversations, when earlier context is missing, or when the user refers to something discussed elsewhere. Cross-conversation reading happens only when the user asks for it in that turn; default scope is the current conversation.
---
# Session recall (read other DSH conversations on demand)

> **Public release note.** This is the field-notes file the skill ships with. Conversation
> titles, account-specific paths and provider names used as examples have been replaced with
> generic ones; the measured findings are kept as they were recorded.

When a task gets split across two conversations, neither one can see the other. This skill lets
you go and **look** — so "what did we decide in the other window?" costs a few hundred bytes of
context instead of a whole transcript.

## The rule about scope — read this first

**Default scope is the current conversation. Nothing else.**

Cross-conversation reading happens **only** when the user asks for it, in words, in that turn.
Concretely:

| Allowed without asking | Requires the user to have asked |
|---|---|
| `whoami`, `list`, `turns`, `grep <t>` | `grep <t> --all`, `list --all` |
| `read` / `timeline` / `tools` on **this** conversation | `read` / `timeline` / `tools` naming **another** conversation |

Say what you are about to do before you do it ("I'll search the other conversations for X"), and
report which conversations you read. Do not browse the user's other chats to "get context" —
that is exactly the thing this skill is designed not to turn into. If a task seems to need
another conversation and the user has not offered, **ask**.

## Running it

```powershell
node scripts/sess.js <command>
```

Any **Node 22+** works — that is the only requirement, and there are no packages to install.
If your agent runtime bundles its own Node, point at that binary instead; the script does not
care where it runs from.

## Commands

| Command | What it gives you |
|---|---|
| `whoami` | which conversation this is (id, title, file, last update) |
| `list [--all]` | conversation index: id, message count, last update, title |
| `turns [N]` | last N messages of **this** conversation (default 12) |
| `grep <term> [N] [--all]` | search, with a snippet per hit. Default: this conversation only. `--all` opts into the rest |
| `read <target> [N]` | read a conversation's messages (default last 30, long ones truncated) |
| `tools <target> [N]` | the tool calls it actually made — what it really touched |
| `timeline <target>` | one line per human turn: the spine of what that conversation was about |

`<target>` is a session id, an id fragment, or part of the title (e.g. `"release checklist"`).

Add `--raw` to include the harness's own injected messages (runtime context, skill catalog,
background-job notices). They are filtered out by default because they outnumber real turns and
make a timeline unreadable.

## Recipes

**"Catch me up on the other window"** — the cheapest useful thing to run:
```powershell
& $node $sr timeline "release checklist"
```

**"Did we settle X over there?"**
```powershell
& $node $sr grep "migration" 5 --all
```

**"What did that task actually change on disk?"**
```powershell
& $node $sr tools "api redesign" 30
```

**Combining two conversations.** Read the timelines of both, then work from the lines — do not
read both transcripts in full. The point is to pull the two spines into one place, not to merge
two contexts.

## How the data is stored (do not rediscover this the hard way)

```
~/.dsh/sessions/<workspace>/<session-id>/session.v4.jsonl.zstd   the transcript
~/.dsh/storages/workspace.json                                   session index per workspace
~/.dsh/storages/session_projcache/sessions/<session-id>.json      title, token totals, sandbox mode
```

`$env:DSH_SESSION_ID` names the current conversation, which is how the default scope is resolved.

**The `.zstd` file is not one compressed stream.** It is an append-only log of roughly 1500
independent zstd frames, one per flush. Both `zstdDecompressSync()` and the streaming
`createZstdDecompress()` stop after the first frame and hand back **252 bytes**, which looks
exactly like an empty transcript. Reading it means walking the frame magic `28 B5 2F FD`,
inflating each frame between boundaries and concatenating. A frame body can contain those bytes by
chance, so a frame that fails to inflate is merged forward until it decodes. A trailing partial
frame is normal in a live session and is skipped.

Records are JSONL. The types worth knowing:

| Record | Where the text is |
|---|---|
| `user/message` | `data.content[]` entries with `type === "text"`; `data.source.kind` says whether it was really the human (`user`), an approval change (`user-approval`), or harness boilerplate (`runtime-context`, `skill-catalog`, `tool-jobs`) |
| `assistant/message` | `data.message.content[]` entries with `type === "text"` — **reasoning blocks sit in the same array**, so filtering by `type` matters |
| `tool/call` | `data.name` + `data.arguments` (JSON string) |

Measured on a real 2 MB session: 1552 frames, 0 failures, 7 MB of JSONL, 2416 records.

## Limits

- Only conversations that still exist on disk. Deleting or trimming a session removes it here too.
- The last few frames of a conversation happening *right now* may not be flushed yet, so this
  conversation can lag by a message or two.
- Sessions in other workspaces are found too (`workspace.json` is only used for reference);
  `list --all` shows them all.
