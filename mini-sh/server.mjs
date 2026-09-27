// Minimal stdio MCP server exposing one shell tool with a tiny schema.
//
// This is the whole tool surface of the `sh` preset. It costs ~0 tokens in the
// context window, because the schema is three lines long.
//
// Runs on Node 18+ or Bun. No dependencies, no build step.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const SHELL = process.env.CLAUDECUT_SHELL || "zsh";
// Where every command starts. Inherited from wherever claudecut was launched,
// which is the repository you are working in; nothing about any project is
// hardcoded. Passing it to the shell explicitly makes it a guarantee, and
// naming it in the tool description below is what lets the model stop writing
// `cd /long/absolute/path &&` in front of every command: the path is then paid
// once in the schema instead of once per call.
const CWD = process.env.CLAUDECUT_CWD || process.cwd();
const TIMEOUT_MS = Number(process.env.CLAUDECUT_SH_TIMEOUT_MS || 600000);
const MAX_OUTPUT = Number(process.env.CLAUDECUT_SH_MAX_OUTPUT || 60000);
// How long `exit` waits for the pipes to drain before answering without `close`.
const FLUSH_GRACE_MS = Number(process.env.CLAUDECUT_SH_FLUSH_GRACE_MS || 200);

// What runs before every command. Each line is here because a measured session
// paid for its absence, and none of it costs a context token: the model never
// sees this string, it only sees the tool description below.
//
// The shell quirks come first, because they cost whole round trips. zsh aborts a
// command when an unquoted glob matches nothing (`grep --include=*.ts` -> "no
// matches found") and expands a leading `=` as a filename (`echo === x ===` ->
// "=== not found"); macOS ships no `timeout`, so a `timeout 120 cmd` is a
// command-not-found rather than a limit. The setopts are zsh-only and silently
// ignored elsewhere; the shim defines `timeout` only when the real one is
// absent, and alarm(2) gives it the same semantics rather than quietly dropping
// the limit.
//
// The color and pager variables are the same kind of saving, paid in context
// rather than round trips: one measured session carried 26k characters of ANSI
// escapes and box-drawing rules through every later request, which re-read them
// ~790k times in total. Nothing reads color out of a JSON-RPC pipe anyway.
const PRELUDE_QUIRKS =
  'setopt NO_NOMATCH NO_EQUALS 2>/dev/null; ' +
  'export NO_COLOR=1 FORCE_COLOR=0 CLICOLOR=0 GIT_PAGER=cat PAGER=cat; ' +
  'command -v timeout >/dev/null 2>&1 || ' +
  'timeout() { perl -e \'alarm shift; exec @ARGV\' "$@"; }; ';

// `bun run` echoes `$ <command>` before every script, and that echo goes to
// **stderr**. Any command that merges the streams before a parser — the shape
// an agent writes constantly, `cmd 2>&1 | awk ...` — hands the parser that line
// as record 1. Seen in a live session: a `--tsv` query piped into an `awk` that
// built its column map from `NR==1` read the header out of
// `$ bun scripts/prod.ts ...`, found no `id` column, and died with
// `awk: illegal field $(), name "id"`. A whole round trip lost and retried.
//
// `--silent` removes it. Measured on bun 1.3.14 against a script that prints to
// stdout and exits 3: `--silent` drops bun's `$ ...` line and its
// `error: script "x" exited with code 3` line, keeps the script's own output
// verbatim, and still exits 3. Dropping that second line is why the `[exit N]`
// note further down has to be unconditional — with the wrapper on, it is the
// only place a failed script still shows.
//
// Only `bun run` is wrapped, and only when bun is present. `command bun` is
// what stops the function recursing into itself.
const PRELUDE_BUN =
  'if command -v bun >/dev/null 2>&1; then ' +
  'bun() { if [ "$1" = run ]; then shift; command bun run --silent "$@"; ' +
  'else command bun "$@"; fi; }; fi; ';

