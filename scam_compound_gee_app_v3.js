// CASA0025 GEE App V3 (performance-optimised build of V2)
//
// Functional parity with V2: density map, reported-site layers, stage funnel,
// validation charts, evidence scatter, priority review list.
//
// Key optimisations vs V2:
//   1. Candidate property normalisation uses FeatureCollection.select with
//      regex alternation — replaces the per-feature `If(contains(...))` chain.
//   2. Density image paints polygons directly (no centroid map / toDictionary)
//      and uses a single reduceNeighborhood with boxcar optimisation.
//   3. Reported points are filtered BEFORE lon/lat reparse, so only the ~150
//      kept features pay the parse cost.
//   4. Each AOI's fully-built layer stack is cached; switching AOIs reuses the
//      existing ui.Map.Layer objects, so tile requests hit server-side cache.
//   5. Tier-split candidate collections are built once per AOI and reused by
//      the evidence scatter and priority ranking.

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

var SCAM_POINTS_ASSET = 'projects/casa0025wk6/assets/scam_points_cleaned';
var CANDIDATE_ASSET = 'projects/casa0025wk6/assets/Final_Summary_Table_Complete';

// ---------------------------------------------------------------------------
// Precomputed workflow summaries
// ---------------------------------------------------------------------------

var WORKFLOW_COUNTS = {
  reported_confirmed: 53,
  reported_suspected: 45,
  stage1_candidates: 24464,
  stage2_high: 8425,
  stage2_medium: 13059,
  stage2_low: 2980,
  shortlist: 15
};

var PRECOMPUTED_VALIDATION = {
  high: {
    candidate_count: 8425,
    controls_hit_500m: 2,
    controls_hit_1000m: 6,
    controls_in_aoi: 22,
    non_reference_confirmed_hit_500m: 5,
    non_reference_confirmed_hit_1000m: 10,
    non_reference_confirmed_in_aoi: 50,
    suspected_hit_500m: 7,
    suspected_hit_1000m: 12,
    suspected_in_aoi: 45
  },
  medium: {
    candidate_count: 13059,
    controls_hit_500m: 4,
    controls_hit_1000m: 11,
    controls_in_aoi: 22,
    non_reference_confirmed_hit_500m: 14,
    non_reference_confirmed_hit_1000m: 18,
    non_reference_confirmed_in_aoi: 50,
    suspected_hit_500m: 5,
    suspected_hit_1000m: 13,
    suspected_in_aoi: 45
  },
  low: {
    candidate_count: 2980,
    controls_hit_500m: 2,
    controls_hit_1000m: 3,
    controls_in_aoi: 22,
    non_reference_confirmed_hit_500m: 1,
    non_reference_confirmed_hit_1000m: 2,
    non_reference_confirmed_in_aoi: 50,
    suspected_hit_500m: 0,
    suspected_hit_1000m: 0,
    suspected_in_aoi: 45
  },
  all_refined: {
    candidate_count: 24464,
    controls_hit_500m: 7,
    controls_hit_1000m: 12,
    controls_in_aoi: 22,
    non_reference_confirmed_hit_500m: 18,
    non_reference_confirmed_hit_1000m: 25,
    non_reference_confirmed_in_aoi: 50,
    suspected_hit_500m: 12,
    suspected_hit_1000m: 21,
    suspected_in_aoi: 45
  }
};

var VALIDATION_TIER_ORDER = ['high', 'medium', 'low', 'all_refined'];
var VALIDATION_TIER_LABELS = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  all_refined: 'All refined'
};

// ---------------------------------------------------------------------------
// AOIs
// ---------------------------------------------------------------------------

var AOIS = {
  'Cambodia-Vietnam detail': ee.Geometry.Rectangle([102.0, 10.0, 108.5, 15.5]),
  'Southeast Asia overview': ee.Geometry.Rectangle([94.5, 8.0, 109.5, 22.5])
};

var DEFAULT_AOI = 'Cambodia-Vietnam detail';

function isOverviewAoiName(aoiName) {
  return aoiName === 'Southeast Asia overview';
}

// ---------------------------------------------------------------------------
// Styling
// ---------------------------------------------------------------------------

var COLORS = {
  confirmed: '#d73027',
  suspected: '#f59e0b',
  control: '#2b6cb0',
  shortlist: '#e11d48',
  high: '#d946ef',
  medium: '#f97316',
  low: '#facc15',
  text: '#1f2937',
  muted: '#6b7280',
  border: '#d0d5dd',
  panelBg: '#ffffff',
  softBg: '#f8fafc'
};

var DENSITY_PALETTE = ['#1a9850', '#66bd63', '#a6d96a', '#fee08b', '#fdae61', '#f46d43', '#d73027'];

// Custom grayscale basemap style — lets the warm density palette and point
// layers carry the colour, instead of competing with satellite imagery.
var GRAYSCALE_STYLE = [
  {stylers: [{saturation: -100}, {gamma: 1.15}]},
  {elementType: 'labels.text.fill', stylers: [{color: '#6b7280'}]},
  {elementType: 'labels.text.stroke', stylers: [{color: '#ffffff'}, {weight: 2}]},
  {featureType: 'administrative.country', elementType: 'geometry.stroke',
   stylers: [{color: '#374151'}, {weight: 1}]},
  {featureType: 'water', stylers: [{color: '#dbeafe'}]},
  {featureType: 'landscape', stylers: [{color: '#f3f4f6'}]},
  {featureType: 'poi', stylers: [{visibility: 'off'}]},
  {featureType: 'transit', stylers: [{visibility: 'off'}]},
  {featureType: 'road', stylers: [{visibility: 'simplified'}, {color: '#d1d5db'}]}
];

// ---------------------------------------------------------------------------
// Input preparation
// ---------------------------------------------------------------------------

// Filter first so only the ~150 kept features pay the lon/lat parse cost.
var scamPoints = ee.FeatureCollection(SCAM_POINTS_ASSET)
  .filter(ee.Filter.inList('site_status', ['confirmed', 'suspected', 'control']))
  .map(function(f) {
    var lon = ee.Number.parse(ee.String(f.get('lon')));
    var lat = ee.Number.parse(ee.String(f.get('lat')));
    return f.setGeometry(ee.Geometry.Point([lon, lat]));
  });

