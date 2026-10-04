#!/usr/bin/env python3
"""Single-file installer and launcher: the entry point of the PyInstaller build.

Run without arguments (a double click) it installs: copies itself into the
user's profile, enables Steam's CEF remote debugging, registers itself to start
at logon and starts the daemon. `--daemon` runs the daemon (that is what the
autostart entry calls), `--uninstall` removes everything again.
"""
import os
import plistlib
import shutil
import subprocess
import sys
import time

import soa_daemon
from soa_daemon import MAC, WINDOWS

NAME = 'Steam Overlay Access'
APP = 'steam-overlay-access'
FLAG = '.cef-enable-remote-debugging'
RUN_KEY = r'Software\Microsoft\Windows\CurrentVersion\Run'
if WINDOWS:
    INSTALL_DIR = os.path.join(os.environ.get('LOCALAPPDATA') or os.path.expanduser('~'), APP)
    TARGET = os.path.join(INSTALL_DIR, APP + '.exe')
elif MAC:
    INSTALL_DIR = os.path.expanduser('~/Library/Application Support/' + APP)
    TARGET = os.path.join(INSTALL_DIR, APP)
    LABEL = 'io.github.borys22blinddev.' + APP
    PLIST = os.path.expanduser('~/Library/LaunchAgents/%s.plist' % LABEL)
    DOMAIN = 'gui/%d' % os.getuid()
else:
    INSTALL_DIR = os.path.join(os.environ.get('XDG_DATA_HOME') or os.path.expanduser('~/.local/share'), APP)
    TARGET = os.path.join(INSTALL_DIR, APP)
    CONFIG_HOME = os.environ.get('XDG_CONFIG_HOME') or os.path.expanduser('~/.config')
    UNIT = os.path.join(CONFIG_HOME, 'systemd', 'user', APP + '.service')
    DESKTOP = os.path.join(CONFIG_HOME, 'autostart', APP + '.desktop')

T = {
    'installed': 'Installed. Restart Steam once so that it opens its debugging port. '
                 'From now on the mod starts by itself at every logon.',
    'removed': 'Removed. Restart Steam to close its debugging port.',
    'no_steam': 'Steam directory not found. Install Steam (or set the STEAM_DIR environment variable) and run this again.',
    'failed': 'Installation failed: %s',
    'again': 'Steam Overlay Access is already installed.\n\nYes: install again (update)\nNo: uninstall\nCancel: do nothing',
    'source': 'This installs the built program only. Build it first (see README) or use install.sh / install.bat.',
}


def child_env():
    """Environment for programs we start: without what the PyInstaller bootloader added."""
    env = dict(os.environ)
    env['PYINSTALLER_RESET_ENVIRONMENT'] = '1'  # the installed copy must unpack itself afresh
    if not WINDOWS:
        orig = env.pop('LD_LIBRARY_PATH_ORIG', None)
        env.pop('LD_LIBRARY_PATH', None)
        if orig:
            env['LD_LIBRARY_PATH'] = orig
    return env


def run(*args):
    try:
        return subprocess.run(args, env=child_env(), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL,
                              creationflags=subprocess.CREATE_NO_WINDOW if WINDOWS else 0).returncode
    except OSError:
        return -1


def tell(text):
    if WINDOWS:
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, text, NAME, 0x40)  # MB_ICONINFORMATION
        return
    print(text, flush=True)
    if MAC:
        if not sys.stdout.isatty():
            run('osascript', '-e', 'on run a', '-e', 'display dialog (item 1 of a) with title (item 2 of a) buttons {"OK"}',
                '-e', 'end run', text, NAME)
    elif not sys.stdout.isatty():  # started from a file manager: nobody sees the output
        run('spd-say', '--', text)
        run('notify-send', NAME, text)


def steam_dirs():
    found = [os.environ.get('STEAM_DIR')]
    if WINDOWS:
        import winreg
        for root, key, value in ((winreg.HKEY_CURRENT_USER, r'Software\Valve\Steam', 'SteamPath'),
                                 (winreg.HKEY_LOCAL_MACHINE, r'SOFTWARE\WOW6432Node\Valve\Steam', 'InstallPath')):
            try:
                with winreg.OpenKey(root, key) as k:
                    found.append(winreg.QueryValueEx(k, value)[0])
            except OSError:
                pass
    elif MAC:
        # Steam's data directory and the client itself, which lives apart from it.
        found += [os.path.expanduser(p) for p in (
            '~/Library/Application Support/Steam',
            '~/Library/Application Support/Steam/Steam.AppBundle/Steam/Contents/MacOS')]
    else:
        found += [os.path.expanduser(p) for p in (
            '~/.steam/steam', '~/.local/share/Steam',
            '~/.var/app/com.valvesoftware.Steam/.local/share/Steam')]
    dirs = []
    for d in found:
        if d and os.path.isdir(d) and os.path.realpath(d) not in dirs:
            dirs.append(os.path.realpath(d))
    return dirs


def have_systemd():
    return run('systemctl', '--user', 'show-environment') == 0


def stop_daemon():
    if WINDOWS:
        # The installed daemon (not this installer, even when it is the same file)
        # and the Python one started by install.bat.
        os.environ['SOA_TARGET'] = TARGET
        run('powershell', '-NoProfile', '-Command',
            "Get-CimInstance Win32_Process | Where-Object {"
            " ($_.ExecutablePath -eq $env:SOA_TARGET -and $_.CommandLine -like '*--daemon*') -or"
            " ($_.Name -like 'python*' -and $_.CommandLine -like '*soa_daemon.py*') } |"
            " ForEach-Object { Stop-Process -Id $_.ProcessId -Force }")
    elif MAC:
        run('launchctl', 'bootout', DOMAIN + '/' + LABEL)
        run('pkill', '-f', TARGET + ' --daemon')
    else:
        run('systemctl', '--user', 'stop', APP + '.service')
        run('pkill', '-f', TARGET + ' --daemon')


