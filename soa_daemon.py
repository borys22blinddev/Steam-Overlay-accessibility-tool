#!/usr/bin/env python3
"""Steam Overlay Access daemon.

Attaches to Steam's CEF remote debugging port, injects agent.js into the
context that owns the in-game overlay (and into overlay web pages), and speaks
whatever the agent reports: through speech-dispatcher on Linux, through NVDA or
SAPI 5 on Windows.

Steam must run with CEF debugging enabled: create the empty file
.cef-enable-remote-debugging in Steam's directory (install.sh / install.ps1 do
it) and restart Steam.
"""
import argparse
import asyncio
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request

import websockets

HERE = os.path.dirname(os.path.abspath(__file__))
WINDOWS = sys.platform == 'win32'
if WINDOWS:
    CONFIG_HOME = os.environ.get('APPDATA') or os.path.expanduser('~')
else:
    CONFIG_HOME = os.environ.get('XDG_CONFIG_HOME', os.path.expanduser('~/.config'))
CONFIG_PATH = os.path.join(CONFIG_HOME, 'steam-overlay-access', 'config.json')
BINDING = '__soaBridge'
# Run inside a toast window: hands the window to the agent of the context that opened it.
REGISTER_TOAST = ('(() => { try { const a = window.opener && window.opener.__soa;'
                  ' return !!(a && a.addToast && a.addToast(window)); } catch (e) { return false; } })()')
TOAST_TRIES = 5
DEFAULTS = {
    'port': 8080,
    'echo': True,       # speak typed characters in edit fields
    'toasts': True,     # speak in-game notification toasts
    'chat': True,       # speak chat messages arriving while the overlay is open
    'rate': None,       # speech rate -100..100; None = user default
    'voice': None,      # synthesis voice name (Windows: any part of a SAPI voice name)
    'module': None,     # speech-dispatcher output module (Linux only)
    'language': None,   # voice language, e.g. 'en' when Steam's UI is English
    'screenreader': True,  # Windows: speak through NVDA when it is running
    'sapi': True,       # Windows: speak through SAPI 5 while NVDA is not running
}


LOG_FILE = None  # set by --log: the Windows build has no console to print to


def log(*args):
    print(*args, file=sys.stderr, flush=True)
    if LOG_FILE is not None:
        print(time.strftime('%H:%M:%S'), *args, file=LOG_FILE, flush=True)


class SpeechdSpeaker:
    """speech-dispatcher client; falls back to spd-say when the Python module is missing."""

    def __init__(self, cfg):
        self.cfg = cfg
        self.client = None
        try:
            import speechd
            self.speechd = speechd
        except ImportError:
            self.speechd = None
            if not shutil.which('spd-say'):
                log('No speech output: install python3-speechd or speech-dispatcher (spd-say).')

    def _connect(self):
        c = self.speechd.SSIPClient('steam-overlay-access')
        if self.cfg['module']:
            c.set_output_module(self.cfg['module'])
        if self.cfg['language']:
            c.set_language(self.cfg['language'])
        if self.cfg['voice']:
            c.set_synthesis_voice(self.cfg['voice'])
        if self.cfg['rate'] is not None:
            c.set_rate(int(self.cfg['rate']))
        c.set_punctuation(self.speechd.PunctuationMode.SOME)
        self.client = c

    def _call(self, fn):
        if not self.speechd:
            return False
        for attempt in (0, 1):
            try:
                if self.client is None:
                    self._connect()
                fn(self.client)
                return True
            except Exception as e:  # speech-dispatcher restarted or timed out: reconnect once
                self.client = None
                if attempt:
                    log('speech-dispatcher error:', e)
        return False

    def say(self, text, interrupt=True):
        def go(c):
            if interrupt:
                c.cancel()
            c.speak(text)
        if not self._call(go) and shutil.which('spd-say'):
            if interrupt:
                subprocess.run(['spd-say', '-C'], stderr=subprocess.DEVNULL)
            subprocess.Popen(['spd-say', '--', text], stderr=subprocess.DEVNULL)

    def stop(self):
        if not self._call(lambda c: c.cancel()) and shutil.which('spd-say'):
            subprocess.Popen(['spd-say', '-C'], stderr=subprocess.DEVNULL)


