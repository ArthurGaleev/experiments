# Blueprint point-cloud assets

Full-density, byte-exact point chunks for the [experiments viewer](https://arthurgaleev.github.io/experiments/). Only the approved Blueprint-Bench example apartment is published. Small previews and HTML remain on main.

PRC1: little-endian header (magic, uint32 count), float32 XYZ, uint8 RGB. PRC2 inserts one uint32 source-photo support mask per point between XYZ and RGB; the viewer manifest gives the bit-to-photo mapping. Names are the first 24 hexadecimal characters of the payload SHA-256. Viewer manifests pin immutable commit URLs. These are predicted surfaces, not measured geometry.
