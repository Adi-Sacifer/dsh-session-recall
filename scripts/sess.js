#!/usr/bin/env node
'use strict';
/*
 * session-recall - read and search DSH conversation transcripts on demand.
 *
 * WHY THIS EXISTS
 * When a task is split across two conversations there is no way to connect their progress: each
 * conversation only sees itself. This tool lets the agent go and LOOK, so the answer to "what did
 * we decide in the other window?" costs a few hundred bytes of context instead of a transcript.
 *
 * DEFAULT SCOPE IS THE CURRENT CONVERSATION.
 * Cross-conversation reading is deliberately opt-in: it happens only when the command carries
 * --all, or when it names another conversation explicitly. Poking around someone's other chats
 * uninvited is not a default. (The user asked for exactly this boundary.)
 *
 * HOW THE DATA IS STORED  (measured, not guessed)
 *   ~/.dsh/sessions/<workspace>/<session-id>/session.v4.jsonl.zstd   the transcript
 *   ~/.dsh/storages/workspace.json                                   the session index
 *   ~/.dsh/storages/session_projcache/sessions/<session-id>.json      titles and usage totals
 *
 * The ".zstd" file is NOT one compressed stream. It is an append-only log of ~1500 INDEPENDENT
 * zstd frames - one per flush. Both zstdDecompressSync() and the streaming API stop after the
 * first frame, which yields a misleading 252 bytes that looks like an empty transcript. The only
 * way in is to walk the frame magic 28 B5 2F FD, inflate each frame between boundaries, and
 * concatenate. A frame body can in principle contain those bytes, so a frame that fails to
 * inflate is merged forward until it decodes.
 *
 * Node 22+ ships zstd in zlib, so this needs no dependencies at all.
 */

const fs = require('fs');
const z = require('zlib');
const path = require('path');
const os = require('os');

const DSH = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const SESS_ROOT = path.join(DSH, 'sessions');
const PROJ_CACHE = path.join(DSH, 'storages', 'session_projcache', 'sessions');
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/* ------------------------------------------------------------------ storage */

function frameOffsets(buf) {
  const offs = [];
  for (let i = 0; i < buf.length - 3; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) offs.push(i);
  }
  offs.push(buf.length);
  return offs;
}

function readRecords(file) {
  const buf = fs.readFileSync(file);
  const offs = frameOffsets(buf);
  const parts = [];
  for (let k = 0; k < offs.length - 1; k++) {
    try { parts.push(z.zstdDecompressSync(buf.subarray(offs[k], offs[k + 1]))); continue; } catch (e) { /* merged below */ }
    let done = false;
    for (let j = k + 2; j < offs.length; j++) {
      try { parts.push(z.zstdDecompressSync(buf.subarray(offs[k], offs[j]))); k = j - 1; done = true; break; } catch (e) { }
    }
    // A trailing partial frame is normal while a session is live; skipping it is correct, not an error.
    if (!done) continue;
  }
  const out = [];
  for (const line of Buffer.concat(parts).toString('utf8').split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch (e) { }
  }
  return out;
}

function allSessions() {
  const list = [];
  if (!fs.existsSync(SESS_ROOT)) return list;
  for (const ws of fs.readdirSync(SESS_ROOT)) {
    const wsp = path.join(SESS_ROOT, ws);
    let dirs = [];
    try { dirs = fs.readdirSync(wsp); } catch (e) { continue; }
    for (const dir of dirs) {
      const f = path.join(wsp, dir, 'session.v4.jsonl.zstd');
      if (!fs.existsSync(f)) continue;
      const st = fs.statSync(f);
      list.push({ id: dir, ws, file: f, size: st.size, mtime: st.mtimeMs });
    }
  }
  list.sort((a, b) => b.mtime - a.mtime);
  return list;
}

function titleOf(id) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(PROJ_CACHE, id + '.json'), 'utf8'));
    const t = j && j.record && j.record.rows && j.record.rows.title;
    if (t && typeof t.val === 'string' && t.val.trim()) return t.val.trim();
  } catch (e) { }
  return null;
}

/* ------------------------------------------------------------------ records */

// The visible conversation only. Reasoning blocks and tool-call arguments sit in the same
// content arrays; pulling those in would both bloat the output and leak private thinking.
//
// The transcript also records SYSTEM injections as user messages, and they outnumber the real
// ones in a long session. data.source.kind separates them:
//   user            - something the human actually typed
//   user-approval   - a policy change the human made; keep, it changes what was allowed
//   runtime-context, skill-catalog, tool-jobs - boilerplate the harness injects; dropped
//     by default, because a timeline full of "Current runtime context..." is unreadable.
const NOISE = new Set(['runtime-context', 'skill-catalog', 'tool-jobs']);