class WindowsSpeaker:
    """Speaks through NVDA whenever it is running (its controller client DLL is
    part of the built program; from source it lies next to this file). Only
    while NVDA is not running does speech go to SAPI 5, driven by a PowerShell
    helper that stays running and takes one JSON command per line."""

    NVDA_DLLS = ('nvdaControllerClient.dll', 'nvdaControllerClient64.dll', 'nvdaControllerClient32.dll')

    def __init__(self, cfg):
        self.cfg = cfg
        self.proc = None
        self.nvda = self._load_nvda() if cfg['screenreader'] else None
        self.nvda_code = 0
        if cfg['screenreader']:
            log('NVDA controller client: %s' % ('loaded' if self.nvda else 'not found, speech goes to SAPI'))

    def _load_nvda(self):
        import ctypes
        # In the one-file build HERE is a temporary directory; the DLL lies next to the .exe.
        dirs = (os.path.dirname(os.path.abspath(sys.executable)), HERE) if getattr(sys, 'frozen', False) else (HERE,)
        for path in (os.path.join(d, name) for d in dirs for name in self.NVDA_DLLS):
            if not os.path.exists(path):
                continue
            try:
                dll = ctypes.WinDLL(path)
                dll.nvdaController_speakText.argtypes = [ctypes.c_wchar_p]
                return dll
            except (OSError, AttributeError):  # DLL built for the other bitness
                continue
        return None

    def _nvda_running(self):
        return self.nvda is not None and self.nvda.nvdaController_testIfRunning() == 0

    def _start(self):
        args = ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass',
                '-File', os.path.join(HERE, 'sapi_speak.ps1')]
        if self.cfg['rate'] is not None:  # SAPI rates run from -10 to 10
            args += ['-Rate', str(max(-10, min(10, round(int(self.cfg['rate']) / 10))))]
        if self.cfg['voice']:
            args += ['-Voice', str(self.cfg['voice'])]
        if self.cfg['language']:
            args += ['-Language', str(self.cfg['language'])]
        self.proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                     stderr=subprocess.DEVNULL, text=True, encoding='ascii',
                                     creationflags=subprocess.CREATE_NO_WINDOW)

    def _sapi(self, msg):
        for attempt in (0, 1):
            try:
                if self.proc is None or self.proc.poll() is not None:
                    self._start()
                self.proc.stdin.write(json.dumps(msg) + '\n')  # ASCII-only, so no code page issues
                self.proc.stdin.flush()
                return
            except OSError as e:  # helper died: restart it once
                self.proc = None
                if attempt:
                    log('SAPI helper error:', e)

    def say(self, text, interrupt=True):
        if self._nvda_running():
            if interrupt:
                self.nvda.nvdaController_cancelSpeech()
            code = self.nvda.nvdaController_speakText(text)
            if code != self.nvda_code:  # log a change, not every utterance
                self.nvda_code = code
                log('NVDA speech: %s' % ('ok' if code == 0 else
                    'refused, error %d (is the focused program in NVDA sleep mode?)' % code))
        elif self.cfg['sapi']:
            self._sapi({'t': 'say', 'text': text, 'interrupt': interrupt})

    def stop(self):
        if self._nvda_running():
            self.nvda.nvdaController_cancelSpeech()
        elif self.proc is not None:
            self._sapi({'t': 'stop'})


Speaker = WindowsSpeaker if WINDOWS else SpeechdSpeaker


def connect_options():
    # The debugging port is on localhost; websockets 15+ would otherwise route
    # the connection through a system-wide proxy.
    try:
        from websockets.version import version
        if int(version.split('.')[0]) >= 15:
            return {'proxy': None}
    except (ImportError, ValueError):
        pass
    return {}


