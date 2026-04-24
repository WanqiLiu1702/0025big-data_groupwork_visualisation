# Visualization Handoff

This repository contains the visualization-side handoff files for the
CASA0025 scam compound project.

## Current script

- `scam_compound_gee_app_v3.js`
  - Current Google Earth Engine app script.
  - This is the main file to paste into the Earth Engine Code Editor.
  - V3 keeps the lightweight map design and focuses on:
    - candidate density map
    - confirmed / suspected / control site layers
    - stage funnel
    - precomputed validation charts
    - evidence scatter
    - priority review list

## Legacy files

- `scam_compound_gee_app.js`
  - Earlier app version kept for reference.
- `index_draft.qmd`
  - Draft write-up / page content from the earlier workflow.

## Data assumptions in V3

The script is configured to read these Earth Engine assets:

```javascript
var SCAM_POINTS_ASSET = 'projects/casa0025wk6/assets/scam_points_cleaned';
var CANDIDATE_ASSET = 'projects/casa0025wk6/assets/Final_Summary_Table_Complete';
```

The current Stage 2 candidate outputs are effectively the
Cambodia-Vietnam workflow outputs. The broader reported-site points still
include Cambodia, Myanmar, Thailand, and Vietnam context points.

## Local supporting files

- `data/`
  - small derived files used for web / static exploration
- `gee_upload_ready/`
  - earlier upload-ready GIS exports kept for reference

## Handoff note

If someone else continues the app, start from `scam_compound_gee_app_v3.js`
rather than the older V1/V2 logic.
