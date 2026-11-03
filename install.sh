#!/bin/sh
# yaah installer: downloads a release from GitHub, verifies its SHA-256 against
# the release's SHA256SUMS and installs it for the current user.
#
#   curl -fsSL https://raw.githubusercontent.com/filipecabaco/yaah/main/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --version v0.1.0      # options after `sh -s --`
#
# macOS (Apple Silicon): yaah.app into /Applications, or ~/Applications when
# /Applications isn't writable. Linux (x86_64, arm64): the AppImage as
# ~/.local/bin/yaah with a menu entry and icon, or the .deb through apt (--deb).
#
# It runs nothing it downloads except the installed, verified app itself.
# POSIX sh (dash, busybox ash, bash, zsh); no bashisms. Run --help for options.

set -eu

YAAH_DEFAULT_REPO=filipecabaco/yaah
APP_ID=dev.yaah.app

usage() {
	cat <<'EOF'
Install yaah from a GitHub release.

Usage: install.sh [options]
       curl -fsSL https://raw.githubusercontent.com/filipecabaco/yaah/main/install.sh | sh -s -- [options]

Options:
  --version vX.Y.Z  Install that release instead of the latest (env: YAAH_VERSION).
  --prefix DIR      macOS: the folder for yaah.app (default /Applications, or
                    ~/Applications when /Applications isn't writable).
                    Linux: installs DIR/bin/yaah and DIR/share/... (default ~/.local).
  --deb             Linux: install the .deb with apt (needs sudo) instead of the AppImage.
  --uninstall       Remove what this script installs. Keeps ~/.yaah and ~/.config/yaah.
  --purge           With --uninstall: also delete yaah's data (~/.yaah, ~/.config/yaah
                    and the app's caches).
  --dry-run         Print what would happen; download, write and remove nothing.
  -q, --quiet       Only print warnings and errors.
  -h, --help        Show this help.

Environment:
  YAAH_REPO          GitHub repository to install from (default filipecabaco/yaah).
  YAAH_VERSION       Same as --version.
  YAAH_RELEASE_BASE  URL of the folder holding the release assets, used as is
                     (for mirrors and testing; overrides YAAH_REPO and the version).

Platforms: macOS arm64, Linux x86_64 and arm64.
EOF
}

say() { [ "$quiet" = 1 ] || printf '%s\n' "$*"; }
warn() { printf 'yaah: warning: %s\n' "$*" >&2; }
die() {
	printf 'yaah: error: %s\n' "$*" >&2
	exit 1
}
has() { command -v "$1" >/dev/null 2>&1; }
# In --dry-run, print the action instead of doing it.
plan() { say "would: $*"; }

cleanup() {
	[ -n "${stage:-}" ] && rm -rf "$stage"
	[ -n "${tmp:-}" ] && rm -rf "$tmp"
	return 0
}

detect_platform() {
	os=$(uname -s)
	arch=$(uname -m)
	case "$os" in
		Darwin)
			os=macos
			# A shell under Rosetta reports x86_64 on an Apple Silicon Mac.
			if [ "$arch" = x86_64 ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then
				arch=arm64
			fi
			[ "$arch" = arm64 ] || die "yaah is built for Apple Silicon Macs (arm64) only; this Mac is $arch."
			;;
		Linux)
			os=linux
			case "$arch" in
				x86_64 | amd64) arch=x86_64 ;;
				aarch64 | arm64) arch=arm64 ;;
				*) die "yaah is built for Linux x86_64 and arm64 only; this machine is $arch." ;;
			esac
			;;
		MINGW* | MSYS* | CYGWIN* | Windows_NT) die "Windows isn't supported; yaah runs on macOS (Apple Silicon) and Linux." ;;
		*) die "$os isn't supported; yaah runs on macOS (Apple Silicon) and Linux (x86_64, arm64)." ;;
	esac
}

