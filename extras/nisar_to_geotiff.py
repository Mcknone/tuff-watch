#!/usr/bin/env python3
"""
nisar_to_geotiff.py  -  NISAR L2 GCOV (L-band)  ->  small GeoTIFFs for Google Earth Engine
NASA Space Apps - Earth Surface Change Monitor

What it does
  1. Searches NASA's Alaska Satellite Facility (ASF) archive for NISAR GCOV
     products that cover your area and dates.
  2. Streams ONLY the pixels inside your area (a full GCOV file is many GB).
  3. Averages NxN pixels to reduce radar speckle, converts to decibels (dB).
  4. Writes one 2-band GeoTIFF per scene:  band 1 = HH (co-pol), band 2 = HV (cross-pol)
     (if a scene was recorded as VV/VH instead, those go in bands 1/2).
  Upload the .tif files to Earth Engine (Assets -> NEW -> GeoTIFF).

EASIEST: run in Google Colab (https://colab.research.google.com)
  !pip install asf_search earthaccess h5py rasterio pyproj
  # use the SAME centre point and radius as in the Earth Engine app (LAT LON):
  !python nisar_to_geotiff.py --list-only --point -8.30 140.40 --radius-km 10 --start 2026-06-17 --end 2026-11-30
  !python nisar_to_geotiff.py --point -8.30 140.40 --radius-km 10 --start 2026-06-17 --end 2026-11-30 --direction A

  You will be asked for your NASA Earthdata username and password
  (free: https://urs.earthdata.nasa.gov). Never paste them into a chat.

Area options (decimal degrees)
  --bbox MIN_LON MIN_LAT MAX_LON MAX_LAT      (note: longitude first here)
  --point LAT LON --radius-km 10              (same order as the Earth Engine app)

Already downloaded the .h5 files?   --h5 file1.h5 file2.h5   (skips the search)
"""
import argparse
import math
import os
import re
import sys

import numpy as np

NODATA = -9999.0
GRID = "/science/LSAR/GCOV/grids/{freq}"


# ----------------------------------------------------------------------------- args
def parse_args(argv=None):
    p = argparse.ArgumentParser(description="NISAR GCOV -> GeoTIFF (dB) for Earth Engine")
    area = p.add_mutually_exclusive_group(required=True)
    area.add_argument("--bbox", nargs=4, type=float,
                      metavar=("MIN_LON", "MIN_LAT", "MAX_LON", "MAX_LAT"))
    area.add_argument("--point", nargs=2, type=float, metavar=("LAT", "LON"))
    p.add_argument("--radius-km", type=float, default=10.0,
                   help="radius around --point (default 10)")
    p.add_argument("--start", help="YYYY-MM-DD (search only)")
    p.add_argument("--end", help="YYYY-MM-DD (search only)")
    p.add_argument("--direction", choices=["A", "D"],
                   help="keep only Ascending or Descending passes (recommended: pick one)")
    p.add_argument("--h5", nargs="+", help="local GCOV .h5 files (skip the search)")
    p.add_argument("--max-products", type=int, default=12)
    p.add_argument("--looks", type=int, default=3,
                   help="average NxN pixels: less speckle, smaller file (default 3)")
    p.add_argument("--frequency", default="frequencyA", choices=["frequencyA", "frequencyB"])
    p.add_argument("--out", default="nisar_geotiffs", help="output folder")
    p.add_argument("--list-only", action="store_true",
                   help="just list the scenes found, don't process")
    p.add_argument("--download", action="store_true",
                   help="download whole .h5 files instead of streaming (slower, many GB)")
    a = p.parse_args(argv)
    if a.h5 is None and not (a.start and a.end):
        p.error("--start and --end are required when searching (or give --h5 files)")
    return a


def area_bbox(args):
    """Return (min_lon, min_lat, max_lon, max_lat) and validate it."""
    if args.bbox:
        x0, y0, x1, y1 = args.bbox
    else:
        lat, lon = args.point
        dlat = args.radius_km / 111.32
        dlon = args.radius_km / (111.32 * max(math.cos(math.radians(lat)), 1e-6))
        x0, y0, x1, y1 = lon - dlon, lat - dlat, lon + dlon, lat + dlat
    x0, x1 = min(x0, x1), max(x0, x1)
    y0, y1 = min(y0, y1), max(y0, y1)
    if not (-180 <= x0 <= 180 and -180 <= x1 <= 180 and -90 <= y0 <= 90 and -90 <= y1 <= 90):
        sys.exit("Area is outside valid lon/lat ranges. Remember: --bbox is LON first, --point is LAT first.")
    return x0, y0, x1, y1


def bbox_wkt(b):
    x0, y0, x1, y1 = b
    return f"POLYGON(({x0} {y0},{x1} {y0},{x1} {y1},{x0} {y1},{x0} {y0}))"


