# INSTALLATION_VALIDATION

- 日期：2026-09-09
- `node contextmind/cli.mjs install <dir>` 幂等；uninstall 只删自己加的条目。
- 安装副本额外复制 `cmhook.exe`（若 `native/build-cmhook.cmd` 已编译 Rust 版）。
- Windows `.cmd`：`install` 验证通过后优先 `cmhook.exe <hookName>`，否则 `node hook.mjs`。
- 不安装 `cm-hookd` / `cmhook-client`（已删除，ADR-0006）。
- `contextmind start`/`stop` 管理 runtime daemon（ADR-0014）。
- 测试：`contextmind/tests/cli.test.mjs`。