release_base() {
	if [ -n "${YAAH_RELEASE_BASE:-}" ]; then
		base=${YAAH_RELEASE_BASE%/}
		return
	fi
	case "$repo" in
		*/* ) ;;
		*) die "YAAH_REPO must look like owner/name, not '$repo'." ;;
	esac
	case "$repo" in *[!A-Za-z0-9._/-]* | */*/*) die "YAAH_REPO must look like owner/name, not '$repo'." ;; esac
	if [ -n "$version" ]; then
		base="https://github.com/$repo/releases/download/$version"
	else
		base="https://github.com/$repo/releases/latest/download"
	fi
}

download() { # url file
	case "$1" in
		https://*) curl_proto="--proto =https" ;;
		*) curl_proto="" ;; # only through YAAH_RELEASE_BASE, e.g. a local test server
	esac
	if has curl; then
		# shellcheck disable=SC2086 # curl_proto is empty or two words on purpose
		curl -fsSL --retry 3 --connect-timeout 20 $curl_proto -o "$2" "$1" ||
			die "couldn't download $1 (no such release or asset, or no network)."
	elif has wget; then
		wget -q -O "$2" "$1" || die "couldn't download $1 (no such release or asset, or no network)."
	else
		die "needs curl or wget to download yaah."
	fi
}

sha256_of() {
	if has sha256sum; then
		sha256sum "$1" | cut -d ' ' -f 1
	elif has shasum; then
		shasum -a 256 "$1" | cut -d ' ' -f 1
	elif has openssl; then
		openssl dgst -sha256 -r "$1" | cut -d ' ' -f 1
	else
		die "needs sha256sum, shasum or openssl to verify the download; nothing was installed."
	fi
}

# Download the asset and SHA256SUMS into $tmp, and stop unless the checksum matches.
fetch_verified() { # asset
	say "Downloading $1 from $base"
	download "$base/SHA256SUMS" "$tmp/SHA256SUMS"
	download "$base/$1" "$tmp/$1"
	expected=$(awk -v f="$1" '$2 == f || $2 == "*" f { print $1; exit }' "$tmp/SHA256SUMS")
	[ -n "$expected" ] || die "SHA256SUMS has no entry for $1; nothing was installed."
	actual=$(sha256_of "$tmp/$1")
	if [ "$actual" != "$expected" ]; then
		die "checksum mismatch for $1 (expected $expected, got $actual); nothing was installed."
	fi
	say "Verified SHA-256 $actual"
}

# ---------------------------------------------------------------- macOS

mac_app_dir() {
	if [ -n "$prefix" ]; then
		app_dir=$prefix
	elif [ -w /Applications ]; then
		app_dir=/Applications
	else
		app_dir=$HOME/Applications
	fi
}

mac_is_yaah() { # path to an .app
	[ -f "$1/Contents/Info.plist" ] &&
		[ "$(defaults read "$1/Contents/Info" CFBundleIdentifier 2>/dev/null || true)" = "$APP_ID" ]
}

# Ask a running copy of the app at $1 to quit (a normal quit, as from the menu),
# and stop if it doesn't within 20 s.
mac_quit() {
	pgrep -f "$1/Contents/MacOS/yaah" >/dev/null 2>&1 || return 0
	if [ "$dry_run" = 1 ]; then
		plan "quit the running yaah ($1)"
		return 0
	fi
	say "yaah is running; asking it to quit"
	osascript -e 'on run argv' -e 'tell application (POSIX file (item 1 of argv) as text) to quit' -e 'end run' "$1" >/dev/null 2>&1 || true
	waited=0
	while pgrep -f "$1/Contents/MacOS/yaah" >/dev/null 2>&1; do
		[ "$waited" -lt 20 ] || die "yaah is still running; quit it (yaah > Quit) and run the installer again."
		sleep 1
		waited=$((waited + 1))
	done
}

mac_install() {
	asset=yaah-macos-arm64.tar.gz
	mac_app_dir
	dest=$app_dir/yaah.app
	if [ "$dry_run" = 1 ]; then
		plan "download $base/$asset and $base/SHA256SUMS, and verify the SHA-256"
		mac_quit "$dest"
		if [ -e "$dest" ]; then plan "replace $dest"; else plan "install $dest"; fi
		plan "remove the quarantine attribute from $dest"
		return 0
	fi
	fetch_verified "$asset"
	mkdir "$tmp/x"
	tar -xzf "$tmp/$asset" -C "$tmp/x"
	[ -x "$tmp/x/yaah.app/Contents/MacOS/yaah" ] || die "$asset doesn't contain yaah.app; nothing was installed."
	mac_quit "$dest"
	mkdir -p "$app_dir" || die "can't create $app_dir."
	[ -w "$app_dir" ] || die "$app_dir isn't writable; use --prefix ~/Applications or run with sudo."
	if [ -e "$dest" ] && ! mac_is_yaah "$dest"; then
		die "$dest exists and isn't yaah; move it away first."
	fi
	# Stage next to the destination, then swap, so a failed copy never leaves half an app.
	stage=$app_dir/.yaah.app.install.$$
	rm -rf "$stage"
	cp -R "$tmp/x/yaah.app" "$stage"
	# Downloads made by curl aren't quarantined, but a browser download of this script
	# or the archive would be: clear it so Gatekeeper doesn't block the ad-hoc-signed app.
	xattr -dr com.apple.quarantine "$stage" 2>/dev/null || true
	rm -rf "$dest"
	mv "$stage" "$dest"
	stage=
	codesign --verify --deep --strict "$dest" 2>/dev/null || warn "codesign couldn't verify $dest's signature."
	installed=$("$dest/Contents/MacOS/yaah" --version 2>/dev/null || echo yaah)
	say "Installed $installed to $dest"
	say "Open it from Spotlight or Launchpad, or run: open \"$dest\""
}

mac_uninstall() {
	if [ -n "$prefix" ]; then
		set -- "$prefix/yaah.app"
	else
		set -- /Applications/yaah.app "$HOME/Applications/yaah.app"
	fi
	found=0
	for app in "$@"; do
		mac_is_yaah "$app" || continue
		found=1
		mac_quit "$app"
		if [ "$dry_run" = 1 ]; then plan "remove $app"; else rm -rf "$app" && say "Removed $app"; fi
	done
	[ "$found" = 1 ] || say "No yaah.app found in $*"
	purge_data "$HOME/Library/Application Support/$APP_ID" "$HOME/Library/Caches/$APP_ID" \
		"$HOME/Library/WebKit/$APP_ID" "$HOME/Library/HTTPStorages/$APP_ID" "$HOME/Library/Logs/$APP_ID" \
		"$HOME/Library/Saved Application State/$APP_ID.savedState" "$HOME/Library/Preferences/$APP_ID.plist"
}

# ---------------------------------------------------------------- Linux

# The AppImage mounts itself with FUSE. Its runtime (AppImage's static type2-runtime)
# carries its own libfuse, so libfuse2 isn't needed: only /dev/fuse and the setuid
# fusermount (or fusermount3) helper. Without them the app still runs with
# --appimage-extract-and-run (or APPIMAGE_EXTRACT_AND_RUN=1), just slower to start.
linux_has_fuse() {
	[ -e /dev/fuse ] || return 1
	has fusermount || has fusermount3 || return 1
	return 0
}

linux_fuse_hint() {
	warn "FUSE isn't available (no /dev/fuse or fusermount), which the AppImage uses to start. Install it:"
	warn "  Debian/Ubuntu: sudo apt install fuse3    Fedora: sudo dnf install fuse3    Arch: sudo pacman -S fuse3"
	warn "or start yaah without FUSE: $1 --appimage-extract-and-run"
}

linux_install_appimage() {
	asset=yaah-linux-$arch.AppImage
	prefix=${prefix:-$HOME/.local}
	bin=$prefix/bin/yaah
	share=$prefix/share
	desktop=$share/applications/yaah.desktop
	if [ "$dry_run" = 1 ]; then
		plan "download $base/$asset and $base/SHA256SUMS, and verify the SHA-256"
		plan "install $bin"
		plan "install $desktop and icons in $share/icons/hicolor"
		linux_has_fuse || linux_fuse_hint "$bin"
		return 0
	fi
	fetch_verified "$asset"
	mkdir -p "$prefix/bin" "$share/applications" || die "can't create folders under $prefix."
	stage=$bin.install.$$
	cp "$tmp/$asset" "$stage"
	chmod 755 "$stage"
	mv -f "$stage" "$bin" # a rename: a running copy keeps its file
	stage=
	# Icons, from inside the verified AppImage (extracting needs no FUSE).
	if (cd "$tmp" && "$bin" --appimage-extract 'usr/share/icons/*' >/dev/null 2>&1) && [ -d "$tmp/squashfs-root/usr/share/icons/hicolor" ]; then
		for png in "$tmp"/squashfs-root/usr/share/icons/hicolor/*/apps/yaah.png; do
			[ -f "$png" ] || continue
			size=$(basename "$(dirname "$(dirname "$png")")")
			mkdir -p "$share/icons/hicolor/$size/apps"
			cp "$png" "$share/icons/hicolor/$size/apps/yaah.png"
		done
	else
		warn "couldn't extract the icon from the AppImage; the menu entry will have a generic one."
	fi
	# A theme icon name when the prefix is on the default XDG path, else an absolute path.
	icon=yaah
	if [ "$prefix" != "$HOME/.local" ]; then
		for size in 128x128 256x256@2 32x32; do
			[ -f "$share/icons/hicolor/$size/apps/yaah.png" ] && icon=$share/icons/hicolor/$size/apps/yaah.png && break
		done
	fi
	cat >"$desktop" <<EOF
[Desktop Entry]
Type=Application
Name=yaah
GenericName=Agent harness
Comment=yet another agent harness
Exec="$bin" %U
Icon=$icon
Terminal=false
Categories=Development;
StartupWMClass=yaah
X-Yaah-Installer=install.sh
EOF
	has update-desktop-database && update-desktop-database -q "$share/applications" 2>/dev/null || true
	has gtk-update-icon-cache && gtk-update-icon-cache -q -t "$share/icons/hicolor" 2>/dev/null || true
	# Start it once (`--version` returns before any window) to catch a machine it can't run on.
	if linux_has_fuse; then
		run_check=
	else
		run_check=--appimage-extract-and-run
		linux_fuse_hint "$bin"
	fi
	# shellcheck disable=SC2086 # run_check is empty or one word on purpose
	if installed=$("$bin" $run_check --version 2>&1); then
		say "Installed $installed to $bin (menu entry: $desktop)"
	else
		say "Installed yaah to $bin (menu entry: $desktop)"
		warn "but it didn't start: $(printf '%s\n' "$installed" | tail -n 1)"
		warn "the AppImage uses the libraries every Linux desktop has (X11/Wayland, OpenGL/EGL, fontconfig, harfbuzz, ...):"
		warn "on a server or minimal image, install the missing one, or use --deb, which pulls everything in."
	fi
	case ":$PATH:" in
		*":$prefix/bin:"*) ;;
		*) warn "$prefix/bin isn't on your PATH; add it to run \`yaah\` from a shell: export PATH=\"$prefix/bin:\$PATH\"" ;;
	esac
}

