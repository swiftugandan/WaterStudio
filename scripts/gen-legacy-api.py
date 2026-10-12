"""Generate the forwarding wrappers of ws-ffi's legacy API (epanet2.h) from OWA-EPANET's
epanet2.c: everything after the "Generated" marker in engine/ws-ffi/src/legacy.rs.

usage: python3 scripts/gen-legacy-api.py oracle/.build/src/src/epanet2.c, then cargo fmt
"""
import re, sys

src = open(sys.argv[1]).read()
src = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
src = re.sub(r'//[^\n]*', '', src)

funcs = []
for m in re.finditer(r'int\s+DLLEXPORT\s+(EN\w+)\s*\(', src):
    name = m.group(1)
    i = m.end()
    depth = 1
    while depth:
        depth += {'(': 1, ')': -1}.get(src[i], 0)
        i += 1
    params = src[m.end():i - 1]
    j = src.index('{', i)
    depth, k = 1, j + 1
    while depth:
        depth += {'{': 1, '}': -1}.get(src[k], 0)
        k += 1
    body = ' '.join(src[j + 1:k - 1].split())
    funcs.append((name, ' '.join(params.split()), body))

TYPES = {
    'int': 'c_int', 'long': 'c_long', 'double': 'c_double', 'double *': '*mut c_double', 'int *': '*mut c_int', 'long *': '*mut c_long', 'char *': '*mut c_char',
    'const char *': '*const c_char', 'EN_API_FLOAT_TYPE': 'f32', 'EN_API_FLOAT_TYPE *': '*mut f32',
}

def parse_params(p):
    if p.strip() in ('', 'void'):
        return []
    out = []
    for part in p.split(','):
        part = part.strip()
        m = re.fullmatch(r'(.*?)(\w+)', part)
        ty = re.sub(r'\s*\*\s*', ' *', m.group(1).strip()).strip()
        out.append((m.group(2), TYPES[ty]))
    return out

SPECIAL = {'ENinit', 'ENopen', 'ENopenX', 'ENclose', 'ENepanet', 'ENgetversion', 'ENgeterror',
           'ENgetnodevalues', 'ENgetlinkvalues', 'ENsetpattern', 'ENsetcurve', 'ENgetcurve', 'ENsetreportcallback', 'ENsetreportcallbackuserdata'}

def snake(n):
    s = re.sub(r'([A-Z])', lambda m: '_' + m.group(1).lower(), n).lstrip('_')
    return {'type': 'kind'}.get(s, s)

out = []
done = []
for name, params, body in funcs:
    if name in SPECIAL:
        continue
    ps = parse_params(params)
    kinds = dict(ps)
    sig = ', '.join(f'{snake(n)}: {t}' for n, t in ps)
    m = re.fullmatch(r'return (EN_\w+)\(_defaultProject(?:, ?(.*))?\) ?;', body)
    lines = []
    if m:
        args = [a.strip() for a in (m.group(2) or '').split(',') if a.strip()]
        conv = [f'f64::from({snake(a)})' if kinds.get(a) == 'f32' else snake(a) for a in args]
        call = f'{m.group(1)}(default_project(){"".join(", " + c for c in conv)})'
        lines.append('    // SAFETY: the caller\'s arguments, forwarded as the C API takes them.')
        lines.append(f'    unsafe {{ crate::{call} }}')
    else:
        decl = re.match(r'double ([^;]*);', body)
        if not decl:
            raise SystemExit(f'unhandled {name}: {body}')
        locs = [re.match(r'(\w+)', d.strip()).group(1) for d in decl.group(1).split(',')]
        cm = re.search(r'int errcode = (EN_\w+)\(_defaultProject, ([^;]*)\);', body)
        args = [a.strip() for a in cm.group(2).split(',')]
        conv = []
        for a in args:
            if a.startswith('&'):
                conv.append(f'&raw mut {a[1:]}')
            elif kinds.get(a) == 'f32':
                conv.append(f'f64::from({snake(a)})')
            else:
                conv.append(snake(a))
        for l in locs:
            lines.append(f'    let mut {l} = 0.0f64;')
        lines.append('    // SAFETY: the caller\'s arguments, forwarded as the C API takes them.')
        lines.append(f'    let errcode = unsafe {{ crate::{cm.group(1)}(default_project(), {", ".join(conv)}) }};')
        for dst, src_ in re.findall(r'\*(\w+) = \(EN_API_FLOAT_TYPE\)(\w+);', body):
            lines.append(f'    // SAFETY: a caller\'s output pointer, or null.')
            lines.append(f'    unsafe {{ out({snake(dst)}, {src_} as f32) }};')
        lines.append('    errcode')
    out.append(f'#[unsafe(no_mangle)]\npub unsafe extern "C" fn {name}({sig}) -> c_int {{\n' + '\n'.join(lines) + '\n}\n')
    done.append(name)

print('\n'.join(out))
print(f'// generated: {len(done)}; special: {sorted(SPECIAL)}', file=sys.stderr)