class Session:
    """One CDP connection to one Steam page target."""

    def __init__(self, daemon, target):
        self.daemon = daemon
        self.id = target['id']
        self.title = target.get('title', '')
        self.url = target['webSocketDebuggerUrl']
        self.shared = self.title == 'SharedJSContext'
        self.ws = None
        self.next_id = 0

    async def send(self, method, **params):
        self.next_id += 1
        await self.ws.send(json.dumps({'id': self.next_id, 'method': method, 'params': params}))

    async def evaluate(self, expression):
        if self.ws is not None:
            await self.send('Runtime.evaluate', expression=expression)

    async def run(self):
        d = self.daemon
        try:
            async with websockets.connect(self.url, max_size=None, ping_interval=None,
                                          **connect_options()) as ws:
                self.ws = ws
                if self.shared:
                    d.shared = self
                    d.toast_tries.clear()  # a fresh agent knows no toast windows yet
                await self.send('Runtime.enable')
                await self.send('Runtime.addBinding', name=BINDING)
                await self.send('Page.enable')
                await self.send('Page.addScriptToEvaluateOnNewDocument', source=d.agent)
                await self.send('Runtime.evaluate', expression=d.agent)
                if not self.shared and d.web_remote:
                    await self.evaluate('window.__soa && window.__soa.setRemote(true)')
                d.debug('attached:', self.title or self.id)
                async for raw in ws:
                    msg = json.loads(raw)
                    if msg.get('method') == 'Runtime.bindingCalled' and msg['params'].get('name') == BINDING:
                        await d.on_agent_message(self, msg['params'].get('payload', ''))
                    elif 'error' in msg:
                        d.debug('cdp error:', msg['error'])
        except (OSError, websockets.WebSocketException) as e:
            d.debug('detached:', self.title or self.id, type(e).__name__)
        finally:
            self.ws = None
            if d.shared is self:
                d.shared = None
            d.sessions.pop(self.id, None)


