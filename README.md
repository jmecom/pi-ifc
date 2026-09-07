# pi-ifc

A Pi extension port of `minimal-ifc-agent`'s useful coding agent. Local work can
use untrusted input. IFC checks happen when commits are pushed.

Requires macOS, Python 3.10+, Xcode command-line tools, and Node.js 22.19+.
Pi is pinned to 0.85.0. Your normal Pi `/login` credentials are reused;
`OPENAI_API_KEY` also works. OpenAI is the default provider; use
`-- --provider openai-codex --model MODEL` for a ChatGPT subscription login.

```sh
npm ci --ignore-scripts
npm start -- --workspace /path/to/project \
  --push-url git@github.com:you/project.git --push-branch agent-work --debug --refresh
```

The push URL and branch are fixed at launch. Destinations default to public;
add `--private-remote` to allow private data to go to a repository you trust with it.
This is your policy declaration, not a check of the repository's hosting settings.
Omit the push options to disable pushing. SSH URLs use your existing SSH keys or
agent and known hosts; interactive SSH authentication is not supported.
Pi options go after another `--`, for example `-- --continue` or `-- --model MODEL`.
Interactive and print/JSON modes are supported. Native RPC shell execution is
excluded because it bypasses Pi's extension hooks. Use `read` for files.

The workspace starts private/trusted. `read`, `write`, `edit`, and `bash` run in
`sandbox-exec`: workspace/scratch writes, Python/Git/system runtime reads, no
network. Outside `read` asks you to deny, read as untrusted, or trust that read.
Untrusted input can influence local edits and tests; it labels the conversation
and subsequent work instead of stopping them. The entire workspace shares one
conservative label.

Some tool results, such as Git server replies, stay hidden behind references.
`inspect` exposes their text and inherits their labels. `quarantined_llm_call`
processes them without tools or conversation history and returns a reference with
the inherited labels. It does not make the answer trusted.

Use ordinary `git add` and `git commit` through `bash`, then ask for `git_push`.
It pushes committed HEAD and any missing ancestors to the configured branch;
uncommitted files stay local. It cannot force-push, delete branches, or push tags.
Trusted work may go to the configured private remote. Untrusted work needs explicit
approval; public pushes also need permission to release private data. When needed,
Pi shows the commit list and recent commit diffs, then asks you to approve the exact
commit, history, and destination. Headless runs cannot approve. Labels stay unchanged.

The push worker copies Git objects into a protected bare repository and pushes
from there. Workspace Git settings and hooks never run outside the sandbox.
Changing HEAD during review cannot change the approved push. Server replies are
hidden as untrusted references. Shell network access stays blocked. This small
version supports SSH only, with a 64 MiB snapshot and 2 MiB review limit.

`--debug` shows dim, colored tool boxes with before/after labels, references, and
push decisions. These traces are UI metadata, not additional model context.

Labels, references, and the initial commit persist under `~/.local/state/pi-ifc/`.
New sessions, compaction, and forks do not clear them. Pi runs from a separate
control directory and loads only this extension; project configs are not loaded.
Pi credentials and global settings come from your normal profile; sessions stay
in the workspace's IFC state directory.
The launcher keeps a runtime copy outside the writable workspace. After editing
the extension, use `--refresh` to explicitly load the new implementation.

This remains a research playground. The initial tree, host, installed extension,
runtime dependencies, SSH configuration, and selected model provider are trusted.
The provider may receive private data. Other host programs changing the workspace
are not tracked.
Push approval does not certify the code. Remote CI may execute it after a push.

Related: [FIDES](https://arxiv.org/abs/2505.23643),
[CaMeL](https://arxiv.org/abs/2503.18813),
[Prudentia](https://arxiv.org/abs/2602.11416),
[Denning](https://faculty.nps.edu/dedennin/publications/lattice76.pdf),
[agent design patterns](https://arxiv.org/abs/2506.08837).