// Normalise via FeatureCollection.select with regex alternation. Each
// alternation picks whichever name the asset actually uses, and the output
// column is renamed to the canonical one. Avoids the per-feature If chain
// that V2 ran across every one of the 24464 candidate polygons.
var candidates = ee.FeatureCollection(CANDIDATE_ASSET).select(
  [
    '^(candidate_id|cand_id)$',
    '^(priority_tier|tier)$',
    '^area_sqm$',
    '^(dNDBI_2021_2024|dndbi)$',
    '^(dNTL_2021_2024|dntl)$',
    '^(dNDVI_2021_2024|dndvi)$',
    '^(dist_to_confirmed_m|dist_conf)$',
    '^(NTL_2024|ntl_2024)$',
    '^(dist_to_border_m|dist_bord)$'
  ],
  [
    'candidate_id',
    'priority_tier',
    'area_sqm',
    'dNDBI_2021_2024',
    'dNTL_2021_2024',
    'dNDVI_2021_2024',
    'dist_to_confirmed_m',
    'NTL_2024',
    'dist_to_border_m'
  ]
);

function filterCandidatesByTier(collection, tierLabel) {
  return collection.filter(ee.Filter.eq('priority_tier', tierLabel));
}

// Country borders (LSIB 2017 simplified, ~200 features globally, cheap).
var COUNTRY_BORDERS = ee.FeatureCollection('USDOS/LSIB_SIMPLE/2017');

function styleCountryBorders(aoi) {
  return COUNTRY_BORDERS.filterBounds(aoi).style({
    color: '#1f2937',
    fillColor: '00000000',
    width: 1.2
  });
}

// Sentinel-2 SR median composite, clipped to the AOI. Renders as satellite
// imagery only inside the selected rectangle; the grayscale Google basemap
// stays visible everywhere else. Median over a full year + cloud filter
// gives near gap-free RGB without the cost of per-pixel cloud scoring.
var S2_VIS = {bands: ['B4', 'B3', 'B2'], min: 300, max: 3000, gamma: 1.3};

function buildAoiSatellite(aoi) {
  return ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(aoi)
    .filterDate('2024-01-01', '2025-06-01')
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 30))
    .select(['B4', 'B3', 'B2'])
    .median()
    .clip(aoi);
}

// ---------------------------------------------------------------------------
// Layer helpers
// ---------------------------------------------------------------------------

function stylePointCollection(collection, color, size) {
  return collection.style({
    color: '#ffffff',
    fillColor: color,
    pointSize: size || 7,
    pointShape: 'circle',
    width: 2
  });
}

function styleAoi(geometry) {
  return ee.FeatureCollection([ee.Feature(geometry)]).style({
    color: '#ffffff',
    fillColor: 'ffffff08',
    width: 4
  });
}

