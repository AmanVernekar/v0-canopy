"""
Fetch Southwark UHI dataset.
Run: python fetch-southwark.py
Output: southwark.json (~5–20MB)
"""

import json
import time
import requests
import pandas as pd
import geopandas as gpd
from pathlib import Path
from shapely.geometry import shape, mapping

# Southwark = E09000028
LA_CODE = "E09000028"
RAW_DIR = Path("./raw")
RAW_DIR.mkdir(exist_ok=True)

OUT = {}

def log(msg):
    print(f"[fetch] {msg}", flush=True)

# ────────────────────────────────────────────────────────────────────────
# 1. LSOA boundaries (ONS Open Geography Portal)
# ────────────────────────────────────────────────────────────────────────
log("Fetching LSOA 2021 boundaries for Southwark…")

# ONS ArcGIS REST endpoint. The boundary layer doesn't carry a LAD code field,
# so we filter by LSOA21NM — Southwark LSOAs are named "Southwark 001A" etc.
LSOA_URL = (
    "https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/"
    "LSOA_2021_EW_BSC_V4_RUC/FeatureServer/0/query"
)
params = {
    "where": "LSOA21NM LIKE 'Southwark%'",
    "outFields": "LSOA21CD,LSOA21NM",
    "outSR": "4326",
    "f": "geojson",
    "resultRecordCount": 2000,
}
r = requests.get(LSOA_URL, params=params, timeout=60)
r.raise_for_status()
lsoa_gj = r.json()
log(f"  → {len(lsoa_gj['features'])} LSOAs")

for f in lsoa_gj["features"]:
    code = f["properties"].get("LSOA21CD") or f["properties"].get("LSOA22CD")
    name = f["properties"].get("LSOA21NM") or f["properties"].get("LSOA22NM")
    OUT[code] = {
        "name": name,
        "geometry": f["geometry"],
        "imd_decile": None,
        "vulnerability_score": None,
        "canopy_cover_pct": None,
        "tree_equity_score": None,
        "building_count": 0,
        "population": None,
        "pop_density_per_ha": None,
        "pct_over_65": None,
        "pct_under_5": None,
        "streets": [],
        "buildings": [],
    }

# ────────────────────────────────────────────────────────────────────────
# 2. IMD 2019 deciles
# ────────────────────────────────────────────────────────────────────────
log("Fetching IMD 2019…")
# 2019 IMD is keyed on LSOA 2011 codes — Southwark LSOA 2021 codes are mostly
# unchanged (a handful re-coded). For the demo this is fine; flag in-app.
IMD_URL = (
    "https://assets.publishing.service.gov.uk/government/uploads/system/"
    "uploads/attachment_data/file/833970/File_1_-_IMD2019_Index_of_Multiple_Deprivation.xlsx"
)
imd_path = RAW_DIR / "imd2019.xlsx"
if not imd_path.exists():
    r = requests.get(IMD_URL, timeout=120)
    r.raise_for_status()
    imd_path.write_bytes(r.content)

imd = pd.read_excel(imd_path, sheet_name="IMD2019")
imd_col_code = next(c for c in imd.columns if "LSOA code" in c)
imd_col_decile = next(c for c in imd.columns if "Decile" in c and "IMD" in c)

for _, row in imd.iterrows():
    code = row[imd_col_code]
    if code in OUT:
        OUT[code]["imd_decile"] = int(row[imd_col_decile])

log(f"  → IMD attached")

# ────────────────────────────────────────────────────────────────────────
# 3. ONS population + age structure (Census 2021)
# ────────────────────────────────────────────────────────────────────────
# NOMIS dataset NM_2020_1 = TS007A (age by 5-year bands), keyed on c2021_age_19.
# Bands: 0=Total, 1=under 5, 14-18=65+. Pass LSOA codes explicitly (chunked) so
# we don't scan all ~33k EW LSOAs.
log("Fetching ONS Census 2021 population by LSOA…")

NOMIS_BASE = "https://www.nomisweb.co.uk/api/v01/dataset/NM_2020_1.data.json"
lsoa_codes = list(OUT.keys())
age_map = {}  # code -> {band_id: count}

