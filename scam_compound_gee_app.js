// CASA0025: Building Spatial Applications with Big Data
// Group: con.casa
// Project: Scam Compound Detection in Southeast Asia
//
// Dashboard-style Google Earth Engine app script.
// Paste this into the Earth Engine Code Editor, save it under your own script,
// then publish it as an Earth Engine App.

// ---------------------------------------------------------------------------
// Data inputs
// ---------------------------------------------------------------------------

var SCAM_POINTS_ASSET = 'projects/project-2736c40e-7bac-492d-b63/assets/scam_sites';
var UPDATED_POINTS_ASSET = 'users/liuwanqi0202/scam_points_update_clean_for_gee';
var UPDATED_POINTS_NEEDS_LONLAT_GEOMETRY = true;

// Current uploaded candidate asset only contains the 4 high-priority zones.
// Replace this with your full uploaded asset when ready:
// 'users/liuwanqi0202/final_candidate_summary_all_shp'
var CANDIDATE_ASSET = 'users/liuwanqi0202/final_candidate_summary_all_shp';

// Analysis settings from the group workspace scripts.
var SIMILARITY_THRESHOLD_MODE = 'p97';
var SIMILARITY_THRESHOLD_VALUE = 0.6848698665063624;
var SAMPLE_SCALE_M = 20;
var REFERENCE_LIMIT = 3;
var CANDIDATE_BUFFER_M = 500;

// ---------------------------------------------------------------------------
// Load and normalise inputs
// ---------------------------------------------------------------------------

function rebuildPointGeometryFromLonLat(collection) {
  return collection.map(function(f) {
    var lon = ee.Number.parse(ee.String(f.get('lon')));
    var lat = ee.Number.parse(ee.String(f.get('lat')));
    return f.setGeometry(ee.Geometry.Point([lon, lat]));
  });
}

var baseReportedPoints = ee.FeatureCollection(SCAM_POINTS_ASSET)
  .filter(ee.Filter.inList('site_status', ['confirmed', 'suspected']));

var updatedPoints = UPDATED_POINTS_ASSET !== ''
  ? (UPDATED_POINTS_NEEDS_LONLAT_GEOMETRY
      ? rebuildPointGeometryFromLonLat(ee.FeatureCollection(UPDATED_POINTS_ASSET))
      : ee.FeatureCollection(UPDATED_POINTS_ASSET))
  : ee.FeatureCollection([]);

var controlPoints = updatedPoints
  .filter(ee.Filter.eq('site_status', 'control'));

var scamPoints = baseReportedPoints.merge(controlPoints);

var confirmed = scamPoints.filter(ee.Filter.eq('site_status', 'confirmed'));
var suspected = scamPoints.filter(ee.Filter.eq('site_status', 'suspected'));
var control = scamPoints.filter(ee.Filter.eq('site_status', 'control'));

var candidatesRaw = CANDIDATE_ASSET !== ''
  ? ee.FeatureCollection(CANDIDATE_ASSET)
  : ee.FeatureCollection([]);

function normaliseCandidateProperties(collection) {
  return collection.map(function(f) {
    var names = f.propertyNames();
    return f.set({
      candidate_id: ee.Algorithms.If(names.contains('candidate_id'), f.get('candidate_id'), f.get('cand_id')),
      priority_tier: ee.Algorithms.If(names.contains('priority_tier'), f.get('priority_tier'), f.get('tier')),
      area_sqm: f.get('area_sqm'),
      dist_to_border_m: ee.Algorithms.If(names.contains('dist_to_border_m'), f.get('dist_to_border_m'), f.get('dist_bord')),
      dist_to_confirmed_m: ee.Algorithms.If(names.contains('dist_to_confirmed_m'), f.get('dist_to_confirmed_m'), f.get('dist_conf')),
      NTL_2024: ee.Algorithms.If(names.contains('NTL_2024'), f.get('NTL_2024'), f.get('ntl_2024')),
      dNDVI_2021_2024: ee.Algorithms.If(names.contains('dNDVI_2021_2024'), f.get('dNDVI_2021_2024'), f.get('dndvi')),
      dNDBI_2021_2024: ee.Algorithms.If(names.contains('dNDBI_2021_2024'), f.get('dNDBI_2021_2024'), f.get('dndbi')),
      dNTL_2021_2024: ee.Algorithms.If(names.contains('dNTL_2021_2024'), f.get('dNTL_2021_2024'), f.get('dntl')),
      development_flag: ee.Algorithms.If(names.contains('development_flag'), f.get('development_flag'), f.get('dev_flag')),
      activity_flag: ee.Algorithms.If(names.contains('activity_flag'), f.get('activity_flag'), f.get('act_flag'))
    });
  });
}

var candidates = normaliseCandidateProperties(candidatesRaw);

function filterCandidatesByTier(collection, tierLabel) {
  return collection.filter(
    ee.Filter.or(
      ee.Filter.eq('priority_tier', tierLabel),
      ee.Filter.eq('tier', tierLabel)
    )
  );
}

var candidateHigh = filterCandidatesByTier(candidates, 'high');
var candidateMedium = filterCandidatesByTier(candidates, 'medium');
var candidateLow = filterCandidatesByTier(candidates, 'low');

// ---------------------------------------------------------------------------
// AOIs
// ---------------------------------------------------------------------------

var AOIS = {
  'Cambodia-Vietnam corridor': ee.Geometry.Rectangle([102.0, 10.0, 108.5, 15.5]),
  'Myanmar-Thailand border': ee.Geometry.Rectangle([97.5, 15.0, 99.8, 18.8]),
  'Golden Triangle': ee.Geometry.Rectangle([99.0, 19.0, 101.5, 21.8]),
  'Southeast Asia overview': ee.Geometry.Rectangle([94.5, 8.0, 109.5, 22.5])
};

var AOI_FEATURES = ee.FeatureCollection([
  ee.Feature(AOIS['Cambodia-Vietnam corridor'], {
    aoi_name: 'Cambodia-Vietnam corridor',
    style: {color: '#22d3ee', fillColor: '#00bcd422', width: 3}
  }),
  ee.Feature(AOIS['Myanmar-Thailand border'], {
    aoi_name: 'Myanmar-Thailand border',
    style: {color: '#22c55e', fillColor: '#1f9d5522', width: 3}
  }),
  ee.Feature(AOIS['Golden Triangle'], {
    aoi_name: 'Golden Triangle',
    style: {color: '#fbbf24', fillColor: '#f59e0b22', width: 3}
  })
]);