# ----------------------------------------------------------------------------- names
def scene_info(name):
    """Pull date, direction and track out of a NISAR file name.
    e.g. NISAR_L2_PR_GCOV_006_172_A_008_2005_DHDH_A_20251204T024618_..._X05009_N_F_J_001.h5"""
    base = os.path.basename(name)
    parts = base.split("_")
    date = re.search(r"_(\d{8})T\d{6}_", base)
    crid = re.search(r"_(X\d{5}|P\d{5})_", base)
    info = {
        "name": base,
        "date": date.group(1) if date else "unknown",
        "direction": parts[6] if len(parts) > 6 and parts[6] in ("A", "D") else "?",
        "track": parts[5] if len(parts) > 5 else "?",
        "crid": crid.group(1) if crid else "",
    }
    # product name without the processing-version part, to drop duplicate versions
    m = re.match(r"(NISAR_L2_\w+?_GCOV(?:_[^_]+){9})", base)
    info["product"] = m.group(1) if m else base
    return info


def latest_versions(urls):
    """Keep only the newest processing version (CRID) of each product."""
    best = {}
    for u in urls:
        i = scene_info(u)
        if i["product"] not in best or i["crid"] > best[i["product"]][0]:
            best[i["product"]] = (i["crid"], u)
    return [v[1] for v in best.values()]


# ----------------------------------------------------------------------------- search
def search(bbox, start, end, direction, max_products):
    import asf_search as asf

    wkt = bbox_wkt(bbox)
    try:
        results = asf.search(dataset="NISAR", processingLevel="GCOV",
                             intersectsWith=wkt, start=start, end=end)
    except Exception:  # older asf_search versions: filter by name instead
        results = asf.search(dataset="NISAR", intersectsWith=wkt, start=start, end=end)
    urls = results.find_urls(extension=".h5", directAccess=False)
    urls = [u for u in urls if "_GCOV_" in os.path.basename(u)]
    urls = latest_versions(urls)
    if direction:
        urls = [u for u in urls if scene_info(u)["direction"] == direction]
    urls.sort(key=lambda u: scene_info(u)["date"])
    return urls[:max_products]


# ----------------------------------------------------------------------------- pixel math
def window_indices(x, y, xmin, xmax, ymin, ymax):
    """Row/col slice of the grid that covers the box. x, y are pixel-centre coordinates."""
    cols = np.where((x >= xmin) & (x <= xmax))[0]
    rows = np.where((y >= ymin) & (y <= ymax))[0]
    if cols.size == 0 or rows.size == 0:
        return None
    return int(rows[0]), int(rows[-1]) + 1, int(cols[0]), int(cols[-1]) + 1


