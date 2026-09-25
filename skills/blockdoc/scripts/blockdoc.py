#!/usr/bin/env python3
"""blockdoc — edit long nested files as small parts; assemble + validate.

Usage:
  blockdoc.py split <file.html> <parts-dir>   adopt an existing long HTML file
  blockdoc.py build <parts-dir> [outfile]     concatenate parts, tag-balance validate, write
  blockdoc.py check <file.html>               validate one HTML file in place
  blockdoc.py selftest                        run built-in checks

The parts dir is the source of truth; the assembled file is a build artifact.
build never writes output when validation fails.
"""
import os
import re
import sys
from html.parser import HTMLParser

VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
        'meta', 'param', 'source', 'track', 'wbr'}


class Checker(HTMLParser):
    """Tag-balance checker: reports mismatches with line numbers."""

    def __init__(self):
        super().__init__()
        self.stack = []   # (tag, line)
        self.errors = []

    def handle_starttag(self, tag, attrs):
        if tag not in VOID:
            self.stack.append((tag, self.getpos()[0]))

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        if not self.stack:
            self.errors.append(f"line {self.getpos()[0]}: </{tag}> with no open tag")
            return
        top_tag, top_line = self.stack[-1]
        if top_tag == tag:
            self.stack.pop()
            return
        names = [t for t, _ in self.stack]
        if tag in names:
            i = len(names) - 1 - names[::-1].index(tag)
            for t, l in reversed(self.stack[i + 1:]):
                self.errors.append(
                    f"line {self.getpos()[0]}: </{tag}> leaves <{t}> unclosed (opened line {l})")
            del self.stack[i:]
        else:
            self.errors.append(
                f"line {self.getpos()[0]}: stray </{tag}> (top is <{top_tag}> from line {top_line})")

    def finish(self):
        for t, l in reversed(self.stack):
            self.errors.append(f"unclosed <{t}> opened at line {l}")


def check_text(text):
    c = Checker()
    c.feed(text)
    c.close()
    c.finish()
    return c.errors


class Splitter(HTMLParser):
    """Record line ranges of top-level <body> children."""

    def __init__(self):
        super().__init__()
        self.stack = []      # (tag, start_line, is_cut)
        self.body_depth = None
        self.cuts = []       # (tag, start_line, end_line)

    def handle_starttag(self, tag, attrs):
        if tag in VOID:
            return
        is_cut = self.body_depth is not None and len(self.stack) == self.body_depth
        self.stack.append((tag, self.getpos()[0], is_cut))
        if tag == 'body':
            self.body_depth = len(self.stack)

    def handle_endtag(self, tag):
        if tag in VOID or not self.stack:
            return
        if self.stack[-1][0] != tag:
            names = [t for t, _, _ in self.stack]
            if tag not in names:
                return
            i = len(names) - 1 - names[::-1].index(tag)
            popped = self.stack[i]
            del self.stack[i:]
        else:
            popped = self.stack.pop()
        ptag, _start, is_cut = popped
        if is_cut:
            self.cuts.append((ptag, _start, self.getpos()[0]))
        if ptag == 'body' and self.body_depth == len(self.stack) + 1:
            self.body_depth = None