for i in range(0, len(lsoa_codes), 100):
    chunk = ",".join(lsoa_codes[i:i + 100])
    params = {
        "date": "latest",
        "geography": chunk,
        "measures": "20100",
        "select": "geography_code,c2021_age_19,obs_value",
    }
    r = requests.get(NOMIS_BASE, params=params, timeout=120)
    if not r.ok:
        log(f"  ⚠ NOMIS chunk {i//100} failed ({r.status_code})")
        continue
    for obs in r.json().get("obs", []):
        code = obs["geography"]["geogcode"]
        if code not in OUT:
            continue
        band_id = obs["c2021_age_19"]["value"]
        age_map.setdefault(code, {})[band_id] = obs["obs_value"]["value"]

for code, bands in age_map.items():
    total = bands.get(0)  # band 0 = Total
    if not total:
        continue
    OUT[code]["population"] = total
    under_5 = bands.get(1, 0)  # band 1 = "Aged 4 years and under"
    over_65 = sum(bands.get(b, 0) for b in (14, 15, 16, 17, 18))  # 65-69 ... 85+
    OUT[code]["pct_under_5"] = round(100 * under_5 / total, 1)
    OUT[code]["pct_over_65"] = round(100 * over_65 / total, 1)

log(f"  → population attached for {len(age_map)} LSOAs")

# Compute pop density from polygon area (approx, EPSG:27700 in metres)
log("Computing population density…")
gdf = gpd.GeoDataFrame.from_features(lsoa_gj, crs="EPSG:4326").to_crs("EPSG:27700")
gdf["area_ha"] = gdf.geometry.area / 10000  # m² → ha
for _, row in gdf.iterrows():
    code = row.get("LSOA21CD") or row.get("LSOA22CD")
    if code in OUT and OUT[code]["population"]:
        OUT[code]["pop_density_per_ha"] = round(OUT[code]["population"] / row["area_ha"], 1)

# ────────────────────────────────────────────────────────────────────────
# 4. Tree Equity Score UK (American Forests + Woodland Trust)
# ────────────────────────────────────────────────────────────────────────
# Per-LSOA in England, keyed on LSOA21CD via the `bge_code` field. Single
# England-wide CSV (~4 MB), filter on la_code = E09000028 for Southwark.
log("Fetching Tree Equity Score UK…")
import zipfile
import io

TES_UK_URL = "https://tes-uk-app-data-share.s3.amazonaws.com/england/england_csv.zip"
tes_csv_path = RAW_DIR / "england_tes.csv"
if not tes_csv_path.exists():
    r = requests.get(TES_UK_URL, timeout=120)
    r.raise_for_status()
    with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
        # archive contains a single CSV — extract whichever .csv is in there
        csv_name = next(n for n in zf.namelist() if n.lower().endswith(".csv"))
        tes_csv_path.write_bytes(zf.read(csv_name))

tes_df = pd.read_csv(tes_csv_path, low_memory=False)
southwark_tes = tes_df[tes_df["la_code"] == LA_CODE]
log(f"  → {len(southwark_tes)} TES UK rows for Southwark")

attached = 0
for _, row in southwark_tes.iterrows():
    code = row["bge_code"]
    if code not in OUT:
        continue
    canopy = row.get("treecanopy")
    score = row.get("tes")
    if pd.notna(canopy):
        OUT[code]["canopy_cover_pct"] = round(float(canopy) * 100, 1)
    if pd.notna(score):
        OUT[code]["tree_equity_score"] = round(float(score), 1)
    attached += 1
log(f"  → canopy + TES attached to {attached} LSOAs")

# ────────────────────────────────────────────────────────────────────────
# 5. OSM streets and buildings via Overpass
# ────────────────────────────────────────────────────────────────────────
log("Fetching OSM streets and buildings (this is the slow part)…")

# Bbox for Southwark, generous: roughly 51.42–51.51 N, -0.12 to -0.02 W
OVERPASS = "https://overpass-api.de/api/interpreter"
# Overpass returns 406 for the default python-requests User-Agent.
OVERPASS_HEADERS = {"User-Agent": "canopy-hackathon/0.1 (aman@adiathermal.co.uk)"}

# Streets: highways, exclude motorways/footways/service
streets_query = """
[out:json][timeout:120];
area["wikidata"="Q730706"]->.southwark;
(
  way["highway"~"^(primary|secondary|tertiary|residential|unclassified|living_street)$"](area.southwark);
);
out geom;
"""
r = requests.post(OVERPASS, data={"data": streets_query}, headers=OVERPASS_HEADERS, timeout=180)
r.raise_for_status()
streets_data = r.json()
log(f"  → {len(streets_data['elements'])} street ways")

