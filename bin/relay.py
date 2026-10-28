#!/usr/bin/env python3
"""Byte relay between a TCP port and a unix socket (socat stand-in, stdlib only).

  relay.py unix2tcp SOCK HOST:PORT   # host side: listen on SOCK, dial HOST:PORT
  relay.py unix2http SOCK HOST:PORT  # same, but one checked HTTP request per connection:
                                     # path must be in RELAY_PATHS, Authorization is replaced
                                     # with RELAY_KEY (so the key never enters the sandbox),
                                     # and a POST body's "model" is forced to RELAY_MODEL if set
  relay.py tcp2unix HOST:PORT SOCK   # sandbox side: listen on HOST:PORT, dial SOCK

The sandbox has no network namespace route out; this pair is the only door,
and it opens onto exactly one upstream endpoint.
"""
import json, os, re, socket, sys, threading, time

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

SLOTS = threading.BoundedSemaphore(int(os.environ.get("RELAY_MAX_CONN", "16")))

def serve(listener, dial):
    while True:
        c, _ = listener.accept()
        if not SLOTS.acquire(blocking=False):  # cap host threads + upstream connections
            c.close(); continue
        def both(c=c):
            try:
                u = dial()
            except OSError:
                c.close(); SLOTS.release(); return
            t = threading.Thread(target=pipe, args=(u, c), daemon=True); t.start()
            pipe(c, u); t.join(); SLOTS.release()
        threading.Thread(target=both, daemon=True).start()

PATHS = tuple(os.environ.get("RELAY_PATHS", "/v1/chat/completions,/v1/models").split(","))
DROP = (b"authorization", b"connection", b"keep-alive", b"upgrade", b"te", b"x-lane")  # x-lane: laneproxy lane pick

def refuse(c, why):
    c.sendall(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: %d\r\n\r\n%s" % (len(why), why))
    c.close()

TOKEN = re.compile(rb"[!#$%&'*+.^_`|~0-9A-Za-z-]+")

def http_one(c, dial):
    """Forward exactly one request whose head passed the allowlist, then only the response."""
    # one deadline for the whole request, not per recv: a client trickling a byte at a time can't hold
    # a slot either; the timeout is lifted before the (long) response
    deadline = time.monotonic() + float(os.environ.get("RELAY_TIMEOUT", "30"))
    def rx(n):
        c.settimeout(max(0.001, deadline - time.monotonic()))
        return c.recv(n)
    buf = b""
    while b"\r\n\r\n" not in buf:
        d = rx(65536)
        if not d or len(buf) > 65536: return refuse(c, b"bad request head")
        buf += d
    head, body = buf.split(b"\r\n\r\n", 1)
    line, *hdrs = head.split(b"\r\n")
    if b"\r" in head.replace(b"\r\n", b"") or b"\n" in head.replace(b"\r\n", b""):
        return refuse(c, b"bare CR/LF")
    parts = line.split(b" ")
    if len(parts) != 3 or parts[0] not in (b"GET", b"POST") or not parts[2].startswith(b"HTTP/1."):
        return refuse(c, b"method")
    path = parts[1].split(b"?", 1)[0].decode("latin-1")
    if path not in PATHS: return refuse(c, b"path")
    line = b" ".join([parts[0], path.encode("latin-1"), parts[2]])  # query dropped: it can skip upstream routing
    # strict head: no folding, no bare lines, one plain-digit Content-Length (no parse differential upstream)
    keep, length = [], None
    for h in hdrs:
        k, sep, v = h.partition(b":")
        if not sep or not TOKEN.fullmatch(k): return refuse(c, b"bad header")
        k, v = k.lower(), v.strip()
        if k == b"transfer-encoding": return refuse(c, b"chunked")
        if k == b"content-length":
            if length is not None or not v.isdigit(): return refuse(c, b"bad content-length")
            length = int(v)
        if k not in DROP and not k.startswith(b"proxy-"): keep.append(h)
    length = length or 0
    if parts[0] == b"GET" and length: return refuse(c, b"GET with a body")
    pin = os.environ.get("RELAY_MODEL")
    if pin and parts[0] == b"POST":  # re-serialize, so duplicate "model" keys can't parse differently upstream
        if length > 16 << 20: return refuse(c, b"body too large")
        while len(body) < length and (d := rx(65536)): body += d
        try: req = json.loads(body[:length])
        except (ValueError, RecursionError): return refuse(c, b"bad json")
        if not isinstance(req, dict): return refuse(c, b"bad json")
        for k in [k for k in req if k.lower() == "model"]: del req[k]  # case-insensitive upstream parsers
        req["model"] = pin
        body = json.dumps(req).encode(); length = len(body)
        keep = [h for h in keep if h.partition(b":")[0].lower() != b"content-length"] + [b"Content-Length: %d" % length]
    keep.append(b"Connection: close")
    if os.environ.get("RELAY_KEY"): keep.append(b"Authorization: Bearer " + os.environ["RELAY_KEY"].encode())
    with dial() as u:  # dial only once the head passed
        u.sendall(b"\r\n".join([line, *keep]) + b"\r\n\r\n" + body[:length])
        left = length - len(body)
        while left > 0 and (d := rx(min(left, 65536))):
            u.sendall(d); left -= len(d)
        c.settimeout(None)
        # anything the client sends after the body (a pipelined 2nd request) is read and dropped, never
        # forwarded; the client hanging up closes the upstream too, even if the upstream keeps it alive
        threading.Thread(target=drain, args=(c, u), daemon=True).start()
        respond(u, c)

def respond(u, c):
    """Pass the response through with Connection: close in its head, so a keep-alive client opens a
    new connection for its next request instead of waiting on this one (whose 2nd request is dropped).
    ponytail: only the first head is rewritten; after a 1xx (Expect: 100-continue) the final head passes
    as-is. Loop over 1xx heads if a client in the jail ever sends Expect."""
    buf = b""
    while b"\r\n\r\n" not in buf:
        d = u.recv(65536)
        if not d or len(buf) > 65536: c.sendall(buf); return  # no head: pass through, then close
        buf += d
    head, rest = buf.split(b"\r\n\r\n", 1)
    line, *hdrs = head.split(b"\r\n")
    hdrs = [h for h in hdrs if h.partition(b":")[0].strip().lower() not in (b"connection", b"keep-alive")]
    c.sendall(b"\r\n".join([line, *hdrs, b"Connection: close"]) + b"\r\n\r\n" + rest)
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
            if not SLOTS.acquire(blocking=False):  # cap host threads + upstream connections
                c.close(); continue
            def one(c=c):
                try: http_one(c, dial)
                except (OSError, ValueError): pass
                finally:  # shutdown, not just close: drain() holds c in recv, so close() alone sends no EOF
                    try: c.shutdown(socket.SHUT_RDWR)
                    except OSError: pass
                    c.close(); SLOTS.release()
            threading.Thread(target=one, daemon=True).start()
    elif mode == "tcp2unix":
        l = socket.socket(); l.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        l.bind(hostport(a)); l.listen(64)
        def dial():
            u = socket.socket(socket.AF_UNIX); u.connect(b); return u
        serve(l, dial)
    else:
        sys.exit(f"unknown mode {mode}")