def split_file(src, parts_dir):
    doc = open(src).read()
    if not doc.endswith('\n'):
        sys.exit('blockdoc: source must end with a trailing newline')
    lines = doc.split('\n')[:-1]
    s = Splitter()
    s.feed(doc)
    s.close()
    if not s.cuts:
        sys.exit('blockdoc: no top-level <body> children found — create parts by hand')
    os.makedirs(parts_dir, exist_ok=True)
    chunks = []
    prev_end = 0
    if s.cuts[0][1] > 1:
        chunks.append(('00-preamble', lines[:s.cuts[0][1] - 1]))
        prev_end = s.cuts[0][1] - 1
    for i, (tag, _start, end) in enumerate(s.cuts):
        slug = re.sub(r'[^a-z0-9]+', '-', tag.lower()).strip('-') or 'block'
        name = f'{i + 1:02d}-{slug}'
        chunks.append((name, lines[prev_end:end]))
        prev_end = end
    if prev_end < len(lines):
        name, cl = chunks[-1]
        chunks[-1] = (name, cl + lines[prev_end:])
    for name, cl in chunks:
        open(os.path.join(parts_dir, name + '.html'), 'w').write('\n'.join(cl) + '\n')
    # round-trip gate: build must reproduce the original byte-for-byte
    joined = ''.join(open(os.path.join(parts_dir, n + '.html')).read() for n, _ in chunks)
    if joined != doc:
        for name, _ in chunks:
            os.remove(os.path.join(parts_dir, name + '.html'))
        sys.exit('blockdoc: round-trip mismatch — split aborted, parts removed')
    print(f'blockdoc: split {src} -> {len(chunks)} parts in {parts_dir}/')


def build(parts_dir, outfile=None):
    names = sorted(f for f in os.listdir(parts_dir) if os.path.isfile(os.path.join(parts_dir, f)))
    if not names:
        sys.exit('blockdoc: no part files in ' + parts_dir)
    text = ''.join(open(os.path.join(parts_dir, f)).read() for f in names)
    errors = check_text(text)
    if errors:
        for e in errors:
            print('blockdoc:', e, file=sys.stderr)
        sys.exit(1)
    if outfile is None:
        sys.stdout.write(text)
    else:
        open(outfile, 'w').write(text)
        print(f'blockdoc: built {outfile} from {len(names)} parts (valid)')


def check(path):
    errors = check_text(open(path).read())
    for e in errors:
        print('blockdoc:', e, file=sys.stderr)
    sys.exit(1 if errors else 0)


def selftest():
    import tempfile
    d = tempfile.mkdtemp()
    # checker: good doc passes
    assert check_text('<html><head><title>t</title></head>'
                      '<body><div><p>a</p></div><br><img src=x></body></html>') == []
    # checker: unclosed tag caught with line number
    errs = check_text('<html><body>\n<div><p>a\n</div></body></html>')
    assert len(errs) == 1 and 'p' in errs[0], errs
    # checker: stray close caught
    assert any('stray' in e for e in check_text('<body></span></body>'))
    # split round-trip on a doc with gaps between top-level children
    src = os.path.join(d, 'a.html')
    doc = '\n'.join([
        '<!doctype html>',
        '<html>',
        '  <head><title>t</title></head>',
        '  <body>',
        '    <header><h1>Hi</h1></header>',
        '',
        '    <main>',
        '      <p>one</p>',
        '      <p>two</p>',
        '    </main>',
        '    <footer>x</footer>',
        '  </body>',
        '</html>',
    ]) + '\n'
    open(src, 'w').write(doc)
    parts = os.path.join(d, 'parts')
    split_file(src, parts)
    names = sorted(os.listdir(parts))
    assert len(names) == 4, names          # preamble + header + main + footer
    out = os.path.join(d, 'out.html')
    build(parts, out)
    assert open(out).read() == doc         # byte-for-byte round trip
    # build gate: broken part fails validation and writes nothing
    badp = [n for n in names if n.startswith('02')][0]
    open(os.path.join(parts, badp), 'w').write('<header><h1>Hi</header>\n')
    try:
        build(parts, out)
        raise AssertionError('build should have failed')
    except SystemExit:
        pass
    print('blockdoc: selftest ok')


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == 'split' and len(args) == 2:
        split_file(args[0], args[1])
    elif cmd == 'build' and 1 <= len(args) <= 2:
        build(args[0], args[1] if len(args) == 2 else None)
    elif cmd == 'check' and len(args) == 1:
        check(args[0])
    elif cmd == 'selftest':
        selftest()
    else:
        sys.exit(__doc__)


if __name__ == '__main__':
    main()
