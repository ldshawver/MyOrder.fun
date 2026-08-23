# MARKLIFE X2 offline capture package

This package characterizes the vendor `rastertoX2` filter without a printer. It
must be used only in a disposable x86_64 macOS VM with no USB passthrough and no
network adapter. It never uses the live CUPS spool.

## Immutable input

`input/Thank-You-Sticker-job-960-copy.png` is a tracked copy of the retained job
960 artwork: 393 x 393, one-bit PNG, 2,123 bytes, SHA-256
`b421a2f74da6c5cec20048c494ba3e898296f0909a309c08badf746bb83dc423`.

The package contains no credential, bridge environment, customer, order, user,
or payment data. The synthetic filter arguments are job `1960`, user
`offline-user`, title `offline-marklife-analysis`, and copies `1`.

## Required operator-supplied inputs

Copy these files into `input/vendor/` inside the disconnected VM:

- `rastertoX2`, expected SHA-256
  `81b1bb4baa28be9daf1afcbfd8d6f4e305784923a0735714463d1e7d99dd4f48`
- the read-only `MARKLIFE_X2.ppd` used for job 960

Do not copy a CUPS control file, spool file, secret, environment file, or log.

## Mandatory phases

1. Run `./verify-package.sh`.
2. Run `./verify-containment.sh`. This does not execute `rastertoX2` or any CUPS
   filter. It creates `capture/containment-report.txt` and deliberately probes
   that writes, network access, IOKit access, CUPS, and MARKLIFE device discovery
   are unavailable inside the sandbox.
3. Review the report. Do not create `capture/OPERATOR_AUTHORIZATION` and do not
   run `capture-filter.sh` until the report has been reviewed and a new explicit
   authorization has been given.
4. After authorization, create the gate exactly as documented by the reviewer.
   `capture-filter.sh` refuses to run unless the gate contains the SHA-256 of the
   reviewed containment report.

The filter phase uses these exact options:

```text
PageSize=Custom.1.9375x1.9375in Resolution=203dpi Horizontal=0 Vertical=0 Rotate=0 ImgMirror=0 ImgNegative=0 Darkness=10
```

The sandbox denies network and IOKit access and permits writes only under the
package `capture/` directory. Standard output is written to a file; it is never
piped to CUPS, `lp`, `lpr`, a backend, `/dev`, or a USB device.