var DEFAULT_AOI = 'Cambodia-Vietnam corridor';
var BASELINE_YEAR = 2021;
var DISPLAY_YEAR = 2023;
var ANALYSIS_YEAR = 2024;

function isOverviewAoiName(aoiName) {
  return aoiName === 'Southeast Asia overview';
}

// ---------------------------------------------------------------------------
// Remote sensing helpers
// ---------------------------------------------------------------------------

function maskS2Clouds(image) {
  var qa = image.select('QA60');
  var cloudBitMask = 1 << 10;
  var cirrusBitMask = 1 << 11;
  var mask = qa.bitwiseAnd(cloudBitMask).eq(0)
    .and(qa.bitwiseAnd(cirrusBitMask).eq(0));

  return image.updateMask(mask).copyProperties(image, image.propertyNames());
}

function getS2Composite(aoi, year) {
  return ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(aoi)
    .filterDate(year + '-01-01', year + '-12-31')
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 25))
    .map(maskS2Clouds)
    .select(['B2', 'B3', 'B4', 'B8', 'B11'])
    .median()
    .clip(aoi);
}

function addSpectralIndices(image, suffix) {
  var ndvi = image.normalizedDifference(['B8', 'B4']).rename('NDVI_' + suffix);
  var ndbi = image.normalizedDifference(['B11', 'B8']).rename('NDBI_' + suffix);
  return image.addBands([ndvi, ndbi]);
}

function getNtl(aoi, year) {
  return ee.ImageCollection('NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG')
    .filterBounds(aoi)
    .filterDate(year + '-01-01', year + '-12-31')
    .select('avg_rad')
    .mean()
    .rename('NTL_' + year)
    .clip(aoi);
}

function buildIndicatorStack(aoi) {
  var display = addSpectralIndices(getS2Composite(aoi, DISPLAY_YEAR), DISPLAY_YEAR);
  var baseline = addSpectralIndices(getS2Composite(aoi, BASELINE_YEAR), BASELINE_YEAR);
  var analysis = addSpectralIndices(getS2Composite(aoi, ANALYSIS_YEAR), ANALYSIS_YEAR);

  var dNdvi = analysis.select('NDVI_' + ANALYSIS_YEAR)
    .subtract(baseline.select('NDVI_' + BASELINE_YEAR))
    .rename('dNDVI_' + BASELINE_YEAR + '_' + ANALYSIS_YEAR);

  var dNdbi = analysis.select('NDBI_' + ANALYSIS_YEAR)
    .subtract(baseline.select('NDBI_' + BASELINE_YEAR))
    .rename('dNDBI_' + BASELINE_YEAR + '_' + ANALYSIS_YEAR);

  var ntlDisplay = getNtl(aoi, DISPLAY_YEAR);
  var ntlBaseline = getNtl(aoi, BASELINE_YEAR);
  var ntlAnalysis = getNtl(aoi, ANALYSIS_YEAR);
  var dNtl = ntlAnalysis.subtract(ntlBaseline)
    .rename('dNTL_' + BASELINE_YEAR + '_' + ANALYSIS_YEAR);

  return {
    rgb: display.select(['B4', 'B3', 'B2']),
    ndvi: display.select('NDVI_' + DISPLAY_YEAR),
    ndbi: display.select('NDBI_' + DISPLAY_YEAR),
    dNdvi: dNdvi,
    dNdbi: dNdbi,
    ntl: ntlDisplay,
    dNtl: dNtl,
    stack: ee.Image.cat([
      display.select('NDVI_' + DISPLAY_YEAR),
      display.select('NDBI_' + DISPLAY_YEAR),
      dNdvi,
      dNdbi,
      ntlDisplay,
      dNtl
    ])
  };
}

// ---------------------------------------------------------------------------
// Styling helpers
// ---------------------------------------------------------------------------

var COLORS = {
  confirmed: '#d73027',
  suspected: '#f59e0b',
  control: '#2b6cb0',
  high: '#d946ef',
  medium: '#f97316',
  low: '#facc15',
  aoi: '#ffffff',
  text: '#1f2937',
  muted: '#6b7280',
  border: '#d0d5dd',
  panelBg: '#ffffff',
  softBg: '#f8fafc'
};

