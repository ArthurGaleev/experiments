# Blueprint point-cloud assets

Full-density, byte-exact point chunks for the [experiments viewer](https://arthurgaleev.github.io/experiments/). Only the approved Blueprint-Bench example apartment is published. Small previews and HTML remain on main.

PRC1: little-endian header (magic, uint32 count), float32 XYZ, uint8 RGB. PRC2 inserts one uint32 source-photo support mask per point between XYZ and RGB; the viewer manifest gives the bit-to-photo mapping. PRC3 uses a 12-byte little-endian magic/count/flags header, then float32 XYZ, float32 normals, optional uint32 support masks (flag bit 0), and uint8 RGB: 27 bytes per sample without support or 31 with support, plus the header. Names are the first 24 hexadecimal characters of the payload SHA-256. Viewer manifests pin immutable commit URLs. These are predicted surfaces, not measured geometry.
