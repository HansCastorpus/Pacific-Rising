"""
Export the Landsat Coastlines GeoPackage layers to newline-delimited GeoJSON
(EPSG:4326), enriched with fields dropped from the original PMTiles export,
ready for re-tiling with tippecanoe.

Adds to the hotspot layers (which carry no eez_territory or direction in the
source GeoPackage) via a spatial join against rates_of_change:
  - eez_territory: majority vote among nearby rates_of_change points
  - direction: circular mean of angle_mean (axial, 0-180 domain) among nearby
    points, combined with the hotspot's own rate_time sign to produce a full
    0-360 bearing (assumes angle_mean's 0-180 axis represents the seaward
    bearing; accretion keeps that bearing, erosion flips it +180). This is a
    documented assumption -- verify visually once rendered and flip if arrows
    point the wrong way.
"""

import json
import math
import sqlite3
import struct
import sys
from collections import Counter

import numpy as np
from pyproj import Transformer
from scipy.spatial import cKDTree

DB_PATH = "data/Landsat Coastlines Geopackage .gpkg"
OUT_DIR = "build"
YEARS = list(range(1999, 2024))
DIST_COLS = [f"dist_{y}" for y in YEARS]

transformer = Transformer.from_crs(3832, 4326, always_xy=True)

COORD_PRECISION = 6  # ~0.1m at the equator; plenty for Landsat-derived (~30m) data
VALUE_PRECISION = 3


def rn(v, nd=VALUE_PRECISION):
    """Round a numeric value, passing None through."""
    return None if v is None else round(v, nd)


def round_coord_pair(pair):
    return [round(pair[0], COORD_PRECISION), round(pair[1], COORD_PRECISION)]


# Pohnpei's map center - used only to disambiguate which of angle_mean's two
# axial (180deg-apart) directions points seaward, since angle_mean alone
# doesn't encode that. "Away from this fixed point" is a reasonable proxy for
# "toward open ocean" for one compact island; it would need reworking for a
# multi-island view.
SEAWARD_REF_LON = 158.22
SEAWARD_REF_LAT = 6.87


def bearing_deg(lon1, lat1, lon2, lat2):
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dlambda = math.radians(lon2 - lon1)
    y = math.sin(dlambda) * math.cos(phi2)
    x = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(dlambda)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def angular_diff(a, b):
    d = abs(a - b) % 360
    return min(d, 360 - d)


def compute_seaward_angle(lon, lat, angle_mean):
    """Pick whichever of angle_mean / angle_mean+180 points closer to "away
    from the reference center", to resolve angle_mean's inherent axial
    (undirected) ambiguity."""
    if angle_mean is None:
        return None
    bearing_to_center = bearing_deg(lon, lat, SEAWARD_REF_LON, SEAWARD_REF_LAT)
    away_from_center = (bearing_to_center + 180) % 360
    candidates = [angle_mean % 360, (angle_mean + 180) % 360]
    return min(candidates, key=lambda c: angular_diff(c, away_from_center))


def unwrap_line_lon(points):
    """Unwrap longitude discontinuities from antimeridian crossings so
    consecutive vertices in a line don't jump ~360 degrees (which otherwise
    renders as a spurious line straight across the map). points: list of
    [lon, lat]."""
    if not points:
        return points
    out = [list(points[0])]
    offset = 0.0
    for i in range(1, len(points)):
        lon, lat = points[i]
        delta = lon - points[i - 1][0]
        if delta > 180:
            offset -= 360
        elif delta < -180:
            offset += 360
        out.append([lon + offset, lat])
    return out


