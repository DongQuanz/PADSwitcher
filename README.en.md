<p align="center"><img src="src/assets/padswitcher-emblem.png" width="180" alt="PADSwitcher"></p>

# PADSwitcher

This is the independent **DongQuanz/PADSwitcher** fork, based on
[padduwcs/PADSwitcher](https://github.com/padduwcs/PADSwitcher) under the MIT license.
Development here targets Windows on `main`; the Linux/macOS builds linked below
belong to upstream. Windows updates only use this fork's releases. Until a release
is available, use the [source setup](#clone-and-develop).

Manage **Codex and Kaggle accounts**, inspect quota and automatically switch to
an available backup Codex account when the current account reaches its limit.

[Tiếng Việt](README.md) · [Support](SUPPORT.md) · [Report a bug](https://github.com/DongQuanz/PADSwitcher/issues/new/choose)

<a id="downloads"></a>
## Download and install

**To use the app, choose an installer below.** Cloning the source, Node.js and
Go are unnecessary for downloaded installers. Windows runs **PADSwitcher**;
Linux/macOS run **PADSwitcher Unix**, with separate accounts and data.

| Operating system | Release | Installer | Guide |
| --- | --- | --- | --- |
| Windows 10/11 x64 | [Stable](https://github.com/DongQuanz/PADSwitcher/releases/latest) | Portable `Windows.exe` | [English](#first-use) |
| Ubuntu/Debian x64 or ARM64 | [Unix.7 · preview](https://github.com/padduwcs/PADSwitcher/releases/tag/unix-v1.19.1-unix.7) | `.deb` | [English](https://github.com/padduwcs/PADSwitcher/blob/feature/cross-platform/docs/UNIX-INSTALL.en.md) |
| Other compatible Linux desktops | [Unix.7 · preview](https://github.com/padduwcs/PADSwitcher/releases/tag/unix-v1.19.1-unix.7) | `.AppImage` | [Linux requirements](https://github.com/padduwcs/PADSwitcher/blob/feature/cross-platform/docs/UNIX-INSTALL.en.md) |
| macOS Intel or Apple Silicon | [Unix.7 · preview](https://github.com/padduwcs/PADSwitcher/releases/tag/unix-v1.19.1-unix.7) | `.dmg` or `.zip` | [English](https://github.com/padduwcs/PADSwitcher/blob/feature/cross-platform/docs/UNIX-INSTALL.en.md) |

Open **Assets** on the release page and choose your operating system and CPU
architecture. A `.sha256` file verifies an installer; **Source code** is for
source checkouts. On Ubuntu 24.04/26.04, use the deb rather than AppImage.

Windows portable builds are unsigned. The Mac preview is ad-hoc signed without
notarization; the installation guide explains the first launch. Unix previews
keep the stable Windows release's **Latest** download unchanged.

## First use

1. Install/open the app, choose **Services → Codex**, and add an account through
   your browser.
2. Open **Connections** and set up **VS Code**, **CLI** or **JetBrains**.
   Windows 1.20 and Unix offer **Open desktop through PADSwitcher** for local Codex.
3. For account fallback, add at least two accounts, open the auto-switch setup,
   select backup accounts and save. Keep PADSwitcher running while connected.

Desktop Codex uses the **Shared** fallback policy. Extensions in Shared
mode use the same policy; separate-account connections have their own lists.
[Step-by-step auto-switch setup](https://github.com/padduwcs/PADSwitcher/blob/feature/cross-platform/docs/UNIX-INSTALL.en.md#enable-account-fallback-for-desktop-and-the-extension).

Fallback supports personal Codex Free/Plus/Pro accounts and explicit quota
rejections before output. Regular ChatGPT history does not move between accounts;
cloud/remote jobs are outside this local Codex connection.

**Kaggle:** open **Services → Kaggle → Setup**, install the tools shown, add your
API token and open a terminal for the account you want. Each terminal keeps its
own account selection. Kaggle guides: [Windows](#first-use) · [Linux/macOS](https://github.com/padduwcs/PADSwitcher/blob/feature/cross-platform/docs/KAGGLE.en.md).

## Clone and develop

This fork develops the Windows edition on `main`. Use Windows 10/11 x64,
Node.js 24.15+ in the 24.x line (or Node 26+) and .NET Framework 4.8.

```powershell
git clone --branch main https://github.com/DongQuanz/PADSwitcher.git
cd PADSwitcher
npm ci
npm start
```

Run `npm run check` and `npm test` before contributing. See [Contributing](CONTRIBUTING.md).
Linux/macOS development belongs to the [upstream repository](https://github.com/padduwcs/PADSwitcher/tree/feature/cross-platform).

## Contributors

- **Anh-Duc Phan** ([@padduwcs](https://github.com/padduwcs)) — author of PADSwitcher.
- **DongQuanz** ([@DongQuanz](https://github.com/DongQuanz)) — maintains the Windows fork:
  its own update channel, and the 1.21.1 fixes for errors right after sign-in
  (`PADCodex.exe`, the Windows error box) and for PADSwitcher/Codex desynchronisation.

## Documentation and support

- [Support](SUPPORT.md) · [Security](SECURITY.md)
- [Windows changelog](https://github.com/DongQuanz/PADSwitcher/blob/main/CHANGELOG.md) · [Unix changelog](https://github.com/padduwcs/PADSwitcher/blob/feature/cross-platform/CHANGELOG.md)

Released under [MIT](LICENSE). Independent of OpenAI, Kaggle and JetBrains.