function dialogue(records, raw) {
  const out = [];
  for (const r of records) {
    if (!r || !r.type) continue;
    let blocks = null, role = null, kind = null;
    if (r.type === 'user/message') {
      blocks = r.data && r.data.content; role = 'USER';
      kind = (r.data && r.data.source && r.data.source.kind) || 'user';
      if (!raw && NOISE.has(kind)) continue;
    } else if (r.type === 'assistant/message') {
      blocks = r.data && r.data.message && r.data.message.content; role = 'BOT ';
    } else continue;
    if (!Array.isArray(blocks)) continue;
    const text = blocks.filter(b => b && b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text).join('\n').trim();
    if (text) out.push({ role, text, at: r.time || 0, kind });
  }
  return out;
}

// Tool calls are how a task's real footprint shows up ("what did it actually touch").
function toolCalls(records) {
  const out = [];
  for (const r of records) {
    if (r && r.type === 'tool/call' && r.data && r.data.name) {
      let arg = r.data.arguments || '';
      try { const o = JSON.parse(arg); arg = o.command || o.path || o.name || o.text || JSON.stringify(o); } catch (e) { }
      out.push({ name: r.data.name, arg: String(arg).replace(/\s+/g, ' ').slice(0, 110), at: r.time || 0 });
    }
  }
  return out;
}

function clip(s, n) {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function when(ms) {
  if (!ms) return '        ';
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ------------------------------------------------------------------ resolve */

function currentId() {
  const e = process.env.DSH_SESSION_ID;
  if (e) return e;
  const all = allSessions();
  return all.length ? all[0].id : null;
}

// An explicit target may be a full id, an id fragment, or part of a title.
function resolve(target) {
  const all = allSessions();
  if (!target) {
    const id = currentId();
    const s = all.find(x => x.id === id);
    if (!s) fail(`current session ${id} not found on disk`);
    return s;
  }
  let m = all.filter(x => x.id === target);
  if (!m.length) m = all.filter(x => x.id.includes(target));
  if (!m.length) m = all.filter(x => (titleOf(x.id) || '').toLowerCase().includes(String(target).toLowerCase()));
  if (!m.length) fail(`no conversation matches "${target}"  (try: list --all)`);
  if (m.length > 1) {
    process.stderr.write(`ambiguous "${target}", matches:\n` + m.map(x => `  ${x.id}  ${titleOf(x.id) || ''}\n`).join(''));
    fail('be more specific');
  }
  return m[0];
}

function fail(msg) { process.stderr.write('session-recall: ' + msg + '\n'); process.exit(1); }

/* ------------------------------------------------------------------ commands */

const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => a.startsWith('--')));
const pos = argv.filter(a => !a.startsWith('--'));
const cmd = pos[0] || 'help';
const ALL = flags.has('--all');
const RAW = flags.has('--raw');

function cmdList() {
  const all = allSessions();
  const me = currentId();
  const show = ALL ? all : all.filter(s => s.id === me);
  for (const s of show) {
    let n = 0;
    try { n = dialogue(readRecords(s.file), RAW).length; } catch (e) { }
    const mark = s.id === me ? '*' : ' ';
    console.log(`${mark} ${s.id}  msgs=${String(n).padStart(4)}  ${when(s.mtime)}  ${titleOf(s.id) || '(untitled)'}`);
  }
  if (!ALL) {
    const others = all.length - show.length;
    console.log(`\n(showing the current conversation only. ${others} other conversation(s) on disk` +
      ` - pass --all, or ask the user before reading them.)`);
  }
}

function cmdWhoami() {
  const s = resolve(null);
  console.log(`id    : ${s.id}`);
  console.log(`title : ${titleOf(s.id) || '(untitled)'}`);
  console.log(`file  : ${s.file}`);
  console.log(`updated: ${when(s.mtime)}`);
}

function cmdTurns() {
  const n = parseInt(pos[1] || '12', 10);
  const s = resolve(null);            // always this conversation; there is no cross-session form
  const d = dialogue(readRecords(s.file), RAW);
  console.log(`=== ${titleOf(s.id) || s.id}  (last ${n} of ${d.length} messages)`);
  for (const m of d.slice(-n)) console.log(`  ${m.role} ${when(m.at)}  ${clip(m.text, 220)}`);
}