// Two navigation helpers, because the measured sessions spend round trips
// hand-rolling them. Across 94 signal-forge sessions and 14,528 calls: 302
// calls grep for a declaration, 263 pass `-A`/`-B` to get its body, and 220 are
// the pair where one call's grep locates a file and the next one reads it. 686
// read a slice with `sed -n RANGEp`, and 128 of those are a second slice of a
// file the previous call already opened at the wrong range.
//
// A helper that misfires is worse than the grep it replaces, because a wrong
// answer costs the round trip it was meant to save. So `def` is deliberately
// conservative in three ways. It excludes data files by extension — the first
// version matched `collector` inside a 100 MB `.jsonl` transcript under
// `bench/` and returned it. It drops any line of 400 characters or more, since
// a declaration is short and a data blob is not. And it requires the keyword to
// sit immediately before the symbol, so `const output = collector();` is not
// reported as the declaration of `collector`; the looser search runs only when
// the exact one finds nothing, and says so on stderr. It prefers missing a
// declaration to inventing one, and says `-- grep it` when it misses.
//
// Defined with `if ! command -v`, not `||`, so the definition is not the right
// operand of a list: that form is a syntax error in some bash builds, and
// CLAUDECUT_SHELL is not always zsh. The guard also means a shell profile that
// already defines `def` or `peek` keeps its own, the same discipline as the
// `timeout` shim above.
const PRELUDE_NAV = `
if ! command -v def >/dev/null 2>&1; then
def() {
  if [ $# -lt 1 ]; then echo "usage: def <symbol> [lines]" >&2; return 2; fi
  sym=$1; n=\${2:-40}
  _def_grep() {
    grep -rnwI \
      --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build \
      --exclude-dir=.next --exclude-dir=vendor --exclude-dir=target --exclude-dir=.venv \
      --exclude-dir=coverage --exclude-dir=.claude \
      --exclude=\\*.json --exclude=\\*.jsonl --exclude=\\*.ndjson --exclude=\\*.lock \
      --exclude=\\*.map --exclude=\\*.min.js --exclude=\\*.csv --exclude=\\*.tsv --exclude=\\*.svg \
      -- "$sym" . 2>/dev/null | awk 'length($0) < 400' | grep -E "$1" | head -5
  }
  _def_kw='(function|class|const|let|var|type|interface|enum|struct|trait|impl|def|fn|module|record)'
  hits=$(_def_grep ":[0-9]+:.*\${_def_kw}[[:space:]]+(async[[:space:]]+)?[*]?\${sym}([^A-Za-z0-9_]|$)")
  if [ -z "$hits" ]; then
    hits=$(_def_grep ":[0-9]+:.*\${_def_kw}[^A-Za-z0-9_]")
    if [ -n "$hits" ]; then echo "def: no exact declaration of \\\`$sym\\\`; loose matches below" >&2; fi
  fi
  unset -f _def_grep
  if [ -z "$hits" ]; then echo "def: no declaration of \\\`$sym\\\` found -- grep it" >&2; return 1; fi
  printf '%s\\n' "$hits" | while IFS=: read -r file lineno rest; do
    printf '\\n==== %s:%s\\n' "$file" "$lineno"
    sed -n "\${lineno},$((lineno + n - 1))p" "$file"
  done
}
fi
if ! command -v peek >/dev/null 2>&1; then
peek() {
  if [ $# -lt 1 ]; then echo "usage: peek <file>:<line> [lines]" >&2; return 2; fi
  spec=$1; n=\${2:-30}
  file=\${spec%%:*}; lineno=\${spec#*:}
  case $lineno in ''|*[!0-9]*) lineno=1 ;; esac
  start=$((lineno - n / 2))
  if [ "$start" -lt 1 ]; then start=1; fi
  printf '==== %s:%s (lines %s-%s)\\n' "$file" "$lineno" "$start" "$((start + n - 1))"
  sed -n "\${start},$((start + n - 1))p" "$file"
}
fi
`;

const PRELUDE =
  process.env.CLAUDECUT_SH_PRELUDE ??
  PRELUDE_QUIRKS + PRELUDE_BUN + PRELUDE_NAV;

// Keep both ends of a long output. The head usually says what ran, the tail
// says how it went; dropping either silently is how a truncated result gets
// mistaken for the whole story.
//
// Both ends are kept as the output arrives, because the first version buffered
// a head-bounded prefix and only then took a head and a tail of *that*: past
// the buffer bound it returned the middle of the output as its tail and
// understated what it had dropped, which is the failure the paragraph above
// says it exists to prevent. Memory is bounded by what is returned, not by a
// multiple of it.
const HALF = Math.max(1, Math.floor(MAX_OUTPUT / 2));

const collector = () => {
  let head = "";
  let tail = "";
  let dropped = 0;
  return {
    take(chunk) {
      if (head.length < HALF) {
        const room = HALF - head.length;
        head += chunk.slice(0, room);
        chunk = chunk.slice(room);
        if (chunk === "") return;
      }
      tail += chunk;
      if (tail.length > HALF) {
        dropped += tail.length - HALF;
        tail = tail.slice(-HALF);
      }
    },
    text() {
      if (dropped === 0) return head + tail;
      return (
        head +
        `\n\n[... ${dropped.toLocaleString("en-US")} characters truncated ...]\n\n` +
        tail
      );
    },
  };
};

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