class Daemon:
    def __init__(self, cfg, verbose):
        self.cfg = cfg
        self.verbose = verbose
        self.speaker = Speaker(cfg)
        self.sessions = {}
        self.shared = None
        self.web_remote = False  # overlay web pages forward their keys to the shared context
        self.toast_tries = {}    # target id -> attempts to hand that toast window to the agent
        self.steam_seen = None
        with open(os.path.join(HERE, 'agent.js'), encoding='utf-8') as f:
            agent_cfg = {k: cfg[k] for k in ('echo', 'toasts', 'chat')}
            self.agent = f.read().replace('/*__SOA_CONFIG__*/{}', json.dumps(agent_cfg))

    def debug(self, *args):
        if self.verbose:
            log(*args)

    def wanted(self, t):
        if t.get('type') != 'page' or not t.get('webSocketDebuggerUrl'):
            return False
        if t.get('title') == 'SharedJSContext':
            return True
        # Web pages: the agent itself bails out unless it runs in the overlay browser.
        url = t.get('url', '')
        return url.startswith(('http://', 'https://')) and 'steamloopback.host' not in url

    def is_toast(self, t):
        # The agent blanks the title of every toast window it knows, so a
        # window still carrying its name is one the agent has not found.
        return (t.get('type') == 'page' and bool(t.get('webSocketDebuggerUrl'))
                and 'notificationtoasts' in t.get('title', '').lower())

    async def register_toast(self, target):
        """Toast windows opened before the agent was injected are found through
        Steam's popup manager, but Big Picture keeps its toasts out of it: such
        a window is handed to the agent from the inside, through its opener."""
        ok = False
        try:
            async with websockets.connect(target['webSocketDebuggerUrl'], max_size=None, ping_interval=None,
                                          **connect_options()) as ws:
                await ws.send(json.dumps({'id': 1, 'method': 'Runtime.evaluate',
                                          'params': {'expression': REGISTER_TOAST, 'returnByValue': True}}))
                while True:
                    msg = json.loads(await asyncio.wait_for(ws.recv(), 5))
                    if msg.get('id') == 1:
                        ok = msg.get('result', {}).get('result', {}).get('value') is True
                        break
        except (OSError, asyncio.TimeoutError, websockets.WebSocketException):
            pass
        self.debug('toast window %s: %s' % (target.get('title'), 'handed to the agent' if ok else 'not reachable'))
        if ok:
            self.toast_tries[target['id']] = TOAST_TRIES

    def fetch_targets(self):
        # No proxy: on Windows urllib would pick up the system-wide one.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open('http://127.0.0.1:%d/json' % self.cfg['port'], timeout=3) as r:
            return json.load(r)

    async def on_agent_message(self, session, payload):
        try:
            msg = json.loads(payload)
        except ValueError:
            return
        kind = msg.get('t')
        if kind == 'say':
            self.debug('say:', msg.get('text'))
            self.speaker.say(str(msg.get('text', '')), bool(msg.get('interrupt', True)))
        elif kind == 'stop':
            self.speaker.stop()
        elif kind == 'cycle' and self.shared is not None:
            await self.shared.evaluate('window.__soa && window.__soa.cycleFromPage(%d, %s)'
                                       % (-1 if msg.get('dir', 1) < 0 else 1, json.dumps(str(msg.get('title', '')))))
        elif kind == 'webmode':
            self.web_remote = not msg.get('web')
            for s in list(self.sessions.values()):
                if not s.shared:
                    await s.evaluate('window.__soa && window.__soa.setRemote(%s)' % ('false' if msg.get('web') else 'true'))
        elif kind == 'key' and self.shared is not None:
            await self.shared.evaluate('window.__soa && window.__soa.remoteKey(%s, %s, %s)' % (
                json.dumps(str(msg.get('key', ''))), json.dumps(bool(msg.get('shift'))), json.dumps(bool(msg.get('ctrl')))))
        elif kind == 'pagefocus' and self.shared is not None:
            await self.shared.evaluate('window.__soa && window.__soa.pageFocused(%s)' % json.dumps(str(msg.get('title', ''))))
        elif kind == 'closeweb' and self.shared is not None:
            await self.shared.evaluate('window.__soa && window.__soa.closeFraming(%s)' % json.dumps(str(msg.get('title', ''))))
        elif kind == 'webfocus':
            await asyncio.sleep(0.3)
            for s in list(self.sessions.values()):
                if not s.shared:
                    await s.evaluate('window.__soa && window.__soa.announceIfFocused()')
        elif kind == 'log':
            self.debug('agent:', msg.get('text'))

    async def run(self):
        while True:
            try:
                targets = await asyncio.to_thread(self.fetch_targets)
                reachable = True
            except (OSError, ValueError):
                targets, reachable = [], False
            if reachable != self.steam_seen:
                self.steam_seen = reachable
                log('Steam CEF debugging port %d: %s' % (self.cfg['port'], 'connected' if reachable else
                    'not reachable (is Steam running with .cef-enable-remote-debugging?)'))
            for t in targets:
                if self.wanted(t) and t['id'] not in self.sessions:
                    s = Session(self, t)
                    self.sessions[t['id']] = s
                    asyncio.create_task(s.run())
                elif self.shared is not None and self.is_toast(t) and self.toast_tries.get(t['id'], 0) < TOAST_TRIES:
                    self.toast_tries[t['id']] = self.toast_tries.get(t['id'], 0) + 1
                    asyncio.create_task(self.register_toast(t))
            await asyncio.sleep(2)


def load_config(args):
    cfg = dict(DEFAULTS)
    try:
        with open(CONFIG_PATH, encoding='utf-8') as f:
            cfg.update({k: v for k, v in json.load(f).items() if k in DEFAULTS})
    except FileNotFoundError:
        pass
    except (OSError, ValueError) as e:
        log('Ignoring broken config %s: %s' % (CONFIG_PATH, e))
    if args.port:
        cfg['port'] = args.port
    return cfg


def main():
    ap = argparse.ArgumentParser(description='Screen reader support for the Steam in-game overlay.')
    ap.add_argument('--port', type=int, help='CEF remote debugging port (default 8080)')
    ap.add_argument('--no-speech', action='store_true', help='do not speak (for debugging with -v)')
    ap.add_argument('-v', '--verbose', action='store_true', help='log everything that is spoken')
    ap.add_argument('--log', metavar='FILE', help='also append the log to FILE')
    args = ap.parse_args()
    if args.log:
        global LOG_FILE
        LOG_FILE = open(args.log, 'a', encoding='utf-8')
    try:
        daemon = Daemon(load_config(args), args.verbose)
        if args.no_speech:
            daemon.speaker.say = lambda text, interrupt=True: None
            daemon.speaker.stop = lambda: None
        asyncio.run(daemon.run())
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
