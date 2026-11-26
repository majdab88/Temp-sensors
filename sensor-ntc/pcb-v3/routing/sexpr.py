"""Minimal S-expression reader for KiCad netlists (kicadsexpr)."""


def parse(s):
    stack = [[]]
    i, n = 0, len(s)
    while i < n:
        c = s[i]
        if c == '(':
            stack.append([]); i += 1
        elif c == ')':
            x = stack.pop(); stack[-1].append(x); i += 1
        elif c == '"':
            j, buf = i + 1, []
            while s[j] != '"':
                if s[j] == '\\':
                    buf.append(s[j + 1]); j += 2
                else:
                    buf.append(s[j]); j += 1
            stack[-1].append(''.join(buf)); i = j + 1
        elif c.isspace():
            i += 1
        else:
            j = i
            while j < n and not s[j].isspace() and s[j] not in '()':
                j += 1
            stack[-1].append(s[i:j]); i = j
    return stack[0][0]


def find(lst, key):
    return [x for x in lst if isinstance(x, list) and x and x[0] == key]


def first(lst, key, default=None):
    f = find(lst, key)
    return f[0][1] if f and len(f[0]) > 1 else default


def netlist(path):
    """-> (components, nets). components: ref -> dict(value, footprint, uuid);
    nets: name -> [(ref, pin)]."""
    d = parse(open(path, encoding='utf-8').read())
    comps = {}
    for c in find(find(d, 'components')[0], 'comp'):
        ref = first(c, 'ref')
        comps[ref] = dict(value=first(c, 'value'), footprint=first(c, 'footprint'),
                          uuid=first(c, 'tstamps'),
                          fields={first(f, 'name'): (f[-1] if isinstance(f[-1], str) else '') for f in find(find(c, 'fields')[0], 'field')}
                          if find(c, 'fields') else {})
    nets = {}
    for n in find(find(d, 'nets')[0], 'net'):
        nets[first(n, 'name')] = [(first(x, 'ref'), first(x, 'pin')) for x in find(n, 'node')]
    return comps, nets