linux_sudo() {
	if [ "$(id -u)" = 0 ]; then
		sudo=
	elif has sudo; then
		sudo=sudo
	else
		die "--deb needs root or sudo."
	fi
}

linux_install_deb() {
	asset=yaah-linux-$arch.deb
	has apt-get || die "--deb needs apt (Debian, Ubuntu); use the AppImage (no --deb) elsewhere."
	[ -z "$prefix" ] || die "--prefix doesn't apply to --deb (the package installs to /usr)."
	if [ "$dry_run" = 1 ]; then
		plan "download $base/$asset and $base/SHA256SUMS, and verify the SHA-256"
		plan "sudo apt-get install $asset (yaah in /usr/bin, menu entry and icons from the package)"
		return 0
	fi
	linux_sudo
	fetch_verified "$asset"
	# apt reads local packages as the _apt user: let it into the private temp folder.
	chmod 755 "$tmp"
	chmod 644 "$tmp/$asset"
	say "Installing $asset with apt (it pulls in WebKitGTK and the libraries it needs)"
	$sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$tmp/$asset" >/dev/null || die "apt couldn't install $asset."
	installed=$(/usr/bin/yaah --version 2>/dev/null || echo yaah)
	say "Installed $installed to /usr/bin/yaah (package yaah; remove with --uninstall --deb)"
}

