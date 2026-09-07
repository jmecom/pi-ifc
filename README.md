# pi-ifc

A small Pi extension for experimenting with information flow control while coding.

```sh
pi install ~/development/pi-ifc
cd /path/to/project
pi
```

Requires macOS `sandbox-exec`, Python 3.10+, and Xcode command-line tools.

- **Sandbox:** The current directory is the approved workspace. File and shell
  tools can edit and test locally, but cannot access the network.
- **Labels:** Public/private tracks confidentiality; trusted/untrusted tracks
  influence. Files start private/trusted. Reads affect the conversation label;
  edits and shell calls also affect the whole workspace label. Taint persists
  across sessions and does not stop local coding.
- **Hidden values:** References keep text out of the main model's context.
  `quarantined_llm_call` processes it without tools and preserves its labels;
  `inspect` reveals it and inherits those labels. Git replies and helper answers
  are hidden; ordinary file reads and shell output are visible.
- **Read approvals:** Outside reads ask you to deny, read as untrusted, or trust
  that read. `ifc_read_many` groups exact files into one decision for that batch.
- **Planning:** `ifc_plan` reports live labels and push requirements so the model
  can anticipate taint and reduce interruptions. A plan grants no permissions.
- **Controlled pushes:** `git_push` sends a fixed commit and its history to your
  configured SSH remote. Public pushes or untrusted influence require approval.
  Approval does not reset labels.
- **Bookkeeping:** State and worker copies live outside the editable workspace.
  Tool calls run in order; a lock prevents competing IFC sessions.

- `/ifc`: status
- `/ifc debug`: toggle colored label traces
- `/ifc push`: configure the destination
- `/reload`: load extension changes

Research code. The initial workspace, Pi, other extensions, runtimes, and model
provider are trusted. The provider may receive private data. Changes made by
other host programs are not tracked.

Papers: [FIDES](https://arxiv.org/abs/2505.23643),
[CaMeL](https://arxiv.org/abs/2503.18813),
[Prudentia](https://arxiv.org/abs/2602.11416),
[Denning](https://faculty.nps.edu/dedennin/publications/lattice76.pdf),
[agent design patterns](https://arxiv.org/abs/2506.08837).
