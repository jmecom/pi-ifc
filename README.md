# pi-ifc

A Pi extension for experimenting with information flow control. Untrusted input
can influence local coding work. IFC checks happen when commits are pushed.

Install once from this checkout, then use Pi normally:

```sh
pi install ~/development/pi-ifc
cd /path/to/project
pi
```

Requires macOS `sandbox-exec`, Python 3.10+ as `python3`, and Xcode command-line
tools. Tested with Pi 0.85.0. Uses your normal Pi model, login, sessions, and UI.
The current directory is the workspace. `/reload` picks up extension changes.

`/ifc` shows status. `/ifc debug` toggles dim, colored label traces and remembers
the setting for this workspace. There are no launcher flags.

The model uses `ifc_read`, `ifc_write`, `ifc_edit`, and `ifc_bash`. Files inside the
workspace start private/trusted. File operations and shell commands run in a
sandbox: workspace/scratch writes, approved runtime reads, no network. Outside
reads ask you to deny, read as untrusted, or trust that read. Untrusted input labels
the conversation and subsequent work, while editing and testing stay available.

Use ordinary `git add` and `git commit` through the sandbox, then ask for `git_push`.
The sandbox copies your global Git name and email; repository settings can override
them. Other global Git settings are excluded.
On the first push, confirm the repository and branch suggested from `origin` and
the current branch. Choose public or private; private explicitly allows sending
private project data there. The extension remembers the destination outside the
workspace. `/ifc push` changes it. SSH uses your existing keys/agent and known hosts.

Trusted work can go to that private destination. Untrusted work needs approval;
public pushes also need permission to release private data. Review the commit
list and recent diffs, then approve the exact commit, history, and destination.
Labels stay unchanged. Headless runs cannot grant approval. Pushes send committed
HEAD and missing ancestors, without force pushes, branch deletion, or tags.

The push worker imports Git objects into a protected bare repository. Workspace
Git settings and hooks never run outside the sandbox, and changing HEAD during
review cannot change the approved push. Server replies stay hidden as untrusted
references. `inspect` exposes them and inherits their labels;
`quarantined_llm_call` processes them without tools and returns a labeled reference.
This version supports SSH, with a 64 MiB snapshot and 2 MiB review limit.

State, settings, and worker copies live under `~/.local/state/pi-ifc/`. Labels persist
across sessions and reloads. Previously untracked conversation history and CLI
`@file` inputs start private/untrusted. One IFC session may use a workspace at a time.

This is a research playground. Pi, other installed extensions, loaded configuration,
the initial workspace, runtime dependencies, SSH configuration, and the selected
model provider are trusted. The provider may receive private data. IFC tools are
the only model tools enabled; other extensions still run as trusted host code.
Interactive and print modes are supported; native RPC mode is excluded.
Other host programs changing files are not tracked. Push approval does not certify
the code; remote CI may execute it.

Related: [FIDES](https://arxiv.org/abs/2505.23643),
[CaMeL](https://arxiv.org/abs/2503.18813),
[Prudentia](https://arxiv.org/abs/2602.11416),
[Denning](https://faculty.nps.edu/dedennin/publications/lattice76.pdf),
[agent design patterns](https://arxiv.org/abs/2506.08837).