// Paints polygons at a fine (1 km) scale, sums candidates in a large square
// neighbourhood with boxcar optimisation, then keeps the OUTPUT at 1 km so
// the heat-map reads as a smooth gradient rather than a coarse grid. Bilinear
// resampling hides the remaining pixel edges at every zoom level.
function makeDensityImage(collection, aoi, smoothingRadius) {
  var PAINT_SCALE = 1000;

  var painted = ee.Image().byte().paint(collection, 1)
    .setDefaultProjection('EPSG:3857', null, PAINT_SCALE);

  var kernel = ee.Kernel.square({
    radius: smoothingRadius,
    units: 'meters',
    normalize: false
  });

  return painted
    .reduceNeighborhood({
      reducer: ee.Reducer.sum(),
      kernel: kernel,
      optimization: 'boxcar'
    })
    .rename('candidate_density')
    .reproject({crs: 'EPSG:3857', scale: PAINT_SCALE})
    .resample('bilinear')
    .clip(aoi)
    .selfMask();
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatNumber(value, digits) {
  if (value === null || value === undefined || isNaN(Number(value))) {
    return 'No data';
  }
  return Number(value).toFixed(digits);
}

function formatBorderDistance(value) {
  if (value === null || value === undefined || isNaN(Number(value)) || Number(value) >= 99999) {
    return 'No usable value';
  }
  return Number(value).toFixed(0) + ' m';
}

function shortCandidateId(value) {
  var text = value ? String(value) : 'Candidate';
  if (text.length <= 16) {
    return text;
  }
  return text.slice(0, 5) + '...' + text.slice(-4);
}

function formatTierLabel(value) {
  if (!value) {
    return 'Unknown';
  }
  var text = String(value).toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function tierColor(value) {
  if (value === 'high') {
    return COLORS.high;
  }
  if (value === 'medium') {
    return COLORS.medium;
  }
  if (value === 'low') {
    return COLORS.low;
  }
  return '#6b7280';
}

function histogramCount(hist, key) {
  if (!hist || hist[key] === undefined || hist[key] === null) {
    return 0;
  }
  return Number(hist[key]);
}

function histogramTotal(hist) {
  var total = 0;
  if (!hist) {
    return total;
  }
  Object.keys(hist).forEach(function(key) {
    total += Number(hist[key] || 0);
  });
  return total;
}

// ---------------------------------------------------------------------------
// Chart helpers (static, built once)
// ---------------------------------------------------------------------------

function makeStageFunnelChart() {
  var funnelFc = ee.FeatureCollection([
    ee.Feature(null, {stage: 'Reported confirmed', count: WORKFLOW_COUNTS.reported_confirmed}),
    ee.Feature(null, {stage: 'Reported suspected', count: WORKFLOW_COUNTS.reported_suspected}),
    ee.Feature(null, {stage: 'Stage 1 candidates', count: WORKFLOW_COUNTS.stage1_candidates}),
    ee.Feature(null, {stage: 'Stage 2 high', count: WORKFLOW_COUNTS.stage2_high}),
    ee.Feature(null, {stage: 'Stage 2 medium', count: WORKFLOW_COUNTS.stage2_medium}),
    ee.Feature(null, {stage: 'Stage 2 low', count: WORKFLOW_COUNTS.stage2_low}),
    ee.Feature(null, {stage: 'Shortlist', count: WORKFLOW_COUNTS.shortlist})
  ]);

  return ui.Chart.feature.byFeature(funnelFc, 'stage', 'count')
    .setChartType('BarChart')
    .setOptions({
      title: 'Stage funnel (Cambodia-Vietnam workflow)',
      legend: {position: 'none'},
      colors: ['#6d28d9'],
      hAxis: {title: 'Count'},
      vAxis: {title: ''},
      chartArea: {width: '72%', height: '78%'},
      height: 240
    });
}

function getValidationRows() {
  return VALIDATION_TIER_ORDER.map(function(tierKey) {
    var row = PRECOMPUTED_VALIDATION[tierKey];
    return {
      tier_label: VALIDATION_TIER_LABELS[tierKey],
      candidate_count: row.candidate_count,
      suspected_500_pct: 100 * row.suspected_hit_500m / row.suspected_in_aoi,
      suspected_1000_pct: 100 * row.suspected_hit_1000m / row.suspected_in_aoi,
      confirmed_500_pct: 100 * row.non_reference_confirmed_hit_500m / row.non_reference_confirmed_in_aoi,
      confirmed_1000_pct: 100 * row.non_reference_confirmed_hit_1000m / row.non_reference_confirmed_in_aoi,
      controls_500_pct: 100 * row.controls_hit_500m / row.controls_in_aoi,
      controls_1000_pct: 100 * row.controls_hit_1000m / row.controls_in_aoi
    };
  });
}

function makeValidationCountChart() {
  var rows = getValidationRows();
  var fc = ee.FeatureCollection(rows.map(function(row) {
    return ee.Feature(null, {tier: row.tier_label, candidates: row.candidate_count});
  }));
  return ui.Chart.feature.byFeature(fc, 'tier', 'candidates')
    .setChartType('ColumnChart')
    .setOptions({
      title: 'Candidate counts by tier',
      legend: {position: 'none'},
      colors: ['#6d28d9'],
      vAxis: {title: 'Candidates'},
      chartArea: {width: '78%', height: '65%'},
      height: 220
    });
}

function makeValidationRateChart(bufferLabel, suspectedField, confirmedField, controlField) {
  var rows = getValidationRows();
  var fc = ee.FeatureCollection(rows.map(function(row) {
    return ee.Feature(null, {
      tier: row.tier_label,
      suspected: row[suspectedField],
      confirmed: row[confirmedField],
      control: row[controlField]
    });
  }));
  return ui.Chart.feature.byFeature(fc, 'tier', ['suspected', 'confirmed', 'control'])
    .setChartType('ColumnChart')
    .setOptions({
      title: 'Validation hit rates (' + bufferLabel + ')',
      colors: [COLORS.suspected, COLORS.confirmed, COLORS.control],
      vAxis: {title: 'Hit rate (%)', viewWindow: {min: 0}},
      legend: {position: 'bottom'},
      chartArea: {width: '78%', height: '62%'},
      height: 240
    });
}

function addEvidenceScatter(panel, tierCollections, renderId) {
  panel.clear();
  panel.add(ui.Label(
    'Loading evidence scatter...',
    {fontSize: '12px', color: COLORS.muted}
  ));

  var samplePerTier = 60;
  var high = tierCollections.high
    .randomColumn('scatter_rand', 11).sort('scatter_rand').limit(samplePerTier);
  var medium = tierCollections.medium
    .randomColumn('scatter_rand', 22).sort('scatter_rand').limit(samplePerTier);
  var low = tierCollections.low
    .randomColumn('scatter_rand', 33).sort('scatter_rand').limit(samplePerTier);

  var scatterRows = high.merge(medium).merge(low)
    .map(function(f) {
      return ee.Feature(null, {
        row: ee.List([
          f.get('priority_tier'),
          f.get('dNDBI_2021_2024'),
          f.get('dNTL_2021_2024')
        ])
      });
    })
    .aggregate_array('row');

  scatterRows.evaluate(function(rows) {
    if (renderId !== activeRenderId) {
      return;
    }

    panel.clear();
    panel.add(ui.Label(
      'Each point is a sampled candidate. Bubble size has been removed because area_sqm is nearly constant in this dataset and was not helping readability.',
      {fontSize: '12px', color: COLORS.muted, whiteSpace: 'pre-wrap', margin: '0 0 8px 0'}
    ));

    if (!rows || !rows.length) {
      panel.add(ui.Label(
        'No candidate rows are available for the current AOI.',
        {fontSize: '12px', color: COLORS.muted}
      ));
      return;
    }

    var dataTable = [[
      {label: 'dNDBI 2021-2024', type: 'number'},
      {label: 'High', type: 'number'},
      {label: 'Medium', type: 'number'},
      {label: 'Low', type: 'number'}
    ]];

    rows.forEach(function(row) {
      var tier = row[0];
      var dNDBI = Number(row[1]);
      var dNTL = Number(row[2]);
      if (isNaN(dNDBI) || isNaN(dNTL)) {
        return;
      }
      dataTable.push([
        dNDBI,
        tier === 'high' ? dNTL : null,
        tier === 'medium' ? dNTL : null,
        tier === 'low' ? dNTL : null
      ]);
    });

    panel.add(ui.Chart(dataTable, 'ScatterChart', {
      title: 'Candidate evidence scatter (sampled by tier)',
      hAxis: {title: 'dNDBI 2021-2024'},
      vAxis: {title: 'dNTL 2021-2024'},
      colors: [COLORS.high, COLORS.medium, COLORS.low],
      pointSize: 5,
      dataOpacity: 0.72,
      legend: {position: 'top'},
      chartArea: {width: '82%', height: '68%'},
      height: 300
    }));
  });
}

function getRankConfig(mode) {
  if (mode === 'Closest to confirmed') {
    return {
      field: 'dist_to_confirmed_m',
      descending: false,
      title: 'Top candidates by distance to confirmed',
      metric: function(props) {
        return 'Distance to confirmed: ' + formatNumber(props.dist_to_confirmed_m, 0) + ' m';
      }
    };
  }
  if (mode === 'Highest dNDBI') {
    return {
      field: 'dNDBI_2021_2024',
      descending: true,
      title: 'Top candidates by built-up growth',
      metric: function(props) {
        return 'dNDBI 2021-2024: ' + formatNumber(props.dNDBI_2021_2024, 3);
      }
    };
  }
  return {
    field: 'dNTL_2021_2024',
    descending: true,
    title: 'Top candidates by night-time light growth',
    metric: function(props) {
      return 'dNTL 2021-2024: ' + formatNumber(props.dNTL_2021_2024, 2);
    }
  };
}

function buildTopCandidates(candidatesInAoi, rankMode) {
  var cfg = getRankConfig(rankMode);
  return candidatesInAoi.sort(cfg.field, !cfg.descending).limit(8);
}

function geometryCenter(geometry) {
  var coords = [];
  if (!geometry) {
    return null;
  }
  if (geometry.type === 'Point') {
    return {lon: geometry.coordinates[0], lat: geometry.coordinates[1]};
  }
  if (geometry.type === 'Polygon') {
    coords = geometry.coordinates[0];
  } else if (geometry.type === 'MultiPolygon') {
    coords = geometry.coordinates[0][0];
  }
  if (!coords || !coords.length) {
    return null;
  }
  var minLon = coords[0][0];
  var maxLon = coords[0][0];
  var minLat = coords[0][1];
  var maxLat = coords[0][1];
  for (var i = 1; i < coords.length; i++) {
    minLon = Math.min(minLon, coords[i][0]);
    maxLon = Math.max(maxLon, coords[i][0]);
    minLat = Math.min(minLat, coords[i][1]);
    maxLat = Math.max(maxLat, coords[i][1]);
  }
  return {lon: (minLon + maxLon) / 2, lat: (minLat + maxLat) / 2};
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

ui.root.clear();

var map = ui.Map();
map.setCenter(104.5, 13.0, 7);
map.setOptions('Grayscale', {Grayscale: GRAYSCALE_STYLE});
map.setControlVisibility({
  all: true,
  layerList: true,
  zoomControl: true,
  mapTypeControl: false,
  scaleControl: true,
  fullscreenControl: true
});

function makeLegendPointRow(label, color) {
  return ui.Panel([
    ui.Label('●', {color: color, fontSize: '16px', margin: '0 6px 0 0'}),
    ui.Label(label, {fontSize: '11px', color: COLORS.text, margin: '0'})
  ], ui.Panel.Layout.flow('horizontal'), {margin: '0 0 4px 0'});
}

function makeLegendDensityRow(label, colors) {
  return ui.Panel([
    ui.Panel(colors.map(function(color) {
      return ui.Label('', {width: '10px', height: '12px', backgroundColor: color, margin: '0'});
    }), ui.Panel.Layout.flow('horizontal'), {margin: '0 6px 0 0'}),
    ui.Label(label, {fontSize: '11px', color: COLORS.text, margin: '0'})
  ], ui.Panel.Layout.flow('horizontal'), {margin: '0 0 4px 0'});
}

var legendPanel = ui.Panel({
  style: {
    position: 'bottom-right',
    padding: '8px 10px',
    backgroundColor: 'rgba(255,255,255,0.94)',
    border: '1px solid ' + COLORS.border,
    maxWidth: '220px'
  }
});
legendPanel.add(ui.Label('Legend', {fontWeight: 'bold', fontSize: '12px', color: COLORS.text, margin: '0 0 6px 0'}));
legendPanel.add(makeLegendPointRow('Confirmed site', COLORS.confirmed));
legendPanel.add(makeLegendPointRow('Suspected site', COLORS.suspected));
legendPanel.add(makeLegendPointRow('Control site', COLORS.control));

// Density legend: colour ramp + numeric scale + unit caption. The scale and
// unit update on AOI switch via updateDensityLegend.
legendPanel.add(ui.Label('Candidate density', {fontSize: '11px', color: COLORS.text, margin: '2px 0 3px 0'}));
legendPanel.add(ui.Panel(DENSITY_PALETTE.map(function(color) {
  return ui.Label('', {width: '14px', height: '10px', backgroundColor: color, margin: '0'});
}), ui.Panel.Layout.flow('horizontal'), {margin: '0'}));

var densityScaleLabel = ui.Label('', {
  fontSize: '10px', color: COLORS.muted, margin: '2px 0 0 0'
});
var densityUnitsLabel = ui.Label('', {
  fontSize: '9px', color: COLORS.muted, margin: '1px 0 0 0', whiteSpace: 'pre-wrap'
});
legendPanel.add(densityScaleLabel);
legendPanel.add(densityUnitsLabel);

function updateDensityLegend(densityMax, kernelAreaKm2) {
  densityScaleLabel.setValue('1  —  ' + Math.round(densityMax / 2) + '  —  ' + densityMax + '+');
  densityUnitsLabel.setValue('candidates per ~' + kernelAreaKm2.toLocaleString() + ' km²');
}

map.add(legendPanel);

var leftPanel = ui.Panel({
  style: {width: '430px', padding: '14px', backgroundColor: COLORS.panelBg}
});

var layerPanel = ui.Panel({style: {margin: '6px 0 0 0'}});
var kpiPanel = ui.Panel({style: {margin: '10px 0 0 0'}});
var funnelPanel = ui.Panel({style: {margin: '10px 0 0 0'}});
var validationPanel = ui.Panel({
  style: {margin: '10px 0 0 0', padding: '10px', border: '1px solid ' + COLORS.border, backgroundColor: COLORS.softBg}
});
var evidencePanel = ui.Panel({
  style: {margin: '10px 0 0 0', padding: '10px', border: '1px solid ' + COLORS.border, backgroundColor: '#fff'}
});
var rankingPanel = ui.Panel({
  style: {margin: '10px 0 0 0', padding: '10px', border: '1px solid ' + COLORS.border, backgroundColor: '#fff'}
});
var infoPanel = ui.Panel({
  style: {margin: '10px 0 0 0', padding: '10px', border: '1px solid ' + COLORS.border, backgroundColor: COLORS.softBg}
});

function sectionTitle(text) {
  return ui.Label(text, {fontWeight: 'bold', fontSize: '14px', margin: '0 0 6px 0', color: COLORS.text});
}

function makeCard(title, accentColor, width) {
  var valueLabel = ui.Label('0', {fontWeight: 'bold', fontSize: '24px', color: accentColor, margin: '0 0 4px 0'});
  var titleLabel = ui.Label(title, {fontSize: '11px', color: COLORS.muted, margin: '0'});
  var noteLabel = ui.Label('', {fontSize: '10px', color: COLORS.muted, margin: '4px 0 0 0'});
  var panel = ui.Panel([valueLabel, titleLabel, noteLabel], ui.Panel.Layout.flow('vertical'), {
    width: width || '48%',
    margin: '0 8px 8px 0',
    padding: '10px',
    border: '1px solid ' + COLORS.border,
    backgroundColor: '#fff'
  });
  return {panel: panel, value: valueLabel, note: noteLabel};
}

var cardReported = makeCard('Reported Sites In View', '#111827', '48%');
var cardConfirmed = makeCard('Confirmed', COLORS.confirmed, '48%');
var cardSuspected = makeCard('Suspected', COLORS.suspected, '48%');
var cardControl = makeCard('Control', COLORS.control, '48%');
var cardCandidate = makeCard('Candidate Zones', COLORS.high, '100%');

var title = ui.Label('Scam Compound Explorer V3', {
  fontSize: '22px',
  fontWeight: 'bold',
  color: COLORS.text,
  margin: '0 0 6px 0'
});

var subtitle = ui.Label(
  'V3 keeps the V2 layout but rebuilds the server graph around FeatureCollection.select, a simpler density kernel, and a per-AOI layer cache so repeat views render from cached tiles.',
  {fontSize: '12px', color: COLORS.muted, whiteSpace: 'pre-wrap', margin: '0 0 12px 0'}
);

var aoiSelect = ui.Select({
  items: Object.keys(AOIS),
  value: DEFAULT_AOI,
  style: {stretch: 'horizontal'}
});

var rankModeSelect = ui.Select({
  items: ['Highest dNTL', 'Highest dNDBI', 'Closest to confirmed'],
  value: 'Highest dNTL',
  style: {stretch: 'horizontal'}
});

var refreshEvidenceButton = ui.Button({
  label: 'Load Evidence & Ranking',
  style: {stretch: 'horizontal'},
  onClick: function() { runEvidence(); }
});

var resetButton = ui.Button({
  label: 'Reset View',
  style: {stretch: 'horizontal'},
  onClick: function() {
    var aoiName = aoiSelect.getValue();
    var aoiData = getAoiData(aoiName);
    map.centerObject(aoiData.geometry, isOverviewAoiName(aoiName) ? 5 : 7);
  }
});

var overviewButton = ui.Button({
  label: 'Show Overview',
  style: {stretch: 'horizontal'},
  onClick: function() { aoiSelect.setValue('Southeast Asia overview'); }
});

var basemapButton = ui.Button({
  label: 'AOI satellite: ON',
  style: {stretch: 'horizontal'},
  onClick: function() {
    aoiSatelliteShown = !aoiSatelliteShown;
    basemapButton.setLabel('AOI satellite: ' + (aoiSatelliteShown ? 'ON' : 'OFF'));
    // Propagate to every cached AOI stack so the preference sticks on switch.
    Object.keys(layerCache).forEach(function(key) {
      if (layerCache[key].aoiSatellite) {
        layerCache[key].aoiSatellite.setShown(aoiSatelliteShown);
      }
    });
  }
});

kpiPanel.add(ui.Panel([cardReported.panel, cardConfirmed.panel], ui.Panel.Layout.flow('horizontal')));
kpiPanel.add(ui.Panel([cardSuspected.panel, cardControl.panel], ui.Panel.Layout.flow('horizontal')));
kpiPanel.add(cardCandidate.panel);

leftPanel.add(title);
leftPanel.add(subtitle);
leftPanel.add(sectionTitle('AOI Controls'));
leftPanel.add(ui.Label('Regional focus', {fontSize: '12px', color: COLORS.muted, margin: '0 0 4px 0'}));
leftPanel.add(aoiSelect);
leftPanel.add(resetButton);
leftPanel.add(overviewButton);
leftPanel.add(basemapButton);
leftPanel.add(sectionTitle('Overview'));
leftPanel.add(kpiPanel);
leftPanel.add(sectionTitle('Stage Funnel'));
leftPanel.add(funnelPanel);
leftPanel.add(sectionTitle('Validation'));
leftPanel.add(validationPanel);
leftPanel.add(sectionTitle('Evidence Scatter'));
leftPanel.add(ui.Label(
  'Evidence scatter and the review list are loaded on demand so the map itself stays light.',
  {fontSize: '12px', color: COLORS.muted, whiteSpace: 'pre-wrap', margin: '0 0 8px 0'}
));
leftPanel.add(refreshEvidenceButton);
leftPanel.add(evidencePanel);
leftPanel.add(sectionTitle('Priority Review List'));
leftPanel.add(ui.Label('Ranking metric', {fontSize: '12px', color: COLORS.muted, margin: '0 0 4px 0'}));
leftPanel.add(rankModeSelect);
leftPanel.add(rankingPanel);
leftPanel.add(sectionTitle('Layers'));
leftPanel.add(layerPanel);
leftPanel.add(sectionTitle('Click Map'));
leftPanel.add(infoPanel);

ui.root.add(ui.SplitPanel({
  firstPanel: leftPanel,
  secondPanel: map,
  orientation: 'horizontal',
  wipe: false,
  style: {stretch: 'both'}
}));

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

var activeAoiName = DEFAULT_AOI;
var activeAoi = AOIS[DEFAULT_AOI];
var activePointsInAoi = null;
var activeCandidatesInAoi = null;
var activeTierCollections = null;
var activeRenderId = 0;

var aoiDataCache = {};    // per-AOI FeatureCollection subsets and tier splits
var densityCache = {};    // per-AOI density image
var satelliteCache = {};  // per-AOI Sentinel-2 composite image
var kpiCache = {};        // per-AOI KPI summary (client-side object)
var layerCache = {};      // per-AOI ui.Map.Layer stack — keyed so AOI switch is a swap

// Persist the user's satellite-inside-AOI choice across AOI switches, so a
// toggle applied to one AOI also reflects on subsequent ones.
var aoiSatelliteShown = true;

function getAoiData(aoiName) {
  if (!aoiDataCache[aoiName]) {
    var geometry = AOIS[aoiName];
    var points = scamPoints.filterBounds(geometry);
    var candidateSubset = candidates.filterBounds(geometry);
    aoiDataCache[aoiName] = {
      geometry: geometry,
      points: points,
      candidates: candidateSubset,
      confirmed: points.filter(ee.Filter.eq('site_status', 'confirmed')),
      suspected: points.filter(ee.Filter.eq('site_status', 'suspected')),
      control: points.filter(ee.Filter.eq('site_status', 'control')),
      tiers: {
        high: filterCandidatesByTier(candidateSubset, 'high'),
        medium: filterCandidatesByTier(candidateSubset, 'medium'),
        low: filterCandidatesByTier(candidateSubset, 'low')
      }
    };
  }
  return aoiDataCache[aoiName];
}

// ---------------------------------------------------------------------------
// Layer management
// ---------------------------------------------------------------------------

function buildLayerStack(aoiName) {
  if (layerCache[aoiName]) {
    return layerCache[aoiName];
  }

  var aoiData = getAoiData(aoiName);
  var overviewMode = isOverviewAoiName(aoiName);
  var densityKey = overviewMode ? aoiName + ':overview' : aoiName + ':detail';
  // Smoothing radius for the density kernel. Output is always at 1 km so
  // visualisation stays smooth; this controls how much blurring happens.
  var smoothingRadius = overviewMode ? 25000 : 12000;
  // Rough saturation cap so hotspots clip to the darkest colour while empty
  // regions stay green. Assumes ~1 painted pixel per candidate at 1 km.
  var densityMax = overviewMode ? 50 : 80;
  // Square kernel area (2r × 2r) in km², used to label the legend.
  var kernelAreaKm2 = Math.round((2 * smoothingRadius / 1000) * (2 * smoothingRadius / 1000));

  if (!densityCache[densityKey]) {
    densityCache[densityKey] = makeDensityImage(
      aoiData.candidates, aoiData.geometry, smoothingRadius);
  }
  if (!satelliteCache[aoiName]) {
    satelliteCache[aoiName] = buildAoiSatellite(aoiData.geometry);
  }

  var stack = {
    aoiSatellite: ui.Map.Layer(
      satelliteCache[aoiName], S2_VIS, 'AOI satellite (S2 2024)', aoiSatelliteShown),
    aoi: ui.Map.Layer(styleAoi(aoiData.geometry), {}, 'Selected AOI boundary', true),
    candidateDensity: ui.Map.Layer(densityCache[densityKey], {
      min: 1,
      max: densityMax,
      palette: DENSITY_PALETTE,
      opacity: 0.72
    }, 'Candidate density', true),
    borders: ui.Map.Layer(styleCountryBorders(aoiData.geometry), {}, 'Country borders', true),
    confirmed: ui.Map.Layer(
      stylePointCollection(aoiData.confirmed, COLORS.confirmed, 7), {}, 'Confirmed sites', true),
    suspected: ui.Map.Layer(
      stylePointCollection(aoiData.suspected, COLORS.suspected, 7), {}, 'Suspected sites', true),
    control: ui.Map.Layer(
      stylePointCollection(aoiData.control, COLORS.control, 6), {}, 'Control sites', true)
  };

  stack.densityMax = densityMax;
  stack.kernelAreaKm2 = kernelAreaKm2;
  layerCache[aoiName] = stack;
  return stack;
}

function applyLayerStack(stack) {
  map.layers().reset([
    stack.aoiSatellite,
    stack.aoi,
    stack.candidateDensity,
    stack.borders,
    stack.confirmed,
    stack.suspected,
    stack.control
  ]);
}

function updateLayerControls(stack) {
  layerPanel.clear();
  [
    {label: 'AOI satellite (Sentinel-2)', key: 'aoiSatellite'},
    {label: 'Selected AOI boundary', key: 'aoi'},
    {label: 'Candidate density', key: 'candidateDensity'},
    {label: 'Country borders', key: 'borders'},
    {label: 'Confirmed sites', key: 'confirmed'},
    {label: 'Suspected sites', key: 'suspected'},
    {label: 'Control sites', key: 'control'}
  ].forEach(function(entry) {
    var layer = stack[entry.key];
    if (!layer) {
      return;
    }
    layerPanel.add(ui.Checkbox({
      label: entry.label,
      value: layer.getShown(),
      onChange: function(value) { layer.setShown(value); },
      style: {margin: '0 0 2px 0'}
    }));
  });
}

// ---------------------------------------------------------------------------
// KPI / panels
// ---------------------------------------------------------------------------

function applyKpiStats(stats, aoiName) {
  cardReported.value.setValue(String(stats.total || 0));
  cardReported.note.setValue(aoiName);

  cardConfirmed.value.setValue(String(stats.confirmed || 0));
  cardConfirmed.note.setValue('Reference sites');

  cardSuspected.value.setValue(String(stats.suspected || 0));
  cardSuspected.note.setValue('Validation comparison');

  cardControl.value.setValue(String(stats.control || 0));
  cardControl.note.setValue('Control locations');

  cardCandidate.value.setValue(String(stats.candidates || 0));
  cardCandidate.note.setValue(
    'High ' + (stats.high || 0) + ' | Medium ' + WORKFLOW_COUNTS.stage2_medium + ' | Low ' + WORKFLOW_COUNTS.stage2_low
  );
}

function updateKpis(pointsInAoi, candidatesInAoi, renderId, aoiName) {
  if (kpiCache[aoiName]) {
    applyKpiStats(kpiCache[aoiName], aoiName);
    return;
  }

  ee.Dictionary({
    point_status_hist: ee.Dictionary(pointsInAoi.aggregate_histogram('site_status')),
    candidate_tier_hist: ee.Dictionary(candidatesInAoi.aggregate_histogram('priority_tier'))
  }).evaluate(function(result) {
    if (renderId !== activeRenderId) {
      return;
    }
    result = result || {};
    var pointStatusHist = result.point_status_hist || {};
    var candidateTierHist = result.candidate_tier_hist || {};
    var stats = {
      total: histogramTotal(pointStatusHist),
      confirmed: histogramCount(pointStatusHist, 'confirmed'),
      suspected: histogramCount(pointStatusHist, 'suspected'),
      control: histogramCount(pointStatusHist, 'control'),
      candidates: histogramTotal(candidateTierHist),
      high: histogramCount(candidateTierHist, 'high')
    };
    kpiCache[aoiName] = stats;
    applyKpiStats(stats, aoiName);
  });
}

function buildStaticPanels() {
  funnelPanel.clear();
  funnelPanel.add(ui.Label(
    'This chart explains the Cambodia-Vietnam workflow counts rather than the current map viewport.',
    {fontSize: '12px', color: COLORS.muted, whiteSpace: 'pre-wrap', margin: '0 0 8px 0'}
  ));
  funnelPanel.add(makeStageFunnelChart());

  validationPanel.clear();
  validationPanel.add(ui.Label(
    'Validation is read from precomputed summary outputs, so these charts load instantly and do not run overlap checks inside the app.',
    {fontSize: '12px', color: COLORS.muted, whiteSpace: 'pre-wrap', margin: '0 0 8px 0'}
  ));
  validationPanel.add(makeValidationCountChart());
  validationPanel.add(makeValidationRateChart('500 m', 'suspected_500_pct', 'confirmed_500_pct', 'controls_500_pct'));
  validationPanel.add(makeValidationRateChart('1000 m', 'suspected_1000_pct', 'confirmed_1000_pct', 'controls_1000_pct'));
}

function setEvidencePlaceholder(aoiName) {
  evidencePanel.clear();
  evidencePanel.add(ui.Label(
    'Click "Load Evidence & Ranking" to sample candidates in ' + aoiName + ' and draw a clean dNDBI vs dNTL scatter.',
    {fontSize: '12px', color: COLORS.muted, whiteSpace: 'pre-wrap'}
  ));
  rankingPanel.clear();
  rankingPanel.add(ui.Label(
    'Click "Load Evidence & Ranking" to build a compact review list for the current AOI.',
    {fontSize: '12px', color: COLORS.muted, whiteSpace: 'pre-wrap'}
  ));
}

function setDefaultInfo() {
  infoPanel.clear();
  infoPanel.add(ui.Label(
    'The map is intentionally sparse: candidate density plus confirmed, suspected and control sites. Detailed candidate comparison now lives in the charts and review list rather than on the map.',
    {fontSize: '12px', color: COLORS.muted, whiteSpace: 'pre-wrap'}
  ));
}

function addInfoRow(label, value) {
  infoPanel.add(ui.Label(label + ': ' + value, {fontSize: '12px', margin: '1px 0'}));
}

function populateInfoFromCandidate(properties) {
  infoPanel.clear();
  infoPanel.add(ui.Label('Candidate Area', {fontWeight: 'bold', margin: '0 0 4px 0'}));
  addInfoRow('Candidate ID', properties.candidate_id || 'Unknown');
  addInfoRow('Priority', properties.priority_tier || 'Unknown');
  addInfoRow('Area', formatNumber(properties.area_sqm, 0) + ' sq m');
  addInfoRow('dNDBI 2021-2024', formatNumber(properties.dNDBI_2021_2024, 3));
  addInfoRow('dNDVI 2021-2024', formatNumber(properties.dNDVI_2021_2024, 3));
  addInfoRow('dNTL 2021-2024', formatNumber(properties.dNTL_2021_2024, 2));
  addInfoRow('Distance to confirmed', formatNumber(properties.dist_to_confirmed_m, 0) + ' m');
  addInfoRow('Distance to border', formatBorderDistance(properties.dist_to_border_m));
}

function nearestReportedSite(point) {
  return activePointsInAoi
    .map(function(feature) {
      return feature.set('distance_m', feature.geometry().distance(point, 1));
    })
    .sort('distance_m')
    .first();
}

function runEvidence() {
  var renderId = activeRenderId;
  addEvidenceScatter(evidencePanel, activeTierCollections, renderId);
  updateRanking(activeCandidatesInAoi, renderId);
}

// Builds one horizontal "label | bar | value" row. Bar width is proportional
// to |value| / maxAbs (or 1 - that ratio if invertBar is true, for distance
// where smaller is a stronger signal). isPrimary paints the bar red and the
// labels bold — so the active ranking metric pops visually.
function makeMetricBar(label, value, maxAbs, formatter, isPrimary, invertBar) {
  var numericValue = Number(value);
  var hasValue = !isNaN(numericValue);
  var absVal = hasValue ? Math.abs(numericValue) : 0;
  var ratio = (maxAbs > 0) ? Math.min(1, absVal / maxAbs) : 0;
  if (invertBar) {
    ratio = 1 - ratio;
  }
  var barWidthPx = Math.max(2, Math.round(ratio * 110));
  var positive = hasValue && numericValue >= 0;
  var barColor = isPrimary
    ? '#dc2626'
    : (positive ? '#fb923c' : '#9ca3af');

  return ui.Panel([
    ui.Label(label, {
      fontSize: '10px',
      color: isPrimary ? COLORS.text : COLORS.muted,
      fontWeight: isPrimary ? 'bold' : 'normal',
      width: '44px',
      margin: '2px 6px 0 0'
    }),
    ui.Label('', {
      width: barWidthPx + 'px',
      height: '8px',
      backgroundColor: barColor,
      margin: '5px 8px 0 0'
    }),
    ui.Label(hasValue ? formatter(numericValue) : 'N/A', {
      fontSize: '10px',
      color: COLORS.text,
      fontWeight: isPrimary ? 'bold' : 'normal',
      margin: '1px 0 0 0'
    })
  ], ui.Panel.Layout.flow('horizontal'), {margin: '0'});
}

function updateRanking(candidatesInAoi, renderId) {
  rankingPanel.clear();
  rankingPanel.add(ui.Label('Loading top candidates...', {fontSize: '12px', color: COLORS.muted}));

  var rankMode = rankModeSelect.getValue();
  var cfg = getRankConfig(rankMode);
  var topCandidates = buildTopCandidates(candidatesInAoi, rankMode);

  topCandidates.evaluate(function(fc) {
    if (renderId !== activeRenderId) {
      return;
    }

    rankingPanel.clear();
    rankingPanel.add(ui.Label(cfg.title, {fontWeight: 'bold', margin: '0 0 4px 0'}));
    rankingPanel.add(ui.Label(
      'Bars compare each candidate against the top 8 on three signals. Red bar = the active ranking metric; for "Distance" shorter = stronger.',
      {fontSize: '11px', color: COLORS.muted, whiteSpace: 'pre-wrap', margin: '0 0 8px 0'}
    ));

    if (!fc || !fc.features || !fc.features.length) {
      rankingPanel.add(ui.Label(
        'No candidate rows are available for the current AOI.',
        {fontSize: '12px', color: COLORS.muted}
      ));
      return;
    }

    // Normaliser: largest |value| (or largest value, for distance) among the
    // 8 cards, so the top-ranked candidate fills its bar end-to-end.
    var maxDNTL = 0.001;
    var maxDNDBI = 0.001;
    var maxDist = 1;
    fc.features.forEach(function(feature) {
      var p = feature.properties || {};
      var nTL = Number(p.dNTL_2021_2024);
      var nDBI = Number(p.dNDBI_2021_2024);
      var dist = Number(p.dist_to_confirmed_m);
      if (!isNaN(nTL)) { maxDNTL = Math.max(maxDNTL, Math.abs(nTL)); }
      if (!isNaN(nDBI)) { maxDNDBI = Math.max(maxDNDBI, Math.abs(nDBI)); }
      if (!isNaN(dist)) { maxDist = Math.max(maxDist, dist); }
    });

    var primaryField = cfg.field;

    fc.features.forEach(function(feature, index) {
      var props = feature.properties || {};
      var center = geometryCenter(feature.geometry);
      var tierValue = String(props.priority_tier || 'unknown').toLowerCase();

      var tierBadge = ui.Label(formatTierLabel(props.priority_tier).toUpperCase(), {
        fontSize: '9px',
        fontWeight: 'bold',
        color: '#ffffff',
        backgroundColor: tierColor(tierValue),
        padding: '2px 6px',
        margin: '0 8px 0 0'
      });

      var rankIdLabel = ui.Label(
        '#' + (index + 1) + '  ' + shortCandidateId(props.candidate_id),
        {fontSize: '12px', fontWeight: 'bold', color: COLORS.text, margin: '2px 0 0 0'}
      );

      var viewButton = ui.Button({
        label: 'View ↗',
        style: {margin: '0', width: '60px'},
        onClick: function() {
          if (center) {
            map.setCenter(center.lon, center.lat, 11);
          }
          populateInfoFromCandidate(props);
        }
      });

      var header = ui.Panel([
        tierBadge,
        rankIdLabel,
        ui.Label('', {stretch: 'horizontal', margin: '0'}),
        viewButton
      ], ui.Panel.Layout.flow('horizontal'), {
        stretch: 'horizontal',
        margin: '0 0 4px 0'
      });

      var dNTLBar = makeMetricBar(
        'dNTL', props.dNTL_2021_2024, maxDNTL,
        function(v) { return (v >= 0 ? '+' : '') + v.toFixed(2); },
        primaryField === 'dNTL_2021_2024', false);
      var dNDBIBar = makeMetricBar(
        'dNDBI', props.dNDBI_2021_2024, maxDNDBI,
        function(v) { return (v >= 0 ? '+' : '') + v.toFixed(3); },
        primaryField === 'dNDBI_2021_2024', false);
      var distBar = makeMetricBar(
        'Dist', props.dist_to_confirmed_m, maxDist,
        function(v) {
          return v >= 1000
            ? (v / 1000).toFixed(1) + ' km'
            : v.toFixed(0) + ' m';
        },
        primaryField === 'dist_to_confirmed_m', true);

      rankingPanel.add(ui.Panel(
        [header, dNTLBar, dNDBIBar, distBar],
        ui.Panel.Layout.flow('vertical'),
        {
          stretch: 'horizontal',
          margin: '0 0 6px 0',
          padding: '8px 10px',
          border: '1px solid ' + COLORS.border,
          backgroundColor: '#ffffff'
        }
      ));
    });
  });
}

// ---------------------------------------------------------------------------
// Map click
// ---------------------------------------------------------------------------

map.onClick(function(coords) {
  infoPanel.clear();
  infoPanel.add(ui.Label('Loading selected location...', {fontSize: '12px', color: COLORS.muted}));

  var point = ee.Geometry.Point([coords.lon, coords.lat]);

  // Run both lookups in parallel via ee.Dictionary so we pay one roundtrip
  // instead of the chained roundtrips V2 used.
  var payload = ee.Dictionary({
    nearest: nearestReportedSite(point),
    candidate: activeCandidatesInAoi.filterBounds(point).first()
  });

  payload.evaluate(function(result) {
    infoPanel.clear();
    infoPanel.add(ui.Label('Selected Location', {fontWeight: 'bold', margin: '0 0 4px 0'}));
    addInfoRow('Longitude', formatNumber(coords.lon, 5));
    addInfoRow('Latitude', formatNumber(coords.lat, 5));

    infoPanel.add(ui.Label('Nearest Reported Site', {fontWeight: 'bold', margin: '8px 0 4px 0'}));

    var siteFeature = result && result.nearest;
    if (siteFeature && siteFeature.properties) {
      var s = siteFeature.properties;
      addInfoRow('Name', s.name || 'Unknown');
      addInfoRow('Status', s.site_status || 'Unknown');
      addInfoRow('Country', s.country || 'Unknown');
      addInfoRow('Context', s.context_type || 'Unknown');
      addInfoRow('Distance', formatNumber(s.distance_m, 0) + ' m');
    } else {
      addInfoRow('Site', 'No reported site found');
    }

    var candidateFeature = result && result.candidate;
    if (candidateFeature && candidateFeature.properties) {
      populateInfoFromCandidate(candidateFeature.properties);
    }
  });
});

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderAoi(aoiName) {
  activeRenderId += 1;
  var renderId = activeRenderId;
  var aoiData = getAoiData(aoiName);

  activeAoiName = aoiName;
  activeAoi = aoiData.geometry;
  activePointsInAoi = aoiData.points;
  activeCandidatesInAoi = aoiData.candidates;
  activeTierCollections = aoiData.tiers;

  var overviewMode = isOverviewAoiName(aoiName);
  var stack = buildLayerStack(aoiName);

  applyLayerStack(stack);
  map.centerObject(activeAoi, overviewMode ? 5 : 7);

  updateLayerControls(stack);
  updateDensityLegend(stack.densityMax, stack.kernelAreaKm2);
  updateKpis(aoiData.points, aoiData.candidates, renderId, aoiName);
  setEvidencePlaceholder(aoiName);
  setDefaultInfo();
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

aoiSelect.onChange(function(value) { renderAoi(value); });

rankModeSelect.onChange(function() {
  rankingPanel.clear();
  rankingPanel.add(ui.Label(
    'Ranking metric changed. Click "Load Evidence & Ranking" to rebuild the review list.',
    {fontSize: '12px', color: COLORS.muted, whiteSpace: 'pre-wrap'}
  ));
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

buildStaticPanels();
renderAoi(DEFAULT_AOI);
