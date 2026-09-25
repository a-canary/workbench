# SETUP — daily refresh cron

The skill works without this; the cron only keeps `~/vault/api/PROVIDERS.md` fresh automatically.

Requires: `bun`, `pass` (GPG agent must be usable from cron — trading crons already prove this on this box), seeded `~/vault/api/models.json`.

## Install

```bash
(crontab -l; echo '17 * * * * $HOME/.bun/bin/bun $HOME/repos/arc-skills/skills/api-providers/refresh.ts >> $HOME/vault/api/refresh.log 2>&1') | crontab -
```

Fires hourly at :17. Quota caps can drain mid-day, so daily was too slow. Failures land loudly in `~/vault/api/refresh.log` and as `FETCH FAILED` / `SMOKE FAILED` rows in the doc itself.

## Reversal

```bash
crontab -l | grep -v 'api-providers/refresh.ts' | crontab -
```
