#!/usr/bin/env python3
"""Downloads NVDA's controller client DLL (LGPL 2.1, from nvaccess.org), which
soa_daemon.py needs to speak through NVDA. build.sh bundles it into the
Windows build; install.ps1 puts it next to soa_daemon.py.

Usage: fetch_nvda_client.py [DEST_DIR] [--arch x64|x86|arm64]
The architecture defaults to that of the running Python, which is the one the
DLL gets loaded into.
"""
import argparse
import io
import os
import platform
import struct
import urllib.request
import zipfile

VERSION = '2026.2'
URL = 'https://download.nvaccess.org/releases/%s/nvda_%s_controllerClient.zip' % (VERSION, VERSION)
DLL = 'nvdaControllerClient.dll'
LICENSE = 'nvdaControllerClient-license.txt'


def python_arch():
    if struct.calcsize('P') == 4:
        return 'x86'
    return 'arm64' if platform.machine().lower() in ('arm64', 'aarch64') else 'x64'


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('dest', nargs='?', default=os.path.dirname(os.path.abspath(__file__)))
    ap.add_argument('--arch', choices=('x64', 'x86', 'arm64'), default=python_arch())
    args = ap.parse_args()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler())
    with opener.open(URL, timeout=60) as r:
        z = zipfile.ZipFile(io.BytesIO(r.read()))
    os.makedirs(args.dest, exist_ok=True)
    with open(os.path.join(args.dest, DLL), 'wb') as f:
        f.write(z.read('%s/%s' % (args.arch, DLL)))
    with open(os.path.join(args.dest, LICENSE), 'wb') as f:
        f.write(z.read('license.txt'))
    print('NVDA controller client %s (%s) -> %s' % (VERSION, args.arch, args.dest))


if __name__ == '__main__':
    main()
