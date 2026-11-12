# Daily refresh on a trusted Linux machine

`just daily` refreshes the existing private roster and publishes the configured
Google spreadsheet. Use it only after authorizing recurring publication. It does
not rename the spreadsheet, change sharing, pull code, or install dependencies.
Run `just install`, `just tools`, and `just check` when deploying reviewed updates.
It uses the same Varlock configuration as `just refresh` and `just sheets`; see
[Infisical setup](infisical.md). Keep the checkout and credentials on this machine.

## Repository changes and machine setup

The reusable automation belongs in Git: the `daily` recipe in `justfile`,
`scripts/daily-refresh.ts`, its synthetic tests in `tests/daily-refresh.test.ts`,
this guide, and the README link. The service and timer below are templates for
installing that command on a trusted machine. Cloning, pulling, or merging this
repository does not install or enable a scheduled job.

Installed units under `~/.config/systemd/user/`, their enabled state, the local
checkout folder name, and T3's project path are machine settings. Renaming the
checkout does not change Git history, remotes, or the Google spreadsheet name.
After a move, update the installed service's `WorkingDirectory` and T3's project
path, then reload systemd and check the next scheduled run.

Private `.env.local`, `.local/`, and `output/` stay ignored, including credentials,
roster data, snapshot backups, and publication recovery markers. Share synthetic
test results rather than live exports or private verification records in a PR.

## Refresh and publication safeguards

The command holds a nonblocking `flock` throughout the cycle. Use `just daily` for
manual runs too; independent `just refresh` and `just sheets` commands bypass this
lock, so stop the timer before using those commands. Exit 75 means another daily
run holds the lock. Existing editable-note and tab-ownership guards still apply.

Before refreshing, it saves the current snapshot under `output/roster/backups/`
and keeps the latest 14 snapshots. Refresh exit 0 or 2 can publish, provided a
validated snapshot was generated during this run, is newer than the previous
snapshot, and is not an empty guild roster. Exit 2 publishes visibly incomplete
data: failed character components are blanked and labelled, with last-success
timestamps kept. Any other refresh
exit stops publication. Successful daily runs return the refresh exit (0 or 2).

Before the single publication attempt it writes
`output/roster/publication-pending.json`, removing it only after an acknowledged
successful Google batch. A failed or interrupted publication leaves the marker
and blocks later daily runs. Inspect the live workbook before clearing it; a
timeout may mean Google committed the write. Check Guild Info's Generated At,
owned tabs and row counts, and human notes. Do not blindly retry. Once the outcome
is resolved, remove the marker and run `just daily` or await the next timer run.
This guard is intentionally conservative, including failures before any write.

## Install a user timer

On Linux with systemd, save these files under `~/.config/systemd/user/`. Adjust the
working directory and executable paths for your machine. No credentials belong
in either unit. Bun 1.4.3, `just`, and `flock` must be on the service's PATH.

```ini
# wow-forever-refresh.service
[Unit]
Description=Refresh and publish the WoW Forever guild report

[Service]
Type=oneshot
WorkingDirectory=%h/Projects/wow-forever-guild-report
Environment=PATH=/usr/local/bin:/usr/bin:/bin
UMask=0077
ExecStart=/usr/bin/just daily
SuccessExitStatus=2 75
TimeoutStartSec=2h
Restart=no
```

```ini
# wow-forever-refresh.timer
[Unit]
Description=WoW Forever guild report at 7 AM Eastern

[Timer]
OnCalendar=*-*-* 07:00:00 America/New_York
Persistent=true
AccuracySec=1s
Unit=wow-forever-refresh.service

[Install]
WantedBy=timers.target
```

Validate the configuration and enable the timer:

```sh
systemd-analyze --user verify ~/.config/systemd/user/wow-forever-refresh.service ~/.config/systemd/user/wow-forever-refresh.timer
systemd-analyze calendar '*-*-* 07:00:00 America/New_York'
systemctl --user daemon-reload
systemctl --user enable --now wow-forever-refresh.timer
systemctl --user list-timers wow-forever-refresh.timer
```

The explicit timezone follows Eastern daylight-saving changes. A user manager
with linger enabled runs while logged out (`loginctl show-user "$USER" -p Linger`).
`Persistent=true` catches missed runs when the user manager starts or the machine
resumes; it does not power on or wake the machine. Network or secret-provider
failures stop the run; there is no automatic service restart. Local journald
records failures, but no external failure notification is configured.

To change the schedule, edit the installed timer's `OnCalendar`, run
`systemctl --user daemon-reload`, restart `wow-forever-refresh.timer`, and check
`systemctl --user list-timers wow-forever-refresh.timer`. Change the installed
unit on each machine that should use the new time; editing this guide alone
does not change an active timer.

Use `systemctl --user start wow-forever-refresh.service` for a manual run with the
same environment as the timer, and inspect its status/logs locally:

```sh
systemctl --user status wow-forever-refresh.service
journalctl --user -u wow-forever-refresh.service -n 30 --no-pager
systemctl --user disable --now wow-forever-refresh.timer
```

The last command disables future automatic runs; a currently running service
continues. Avoid editing Player Notes during publication because Google Sheets
has no compare-and-swap protection for concurrent human edits. A departed player
with notes will stop publication until those notes are archived and cleared by
the owner. Unrelated human-maintained tabs stay outside the exporter scope.
