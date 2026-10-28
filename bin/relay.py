#!/usr/bin/env python3
"""Byte relay between a TCP port and a unix socket (socat stand-in, stdlib only).

  relay.py unix2tcp SOCK HOST:PORT   # host side: listen on SOCK, dial HOST:PORT
  relay.py unix2http SOCK HOST:PORT  # same, but one checked HTTP request per connection:
                                     # path must be in RELAY_PATHS, Authorization is replaced
                                     # with RELAY_KEY (so the key never enters the sandbox)
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

PATHS = tuple(os.environ.get("RELAY_PATHS", "/v1/chat/completions,/v1/models").split(","))
DROP = (b"authorization", b"connection", b"keep-alive", b"upgrade", b"te")

def refuse(c, why):
    c.sendall(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: %d\r\n\r\n%s" % (len(why), why))
    c.close()

def http_one(c, u):
    """Forward exactly one request whose head passed the allowlist, then only the response."""
    buf = b""
    while b"\r\n\r\n" not in buf:
        d = c.recv(65536)
        if not d or len(buf) > 65536: return refuse(c, b"bad request head")
        buf += d
    head, body = buf.split(b"\r\n\r\n", 1)
    line, *hdrs = head.split(b"\r\n")
    parts = line.split(b" ")
    if len(parts) != 3 or parts[0] not in (b"GET", b"POST") or not parts[2].startswith(b"HTTP/1."):
        return refuse(c, b"method")
    path = parts[1].split(b"?", 1)[0].decode("latin-1")
    if path not in PATHS: return refuse(c, b"path")
    keep, length = [], 0
    for h in hdrs:
        k = h.split(b":", 1)[0].strip().lower()
        if k == b"transfer-encoding": return refuse(c, b"chunked")
        if k == b"content-length": length = int(h.split(b":", 1)[1])
        if k not in DROP and not k.startswith(b"proxy-"): keep.append(h)
    keep.append(b"Connection: close")
    if os.environ.get("RELAY_KEY"): keep.append(b"Authorization: Bearer " + os.environ["RELAY_KEY"].encode())
    u.sendall(b"\r\n".join([line, *keep]) + b"\r\n\r\n" + body[:length])
    left = length - len(body)
    while left > 0 and (d := c.recv(min(left, 65536))):
        u.sendall(d); left -= len(d)
    # anything the client sends after the body (a pipelined 2nd request) is read and dropped, never
    # forwarded; the client hanging up closes the upstream too, even if the upstream keeps it alive
    threading.Thread(target=drain, args=(c, u), daemon=True).start()
    pipe(u, c)

def drain(c, u):
    try:
        while c.recv(65536): pass
    except OSError: pass
    try: u.shutdown(socket.SHUT_RDWR)
    except OSError: pass

def hostport(s):
    h, p = s.rsplit(":", 1)
    return h, int(p)

if __name__ == "__main__":
    mode, a, b = sys.argv[1:4]
    if mode in ("unix2tcp", "unix2http"):
        if os.path.exists(a): os.unlink(a)
        l = socket.socket(socket.AF_UNIX); l.bind(a); l.listen(64)
        dial = lambda: socket.create_connection(hostport(b))
        if mode == "unix2tcp": serve(l, dial)
        while True:
            c, _ = l.accept()
            def one(c=c):
                try:
                    with dial() as u: http_one(c, u)
                except (OSError, ValueError): pass
                finally: c.close()
            threading.Thread(target=one, daemon=True).start()
    elif mode == "tcp2unix":
        l = socket.socket(); l.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        l.bind(hostport(a)); l.listen(64)
        def dial():
            u = socket.socket(socket.AF_UNIX); u.connect(b); return u
        serve(l, dial)
    else:
        sys.exit(f"unknown mode {mode}")