def parse_geom(blob):
    """Parse a GeoPackage geometry blob (Point or MultiLineString) into raw
    EPSG:3832 coordinates. Returns ('Point', (x, y)) or
    ('MultiLineString', [[(x, y), ...], ...])."""
    if blob is None:
        return None, None
    flags = blob[3]
    envelope_sizes = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}
    env_len = envelope_sizes[(flags >> 1) & 0x07]
    offset = 8 + env_len
    wkb_type = struct.unpack_from("<I", blob, offset + 1)[0]
    if wkb_type == 1:  # Point
        x, y = struct.unpack_from("<dd", blob, offset + 5)
        return "Point", (x, y)
    if wkb_type == 5:  # MultiLineString
        pos = offset + 5
        num_lines = struct.unpack_from("<I", blob, pos)[0]
        pos += 4
        lines = []
        for _ in range(num_lines):
            pos += 5  # skip byte order + line wkb type
            num_points = struct.unpack_from("<I", blob, pos)[0]
            pos += 4
            coords = list(struct.unpack_from(f"<{num_points * 2}d", blob, pos))
            pos += num_points * 16
            lines.append(list(zip(coords[0::2], coords[1::2])))
        return "MultiLineString", lines
    raise ValueError(f"Unsupported WKB type {wkb_type}")


def reproject_points(xy_array):
    """Vectorized 3832 -> 4326 reprojection. xy_array: (N, 2) numpy array."""
    lon, lat = transformer.transform(xy_array[:, 0], xy_array[:, 1])
    return np.column_stack([lon, lat])


def export_shorelines(con):
    print("Exporting shorelines_annual...", flush=True)
    cur = con.cursor()
    cur.execute("SELECT fid, geom, year, certainty, eez_territory FROM shorelines_annual")
    n = 0
    with open(f"{OUT_DIR}/shorelines_annual.geojsonl", "w") as out:
        for fid, geom_blob, year, certainty, eez in cur:
            gtype, lines = parse_geom(geom_blob)
            if gtype != "MultiLineString":
                continue
            reproj_lines = []
            for line in lines:
                arr = np.array(line)
                arr4326 = reproject_points(arr)
                unwrapped = unwrap_line_lon(arr4326.tolist())
                reproj_lines.append([round_coord_pair(p) for p in unwrapped])
            feature = {
                "type": "Feature",
                "geometry": {"type": "MultiLineString", "coordinates": reproj_lines},
                "properties": {
                    "year": year,
                    "certainty": certainty,
                    "eez_territory": eez or "",
                },
            }
            out.write(json.dumps(feature, separators=(",", ":")) + "\n")
            n += 1
    print(f"  wrote {n} features", flush=True)


def export_rates_of_change(con):
    print("Exporting rates_of_change...", flush=True)
    cur = con.cursor()
    dist_sql = ", ".join(DIST_COLS)
    cur.execute(
        f"SELECT fid, geom, rate_time, sig_time, se_time, certainty, eez_territory, angle_mean, {dist_sql} "
        f"FROM rates_of_change"
    )
    n = 0
    with open(f"{OUT_DIR}/rates_of_change.geojsonl", "w") as out:
        batch_rows = cur.fetchmany(50000)
        while batch_rows:
            xy = np.array([parse_geom(r[1])[1] for r in batch_rows])
            lonlat = reproject_points(xy)
            for row, (lon, lat) in zip(batch_rows, lonlat):
                fid, _geom, rate_time, sig_time, se_time, certainty, eez, angle_mean, *dists = row
                props = {
                    "rate_time": rn(rate_time),
                    "sig_time": rn(sig_time),
                    "se_time": rn(se_time),
                    "certainty": certainty,
                    "eez_territory": eez or "",
                    "angle_mean": rn(angle_mean, 1),
                    "angle_seaward": rn(compute_seaward_angle(lon, lat, angle_mean), 1),
                }
                for y, d in zip(YEARS, dists):
                    props[f"dist_{y}"] = rn(d)
                feature = {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": round_coord_pair([lon, lat])},
                    "properties": props,
                }
                out.write(json.dumps(feature, separators=(",", ":")) + "\n")
                n += 1
            if n % 200000 < 50000:
                print(f"  ...{n} so far", flush=True)
            batch_rows = cur.fetchmany(50000)
    print(f"  wrote {n} features", flush=True)