function cmdGrep() {
  const term = pos[1];
  const n = parseInt(pos[2] || '6', 10);
  if (!term) fail('grep needs a search term');
  const re = new RegExp(term, 'i');
  const me = currentId();
  const targets = ALL ? allSessions() : allSessions().filter(s => s.id === me);
  if (!ALL && targets.length === 0) fail('current conversation not found on disk');
  let shown = 0;
  for (const s of targets) {
    let d = [];
    try { d = dialogue(readRecords(s.file), RAW); } catch (e) { continue; }
    // 1-based, matching timeline/turns, so that "#n" printed by a grep can be fed straight to `msg n`
    const hits = d.map((m, i) => ({ m, i: i + 1 })).filter(x => re.test(x.m.text));
    if (!hits.length) continue;
    console.log(`\n=== ${titleOf(s.id) || s.id}   [${s.id}]   hits=${hits.length}`);
    for (const h of hits.slice(0, n)) {
      const k = h.m.text.search(re);
      const a = Math.max(0, k - 70), b = Math.min(h.m.text.length, k + 170);
      console.log(`  ${h.m.role} ${when(h.m.at)} #${h.i}  …${h.m.text.slice(a, b).replace(/\n/g, ' ')}…`);
      shown++;
    }
    if (hits.length > n) console.log(`  … ${hits.length - n} more in this conversation`);
  }
  if (!shown) console.log(`no match for "${term}" in ${ALL ? 'any conversation' : 'this conversation'}` +
    (ALL ? '' : '  (pass --all to search the others, but ask the user first)'));
}

// read / tools / timeline all take an optional target. A bare number is always a count, so
// "read 20" means "20 messages of THIS conversation" and not a conversation called 20.
function targetAndCount(defCount) {
  const t = pos[1];
  if (t === undefined || /^\d+$/.test(t)) {
    return { target: null, n: parseInt(t === undefined ? String(defCount) : t, 10) };
  }
  return { target: t, n: parseInt(pos[2] || String(defCount), 10) };
}

function cmdRead() {
  const { target, n } = targetAndCount(30);
  const s = resolve(target);
  const recs = readRecords(s.file);
  const d = dialogue(recs, RAW);
  const tc = toolCalls(recs);
  console.log(`=== ${titleOf(s.id) || s.id}   [${s.id}]`);
  console.log(`messages=${d.length}  toolCalls=${tc.length}  updated=${when(s.mtime)}\n`);
  for (const m of d.slice(-n)) {
    console.log(`--- ${m.role} ${when(m.at)}`);
    console.log(m.text.length > 900 ? m.text.slice(0, 900) + '\n…[truncated]' : m.text);
    console.log('');
  }
}

function cmdTools() {
  const { target, n } = targetAndCount(40);
  const s = resolve(target);
  const tc = toolCalls(readRecords(s.file));
  console.log(`=== ${titleOf(s.id) || s.id}   tool calls=${tc.length} (last ${n})`);
  for (const t of tc.slice(-n)) console.log(`  ${when(t.at)}  ${t.name.padEnd(14)} ${t.arg}`);
}

function cmdTimeline() {
  const { target } = targetAndCount(0);
  const s = resolve(target);
  const d = dialogue(readRecords(s.file), RAW);
  console.log(`=== ${titleOf(s.id) || s.id}   ${d.length} messages, ${when(d.length ? d[0].at : 0)} -> ${when(s.mtime)}`);
  // one line per user turn, which is the spine of what the conversation was actually about
  let idx = 0;
  for (const m of d) {
    idx++;
    if (m.role === 'USER') console.log(`  ${when(m.at)} [${idx}] ${clip(m.text, 200)}`);
  }
}

// Full text of one message, by the index that timeline/turns print. The snippets grep returns
// are deliberately short; when a specific message is the thing you actually need, read it whole.
function cmdMsg() {
  const { target } = targetAndCount(0);
  const want = parseInt(pos[2] !== undefined && !/^\d+$/.test(pos[1]) ? pos[2] : pos[1], 10);
  if (!Number.isFinite(want)) fail('msg needs a message index (see timeline)');
  const s = resolve(target);
  const d = dialogue(readRecords(s.file), RAW);
  const m = d[want - 1];
  if (!m) fail(`this conversation has ${d.length} messages; #${want} is out of range`);
  console.log(`=== ${titleOf(s.id) || s.id}   message #${want} of ${d.length}   ${m.role} ${when(m.at)}`);
  console.log('');
  console.log(m.text);
}

const cmds = {
  help: () => {
    console.log(`session-recall - read DSH conversations without loading them into context

  whoami                      which conversation this is
  list [--all]                conversation index (default: this one only)
  turns [N]                   last N messages of this conversation
  grep <term> [N] [--all]     search; default scope is THIS conversation
  read <target> [N]           read a conversation (target = id / id fragment / title fragment)
  tools <target> [N]          what tool calls that conversation actually made
  timeline <target>           one line per user turn - the spine of the conversation
  msg <target> <n>            full text of message #n (indices come from timeline/turns)

  --all opts into cross-conversation search. Only use it when the user asks for it.`);
  },
  whoami: cmdWhoami,
  list: cmdList,
  turns: cmdTurns,
  grep: cmdGrep,
  read: cmdRead,
  tools: cmdTools,
  timeline: cmdTimeline,
  msg: cmdMsg,
};

(cmds[cmd] || cmds.help)();
