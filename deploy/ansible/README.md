# Sovereign Node Installer Ansible Support

These Ansible assets are internal support for the existing installer.

Users still install and update a node through the normal entrypoints:

- the `curl` installer
- `scripts/install.sh`
- `sovereign-node update`

Ansible is only used behind the scenes for post-install reconciliation and verification so the operator still experiences a single install/update path.

Current responsibilities:

- reconcile Mail Sentinel scheduler state after install/update
- verify `sovereign-node doctor`, `sovereign-node status`, and the Mail Sentinel systemd timer
- provide Molecule coverage for the legacy OpenClaw cron cleanup path

Relevant files:

- `playbooks/post-install-local.yml`: local-only playbook invoked by `scripts/install.sh`
- `roles/sovereign_node_mail_sentinel_reconcile/`: removes stale Mail Sentinel OpenClaw cron jobs and enforces the systemd timer
- `roles/sovereign_node_verify/`: asserts post-install runtime health
- `molecule/upgrade_mail_sentinel_scheduler/`: local test scenario for the scheduler migration

Local validation:

```bash
cd deploy/ansible
ansible-playbook --syntax-check playbooks/post-install-local.yml
molecule test -s upgrade_mail_sentinel_scheduler
```
