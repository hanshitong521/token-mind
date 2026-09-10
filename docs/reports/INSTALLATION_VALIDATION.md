# INSTALLATION_VALIDATION

- 日期：2026-09-09
- `node contextmind/cli.mjs install <dir>` 幂等；uninstall 只删自己加的条目。
- 安装副本额外复制 `cmhook.exe`（若已编译）+ `cm-hookd.mjs`。
- Windows `.cmd` 优先 `cmhook.exe <hookName>`，否则 `node hook.mjs`。
- **无** `start`/`stop`（ADR-0003/0006）。
- 测试：`contextmind/tests/cli.test.mjs`。