def load_rates_of_change_join_data(con):
    """Load minimal columns needed for the hotspot spatial join, in native
    EPSG:3832 coordinates (same CRS radius_m is defined in)."""
    print("Loading rates_of_change join data (coords, angle_mean, eez)...", flush=True)
    cur = con.cursor()
    cur.execute("SELECT geom, angle_mean, eez_territory FROM rates_of_change")
    xs, ys, angles, eezs = [], [], [], []
    for geom_blob, angle_mean, eez in cur:
        _gtype, (x, y) = parse_geom(geom_blob)
        xs.append(x)
        ys.append(y)
        angles.append(angle_mean if angle_mean is not None else np.nan)
        eezs.append(eez or "")
    xy = np.column_stack([xs, ys])
    angles = np.array(angles, dtype=float)
    eezs = np.array(eezs, dtype=object)
    print(f"  loaded {len(xs)} points, building KDTree...", flush=True)
    tree = cKDTree(xy)
    return tree, xy, angles, eezs


def circular_mean_axial_deg(angles_deg):
    """Circular mean of axial (0-180 period) angle data, in degrees."""
    angles_deg = angles_deg[~np.isnan(angles_deg)]
    if len(angles_deg) == 0:
        return None
    rad2 = np.deg2rad(angles_deg) * 2
    mx = np.mean(np.cos(rad2))
    my = np.mean(np.sin(rad2))
    mean_deg = np.rad2deg(np.arctan2(my, mx)) / 2
    return mean_deg % 180


def export_hotspots(con, layer_name, radius_m, tree, xy, angles, eezs):
    print(f"Exporting {layer_name} (radius {radius_m}m)...", flush=True)
    cur = con.cursor()
    dist_sql = ", ".join(DIST_COLS)
    cur.execute(
        f"SELECT fid, geom, rate_time, sig_time, certainty, radius_m, n, {dist_sql} "
        f"FROM {layer_name}"
    )
    rows = cur.fetchall()
    n_written = 0
    n_no_neighbors = 0
    with open(f"{OUT_DIR}/{layer_name}.geojsonl", "w") as out:
        for row in rows:
            fid, geom_blob, rate_time, sig_time, certainty, r_m, n_pts, *dists = row
            gtype, (x, y) = parse_geom(geom_blob)
            idxs = tree.query_ball_point([x, y], r=radius_m)
            if not idxs:
                _, nearest_idx = tree.query([x, y], k=1)
                idxs = [int(nearest_idx)]
                n_no_neighbors += 1
            nearby_angles = angles[idxs]
            nearby_eez = eezs[idxs]
            axis_angle = circular_mean_axial_deg(nearby_angles)
            direction = None
            if axis_angle is not None:
                if rate_time is not None and rate_time < 0:
                    direction = axis_angle % 360
                else:
                    direction = (axis_angle + 180) % 360
            eez_counts = Counter(e for e in nearby_eez if e)
            eez_territory = eez_counts.most_common(1)[0][0] if eez_counts else ""
            lon, lat = reproject_points(np.array([[x, y]]))[0]
            props = {
                "rate_time": rn(rate_time),
                "sig_time": rn(sig_time),
                "certainty": certainty,
                "radius_m": r_m,
                "n": n_pts,
                "eez_territory": eez_territory,
                "direction": rn(direction, 1),
            }
            for yy, d in zip(YEARS, dists):
                props[f"dist_{yy}"] = rn(d)
            feature = {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": round_coord_pair([lon, lat])},
                "properties": props,
            }
            out.write(json.dumps(feature, separators=(",", ":")) + "\n")
            n_written += 1
    print(f"  wrote {n_written} features ({n_no_neighbors} used nearest-point fallback)", flush=True)


def main():
    target = sys.argv[1] if len(sys.argv) > 1 else "all"
    con = sqlite3.connect(DB_PATH)

    if target in ("shorelines_annual", "all"):
        export_shorelines(con)
    if target in ("rates_of_change", "all"):
        export_rates_of_change(con)
    if target in ("hotspots_zoom_1", "hotspots_zoom_2", "hotspots_zoom_3", "all"):
        tree, xy, angles, eezs = load_rates_of_change_join_data(con)
        radii = {"hotspots_zoom_1": 15000, "hotspots_zoom_2": 5000, "hotspots_zoom_3": 1000}
        for layer, radius in radii.items():
            if target in (layer, "all"):
                export_hotspots(con, layer, radius, tree, xy, angles, eezs)

    con.close()
    print("Done.", flush=True)


if __name__ == "__main__":
    main()
