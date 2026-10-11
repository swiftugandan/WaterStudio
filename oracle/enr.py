"""Reader for OWA-EPANET's binary output file, through libepanet-output (ctypes).

Used by roundtrip.py, which compares runepanet's output for a file and its rewrite.
"""

import ctypes
import os

ENR_NODE, ENR_LINK = 1, 2
ENR_DEMAND, ENR_HEAD = 1, 2
ENR_FLOW = 1
ENR_PRESS_UNITS = 2
ENR_REPORT_START, ENR_REPORT_STEP, ENR_NUM_PERIODS = 1, 2, 4


class OutFile:
    """Thin ctypes wrapper over OWA-EPANET's output-file reader."""

    def __init__(self, lib, path):
        self.lib = lib
        self.h = ctypes.c_void_p()
        self._check(lib.ENR_init(ctypes.byref(self.h)))
        self._check(lib.ENR_open(self.h, path.encode()))

    def _check(self, code):
        if code >= 400:
            raise RuntimeError(f"ENR error {code}")

    def close(self):
        self.lib.ENR_close(ctypes.byref(self.h))

    def size(self):
        arr, dim = ctypes.POINTER(ctypes.c_int)(), ctypes.c_int()
        self._check(self.lib.ENR_getNetSize(self.h, ctypes.byref(arr), ctypes.byref(dim)))
        out = [arr[i] for i in range(dim.value)]
        self.lib.ENR_free(ctypes.byref(arr))
        return {"nodes": out[0], "tanks": out[1], "links": out[2]}

    def time(self, which):
        v = ctypes.c_int()
        self._check(self.lib.ENR_getTimes(self.h, which, ctypes.byref(v)))
        return v.value

    def units(self, which):
        v = ctypes.c_int()
        self._check(self.lib.ENR_getUnits(self.h, which, ctypes.byref(v)))
        return v.value

    def name(self, kind, index):
        buf, n = ctypes.c_char_p(), ctypes.c_int()
        self._check(self.lib.ENR_getElementName(self.h, kind, index, ctypes.byref(buf), ctypes.byref(n)))
        name = buf.value.decode()
        self.lib.ENR_free(ctypes.byref(buf))
        return name

    def attribute(self, kind, period, attr):
        arr, n = ctypes.POINTER(ctypes.c_float)(), ctypes.c_int()
        fn = self.lib.ENR_getNodeAttribute if kind == ENR_NODE else self.lib.ENR_getLinkAttribute
        self._check(fn(self.h, period, attr, ctypes.byref(arr), ctypes.byref(n)))
        vals = [arr[i] for i in range(n.value)]
        self.lib.ENR_free(ctypes.byref(arr))
        return vals


def load_lib(epanet_dir):
    lib = ctypes.CDLL(os.path.join(epanet_dir, "lib", "libepanet-output.so"))
    lib.ENR_open.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
    for f in ("ENR_getNetSize", "ENR_getTimes", "ENR_getUnits", "ENR_getElementName",
              "ENR_getNodeAttribute", "ENR_getLinkAttribute"):
        getattr(lib, f).argtypes = None
    lib.ENR_getNetSize.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
    lib.ENR_getTimes.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
    lib.ENR_getUnits.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
    lib.ENR_getElementName.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int,
                                       ctypes.c_void_p, ctypes.c_void_p]
    lib.ENR_getNodeAttribute.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int,
                                         ctypes.c_void_p, ctypes.c_void_p]
    lib.ENR_getLinkAttribute.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int,
                                         ctypes.c_void_p, ctypes.c_void_p]
    return lib
