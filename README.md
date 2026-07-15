# `clauctl`: a claude agent orchestration CLI

`clauctl` is [`pictl`](https://github.com/geraschenko/pictl) for claude code.

> [!NOTE]
> Linux and macOS only; it uses Unix domain sockets and has no native Windows
> support. Node 22.18 or newer is required.
>
> On Linux, the [`node-pty`](https://github.com/microsoft/node-pty)
> dependency has no prebuilt binary and compiles a native addon during install,
> so you need a C/C++ toolchain and Python: `build-essential` and `python3` on
> Debian/Ubuntu, or the equivalent.
