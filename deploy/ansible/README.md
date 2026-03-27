# Sovereign Node Ansible Wrapper

This Ansible layer wraps the existing Sovereign Node installer instead of replacing it.

Lifecycle split:

- bootstrap: check out the requested `sovereign-ai-node` and `sovereign-ai-bots` refs
- configure: render `/etc/sovereign-node/install-request.json`
- apply: run `scripts/install.sh` in explicit `install` or `update` mode
- reconcile: remove stale Mail Sentinel OpenClaw cron jobs and enforce the systemd timer
- verify: run focused health checks after the installer completes

Quick start:

```bash
cd deploy/ansible
ansible-playbook playbooks/site.yml -l my-node
```

Useful entrypoints:

- `playbooks/site.yml`: auto-select `install` vs `update`
- `playbooks/install.yml`: force install mode
- `playbooks/update.yml`: force update mode

Test scaffolding:

- `molecule/upgrade_mail_sentinel_scheduler/`: exercises the legacy Mail Sentinel cron cleanup path with fake `openclaw`, `systemctl`, and `sovereign-node` shims

Before running against a real host:

- fill in `inventories/prod/hosts.yml`
- update values in `inventories/prod/group_vars/all.yml`
- point secret refs like `sovereign_openrouter_secret_ref` and `sovereign_imap_secret_ref` at real secrets