def remove_autostart():
    if WINDOWS:
        import winreg
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as k:
                winreg.DeleteValue(k, NAME)
        except OSError:
            pass
        # shortcut left by install.bat
        lnk = os.path.join(os.environ.get('APPDATA', ''), 'Microsoft', 'Windows', 'Start Menu',
                           'Programs', 'Startup', NAME + '.lnk')
        if os.path.exists(lnk):
            os.remove(lnk)
    elif MAC:
        if os.path.exists(PLIST):
            os.remove(PLIST)
    else:
        run('systemctl', '--user', 'disable', APP + '.service')
        for path in (UNIT, DESKTOP):
            if os.path.exists(path):
                os.remove(path)
        run('systemctl', '--user', 'daemon-reload')


def copy_self():
    src = os.path.abspath(sys.executable)
    if os.path.exists(TARGET) and os.path.samefile(src, TARGET):
        return
    os.makedirs(INSTALL_DIR, exist_ok=True)
    for attempt in range(20):  # on Windows the old daemon needs a moment to let go of the file
        try:
            shutil.copyfile(src, TARGET + '.new')
            os.replace(TARGET + '.new', TARGET)
            break
        except PermissionError:
            if attempt == 19:
                raise
            time.sleep(0.25)
    if not WINDOWS:
        os.chmod(TARGET, 0o755)


def add_autostart_and_start():
    if WINDOWS:
        import winreg
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as k:
            winreg.SetValueEx(k, NAME, 0, winreg.REG_SZ, '"%s" --daemon' % TARGET)
        subprocess.Popen([TARGET, '--daemon'], env=child_env(), close_fds=True,
                         creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP)
    elif MAC:
        os.makedirs(os.path.dirname(PLIST), exist_ok=True)
        with open(PLIST, 'wb') as f:
            plistlib.dump({'Label': LABEL,
                           'ProgramArguments': [TARGET, '--daemon'],
                           'RunAtLoad': True,
                           'KeepAlive': {'SuccessfulExit': False},
                           'StandardErrorPath': os.path.expanduser('~/Library/Logs/%s.log' % APP)}, f)
        for attempt in range(10):  # launchd may still be letting go of the old service
            if run('launchctl', 'bootstrap', DOMAIN, PLIST) == 0:
                break
            time.sleep(0.5)
        else:
            raise OSError('launchctl bootstrap')
    elif have_systemd():
        os.makedirs(os.path.dirname(UNIT), exist_ok=True)
        with open(UNIT, 'w', encoding='utf-8') as f:
            f.write('[Unit]\n'
                    'Description=Steam Overlay Access (screen reader support for the Steam overlay)\n\n'
                    '[Service]\n'
                    'ExecStart="%s" --daemon\n'
                    'Restart=on-failure\n'
                    'RestartSec=5\n\n'
                    '[Install]\n'
                    'WantedBy=default.target\n' % TARGET)
        run('systemctl', '--user', 'daemon-reload')
        if run('systemctl', '--user', 'enable', APP + '.service') != 0:
            raise OSError('systemctl --user enable')
        run('systemctl', '--user', 'restart', APP + '.service')
    else:  # no systemd user session: the desktop's own autostart
        os.makedirs(os.path.dirname(DESKTOP), exist_ok=True)
        with open(DESKTOP, 'w', encoding='utf-8') as f:
            f.write('[Desktop Entry]\n'
                    'Type=Application\n'
                    'Name=%s\n'
                    'Exec="%s" --daemon\n'
                    'NoDisplay=true\n' % (NAME, TARGET))
        subprocess.Popen([TARGET, '--daemon'], env=child_env(), stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)


def install():
    dirs = steam_dirs()
    if not dirs:
        tell(T['no_steam'])
        return 1
    try:
        for d in dirs:
            open(os.path.join(d, FLAG), 'a').close()
        stop_daemon()
        remove_autostart()
        copy_self()
        add_autostart_and_start()
    except OSError as e:
        tell(T['failed'] % e)
        return 1
    tell(T['installed'])
    return 0


def uninstall():
    stop_daemon()
    remove_autostart()
    for d in steam_dirs():
        try:
            os.remove(os.path.join(d, FLAG))
        except OSError:
            pass
    time.sleep(0.5)
    shutil.rmtree(INSTALL_DIR, ignore_errors=True)  # leaves our own file when run from there on Windows
    tell(T['removed'])
    return 0


def main():
    if '--daemon' in sys.argv:
        sys.argv.remove('--daemon')
        if not WINDOWS:  # speech helpers the daemon starts must not load our bundled libraries
            os.environ.update(child_env())
            if 'LD_LIBRARY_PATH_ORIG' not in os.environ:
                os.environ.pop('LD_LIBRARY_PATH', None)
        return soa_daemon.main()
    if not getattr(sys, 'frozen', False):
        print(T['source'], file=sys.stderr)
        return 1
    if '--uninstall' in sys.argv:
        return uninstall()
    if WINDOWS and os.path.exists(TARGET):
        import ctypes
        answer = ctypes.windll.user32.MessageBoxW(None, T['again'], NAME, 0x23)  # MB_YESNOCANCEL | MB_ICONQUESTION
        if answer == 7:  # IDNO
            return uninstall()
        if answer != 6:  # IDYES
            return 0
    return install()


if __name__ == '__main__':
    sys.exit(main())
