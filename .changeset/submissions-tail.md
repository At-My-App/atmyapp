---
"@atmyapp/cli": minor
---

`atmyapp submissions tail [type]` follows form submissions as they arrive: received ones with their environment, sender and a snippet; rejected ones with the reason; and inbox changes. `--json` prints NDJSON for scripts. Live visitor data is hidden unless `--include-live-data` is passed; test and local submissions always show in full.
