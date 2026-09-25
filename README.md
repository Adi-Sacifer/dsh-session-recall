# dsh-session-recall — let an agent read its other conversations

A small, dependency-free tool that lets an AI agent **go and look at a different conversation**
when a task is split across two of them — without pulling either transcript into its context.

```
scripts/sess.js    ~14 KB, plain Node, no packages
```

**[中文说明 / Chinese README](README.zh-CN.md)**

---

## The problem

Work gets split across conversations. Conversation A does the research, conversation B does the
build, and neither can see the other. Ask "what did we decide in the other window?" and the only
honest answers are *"I don't know"* or *"paste it here"* — the second of which costs a whole
transcript in context.

This gives the agent a third answer: **go and read it, on demand, and bring back only the lines
that matter.**

```
$ sess.js timeline "release checklist"
=== release checklist   263 messages, 09-25 11:25 -> 09-25 13:04
  09-25 11:25 [2]  let's verify the new build path end to end
  09-25 11:32 [26] the overlay should fade by itself once the run ends
  09-25 11:41 [56] open the accelerator, then find the editor app
  ...
```

Three conversations, 6 MB and 655 messages on disk — a search reads a few snippets and nothing
else.

## Default scope is the current conversation

Cross-conversation reading is **opt-in, by design**:

| Allowed without asking | Requires the user to have asked |
|---|---|
| `whoami`, `list`, `turns`, `grep <t>` | `grep <t> --all`, `list --all` |
| `read` / `timeline` / `tools` on **this** conversation | `read` / `timeline` / `tools` naming **another** conversation |

`list` on its own will not even print the titles of other conversations — it reports how many
exist and stops. Browsing someone's other chats to "get context" is exactly the behaviour this
tool is built not to turn into, and the agent-facing `SKILL.md` says so in its first section.

## Commands

| Command | What it gives you |
|---|---|
| `whoami` | which conversation this is (id, title, file, last update) |
| `list [--all]` | conversation index: id, message count, last update, title |
| `turns [N]` | last N messages of this conversation |
| `grep <term> [N] [--all]` | search with a snippet per hit; `--all` opts into the other conversations |
| `read <target> [N]` | read a conversation's messages |
| `tools <target> [N]` | the tool calls it actually made — what it really touched |
| `timeline <target>` | one line per human turn: the spine of what it was about |
| `msg <target> <n>` | full text of message #n, using the indices `timeline` prints |

Add `--raw` to include the harness's own injected messages (runtime context, skill catalog,
background-job notices). They are filtered out by default because in a long session they
outnumber the real turns and make a timeline unreadable.

## Requirements

**Node 22+.** That is the whole list. No packages, no build, no install.

## The interesting part: the transcript format

If you want to read these files yourself, this is what costs you an afternoon otherwise.

```
~/.dsh/sessions/<workspace>/<session-id>/session.v4.jsonl.zstd   the transcript
~/.dsh/storages/workspace.json                                   the session index
~/.dsh/storages/session_projcache/sessions/<session-id>.json      title, token totals
```

**The `.zstd` file is not one compressed stream.** It is an append-only log of roughly **1500
independent zstd frames**, one per flush. Both `zstdDecompressSync()` and the streaming
`createZstdDecompress()` stop after the first frame and hand back **252 bytes** — which looks
exactly like an empty transcript, and sends you looking for a bug in entirely the wrong place.

Reading it means walking the frame magic `28 B5 2F FD`, inflating each frame between boundaries
and concatenating. A frame body can contain those bytes by chance, so a frame that fails to
inflate is merged forward until it decodes. A trailing partial frame is normal in a live session
and is skipped. Measured on a real 2 MB session: **1552 frames, 0 failures, 7 MB of JSONL, 2416
records.**

Node 22+ ships zstd in `zlib`, which is why this needs no dependencies at all.

Records are JSONL. The shape worth knowing:

| Record | Where the text is |
|---|---|
| `user/message` | `data.content[]` entries with `type === "text"`; `data.source.kind` says whether it was really the human (`user`), an approval change (`user-approval`), or harness boilerplate (`runtime-context`, `skill-catalog`, `tool-jobs`) |
| `assistant/message` | `data.message.content[]` entries with `type === "text"` — **reasoning blocks sit in the same array**, so filtering by `type` matters |
| `tool/call` | `data.name` + `data.arguments` |

## Using it as an agent skill

`SKILL.md` carries the front-matter and the scope rules and is written to be loaded straight into
an agent's context. Drop `SKILL.md` plus `scripts/` into your agent's skill directory.

### Portability

The front-matter is the open **Agent Skills** format — `name` plus `description` — which Claude
Code, Codex and DSH all read. **The `description` field is the routing contract:** it is what the
agent sees before deciding whether to load the skill at all, so it is written to say both when
this applies and when it does not. Dropping the front-matter does not make the skill "simpler",
it makes it invisible.

What travels between hosts is the format and the instructions. What may not travel is whatever a
skill shells out to. This one is plain Node with no packages, so it runs anywhere Node 22+ does;
a skill that assumes `bash`, macOS paths, or a specific host's built-in tools will not.

## Limits

- Only conversations that still exist on disk.
- The last few frames of a conversation happening *right now* may not be flushed yet, so it can
  lag by a message or two.
- It reads the transcript format as measured on one version of the host app. If the format
  changes, `readRecords()` is the one function to fix.

## License

MIT — see [LICENSE](LICENSE).
