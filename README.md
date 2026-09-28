# MINTCAT
![Logo](https://raw.githubusercontent.com/iriscats/mintcat/refs/heads/main/public/icon.ico)

# Introduction
MintCat is a Deep Rock Galactic mod loader and integration tool. It is built with Rust and Tauri, and the frontend is built with React and Typescript.


# Features
## 1. Mod Management:
- Add mods from mod.io
- Add mods from local files
- Update mods
- Mod rename

2. mod.io Search, Download, Update


# Architecture
1. Frontend: React + Typescript + Vite + AntDesign
2. Backend: Rust + Tauri 


## Tauri 2.0
https://v2.tauri.app/start/


## AntDesign
https://ant-design.antgroup.com/index-cn


## Modio RESTful API
https://docs.mod.io/restapiref/#getting-started


# Build & Dev (Linux)

MintCat targets Windows upstream, but runs on Linux (game via Steam + Proton).
Auto-detection expects DRG installed in Steam (app ID `548430`).

## System dependencies (Arch / CachyOS)

```bash
sudo pacman -Syu base-devel curl wget file openssl webkit2gtk-4.1 gtk3 libsoup3 librsvg libappindicator-gtk3 pnpm nodejs
```

## Dev run

```
pnpm install
pnpm approve-builds esbuild   # pnpm 11+ blocks esbuild postinstall scripts otherwise
pnpm package:integrator-runtime:dev  # build Linux backend runtime (.so), required for game detection/install
WEBKIT_DISABLE_DMABUF_RENDERER=1 pnpm tauri dev
```

Notes:
- The first `tauri dev` compiles Rust (~5 min); later starts are incremental.
- If the window is black/empty on Wayland, run with `GDK_BACKEND=x11`.
- After changing Rust code in `src-tauri/crates/`, re-run `pnpm package:integrator-runtime:dev` before restarting dev.
- In Select Game dialog, the ⌖ (Auto Find) button fills the `FSD-WindowsNoEditor.pak` path via Steam library detection.

## Release build (AppImage)

```bash
pnpm package:integrator-runtime  # release .so into src-tauri/assets/plugins/
pnpm tauri build --config src-tauri/tauri.linux.conf.json
# -> src-tauri/target/release/bundle/appimage/mintcat_0.6.0_amd64.AppImage
```

The AppImage needs `webkit2gtk-4.1` on the host system. The updater only serves
`windows-x86_64` (`latest.json`), so on Linux update by rebuilding.

# Publish (Windows, upstream flow)

```shell
./scripts/build-release.sh  # cross-compile with cargo-xwin, needs signing key (see script)
```


# App Path

## Config Path
```
Windows:
C:\Users\Alice\AppData\Roaming\com.mint.cat

macOS:
~/Library/Application Support/com.mint.cat

Linux:
~/.config/com.mint.cat
```

## Log Path
```
Windows: 
C:\Users\Alice\AppData\Local\com.mint.cat\logs

macOS:
~/Library/Logs/com.mint.cat/mintcat.log
```

## Cache Path
```
Windows: 
C:\Users\Alice\AppData\Local\com.mint.cat\

macOS:
~/Library/Caches/com.mint.cat
```
