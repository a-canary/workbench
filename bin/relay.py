#!/usr/bin/env python3
"""Byte relay between a TCP port and a unix socket (socat stand-in, stdlib only).

  relay.py unix2tcp SOCK HOST:PORT   # host side: listen on SOCK, dial HOST:PORT
  relay.py tcp2unix HOST:PORT SOCK   # sandbox side: listen on HOST:PORT, dial SOCK

The sandbox has no network namespace route out; this pair is the only door,
and it opens onto exactly one upstream endpoint.
"""
import os, socket, sys, threading

def pipe(a, b):
    try:
        while (d := a.recv(65536)):
            b.sendall(d)
    except OSError:
        pass
    finally:
        for s in (a, b):
            try: s.shutdown(socket.SHUT_RDWR)
            except OSError: pass

def serve(listener, dial):
    while True:
        c, _ = listener.accept()
        try:
            u = dial()
        except OSError:
            c.close(); continue
        threading.Thread(target=pipe, args=(c, u), daemon=True).start()
        threading.Thread(target=pipe, args=(u, c), daemon=True).start()

def hostport(s):
    h, p = s.rsplit(":", 1)
    return h, int(p)

if __name__ == "__main__":
    mode, a, b = sys.argv[1:4]
    if mode == "unix2tcp":
        if os.path.exists(a): os.unlink(a)
        l = socket.socket(socket.AF_UNIX); l.bind(a); l.listen(64)
        serve(l, lambda: socket.create_connection(hostport(b)))
    elif mode == "tcp2unix":
        l = socket.socket(); l.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        l.bind(hostport(a)); l.listen(64)
        def dial():
            u = socket.socket(socket.AF_UNIX); u.connect(b); return u
        serve(l, dial)
    else:
        sys.exit(f"unknown mode {mode}")