const tool = {
  name: "sh",
  description:
    `Run a shell command; returns stdout+stderr. Every call starts in ${CWD}, ` +
    "so no cd is needed. Each call is a separate round trip that re-reads the " +
    "whole context, so put independent steps in one call with && or ;. " +
    "Two helpers save the locate-then-read pair: `def <symbol> [lines]` prints a " +
    "declaration and its body from anywhere in the tree, `peek <file>:<line> " +
    "[lines]` prints a window around a line.",
  inputSchema: {
    type: "object",
    properties: { cmd: { type: "string" } },
    required: ["cmd"],
  },
};

createInterface({ input: process.stdin }).on("line", (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return; // Not our business; the transport will resend or fail loudly.
  }
  if (req.id === undefined) return; // Notification, no reply expected.

  const reply = (result) => send({ jsonrpc: "2.0", id: req.id, result });

  switch (req.method) {
    case "initialize":
      return reply({
        protocolVersion: req.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "sh", version: "1" },
      });

    case "tools/list":
      return reply({ tools: [tool] });

    case "tools/call": {
      // A server with one tool cannot afford to die on a bad frame: the session
      // keeps running and has nothing left to run commands with. Answer the
      // error instead.
      const cmd = req.params?.arguments?.cmd;
      if (typeof cmd !== "string") {
        return send({
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32602, message: "invalid params: cmd must be a string" },
        });
      }

      // Asynchronous on purpose. The first version used spawnSync, which
      // serialised the whole server: a `sleep 240` left every later call
      // queued behind it, and in one measured session six calls — including a
      // bare `echo ping` — sat for 120s until the client gave up on them and
      // moved them to the background. Nothing about running a command needs
      // the event loop held.
      // `detached` puts the command in its own process group, so the timeout
      // below can kill the whole pipeline. Without it only the shell dies and
      // `cmd | tail` leaves `cmd` running.
      const child = spawn(SHELL, ["-lc", PRELUDE + cmd], {
        cwd: CWD,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });

      const output = collector();
      let killedByTimeout = false;
      let done = false;
      child.stdout.on("data", (c) => output.take(String(c)));
      child.stderr.on("data", (c) => output.take(String(c)));

      const timer = setTimeout(() => {
        killedByTimeout = true;
        // Negative pid is the process group. It can be gone already between the
        // timer firing and the signal, which is not an error worth reporting.
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, TIMEOUT_MS);

      const finish = (status, signal, error) => {
        if (done) return; // 'error' and 'close' can both fire.
        done = true;
        clearTimeout(timer);
        const notes = [];
        if (killedByTimeout) notes.push(`[timed out after ${TIMEOUT_MS}ms]`);
        else if (error) notes.push(`[failed to run: ${error.message}]`);
        if (signal && !killedByTimeout) notes.push(`[killed by ${signal}]`);
        if (status) notes.push(`[exit ${status}]`);
        const text = output.text() + (notes.length ? `\n${notes.join(" ")}` : "");
        // A command's own exit status is data, not a failed call. It is carried
        // losslessly by the `[exit N]` note above, which is why that note is
        // unconditional — with the `bun run --silent` wrapper on, it is the only
        // place a failed script still shows. Reporting it as `isError` too made
        // the client paint ordinary results red: a `grep` with no match exits 1,
        // and in one measured session 2 of 146 calls were flagged that way with
        // nothing wrong in them, which is a nudge to re-run a command that
        // already answered. Only a call that did not run to completion — a
        // timeout, or a shell that could not be spawned — is an error here.
        reply({
          content: [{ type: "text", text: text || "(no output)" }],
          isError: killedByTimeout || Boolean(error),
        });
      };

      child.on("error", (e) => finish(null, null, e));
      // `close` is the good path: it waits for the pipes, so no output is lost.
      // But a process that outlived the shell holds those pipes open and `close`
      // then never fires at all, which is a call that is never answered rather
      // than one that reports a timeout. `exit` always fires, so it answers
      // after a short grace period for the flush; whichever lands first wins.
      child.on("close", (status, signal) => finish(status, signal, null));
      child.on("exit", (status, signal) => {
        setTimeout(() => finish(status, signal, null), FLUSH_GRACE_MS);
      });
      return;
    }

    default:
      return send({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32601, message: "method not found" },
      });
  }
});