function stylePointCollection(collection, color, size) {
  return collection.style({
    color: '#ffffff',
    fillColor: color,
    pointSize: size || 8,
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

function styleRegionalAois() {
  return AOI_FEATURES.style({
    styleProperty: 'style'
  });
}

function styleCandidateTier(collection, strokeColor, fillColor, width) {
  return collection.style({
    color: strokeColor,
    fillColor: fillColor,
    width: width || 1
  });
}

function formatNumber(value, digits) {
  if (value === null || value === undefined || isNaN(Number(value))) {
    return 'No data';
  }
  return Number(value).toFixed(digits);
}

function percentageText(part, total) {
  if (!total) {
    return '0%';
  }
  return (100 * part / total).toFixed(0) + '%';
}

// ---------------------------------------------------------------------------
// Chart helpers
// ---------------------------------------------------------------------------

function makeCountFeatureCollection(fc, field, orderedKeys) {
  var histogram = ee.Dictionary(fc.aggregate_histogram(field));
  return ee.FeatureCollection(orderedKeys.map(function(key) {
    return ee.Feature(null, {
      category: key,
      count: ee.Number(histogram.get(key, 0))
    });
  }));
}

function makeContextFeatureCollection(fc) {
  var histogram = ee.Dictionary(fc.aggregate_histogram('context_type'));
  var keys = histogram.keys().sort();
  return ee.FeatureCollection(keys.map(function(key) {
    var keyString = ee.String(key);
    var displayLabel = ee.String(
      ee.Algorithms.If(keyString.equals('urban_area'), 'Urban area',
      ee.Algorithms.If(keyString.equals('border_area'), 'Border area',
      ee.Algorithms.If(keyString.equals('commercial_complex'), 'Commercial complex',
      ee.Algorithms.If(keyString.equals('industrail compound'), 'Industrial compound',
      ee.Algorithms.If(keyString.equals('unknown'), 'Unknown', keyString)))))
    );
    return ee.Feature(null, {
      context_type: displayLabel,
      count: ee.Number(histogram.get(key, 0))
    });
  })).sort('count', false);
}

function makeIndicatorSummary(sampled) {
  return ee.FeatureCollection([
    makeIndicatorSummaryFeature(sampled, 'confirmed'),
    makeIndicatorSummaryFeature(sampled, 'suspected'),
    makeIndicatorSummaryFeature(sampled, 'control')
  ]);
}

function makeIndicatorSummaryFeature(sampled, status) {
  var subset = sampled.filter(ee.Filter.eq('site_status', status));
  var feature = ee.Feature(null, {
    site_status: status
  });
  feature = feature.set('ndvi_mean', subset.aggregate_mean('NDVI_' + DISPLAY_YEAR));
  feature = feature.set('ndbi_mean', subset.aggregate_mean('NDBI_' + DISPLAY_YEAR));
  return feature;
}

function getRankConfig(mode) {
  if (mode === 'Closest to confirmed') {
    return {field: 'dist_to_confirmed_m', descending: false, title: 'Closest Candidates to Confirmed Sites', axis: 'Distance to confirmed (m)'};
  }
  if (mode === 'Closest to border') {
    return {field: 'dist_to_border_m', descending: false, title: 'Closest Candidates to Borders', axis: 'Distance to border (m)'};
  }
  if (mode === 'Highest dNDBI') {
    return {field: 'dNDBI_2021_2024', descending: true, title: 'Top Candidates by Built-up Growth', axis: 'dNDBI 2021-2024'};
  }
  return {field: 'dNTL_2021_2024', descending: true, title: 'Top Candidates by Night-time Light Growth', axis: 'dNTL 2021-2024'};
}

function buildTopCandidates(candidatesInAoi, rankMode) {
  var cfg = getRankConfig(rankMode);
  return candidatesInAoi.sort(cfg.field, !cfg.descending).limit(5);
}

// ---------------------------------------------------------------------------
// UI components
// ---------------------------------------------------------------------------

ui.root.clear();

var map = ui.Map();
map.setCenter(101.5, 15.0, 5);
map.setOptions('SATELLITE');
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
    ui.Label('●', {
      color: color,
      fontSize: '16px',
      margin: '0 6px 0 0'
    }),
    ui.Label(label, {
      fontSize: '11px',
      color: COLORS.text,
      margin: '0'
    })
  ], ui.Panel.Layout.flow('horizontal'), {margin: '0 0 4px 0'});
}

function makeLegendZoneRow(label, strokeColor, fillColor) {
  return ui.Panel([
    ui.Label('', {
      width: '14px',
      height: '14px',
      margin: '0 6px 0 0',
      border: '2px solid ' + strokeColor,
      backgroundColor: fillColor
    }),
    ui.Label(label, {
      fontSize: '11px',
      color: COLORS.text,
      margin: '0'
    })
  ], ui.Panel.Layout.flow('horizontal'), {margin: '0 0 4px 0'});
}

var legendPanel = ui.Panel({
  style: {
    position: 'bottom-right',
    padding: '8px 10px',
    backgroundColor: 'rgba(255,255,255,0.94)',
    border: '1px solid ' + COLORS.border,
    maxWidth: '210px'
  }
});

legendPanel.add(ui.Label('Legend', {
  fontWeight: 'bold',
  fontSize: '12px',
  color: COLORS.text,
  margin: '0 0 6px 0'
}));
legendPanel.add(makeLegendPointRow('Confirmed site', COLORS.confirmed));
legendPanel.add(makeLegendPointRow('Suspected site', COLORS.suspected));
legendPanel.add(makeLegendPointRow('Control site', COLORS.control));
legendPanel.add(makeLegendZoneRow('High candidate zone', COLORS.high, '#d946ef22'));
legendPanel.add(makeLegendZoneRow('Medium candidate zone', COLORS.medium, '#f9731618'));
legendPanel.add(makeLegendZoneRow('Low candidate zone', COLORS.low, '#facc1512'));

map.add(legendPanel);

var leftPanel = ui.Panel({
  style: {
    width: '440px',
    padding: '14px',
    backgroundColor: COLORS.panelBg
  }
});

var layerPanel = ui.Panel({style: {margin: '6px 0 0 0'}});
var kpiPanel = ui.Panel({style: {margin: '10px 0 0 0'}});
var chartsPanel = ui.Panel({style: {margin: '10px 0 0 0'}});
var validationPanel = ui.Panel({
  style: {
    margin: '10px 0 0 0',
    padding: '10px',
    border: '1px solid ' + COLORS.border,
    backgroundColor: COLORS.softBg
  }
});
var rankingPanel = ui.Panel({
  style: {
    margin: '10px 0 0 0',
    padding: '10px',
    border: '1px solid ' + COLORS.border,
    backgroundColor: '#fff'
  }
});
var infoPanel = ui.Panel({
  style: {
    margin: '10px 0 0 0',
    padding: '10px',
    border: '1px solid ' + COLORS.border,
    backgroundColor: COLORS.softBg
  }
});

function sectionTitle(text) {
  return ui.Label(text, {
    fontWeight: 'bold',
    fontSize: '14px',
    margin: '0 0 6px 0',
    color: COLORS.text
  });
}

function makeCard(title, accentColor, width) {
  var valueLabel = ui.Label('0', {
    fontWeight: 'bold',
    fontSize: '24px',
    color: accentColor,
    margin: '0 0 4px 0'
  });
  var titleLabel = ui.Label(title, {
    fontSize: '11px',
    color: COLORS.muted,
    margin: '0'
  });
  var noteLabel = ui.Label('', {
    fontSize: '10px',
    color: COLORS.muted,
    margin: '4px 0 0 0'
  });
  var panel = ui.Panel([valueLabel, titleLabel, noteLabel], ui.Panel.Layout.flow('vertical'), {
    width: width || '48%',
    margin: '0 8px 8px 0',
    padding: '10px',
    border: '1px solid ' + COLORS.border,
    backgroundColor: '#fff'
  });
  return {
    panel: panel,
    value: valueLabel,
    note: noteLabel
  };
}