linux_uninstall() {
	if [ "$use_deb" = 1 ]; then
		if dpkg-query -W -f '${Status}' yaah 2>/dev/null | grep -q 'install ok installed'; then
			if [ "$dry_run" = 1 ]; then
				plan "sudo apt-get remove yaah"
			else
				linux_sudo
				$sudo env DEBIAN_FRONTEND=noninteractive apt-get remove -y -qq yaah >/dev/null && say "Removed the yaah package"
			fi
		else
			say "The yaah package isn't installed"
		fi
	else
		prefix=${prefix:-$HOME/.local}
		share=$prefix/share
		removed=0
		for f in "$prefix/bin/yaah" "$share/icons/hicolor"/*/apps/yaah.png; do
			[ -f "$f" ] || continue
			removed=1
			if [ "$dry_run" = 1 ]; then plan "remove $f"; else rm -f "$f" && say "Removed $f"; fi
		done
		# Only the menu entry this script wrote.
		if [ -f "$share/applications/yaah.desktop" ] && grep -q '^X-Yaah-Installer=install.sh' "$share/applications/yaah.desktop"; then
			removed=1
			if [ "$dry_run" = 1 ]; then
				plan "remove $share/applications/yaah.desktop"
			else
				rm -f "$share/applications/yaah.desktop" && say "Removed $share/applications/yaah.desktop"
				has update-desktop-database && update-desktop-database -q "$share/applications" 2>/dev/null || true
			fi
		fi
		[ "$removed" = 1 ] || say "No yaah AppImage install found under $prefix"
		if has dpkg-query && dpkg-query -W -f '${Status}' yaah 2>/dev/null | grep -q 'install ok installed'; then
			say "The yaah .deb package is installed too; remove it with --uninstall --deb (or: sudo apt remove yaah)"
		fi
	fi
	purge_data "${XDG_DATA_HOME:-$HOME/.local/share}/$APP_ID" "${XDG_CACHE_HOME:-$HOME/.cache}/$APP_ID"
}

# ---------------------------------------------------------------- both

purge_data() { # platform-specific app folders; ~/.yaah and ~/.config/yaah are added here
	if [ "$purge" != 1 ]; then
		for d in "$HOME/.yaah" "$HOME/.config/yaah"; do
			[ -e "$d" ] && say "Kept your data in $d (--purge deletes it)"
		done
		return 0
	fi
	for d in "$HOME/.yaah" "$HOME/.config/yaah" "$@"; do
		[ -e "$d" ] || continue
		if [ "$dry_run" = 1 ]; then plan "delete $d"; else rm -rf "$d" && say "Deleted $d"; fi
	done
}

main() {
	repo=${YAAH_REPO:-$YAAH_DEFAULT_REPO}
	version=${YAAH_VERSION:-}
	prefix=
	action=install
	use_deb=0
	purge=0
	dry_run=0
	quiet=0
	while [ $# -gt 0 ]; do
		case "$1" in
			--version)
				[ $# -ge 2 ] || die "--version needs a release, e.g. --version v0.1.0"
				version=$2
				shift
				;;
			--version=*) version=${1#*=} ;;
			--prefix)
				[ $# -ge 2 ] || die "--prefix needs a folder"
				prefix=$2
				shift
				;;
			--prefix=*) prefix=${1#*=} ;;
			--deb) use_deb=1 ;;
			--uninstall) action=uninstall ;;
			--purge) purge=1 ;;
			--dry-run | -n) dry_run=1 ;;
			-q | --quiet) quiet=1 ;;
			-h | --help)
				usage
				exit 0
				;;
			*) die "unknown option '$1' (see --help)" ;;
		esac
		shift
	done
	if [ "$purge" = 1 ] && [ "$action" != uninstall ]; then die "--purge only goes with --uninstall"; fi
	if [ -n "$version" ]; then
		case "$version" in
			v*) ;;
			*) version=v$version ;;
		esac
		case "$version" in *[!A-Za-z0-9._-]*) die "'$version' isn't a release version (e.g. v0.1.0)" ;; esac
	fi
	if [ -n "$prefix" ]; then
		case "$prefix" in
			/*) prefix=${prefix%/} ;;
			*) prefix=$(pwd)/${prefix%/} ;;
		esac
		[ -n "$prefix" ] || die "--prefix can't be /"
	fi

	detect_platform
	if [ "$use_deb" = 1 ] && [ "$os" != linux ]; then die "--deb is for Debian and Ubuntu Linux"; fi
	[ "$dry_run" = 1 ] && say "Dry run: nothing will be downloaded, written or removed."

	if [ "$action" = uninstall ]; then
		if [ "$os" = macos ]; then mac_uninstall; else linux_uninstall; fi
		return 0
	fi

	release_base
	[ "$dry_run" = 1 ] || tmp=$(mktemp -d 2>/dev/null || mktemp -d -t yaah)
	if [ "$os" = macos ]; then
		mac_install
	elif [ "$use_deb" = 1 ]; then
		linux_install_deb
	else
		linux_install_appimage
	fi
}

stage=
tmp=
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# All in a function, called on the last line: a download cut short runs nothing.
main "$@"