def multilook(a, n):
    """Average n x n blocks (in linear power), ignoring missing pixels."""
    if n <= 1:
        return a
    r, c = (a.shape[0] // n) * n, (a.shape[1] // n) * n
    if r == 0 or c == 0:
        return a
    blocks = a[:r, :c].reshape(r // n, n, c // n, n)
    with np.errstate(invalid="ignore"):
        return np.nanmean(blocks, axis=(1, 3))


def to_db(linear):
    """Linear power -> dB. Zero, negative and missing values become NODATA."""
    out = np.full(linear.shape, NODATA, dtype=np.float32)
    ok = np.isfinite(linear) & (linear > 0)
    out[ok] = 10.0 * np.log10(linear[ok])
    return out


# ----------------------------------------------------------------------------- per scene
def read_epsg(grp):
    proj = grp["projection"]
    if "epsg_code" in proj.attrs:
        return int(np.asarray(proj.attrs["epsg_code"]).item())
    return int(np.asarray(proj[()]).item())


def process(h5file, label, bbox, args):
    import h5py
    import rasterio
    from pyproj import Transformer
    from rasterio.transform import Affine

    info = scene_info(label)
    with h5py.File(h5file, "r") as f:
        path = GRID.format(freq=args.frequency)
        if path not in f:
            print(f"  ! {info['name']}: no {args.frequency} grid, skipped")
            return None
        grp = f[path]
        epsg = read_epsg(grp)
        x = grp["xCoordinates"][:]
        y = grp["yCoordinates"][:]

        # Area corners (densified edges) -> the product's map projection
        tr = Transformer.from_crs(4326, epsg, always_xy=True)
        x0, y0, x1, y1 = bbox
        t = np.linspace(0, 1, 21)
        lons = np.concatenate([x0 + (x1 - x0) * t, np.full(21, x1), x1 - (x1 - x0) * t, np.full(21, x0)])
        lats = np.concatenate([np.full(21, y0), y0 + (y1 - y0) * t, np.full(21, y1), y1 - (y1 - y0) * t])
        px, py = tr.transform(lons, lats)
        win = window_indices(x, y, px.min(), px.max(), py.min(), py.max())
        if win is None:
            print(f"  ! {info['name']}: does not overlap your area, skipped")
            return None
        r0, r1, c0, c1 = win

        co = "HHHH" if "HHHH" in grp else ("VVVV" if "VVVV" in grp else None)
        cx = "HVHV" if "HVHV" in grp else ("VHVH" if "VHVH" in grp else None)
        if co is None or cx is None:
            print(f"  ! {info['name']}: needs a co-pol and cross-pol layer, found "
                  f"{[k for k in grp.keys() if len(k) == 4 and k.isupper()]}, skipped")
            return None

        print(f"  reading {r1 - r0} x {c1 - c0} pixels of {co}, {cx} ...")
        bands = []
        for name in (co, cx):
            a = grp[name][r0:r1, c0:c1].astype(np.float32)
            a[~np.isfinite(a) | (a <= 0)] = np.nan
            bands.append(a)

        dx = float(np.asarray(grp["xCoordinateSpacing"][()]))
        dy = float(np.asarray(grp["yCoordinateSpacing"][()]))
        ys = y[r0:r1]
        if ys.size > 1 and ys[1] > ys[0]:          # make rows run north -> south
            bands = [b[::-1] for b in bands]
            ys = ys[::-1]
        dy = -abs(dy)

    n = max(1, args.looks)
    bands = [to_db(multilook(b, n)) for b in bands]
    west = x[c0] - abs(dx) / 2.0
    north = ys[0] + abs(dy) / 2.0
    transform = Affine(abs(dx) * n, 0.0, west, 0.0, dy * n, north)

    os.makedirs(args.out, exist_ok=True)
    out = os.path.join(args.out,
                       f"NISAR_{info['date']}_{info['direction']}_T{info['track']}.tif")
    profile = dict(driver="GTiff", dtype="float32", count=2,
                   height=bands[0].shape[0], width=bands[0].shape[1],
                   crs=f"EPSG:{epsg}", transform=transform, nodata=NODATA,
                   compress="deflate", tiled=True, blockxsize=256, blockysize=256)
    with rasterio.open(out, "w", **profile) as dst:
        dst.write(bands[0], 1)
        dst.write(bands[1], 2)
        dst.set_band_description(1, co[:2])
        dst.set_band_description(2, cx[:2])

    valid = bands[1][bands[1] != NODATA]
    med = f"{np.median(valid):.1f} dB" if valid.size else "no valid pixels"
    size_mb = os.path.getsize(out) / 1e6
    print(f"  -> {out}  ({size_mb:.1f} MB, median {cx[:2]} {med})")
    return out


# ----------------------------------------------------------------------------- main
def main(argv=None):
    args = parse_args(argv)
    bbox = area_bbox(args)
    print(f"Area (lon/lat): {bbox}")

    if args.h5:
        for h in args.h5:
            print(f"\n{os.path.basename(h)}")
            process(h, h, bbox, args)
        return

    urls = search(bbox, args.start, args.end, args.direction, args.max_products)
    if not urls:
        sys.exit("No NISAR GCOV scenes found. Try wider dates, a bigger area, or no --direction.\n"
                 "Note: calibrated NISAR data starts 2026-06-17; older data is still being released.")

    print(f"\nFound {len(urls)} scene(s):")
    for u in urls:
        i = scene_info(u)
        print(f"  {i['date']}  direction={i['direction']}  track={i['track']}  {i['name']}")
    dirs = {scene_info(u)["direction"] for u in urls}
    if len(dirs) > 1:
        print("\nTip: scenes from both directions were found. Compare only the same\n"
              "direction - re-run with --direction A or --direction D.")
    if args.list_only:
        return

    import earthaccess
    earthaccess.login(strategy="interactive", persist=True)

    written = []
    if args.download:
        files = earthaccess.download(urls, local_path=os.path.join(args.out, "h5"))
        for u, fpath in zip(urls, files):
            print(f"\n{scene_info(u)['name']}")
            written.append(process(fpath, u, bbox, args))
    else:
        for u in urls:
            print(f"\n{scene_info(u)['name']}")
            try:
                fobj = earthaccess.open([u])[0]
                written.append(process(fobj, u, bbox, args))
            except Exception as e:  # network hiccup or server refusing range reads
                print(f"  ! streaming failed ({e}).\n    Re-run with --download to fetch whole files.")

    written = [w for w in written if w]
    print(f"\nDone: {len(written)} GeoTIFF(s) in '{args.out}/'.")
    print("Next: Earth Engine Code Editor -> Assets -> NEW -> GeoTIFF -> upload each file.")


if __name__ == "__main__":
    main()