var cardReported = makeCard('Reported Sites in View', '#111827', '48%');
var cardConfirmed = makeCard('Confirmed', COLORS.confirmed, '48%');
var cardSuspected = makeCard('Suspected', COLORS.suspected, '48%');
var cardControl = makeCard('Control', COLORS.control, '48%');
var cardCandidate = makeCard('Candidate Zones', COLORS.high, '100%');

var title = ui.Label('Scam Compound Pattern Explorer', {
  fontSize: '22px',
  fontWeight: 'bold',
  color: COLORS.text,
  margin: '0 0 6px 0'
});

var subtitle = ui.Label(
  'Explore three regional AOIs, reported sites, remote-sensing indicators and candidate areas. Candidate outputs currently originate from the Cambodia-Vietnam workflow and indicate spatial similarity patterns, not verified identifications.',
  {
    fontSize: '12px',
    color: COLORS.muted,
    whiteSpace: 'pre-wrap',
    margin: '0 0 12px 0'
  }
);

var aoiSelect = ui.Select({
  items: Object.keys(AOIS),
  value: DEFAULT_AOI,
  style: {stretch: 'horizontal'}
});

var rankModeSelect = ui.Select({
  items: ['Highest dNTL', 'Highest dNDBI', 'Closest to confirmed', 'Closest to border'],
  value: 'Highest dNTL',
  style: {stretch: 'horizontal'}
});

var loadImageryButton = ui.Button({
  label: 'Load Imagery Layers',
  style: {stretch: 'horizontal'},
  onClick: function() {
    loadImageryForActiveAoi();
  }
});

var refreshAnalyticsButton = ui.Button({
  label: 'Refresh Analytics',
  style: {stretch: 'horizontal'},
  onClick: function() {
    runAnalytics();
  }
});

var resetButton = ui.Button({
  label: 'Reset View',
  style: {stretch: 'horizontal'},
  onClick: function() {
    renderAoi(aoiSelect.getValue());
  }
});

