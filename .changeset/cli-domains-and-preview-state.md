---
"@atmyapp/cli": minor
---

`atmyapp domains` manages custom domains from the terminal: `ls`, `show [--debug] [--records-text]`, `add <hostname>`, `edit`, `check [--wait]` and `rm`. Every result includes `setup`: the phase, every DNS record to add, issues with fixes, and next steps. Reading needs `hosting.read`; changes need `hosting.deploy`.

`stage preview` now reports `state` (`ready`, `starting`, `error`, `ended` or `unknown`). With `--wait [--timeout 3m]` it waits until the preview server is ready, and retries once if it fails to start, instead of returning a link that still shows a loading page.

`use --token <key>` no longer needs `--url` for production projects: the key names its project. `space create` now switches to the new space; pass `--no-use` to stay on the current one.
