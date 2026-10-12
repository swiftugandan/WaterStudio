#!/usr/bin/env python3
"""Zero the last byte of each node and link ID field in an EPANET output file.

OWA-EPANET copies a new element's ID with strncpy(ID, id, MAXID), which leaves the
32nd byte of the field as whatever realloc returned, and writes all 32 bytes to the
prolog. That byte means nothing, so toolkit.sh compares output files without it.

usage: outnorm.py <file.out>   (rewrites the file)
"""
import struct
import sys

HEADER = 15 * 4 + 3 * 80 + 2 * 260 + 2 * 32  # ints, titles, file names, chemical
MAXID1 = 32


def main():
    path = sys.argv[1]
    with open(path, "rb") as f:
        data = bytearray(f.read())
    if len(data) < HEADER:
        return
    nnodes, _ntanks, nlinks = struct.unpack_from("<3i", data, 8)
    for k in range(nnodes + nlinks):
        at = HEADER + k * MAXID1 + MAXID1 - 1
        if at < len(data):
            data[at] = 0
    with open(path, "wb") as f:
        f.write(data)


if __name__ == "__main__":
    main()