var overviewButton = ui.Button({
  label: 'Show All Regions',
  style: {stretch: 'horizontal'},
  onClick: function() {
    map.centerObject(AOI_FEATURES.geometry().bounds(), 5);
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
leftPanel.add(sectionTitle('Imagery'));
leftPanel.add(ui.Label(
  'Satellite indicator layers are loaded on demand so the app starts faster and points appear first.',
  {fontSize: '12px', color: COLORS.muted, whiteSpace: 'pre-wrap', margin: '0 0 8px 0'}
));
leftPanel.add(loadImageryButton);
leftPanel.add(sectionTitle('Overview'));
leftPanel.add(kpiPanel);
leftPanel.add(sectionTitle('Analytics'));
leftPanel.add(ui.Label(
  'Map layers and KPIs load first. Run charts, validation and ranking on demand to keep the app responsive.',
  {fontSize: '12px', color: COLORS.muted, whiteSpace: 'pre-wrap', margin: '0 0 8px 0'}
));
leftPanel.add(refreshAnalyticsButton);
leftPanel.add(sectionTitle('Charts'));
leftPanel.add(chartsPanel);
leftPanel.add(sectionTitle('Validation'));
leftPanel.add(validationPanel);
leftPanel.add(sectionTitle('Top Candidates'));
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
// App state
// ---------------------------------------------------------------------------

var currentLayers = {};
var activeIndicators = null;
var activeAoi = AOIS[DEFAULT_AOI];
var activePointsInAoi = scamPoints.filterBounds(activeAoi);
var activeCandidatesInAoi = candidates.filterBounds(activeAoi);
var activeRenderId = 0;
var indicatorCache = {};

// ---------------------------------------------------------------------------
// Layer management
// ---------------------------------------------------------------------------

function addLayer(key, object, vis, name, shown) {
  var layer = ui.Map.Layer(object, vis, name, shown);
  map.layers().add(layer);
  currentLayers[key] = layer;
  return layer;
}

function addLayerToggle(label, key) {
  if (!currentLayers[key]) {
    return;
  }
  layerPanel.add(ui.Checkbox({
    label: label,
    value: currentLayers[key].getShown(),
    onChange: function(value) {
      currentLayers[key].setShown(value);
    },
    style: {margin: '0 0 2px 0'}
  }));
}

function updateLayerControls() {
  layerPanel.clear();
  addLayerToggle('Regional AOI boundaries', 'allAois');
  addLayerToggle('Selected AOI boundary', 'aoi');
  addLayerToggle('Sentinel-2 RGB (' + DISPLAY_YEAR + ')', 'rgb');
  addLayerToggle('NDVI (' + DISPLAY_YEAR + ')', 'ndvi');
  addLayerToggle('NDBI (' + DISPLAY_YEAR + ')', 'ndbi');
  addLayerToggle('Delta NDVI (' + BASELINE_YEAR + '-' + ANALYSIS_YEAR + ')', 'dNdvi');
  addLayerToggle('Delta NDBI (' + BASELINE_YEAR + '-' + ANALYSIS_YEAR + ')', 'dNdbi');
  addLayerToggle('Night-time lights (' + DISPLAY_YEAR + ')', 'ntl');
  addLayerToggle('Delta NTL (' + BASELINE_YEAR + '-' + ANALYSIS_YEAR + ')', 'dNtl');
  addLayerToggle('Confirmed sites', 'confirmed');
  addLayerToggle('Suspected sites', 'suspected');
  addLayerToggle('Control sites', 'control');
  addLayerToggle('High-priority candidates', 'candidateHigh');
  addLayerToggle('Medium-priority candidates', 'candidateMedium');
  addLayerToggle('Low-priority candidates', 'candidateLow');
}

function loadImageryForActiveAoi() {
  var aoiName = aoiSelect.getValue();
  if (isOverviewAoiName(aoiName)) {
    loadImageryButton.setLabel('Overview imagery disabled');
    return;
  }

  if (!indicatorCache[aoiName]) {
    loadImageryButton.setLabel('Imagery loaded for ' + aoiName);
    indicatorCache[aoiName] = buildIndicatorStack(AOIS[aoiName]);
  }
  renderAoi(aoiName);
}

function setAnalyticsPlaceholder(aoiName) {
  chartsPanel.clear();
  chartsPanel.add(ui.Label(
    'Analytics paused for faster rendering. Click "Refresh Analytics" to load charts for ' + aoiName + '.',
    {fontSize: '12px', color: COLORS.muted, whiteSpace: 'pre-wrap'}
  ));

  validationPanel.clear();
  validationPanel.add(ui.Label(
    'Validation is loaded on demand to avoid slow AOI refreshes.',
    {fontSize: '12px', color: COLORS.muted, whiteSpace: 'pre-wrap'}
  ));

  rankingPanel.clear();
  rankingPanel.add(ui.Label(
    'Candidate ranking is loaded on demand. Click "Refresh Analytics" when needed.',
    {fontSize: '12px', color: COLORS.muted, whiteSpace: 'pre-wrap'}
  ));
}

function runAnalytics() {
  var renderId = activeRenderId;
  var aoiName = aoiSelect.getValue();
  updateCharts(activePointsInAoi, activeCandidatesInAoi, renderId, aoiName);
  updateValidation(activePointsInAoi, activeCandidatesInAoi, renderId);
  updateRanking(activeCandidatesInAoi, renderId);
}

// ---------------------------------------------------------------------------
// KPI, charts, validation, ranking
// ---------------------------------------------------------------------------

function updateKpis(pointsInAoi, candidatesInAoi, renderId, aoiName) {
  var total = pointsInAoi.size();
  var confirmedCount = pointsInAoi.filter(ee.Filter.eq('site_status', 'confirmed')).size();
  var suspectedCount = pointsInAoi.filter(ee.Filter.eq('site_status', 'suspected')).size();
  var controlCount = pointsInAoi.filter(ee.Filter.eq('site_status', 'control')).size();
  var candidateCount = candidatesInAoi.size();
  var highCount = filterCandidatesByTier(candidatesInAoi, 'high').size();
  var mediumCount = filterCandidatesByTier(candidatesInAoi, 'medium').size();
  var lowCount = filterCandidatesByTier(candidatesInAoi, 'low').size();

  ee.Dictionary({
    total: total,
    confirmed: confirmedCount,
    suspected: suspectedCount,
    control: controlCount,
    candidates: candidateCount,
    high: highCount,
    medium: mediumCount,
    low: lowCount
  }).evaluate(function(stats) {
    if (renderId !== activeRenderId) {
      return;
    }
    stats = stats || {};
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
      'High ' + (stats.high || 0) +
      ' | Medium ' + (stats.medium || 0) +
      ' | Low ' + (stats.low || 0)
    );
  });
}

function updateCharts(pointsInAoi, candidatesInAoi, renderId, aoiName) {
  chartsPanel.clear();
  chartsPanel.add(ui.Label('Loading charts...', {
    fontSize: '12px',
    color: COLORS.muted
  }));

  var siteStatusSummary = makeCountFeatureCollection(
    pointsInAoi,
    'site_status',
    ['confirmed', 'suspected', 'control']
  );

  var contextSummary = makeContextFeatureCollection(pointsInAoi);
  var indicatorSummary = null;
  if (activeIndicators) {
    var sampled = activeIndicators.sampleRegions({
      collection: pointsInAoi,
      properties: ['site_status'],
      scale: 30,
      geometries: false
    });
    indicatorSummary = makeIndicatorSummary(sampled);
  }

  chartsPanel.clear();
  chartsPanel.add(
    ui.Chart.feature.byFeature(siteStatusSummary, 'category', 'count')
      .setChartType('PieChart')
      .setOptions({
        title: 'Reported site status',
        pieHole: 0.45,
        colors: [COLORS.confirmed, COLORS.suspected, COLORS.control],
        legend: {position: 'bottom'},
        chartArea: {width: '90%', height: '75%'},
        height: 220
      })
  );

  chartsPanel.add(
    ui.Chart.feature.byFeature(contextSummary, 'context_type', 'count')
      .setChartType('BarChart')
      .setOptions({
        title: 'Spatial context distribution',
        legend: {position: 'none'},
        hAxis: {title: 'Count'},
        vAxis: {title: ''},
        colors: ['#4f46e5'],
        chartArea: {width: '70%', height: '72%'},
        height: 230
      })
  );

  if (indicatorSummary) {
    chartsPanel.add(
      ui.Chart.feature.byFeature(indicatorSummary, 'site_status', ['ndvi_mean', 'ndbi_mean'])
        .setChartType('ColumnChart')
        .setOptions({
          title: 'Mean spectral indicators by site status',
          legend: {position: 'bottom'},
          colors: ['#1a9850', '#b2182b'],
          vAxis: {title: 'Mean value'},
          chartArea: {width: '82%', height: '65%'},
          height: 240
        })
    );
  } else {
    chartsPanel.add(ui.Label(
      'Spectral indicator chart is disabled in Southeast Asia overview to avoid Earth Engine memory limits. Switch to a detailed AOI to inspect NDVI/NDBI layers and site-level means.',
      {fontSize: '12px', color: COLORS.muted, whiteSpace: 'pre-wrap', margin: '6px 0 10px 0'}
    ));
  }

}

function candidateHitCount(pointsFc, candidateFc, bufferMeters) {
  var candidateMask = ee.Image().byte().paint(candidateFc, 1).rename('candidate').selfMask();
  return ee.FeatureCollection(pointsFc.map(function(f) {
    var hit = candidateMask.reduceRegion({
      reducer: ee.Reducer.max(),
      geometry: f.geometry().buffer(bufferMeters),
      scale: 120,
      bestEffort: true,
      maxPixels: 1e10,
      tileScale: 4
    }).get('candidate');

    return f.set('hit', ee.Number(ee.Algorithms.If(hit, 1, 0)));
  })).filter(ee.Filter.eq('hit', 1)).size();
}

function updateValidation(pointsInAoi, candidatesInAoi, renderId) {
  validationPanel.clear();
  validationPanel.add(ui.Label('Loading validation metrics...', {
    fontSize: '12px',
    color: COLORS.muted
  }));

  var confirmedInAoi = pointsInAoi.filter(ee.Filter.eq('site_status', 'confirmed'));
  var suspectedInAoi = pointsInAoi.filter(ee.Filter.eq('site_status', 'suspected'));
  var controlInAoi = pointsInAoi.filter(ee.Filter.eq('site_status', 'control'));

  ee.Dictionary({
    confirmed_total: confirmedInAoi.size(),
    suspected_total: suspectedInAoi.size(),
    control_total: controlInAoi.size(),
    candidate_total: candidatesInAoi.size(),
    suspected_hit_500: candidateHitCount(suspectedInAoi, candidatesInAoi, 500),
    suspected_hit_1000: candidateHitCount(suspectedInAoi, candidatesInAoi, 1000),
    confirmed_hit_500: candidateHitCount(confirmedInAoi, candidatesInAoi, 500),
    control_hit_500: candidateHitCount(controlInAoi, candidatesInAoi, 500)
  }).evaluate(function(stats) {
    if (renderId !== activeRenderId) {
      return;
    }
    stats = stats || {};
    validationPanel.clear();
    validationPanel.add(ui.Label(
      'Current workflow settings: Satellite Embedding 2024, ' +
      SIMILARITY_THRESHOLD_MODE + ' threshold (' + SIMILARITY_THRESHOLD_VALUE.toFixed(3) +
      '), ' + SAMPLE_SCALE_M + ' m sample scale, ' + CANDIDATE_BUFFER_M + ' m candidate buffers, ' +
      REFERENCE_LIMIT + ' confirmed reference sites.',
      {fontSize: '12px', color: COLORS.muted, whiteSpace: 'pre-wrap', margin: '0 0 8px 0'}
    ));

    var candidateCount = stats.candidate_total || 0;
    if (!candidateCount) {
      validationPanel.add(ui.Label(
        'No candidate polygons are loaded for this AOI, so overlap validation cannot be displayed yet.',
        {fontSize: '12px', color: COLORS.muted, whiteSpace: 'pre-wrap'}
      ));
      return;
    }

    validationPanel.add(ui.Label(
      'Suspected sites within 500 m: ' +
      (stats.suspected_hit_500 || 0) + ' / ' + (stats.suspected_total || 0) +
      ' (' + percentageText(stats.suspected_hit_500 || 0, stats.suspected_total || 0) + ')',
      {fontSize: '12px', margin: '2px 0'}
    ));
    validationPanel.add(ui.Label(
      'Suspected sites within 1000 m: ' +
      (stats.suspected_hit_1000 || 0) + ' / ' + (stats.suspected_total || 0) +
      ' (' + percentageText(stats.suspected_hit_1000 || 0, stats.suspected_total || 0) + ')',
      {fontSize: '12px', margin: '2px 0'}
    ));
    validationPanel.add(ui.Label(
      'Confirmed sites within 500 m: ' +
      (stats.confirmed_hit_500 || 0) + ' / ' + (stats.confirmed_total || 0),
      {fontSize: '12px', margin: '2px 0'}
    ));
    validationPanel.add(ui.Label(
      'Control sites within 500 m: ' +
      (stats.control_hit_500 || 0) + ' / ' + (stats.control_total || 0) +
      ' (' + percentageText(stats.control_hit_500 || 0, stats.control_total || 0) + ')',
      {fontSize: '12px', margin: '2px 0 8px 0'}
    ));

    if (candidateCount <= 4) {
      validationPanel.add(ui.Label(
        'Current uploaded candidate asset contains only the high-priority candidate polygons. Upload the full candidate asset to expose medium/low rankings and broader overlap metrics.',
        {fontSize: '12px', color: COLORS.muted, whiteSpace: 'pre-wrap'}
      ));
    }
  });
}

function candidateMetricLabel(props, rankMode) {
  if (rankMode === 'Closest to confirmed') {
    return 'Distance to confirmed: ' + formatNumber(props.dist_to_confirmed_m, 0) + ' m';
  }
  if (rankMode === 'Closest to border') {
    return 'Distance to border: ' + formatNumber(props.dist_to_border_m, 0) + ' m';
  }
  if (rankMode === 'Highest dNDBI') {
    return 'dNDBI 2021-2024: ' + formatNumber(props.dNDBI_2021_2024, 3);
  }
  return 'dNTL 2021-2024: ' + formatNumber(props.dNTL_2021_2024, 2);
}

function geometryCenter(geometry) {
  var coords = [];
  if (!geometry) {
    return null;
  }
  if (geometry.type === 'Point') {
    return {
      lon: geometry.coordinates[0],
      lat: geometry.coordinates[1]
    };
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
  var i;
  for (i = 1; i < coords.length; i++) {
    minLon = Math.min(minLon, coords[i][0]);
    maxLon = Math.max(maxLon, coords[i][0]);
    minLat = Math.min(minLat, coords[i][1]);
    maxLat = Math.max(maxLat, coords[i][1]);
  }
  return {
    lon: (minLon + maxLon) / 2,
    lat: (minLat + maxLat) / 2
  };
}

function populateInfoFromCandidate(properties) {
  infoPanel.clear();
  infoPanel.add(ui.Label('Candidate Area', {
    fontWeight: 'bold',
    margin: '0 0 4px 0'
  }));
  addInfoRow('Candidate ID', properties.candidate_id || 'Unknown');
  addInfoRow('Priority', properties.priority_tier || 'Unknown');
  addInfoRow('Area', formatNumber(properties.area_sqm, 0) + ' sqm');
  addInfoRow('dNDBI 2021-2024', formatNumber(properties.dNDBI_2021_2024, 3));
  addInfoRow('dNDVI 2021-2024', formatNumber(properties.dNDVI_2021_2024, 3));
  addInfoRow('dNTL 2021-2024', formatNumber(properties.dNTL_2021_2024, 2));
  addInfoRow('Distance to confirmed', formatNumber(properties.dist_to_confirmed_m, 0) + ' m');
  addInfoRow('Distance to border', formatNumber(properties.dist_to_border_m, 0) + ' m');
}

function updateRanking(candidatesInAoi, renderId) {
  rankingPanel.clear();
  rankingPanel.add(ui.Label('Loading candidate ranking...', {
    fontSize: '12px',
    color: COLORS.muted
  }));

  var rankMode = rankModeSelect.getValue();
  var cfg = getRankConfig(rankMode);
  var topCandidates = buildTopCandidates(candidatesInAoi, rankMode);

  candidatesInAoi.size().evaluate(function(count) {
    if (renderId !== activeRenderId) {
      return;
    }
    rankingPanel.clear();

    if (!count) {
      rankingPanel.add(ui.Label(
        'No candidate polygons are available for the current AOI.',
        {fontSize: '12px', color: COLORS.muted}
      ));
      return;
    }

    var topCandidatesChart = topCandidates.map(function(f) {
      return ee.Feature(null, {
        candidate_id: f.get('candidate_id'),
        value: f.get(cfg.field)
      });
    });

    rankingPanel.add(
      ui.Chart.feature.byFeature(topCandidatesChart, 'candidate_id', 'value')
        .setChartType('ColumnChart')
        .setOptions({
          title: cfg.title,
          legend: {position: 'none'},
          colors: ['#6d28d9'],
          vAxis: {title: cfg.axis},
          hAxis: {title: ''},
          chartArea: {width: '82%', height: '62%'},
          height: 230
        })
    );

    var listPanel = ui.Panel({style: {margin: '8px 0 0 0'}});
    rankingPanel.add(listPanel);

    var topCandidatesList = topCandidates.map(function(f) {
      var centroid = f.geometry().centroid(30);
      return ee.Feature(centroid, {
        candidate_id: f.get('candidate_id'),
        priority_tier: f.get('priority_tier'),
        area_sqm: f.get('area_sqm'),
        dNDVI_2021_2024: f.get('dNDVI_2021_2024'),
        dNDBI_2021_2024: f.get('dNDBI_2021_2024'),
        dNTL_2021_2024: f.get('dNTL_2021_2024'),
        dist_to_border_m: f.get('dist_to_border_m'),
        dist_to_confirmed_m: f.get('dist_to_confirmed_m')
      });
    });

    topCandidatesList.evaluate(function(fc) {
      if (renderId !== activeRenderId) {
        return;
      }
      if (!fc || !fc.features || !fc.features.length) {
        listPanel.add(ui.Label('No ranked features available.', {
          fontSize: '12px',
          color: COLORS.muted
        }));
        return;
      }

      fc.features.forEach(function(feature, index) {
        var props = feature.properties || {};
        var center = geometryCenter(feature.geometry);
        var label = (index + 1) + '. ' + (props.candidate_id || 'Candidate') +
          ' | ' + candidateMetricLabel(props, rankMode);

        var button = ui.Button({
          label: label,
          style: {stretch: 'horizontal', margin: '0 0 4px 0'},
          onClick: function() {
            if (center) {
              map.setCenter(center.lon, center.lat, 11);
            }
            populateInfoFromCandidate(props);
          }
        });
        listPanel.add(button);
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Info panel and map click
// ---------------------------------------------------------------------------

function setDefaultInfo() {
  infoPanel.clear();
  var defaultText = activeIndicators
    ? 'Click anywhere on the map to sample NDVI, NDBI and night-time lights, find the nearest reported site, and inspect candidate metrics if the clicked point falls inside a candidate polygon.'
    : 'Imagery and pixel-level sampling are loaded on demand. Click "Load Imagery Layers" for the current detailed AOI when you need Sentinel or VIIRS inspection.';
  infoPanel.add(ui.Label(
    defaultText,
    {fontSize: '12px', color: COLORS.muted, whiteSpace: 'pre-wrap'}
  ));
}

function nearestReportedSite(point) {
  return activePointsInAoi
    .map(function(feature) {
      return feature.set('distance_m', feature.geometry().distance(point, 1));
    })
    .sort('distance_m')
    .first();
}

function addInfoRow(label, value) {
  infoPanel.add(ui.Label(label + ': ' + value, {
    fontSize: '12px',
    margin: '1px 0'
  }));
}

map.onClick(function(coords) {
  infoPanel.clear();
  infoPanel.add(ui.Label('Loading selected location...', {
    fontSize: '12px',
    color: COLORS.muted
  }));

  var point = ee.Geometry.Point([coords.lon, coords.lat]);
  var nearest = nearestReportedSite(point);
  var sampled = activeIndicators
    ? activeIndicators.sample({
        region: point,
        scale: 30,
        numPixels: 1,
        geometries: false
      }).first()
    : null;

  nearest.evaluate(function(siteFeature) {
    var handleSample = function(sampleFeature) {
      infoPanel.clear();
      infoPanel.add(ui.Label('Selected Location', {
        fontWeight: 'bold',
        margin: '0 0 4px 0'
      }));

      addInfoRow('Longitude', formatNumber(coords.lon, 5));
      addInfoRow('Latitude', formatNumber(coords.lat, 5));

      if (sampleFeature && sampleFeature.properties) {
        var p = sampleFeature.properties;
        addInfoRow('NDVI ' + DISPLAY_YEAR, formatNumber(p['NDVI_' + DISPLAY_YEAR], 3));
        addInfoRow('NDBI ' + DISPLAY_YEAR, formatNumber(p['NDBI_' + DISPLAY_YEAR], 3));
        addInfoRow('Delta NDVI', formatNumber(p['dNDVI_' + BASELINE_YEAR + '_' + ANALYSIS_YEAR], 3));
        addInfoRow('Delta NDBI', formatNumber(p['dNDBI_' + BASELINE_YEAR + '_' + ANALYSIS_YEAR], 3));
        addInfoRow('NTL ' + DISPLAY_YEAR, formatNumber(p['NTL_' + DISPLAY_YEAR], 2));
        addInfoRow('Delta NTL', formatNumber(p['dNTL_' + BASELINE_YEAR + '_' + ANALYSIS_YEAR], 2));
      } else {
        addInfoRow('Indicators', activeIndicators ? 'No image data at this point' : 'Disabled in overview mode');
      }

      infoPanel.add(ui.Label('Nearest Reported Site', {
        fontWeight: 'bold',
        margin: '8px 0 4px 0'
      }));

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

      var candidateAtPoint = activeCandidatesInAoi.filterBounds(point).first();
      candidateAtPoint.evaluate(function(candidateFeature) {
        if (!candidateFeature || !candidateFeature.properties) {
          return;
        }
        var c = candidateFeature.properties;
        infoPanel.add(ui.Label('Candidate Area', {
          fontWeight: 'bold',
          margin: '8px 0 4px 0'
        }));
        addInfoRow('Candidate ID', c.candidate_id || candidateFeature.id || 'Unknown');
        addInfoRow('Priority', c.priority_tier || 'Unknown');
        addInfoRow('dNDBI 2021-2024', formatNumber(c.dNDBI_2021_2024, 3));
        addInfoRow('dNDVI 2021-2024', formatNumber(c.dNDVI_2021_2024, 3));
        addInfoRow('dNTL 2021-2024', formatNumber(c.dNTL_2021_2024, 2));
        addInfoRow('Distance to border', formatNumber(c.dist_to_border_m, 0) + ' m');
        addInfoRow('Distance to confirmed', formatNumber(c.dist_to_confirmed_m, 0) + ' m');
      });
    };

    if (sampled) {
      sampled.evaluate(handleSample);
    } else {
      handleSample(null);
    }
  });
});

// ---------------------------------------------------------------------------
// Render and refresh
// ---------------------------------------------------------------------------

function renderAoi(aoiName) {
  activeRenderId += 1;
  var renderId = activeRenderId;
  activeAoi = AOIS[aoiName];
  activePointsInAoi = scamPoints.filterBounds(activeAoi);
  activeCandidatesInAoi = candidates.filterBounds(activeAoi);
  var overviewMode = isOverviewAoiName(aoiName);
  var indicators = null;
  activeIndicators = null;
  if (!overviewMode && indicatorCache[aoiName]) {
    indicators = indicatorCache[aoiName];
    activeIndicators = indicators.stack;
  }

  loadImageryButton.setLabel(overviewMode
    ? 'Overview imagery disabled'
    : (indicatorCache[aoiName] ? 'Imagery loaded for ' + aoiName : 'Load Imagery Layers'));

  currentLayers = {};
  map.layers().reset([]);
  map.centerObject(activeAoi, aoiName === 'Southeast Asia overview' ? 5 : 7);

  if (!overviewMode && indicators) {
    addLayer('rgb', indicators.rgb, {
      bands: ['B4', 'B3', 'B2'],
      min: 0,
      max: 3000
    }, 'Sentinel-2 RGB (' + DISPLAY_YEAR + ')', false);

    addLayer('ndvi', indicators.ndvi, {
      min: -0.4,
      max: 0.8,
      palette: ['#8c510a', '#f6e8c3', '#1a9850']
    }, 'NDVI (' + DISPLAY_YEAR + ')', false);

    addLayer('ndbi', indicators.ndbi, {
      min: -0.5,
      max: 0.5,
      palette: ['#2166ac', '#f7f7f7', '#b2182b']
    }, 'NDBI (' + DISPLAY_YEAR + ')', false);

    addLayer('dNdvi', indicators.dNdvi, {
      min: -0.35,
      max: 0.35,
      palette: ['#b2182b', '#f7f7f7', '#1a9850']
    }, 'Delta NDVI (' + BASELINE_YEAR + '-' + ANALYSIS_YEAR + ')', false);

    addLayer('dNdbi', indicators.dNdbi, {
      min: -0.25,
      max: 0.25,
      palette: ['#2166ac', '#f7f7f7', '#b2182b']
    }, 'Delta NDBI (' + BASELINE_YEAR + '-' + ANALYSIS_YEAR + ')', false);

    addLayer('ntl', indicators.ntl, {
      min: 0,
      max: 20,
      palette: ['#000000', '#2c7bb6', '#ffffbf', '#d7191c']
    }, 'Night-time lights (' + DISPLAY_YEAR + ')', false);

    addLayer('dNtl', indicators.dNtl, {
      min: -5,
      max: 5,
      palette: ['#2c7bb6', '#f7f7f7', '#d7191c']
    }, 'Delta NTL (' + BASELINE_YEAR + '-' + ANALYSIS_YEAR + ')', false);
  }

  addLayer('allAois', styleRegionalAois(), {}, 'Regional AOI boundaries', true);
  addLayer('aoi', styleAoi(activeAoi), {}, 'Selected AOI boundary', true);

  var pointsLayerSource = overviewMode ? scamPoints : activePointsInAoi;
  var candidatesLayerSource = overviewMode ? candidates : activeCandidatesInAoi;

  addLayer('confirmed', stylePointCollection(pointsLayerSource.filter(ee.Filter.eq('site_status', 'confirmed')), COLORS.confirmed, 7), {}, 'Confirmed sites', true);
  addLayer('suspected', stylePointCollection(pointsLayerSource.filter(ee.Filter.eq('site_status', 'suspected')), COLORS.suspected, 7), {}, 'Suspected sites', true);
  addLayer('control', stylePointCollection(pointsLayerSource.filter(ee.Filter.eq('site_status', 'control')), COLORS.control, 6), {}, 'Control sites', true);

  addLayer('candidateLow', styleCandidateTier(filterCandidatesByTier(candidatesLayerSource, 'low'), COLORS.low, '#facc1512', 1), {}, 'Low-priority candidates', false);
  addLayer('candidateMedium', styleCandidateTier(filterCandidatesByTier(candidatesLayerSource, 'medium'), COLORS.medium, '#f9731618', 1.5), {}, 'Medium-priority candidates', false);
  addLayer('candidateHigh', styleCandidateTier(filterCandidatesByTier(candidatesLayerSource, 'high'), COLORS.high, '#d946ef22', 3), {}, 'High-priority candidates', true);

  updateLayerControls();
  updateKpis(activePointsInAoi, activeCandidatesInAoi, renderId, aoiName);
  setAnalyticsPlaceholder(aoiName);
  setDefaultInfo();
}

aoiSelect.onChange(function(value) {
  renderAoi(value);
});

rankModeSelect.onChange(function() {
  rankingPanel.clear();
  rankingPanel.add(ui.Label(
    'Ranking metric changed. Click "Refresh Analytics" to recompute candidate ranking.',
    {fontSize: '12px', color: COLORS.muted, whiteSpace: 'pre-wrap'}
  ));
});

renderAoi(DEFAULT_AOI);
