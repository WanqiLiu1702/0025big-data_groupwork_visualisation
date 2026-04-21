# Visualization workflow

This folder contains the visualization-facing Earth Engine app script for the
CASA0025 scam compound pattern exploration project.

## Files

- `scam_compound_gee_app.js`: Google Earth Engine UI script. Paste into the
  Earth Engine Code Editor and publish as an Earth Engine App.

## Current app coverage

The script builds on the group analysis code and adds:

- AOI selector for Cambodia-Vietnam, Myanmar-Thailand, Golden Triangle, and
  Southeast Asia overview.
- Persistent semi-transparent boundaries for the three main AOIs, plus a
  "Show All Regions" button for the regional overview.
- Layer toggles for Sentinel-2 RGB, NDVI, NDBI, delta NDVI, delta NDBI,
  VIIRS night-time lights, delta night-time lights, and reported site classes.
- Reported site styling for confirmed, suspected, and control points.
- Final candidate layers split into high, medium, and low priority tiers.
- Summary counts and a mean NDVI/NDBI chart by site status.
- Candidate priority counts from the final summary asset.
- Map-click panel that samples the selected location, reports the nearest
  known site, and shows candidate metrics when the click falls inside a
  candidate area.

## Inputs needed from analysis

The app is currently set to run with the shared project asset that was already
available in the original group script:

```javascript
var SCAM_POINTS_ASSET = 'projects/project-2736c40e-7bac-492d-b63/assets/scam_sites';
var UPDATED_POINTS_ASSET = '';
var UPDATED_POINTS_NEEDS_LONLAT_GEOMETRY = false;
var CANDIDATE_ASSET = '';
```

`UPDATED_POINTS_ASSET` and `CANDIDATE_ASSET` are optional because the asset IDs
found in the analysis scripts were private to another account and may not load
in your Earth Engine account. To activate controls and candidates, ask the owner
to share these assets with you or upload the CSV/GeoJSON outputs under your own
account, then paste your asset IDs into those two variables.

The updated points asset should contain:

- `id`
- `country`
- `city`
- `name`
- `lat`
- `lon`
- `site_status`
- `context_type`

The final candidate asset should contain:

- `candidate_id`
- `priority_tier`
- `dNDBI_2021_2024`
- `dNDVI_2021_2024`
- `dNTL_2021_2024`
- `dist_to_border_m`
- `dist_to_confirmed_m`

## Usable outputs already found in the zip files

- `CASA0025Project-main.zip`: Quarto/GitHub Pages template and an early
  `index.qmd` draft.
- `CASA0025_Project_Template-main.zip`: clean Quarto template.
- `CASA0025_project_workspace-main.zip`: the important analysis materials:
  - `Analysis/1_embedding_similarity.js`: Google Satellite Embedding similarity
    screening and candidate point export.
  - `Analysis/2_candidate_metrics.js`: candidate buffers, NDVI/NDBI/NTL metrics,
    and distance-to-confirmed metrics.
  - `Analysis/04`: final candidate tiering and the asset ID
    `users/houm4ki/0025analysis/Final_Summary_Table_Complete`.
  - `Analysis/files/Final_Scam_Candidate_Summary_Table.csv`: final exported
    candidate table with geometry and priority tier.

## Presentation note

Use cautious wording in the interface and presentation. The app visualizes
spatial similarity and remote-sensing indicators; it does not verify that any
candidate location is a scam compound.