# Buildings
buildings_query = """
[out:json][timeout:180];
area["wikidata"="Q730706"]->.southwark;
(
  way["building"](area.southwark);
);
out geom;
"""
r = requests.post(OVERPASS, data={"data": buildings_query}, headers=OVERPASS_HEADERS, timeout=300)
r.raise_for_status()
buildings_data = r.json()
log(f"  → {len(buildings_data['elements'])} buildings")

# Spatial bin to LSOAs
from shapely.geometry import Polygon, LineString, Point

lsoa_polys = {}
for f in lsoa_gj["features"]:
    code = f["properties"].get("LSOA21CD") or f["properties"].get("LSOA22CD")
    lsoa_polys[code] = shape(f["geometry"])

def find_lsoa(point):
    for code, poly in lsoa_polys.items():
        if poly.contains(point):
            return code
    return None

log("Binning streets to LSOAs…")
for el in streets_data["elements"]:
    if "geometry" not in el or len(el["geometry"]) < 2:
        continue
    coords = [(p["lon"], p["lat"]) for p in el["geometry"]]
    centroid = LineString(coords).centroid
    code = find_lsoa(centroid)
    if code and code in OUT:
        OUT[code]["streets"].append({
            "id": el["id"],
            "name": el.get("tags", {}).get("name"),
            "highway": el.get("tags", {}).get("highway"),
            "coords": coords,
        })

log("Binning buildings to LSOAs…")
for el in buildings_data["elements"]:
    if "geometry" not in el or len(el["geometry"]) < 3:
        continue
    coords = [(p["lon"], p["lat"]) for p in el["geometry"]]
    if coords[0] != coords[-1]:
        coords.append(coords[0])
    try:
        poly = Polygon(coords)
        if not poly.is_valid:
            continue
        code = find_lsoa(poly.centroid)
        if code and code in OUT:
            OUT[code]["buildings"].append({
                "id": el["id"],
                "coords": coords,
            })
            OUT[code]["building_count"] += 1
    except Exception:
        continue

# ────────────────────────────────────────────────────────────────────────
# 6. Compute composite vulnerability score
# ────────────────────────────────────────────────────────────────────────
# Proxy: weighted combination of (1) IMD inverse decile, (2) age vulnerability
# (over-65 + under-5), (3) low canopy, (4) high density.
# All normalised 0–1, weights chosen to be defensible not optimal.
log("Computing composite vulnerability score…")

def safe_minmax(values):
    vals = [v for v in values if v is not None]
    if not vals:
        return lambda x: 0
    lo, hi = min(vals), max(vals)
    if hi == lo:
        return lambda x: 0.5
    return lambda x: (x - lo) / (hi - lo) if x is not None else 0

imd_norm    = safe_minmax([(11 - v["imd_decile"]) for v in OUT.values() if v["imd_decile"]])
age_norm    = safe_minmax([(v.get("pct_over_65") or 0) + (v.get("pct_under_5") or 0) for v in OUT.values()])
canopy_norm = safe_minmax([v.get("canopy_cover_pct") for v in OUT.values()])
dens_norm   = safe_minmax([v.get("pop_density_per_ha") for v in OUT.values()])

for code, v in OUT.items():
    imd_score    = imd_norm(11 - v["imd_decile"]) if v["imd_decile"] else 0
    age_score    = age_norm((v.get("pct_over_65") or 0) + (v.get("pct_under_5") or 0))
    canopy_score = 1 - canopy_norm(v.get("canopy_cover_pct"))   # low canopy = high vulnerability
    dens_score   = dens_norm(v.get("pop_density_per_ha"))
    v["vulnerability_score"] = round(
        0.35 * imd_score + 0.25 * age_score + 0.25 * canopy_score + 0.15 * dens_score, 3
    )

# ────────────────────────────────────────────────────────────────────────
# 7. Write
# ────────────────────────────────────────────────────────────────────────
out_path = Path("southwark.json")
with out_path.open("w") as f:
    json.dump(OUT, f, separators=(",", ":"))

size_mb = out_path.stat().st_size / 1024 / 1024
log(f"\n✓ Wrote {out_path} ({size_mb:.1f} MB) covering {len(OUT)} LSOAs")
log(f"  Sample LSOA: {next(iter(OUT))} → "
    f"{OUT[next(iter(OUT))]['name']}, "
    f"vuln={OUT[next(iter(OUT))]['vulnerability_score']}")