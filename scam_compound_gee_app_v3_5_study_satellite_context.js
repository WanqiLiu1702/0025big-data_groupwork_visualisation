// CASA0025 GEE App V3 (performance-optimised build of V2)
//
// Functional parity with V2: tiered candidate map, reported-site layers, stage funnel,
// validation charts, evidence scatter, priority review list.
//
// Key optimisations vs V2:
//   1. Candidate property normalisation uses FeatureCollection.select with
//      regex alternation — replaces the per-feature If(contains(...)) chain.
//   2. Candidate tier image paints polygons directly as one categorical layer.
//   3. Reported points are filtered BEFORE lon/lat reparse, so only the ~150
//      kept features pay the parse cost.
//   4. Each AOI's fully-built layer stack is cached; switching AOIs reuses the
//      existing ui.Map.Layer objects, so tile requests hit server-side cache.
//   5. Tier-split candidate collections are built once per AOI and reused by
//      the evidence scatter and priority ranking.
//
// V3.1 changes:
//   - AOIs replaced with real country boundary geometries (no more rectangles)
//   - Province-level (GAUL level-1) borders added inside each AOI
//   - AOI outline style changed to thin dark line (no white rectangle frame)
//   - Satellite imagery clipped to true country outlines

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------


var SCAM_POINTS_ASSET = 'projects/casa0025wk6/assets/scam_points_cleaned';
var CANDIDATE_ASSET   = 'projects/casa0025wk6/assets/Final_Summary_Table_Complete';

// ---------------------------------------------------------------------------
// Precomputed workflow summaries
// ---------------------------------------------------------------------------

var WORKFLOW_COUNTS = {
  reported_confirmed: 53,
  reported_suspected: 45,
  stage1_candidates:  24464,
  stage2_high:        8425,
  stage2_medium:      13059,
  stage2_low:         2980,
  shortlist:          15
};

var PRECOMPUTED_VALIDATION = {
  high: {
    candidate_count: 8425,
    controls_hit_500m: 2,   controls_hit_1000m: 6,
    controls_in_aoi: 22,
    non_reference_confirmed_hit_500m: 5,  non_reference_confirmed_hit_1000m: 10,
    non_reference_confirmed_in_aoi: 50,
    suspected_hit_500m: 7,  suspected_hit_1000m: 12,
    suspected_in_aoi: 45
  },
  medium: {
    candidate_count: 13059,
    controls_hit_500m: 4,   controls_hit_1000m: 11,
    controls_in_aoi: 22,
    non_reference_confirmed_hit_500m: 14, non_reference_confirmed_hit_1000m: 18,
    non_reference_confirmed_in_aoi: 50,
    suspected_hit_500m: 5,  suspected_hit_1000m: 13,
    suspected_in_aoi: 45
  },
  low: {
    candidate_count: 2980,
    controls_hit_500m: 2,   controls_hit_1000m: 3,
    controls_in_aoi: 22,
    non_reference_confirmed_hit_500m: 1,  non_reference_confirmed_hit_1000m: 2,
    non_reference_confirmed_in_aoi: 50,
    suspected_hit_500m: 0,  suspected_hit_1000m: 0,
    suspected_in_aoi: 45
  },
  all_refined: {
    candidate_count: 24464,
    controls_hit_500m: 7,   controls_hit_1000m: 12,
    controls_in_aoi: 22,
    non_reference_confirmed_hit_500m: 18, non_reference_confirmed_hit_1000m: 25,
    non_reference_confirmed_in_aoi: 50,
    suspected_hit_500m: 12, suspected_hit_1000m: 21,
    suspected_in_aoi: 45
  }
};

var VALIDATION_TIER_ORDER  = ['high', 'medium', 'low', 'all_refined'];
var VALIDATION_TIER_LABELS = {
  high:        'High',
  medium:      'Medium',
  low:         'Low',
  all_refined: 'All refined'
};

// ---------------------------------------------------------------------------
// AOIs — real country boundaries instead of rectangles
// ---------------------------------------------------------------------------

var LSIB = ee.FeatureCollection('USDOS/LSIB_SIMPLE/2017');

// Individual country geometries (LSIB uses 'Burma' for Myanmar, 'Laos' for Lao PDR)
var geom_cambodia = LSIB.filter(ee.Filter.eq('country_na', 'Cambodia')).geometry();
var geom_vietnam  = LSIB.filter(ee.Filter.eq('country_na', 'Vietnam')).geometry();
var geom_myanmar  = LSIB.filter(ee.Filter.eq('country_na', 'Burma')).geometry();
var geom_thailand = LSIB.filter(ee.Filter.eq('country_na', 'Thailand')).geometry();
var geom_laos     = LSIB.filter(ee.Filter.eq('country_na', 'Laos')).geometry();
var STUDY_GEOM    = geom_cambodia.union(geom_vietnam)
                     .union(geom_myanmar).union(geom_thailand).union(geom_laos);
var STUDY_BOUNDS  = STUDY_GEOM.bounds(1000);

// Cambodia border corridor — Cambodia and Vietnam geometry, with the
// Cambodia-Thailand shared border highlighted as an adjacent study signal.
var AOI_CV = geom_cambodia.union(geom_vietnam);

// Myanmar-Thailand border — union of both countries
var AOI_MT = geom_myanmar.union(geom_thailand);

// Golden Triangle — three-country intersection clipped to the border region
var goldenTriangleBounds = ee.Geometry.Rectangle([98.0, 19.5, 102.5, 22.5]);
var AOI_GT = geom_myanmar.union(geom_thailand).union(geom_laos)
               .intersection(goldenTriangleBounds);

// Southeast Asia overview — all study countries combined
var AOI_SEA = STUDY_GEOM;

var AOIS = {
  'Cambodia Border Corridor': AOI_CV,
  'Myanmar-Thailand Border':  AOI_MT,
  'Golden Triangle (future extension)': AOI_GT,
  'Southeast Asia overview': AOI_SEA
};

var DEFAULT_AOI = 'Cambodia Border Corridor';

function isOverviewAoiName(aoiName) {
  return aoiName === 'Southeast Asia overview';
}

var AOI_VIEWS = {
  'Cambodia Border Corridor': {lon: 104.5, lat: 13.0, zoom: 7},
  'Myanmar-Thailand Border':  {lon: 98.8,  lat: 17.2, zoom: 6},
  'Golden Triangle (future extension)': {lon: 100.2, lat: 21.0, zoom: 8},
  'Southeast Asia overview': {lon: 102.5, lat: 15.5, zoom: 5}
};

function setMapToAoiView(targetMap, aoiName) {
  var view = AOI_VIEWS[aoiName] || AOI_VIEWS[DEFAULT_AOI];
  targetMap.setCenter(view.lon, view.lat, view.zoom);
}

// ---------------------------------------------------------------------------
// Styling
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Language support
// ---------------------------------------------------------------------------

var currentLanguage = 'English';

var TRANSLATIONS = {
  'English': {
    'Scam Compound Explorer V3': 'Scam Compound Explorer V3',
    'AOI Controls': 'AOI Controls',
    'Regional focus': 'Regional focus',
    'Reset View': 'Reset View',
    'Show Overview': 'Show Overview',
    'AOI satellite: ON': 'AOI satellite: ON',
    'AOI satellite: OFF': 'AOI satellite: OFF',
    'Overview': 'Overview',
    'Stage Funnel': 'Stage Funnel',
    'Validation': 'Validation',
    'Evidence Scatter': 'Evidence Scatter',
    'Load Evidence & Ranking': 'Load Evidence & Ranking',
    'Priority Review List': 'Priority Review List',
    'Ranking metric': 'Ranking metric',
    'Layers': 'Layers',
    'Click Map': 'Click Map',
    'Legend': 'Legend',
    'Confirmed site': 'Confirmed site',
    'Suspected site': 'Suspected site',
    'Control site': 'Control site',
    'Candidate density': 'Candidate density',
    'High candidate tier': 'High candidate tier',
    'Medium candidate tier': 'Medium candidate tier',
    'Low candidate tier': 'Low candidate tier',
    'Confirmed sites': 'Confirmed sites',
    'Suspected sites': 'Suspected sites',
    'Control sites': 'Control sites',
    'Country borders': 'Country borders',
    'Province borders': 'Province borders',
    'Key shared borders': 'Key shared borders',
    'Study area boundary': 'Study area boundary',
    'AOI satellite — core (Cambodia)': 'AOI satellite — core (Cambodia)',
    'AOI satellite — peripheral': 'AOI satellite — peripheral',
    'Selected Location': 'Selected Location',
    'Nearest Reported Site': 'Nearest Reported Site',
    'Candidate Area': 'Candidate Area',
    'Loading...': 'Loading...',
    'Highest dNTL': 'Highest dNTL',
    'Highest dNDBI': 'Highest dNDBI',
    'Closest to confirmed': 'Closest to confirmed',
    'Workflow summary only. Tier counts are shown in Candidate Zones by Tier.': 'Workflow summary only. Tier counts are shown in Candidate Zones by Tier.',
    'subtitle': 'Candidate tiers are shown as red, yellow, and green zones over satellite imagery clipped to country boundaries.'
  },
  'Khmer': {
    'Scam Compound Explorer V3': 'ឧបករណ៍ស្វែងរកទីតាំងបោកប្រាស់',
    'AOI Controls': 'ការគ្រប់គ្រងតំបន់',
    'Regional focus': 'តំបន់ស្រាវជ្រាវ',
    'Reset View': 'កំណត់ទិដ្ឋភាពឡើងវិញ',
    'Show Overview': 'បង្ហាញទិដ្ឋភាពទូទៅ',
    'AOI satellite: ON': 'រូបភាពផ្កាយរណប: បើក',
    'AOI satellite: OFF': 'រូបភាពផ្កាយរណប: បិទ',
    'Overview': 'ទិដ្ឋភាពទូទៅ',
    'Stage Funnel': 'តម្រងដំណាក់កាល',
    'Validation': 'ការផ្ទៀងផ្ទាត់',
    'Evidence Scatter': 'ការបែងចែកភស្តុតាង',
    'Load Evidence & Ranking': 'ផ្ទុកភស្តុតាង និងចំណាត់ថ្នាក់',
    'Priority Review List': 'បញ្ជីត្រួតពិនិត្យអាទិភាព',
    'Ranking metric': 'លក្ខណៈវិនិច្ឆ័យចំណាត់ថ្នាក់',
    'Layers': 'ស្រទាប់',
    'Click Map': 'ចុចលើផែនទី',
    'Legend': 'សញ្ញាបញ្ជាក់',
    'Confirmed site': 'ទីតាំងបានបញ្ជាក់',
    'Suspected site': 'ទីតាំងសង្ស័យ',
    'Control site': 'ទីតាំងត្រួតពិនិត្យ',
    'Candidate density': 'ដង់ស៊ីតេបេក្ខជន',
    'High candidate tier': 'បេក្ខជនកម្រិតខ្ពស់',
    'Medium candidate tier': 'បេក្ខជនកម្រិតមធ្យម',
    'Low candidate tier': 'បេក្ខជនកម្រិតទាប',
    'Confirmed sites': 'ទីតាំងបានបញ្ជាក់',
    'Suspected sites': 'ទីតាំងសង្ស័យ',
    'Control sites': 'ទីតាំងត្រួតពិនិត្យ',
    'Country borders': 'ព្រំដែនប្រទេស',
    'Province borders': 'ព្រំដែនខេត្ត',
    'Key shared borders': 'ព្រំដែនចែករំលែកសំខាន់',
    'Study area boundary': 'ព្រំដែនតំបន់ស្រាវជ្រាវ',
    'AOI satellite — core (Cambodia)': 'ផ្កាយរណប — កម្ពុជា',
    'AOI satellite — peripheral': 'ផ្កាយរណប — តំបន់ជុំវិញ',
    'Selected Location': 'ទីតាំងដែលបានជ្រើស',
    'Nearest Reported Site': 'ទីតាំងរាយការណ៍ជិតបំផុត',
    'Candidate Area': 'តំបន់បេក្ខជន',
    'Loading...': 'កំពុងផ្ទុក...',
    'Highest dNTL': 'dNTL ខ្ពស់បំផុត',
    'Highest dNDBI': 'dNDBI ខ្ពស់បំផុត',
    'Closest to confirmed': 'ជិតទីតាំងបញ្ជាក់បំផុត',
    'subtitle': 'រូបភាពផ្កាយរណបត្រូវបានកាត់តាមព្រំដែនប្រទេស។ ព្រំដែនខេត្តត្រូវបានបង្ហាញ។',
    'This chart shows the Cambodia-Vietnam workflow counts, not the current viewport.': 'តារាងនេះបង្ហាញចំនួនដំណើរការកម្ពុជា-វៀតណាម មិនមែនទិដ្ឋភាពបច្ចុប្បន្នទេ។',
    'Workflow summary only. Tier counts are shown in Candidate Zones by Tier.': 'សង្ខេបដំណើរការប៉ុណ្ណោះ។ ចំនួនតាមកម្រិតបង្ហាញក្នុងតំបន់បេក្ខជនតាមកម្រិត។',
    'Validation figures are read from precomputed outputs — charts load instantly without running overlap checks inside the app.': 'តួលេខផ្ទៀងផ្ទាត់ត្រូវបានអានពីលទ្ធផលដែលបានគណនាជាមុន។',
    'Evidence scatter and the review list are loaded on demand so the map stays light.': 'ការបែងចែកភស្តុតាងត្រូវបានផ្ទុកតាមការស្នើសុំ។',
    'Click "Load Evidence & Ranking" to sample candidates in': 'ចុច "ផ្ទុកភស្តុតាង និងចំណាត់ថ្នាក់" ដើម្បីជ្រើសរើសបេក្ខជននៅក្នុង',
'and draw the dNDBI vs dNTL scatter.': 'និងគូររូបភាព dNDBI vs dNTL។',
'Click "Load Evidence & Ranking" to build the priority review list for the current AOI.': 'ចុច "ផ្ទុកភស្តុតាង និងចំណាត់ថ្នាក់" ដើម្បីបង្កើតបញ្ជីត្រួតពិនិត្យអាទិភាព។',
'Click anywhere on the map to inspect the nearest reported site and any candidate zone at that location.': 'ចុចគ្រប់ទីកន្លែងលើផែនទីដើម្បីពិនិត្យទីតាំងដែលបានរាយការណ៍ជិតបំផុត។',
'Loading selected location...': 'កំពុងផ្ទុកទីតាំងដែលបានជ្រើស...',
'Selected Location': 'ទីតាំងដែលបានជ្រើស',
'Nearest Reported Site': 'ទីតាំងរាយការណ៍ជិតបំផុត',
'Longitude': 'រយៈទទឹង',
'Latitude': 'រយៈបណ្តោយ',
'Name': 'ឈ្មោះ',
'Status': 'ស្ថានភាព',
'Country': 'ប្រទេស',
'Context': 'បរិបទ',
'Distance': 'គម្លាត',
'No reported site found': 'រកមិនឃើញទីតាំងដែលបានរាយការណ៍',
'Candidate Area': 'តំបន់បេក្ខជន',
'Candidate ID': 'លេខសម្គាល់បេក្ខជន',
'Priority': 'អាទិភាព',
'Area': 'ផ្ទៃក្រឡា',
'Distance to confirmed': 'គម្លាតទៅទីតាំងបញ្ជាក់',
'Distance to border': 'គម្លាតទៅព្រំដែន',
'Ranking metric changed. Click "Load Evidence & Ranking" to rebuild the review list.': 'លក្ខណៈវិនិច្ឆ័យចំណាត់ថ្នាក់ត្រូវបានផ្លាស់ប្តូរ។ ចុច "ផ្ទុកភស្តុតាង និងចំណាត់ថ្នាក់" ដើម្បីបង្កើតបញ្ជីឡើងវិញ។',
'Top candidates by distance to confirmed': 'បេក្ខជនកំពូលតាមគម្លាតទៅទីតាំងបញ្ជាក់',
'Top candidates by built-up growth': 'បេក្ខជនកំពូលតាមការលូតលាស់ទីក្រុង',
'Top candidates by night-time light growth': 'បេក្ខជនកំពូលតាមការលូតលាស់ពន្លឺយប់',
'Bars compare each candidate against the top 8. Red = active ranking metric. For distance, shorter bar = closer.': 'របារប្រៀបធៀបបេក្ខជននីមួយៗជាមួយ 8 កំពូល។',
'No candidate rows available for the current AOI.': 'មិនមានទិន្នន័យបេក្ខជនសម្រាប់តំបន់បច្ចុប្បន្ន។',
'Each point is a sampled candidate. Bubble size removed — area_sqm is nearly constant in this dataset.': 'ចំណុចនីមួយៗជាបេក្ខជនគំរូ។',
'No candidate rows available for the current AOI.': 'មិនមានទិន្នន័យបេក្ខជន។',
'Stage funnel (Cambodia-Vietnam workflow)': 'តម្រងដំណាក់កាល (ដំណើរការកម្ពុជា-វៀតណាម)',
'Candidate counts by tier': 'ចំនួនបេក្ខជនតាមថ្នាក់',
'Validation hit rates (500 m)': 'អត្រាផ្ទៀងផ្ទាត់ (៥០០ ម)',
'Validation hit rates (1000 m)': 'អត្រាផ្ទៀងផ្ទាត់ (១០០០ ម)',
'View in panel ↓': 'មើលក្នុងផ្ទាំង ↓',
'Select a value...': 'ជ្រើសរើសតម្លៃ...',
'About & Methodology': 'អំពី និងវិធីសាស្ត្រ',
'✕ Close Methodology': '✕ បិទវិធីសាស្ត្រ',
'ℹ About & Methodology': 'ℹ អំពី និងវិធីសាស្ត្រ',
'About This Tool': 'អំពីឧបករណ៍នេះ',
'Stage 1 — Satellite Embedding Similarity': 'ដំណាក់កាល ១ — ភាពស្រដៀងគ្នានៃផ្កាយរណប',
'Stage 2 — Indicator-Based Refinement': 'ដំណាក់កាល ២ — ការចំរាញ់ដោយប្រើសូចនាករ',
'Tier Classification': 'ការចាត់ថ្នាក់',
'Validation': 'ការផ្ទៀងផ្ទាត់',
'Data Sources': 'ប្រភពទិន្នន័យ',
'Candidate Zones by Tier': 'តំបន់បេក្ខជនតាមថ្នាក់',
'AOI Dashboard': 'ផ្ទាំងគ្រប់គ្រងតំបន់',
'Year Compare: OFF': 'ប្រៀបធៀបឆ្នាំ: បិទ',
'Year Compare: ON': 'ប្រៀបធៀបឆ្នាំ: បើក',
  },
  'Thai': {
    'Scam Compound Explorer V3': 'เครื่องมือสำรวจแหล่งหลอกลวง',
    'AOI Controls': 'ควบคุมพื้นที่',
    'Regional focus': 'พื้นที่ศึกษา',
    'Reset View': 'รีเซ็ตมุมมอง',
    'Show Overview': 'แสดงภาพรวม',
    'AOI satellite: ON': 'ภาพดาวเทียม: เปิด',
    'AOI satellite: OFF': 'ภาพดาวเทียม: ปิด',
    'Overview': 'ภาพรวม',
    'Stage Funnel': 'ขั้นตอนการกรอง',
    'Validation': 'การตรวจสอบ',
    'Evidence Scatter': 'การกระจายหลักฐาน',
    'Load Evidence & Ranking': 'โหลดหลักฐานและการจัดอันดับ',
    'Priority Review List': 'รายการตรวจสอบลำดับความสำคัญ',
    'Ranking metric': 'เกณฑ์การจัดอันดับ',
    'Layers': 'ชั้นข้อมูล',
    'Click Map': 'คลิกแผนที่',
    'Legend': 'คำอธิบายสัญลักษณ์',
    'Confirmed site': 'พื้นที่ยืนยัน',
    'Suspected site': 'พื้นที่สงสัย',
    'Control site': 'พื้นที่ควบคุม',
    'Candidate density': 'ความหนาแน่นผู้สมัคร',
    'High candidate tier': 'ผู้สมัครระดับสูง',
    'Medium candidate tier': 'ผู้สมัครระดับกลาง',
    'Low candidate tier': 'ผู้สมัครระดับต่ำ',
    'Confirmed sites': 'พื้นที่ยืนยัน',
    'Suspected sites': 'พื้นที่สงสัย',
    'Control sites': 'พื้นที่ควบคุม',
    'Country borders': 'พรมแดนประเทศ',
    'Province borders': 'พรมแดนจังหวัด',
    'Key shared borders': 'พรมแดนร่วมสำคัญ',
    'Study area boundary': 'ขอบเขตพื้นที่ศึกษา',
    'AOI satellite — core (Cambodia)': 'ดาวเทียม — กัมพูชา',
    'AOI satellite — peripheral': 'ดาวเทียม — พื้นที่รอบนอก',
    'Selected Location': 'ตำแหน่งที่เลือก',
    'Nearest Reported Site': 'พื้นที่รายงานที่ใกล้ที่สุด',
    'Candidate Area': 'พื้นที่ผู้สมัคร',
    'Loading...': 'กำลังโหลด...',
    'Highest dNTL': 'dNTL สูงสุด',
    'Highest dNDBI': 'dNDBI สูงสุด',
    'Closest to confirmed': 'ใกล้พื้นที่ยืนยันมากที่สุด',
    'subtitle': 'ภาพดาวเทียมถูกตัดตามขอบเขตประเทศจริง แสดงพรมแดนระดับจังหวัด',
    'This chart shows the Cambodia-Vietnam workflow counts, not the current viewport.': 'แผนภูมินี้แสดงจำนวนขั้นตอนกัมพูชา-เวียดนาม ไม่ใช่มุมมองปัจจุบัน',
    'Workflow summary only. Tier counts are shown in Candidate Zones by Tier.': 'สรุปขั้นตอนเท่านั้น จำนวนตามระดับอยู่ในพื้นที่ผู้สมัครตามระดับ',
'Validation figures are read from precomputed outputs — charts load instantly without running overlap checks inside the app.': 'ตัวเลขการตรวจสอบอ่านจากผลลัพธ์ที่คำนวณไว้ล่วงหน้า',
'Evidence scatter and the review list are loaded on demand so the map stays light.': 'การกระจายหลักฐานถูกโหลดตามต้องการ',
'Click "Load Evidence & Ranking" to sample candidates in': 'คลิก "โหลดหลักฐานและการจัดอันดับ" เพื่อสุ่มตัวอย่างผู้สมัครใน',
'and draw the dNDBI vs dNTL scatter.': 'และวาดกราฟ dNDBI vs dNTL',
'Click "Load Evidence & Ranking" to build the priority review list for the current AOI.': 'คลิก "โหลดหลักฐานและการจัดอันดับ" เพื่อสร้างรายการตรวจสอบ',
'Click anywhere on the map to inspect the nearest reported site and any candidate zone at that location.': 'คลิกที่ใดก็ได้บนแผนที่เพื่อตรวจสอบพื้นที่รายงานที่ใกล้ที่สุด',
'Loading selected location...': 'กำลังโหลดตำแหน่งที่เลือก...',
'Selected Location': 'ตำแหน่งที่เลือก',
'Nearest Reported Site': 'พื้นที่รายงานที่ใกล้ที่สุด',
'Longitude': 'ลองจิจูด',
'Latitude': 'ละติจูด',
'Name': 'ชื่อ',
'Status': 'สถานะ',
'Country': 'ประเทศ',
'Context': 'บริบท',
'Distance': 'ระยะทาง',
'No reported site found': 'ไม่พบพื้นที่รายงาน',
'Candidate Area': 'พื้นที่ผู้สมัคร',
'Candidate ID': 'รหัสผู้สมัคร',
'Priority': 'ลำดับความสำคัญ',
'Area': 'พื้นที่',
'Distance to confirmed': 'ระยะทางถึงพื้นที่ยืนยัน',
'Distance to border': 'ระยะทางถึงพรมแดน',
'Ranking metric changed. Click "Load Evidence & Ranking" to rebuild the review list.': 'เกณฑ์การจัดอันดับเปลี่ยนแล้ว คลิก "โหลดหลักฐานและการจัดอันดับ" เพื่อสร้างรายการใหม่',
'Top candidates by distance to confirmed': 'ผู้สมัครอันดับต้นตามระยะทางถึงพื้นที่ยืนยัน',
'Top candidates by built-up growth': 'ผู้สมัครอันดับต้นตามการเติบโตของสิ่งปลูกสร้าง',
'Top candidates by night-time light growth': 'ผู้สมัครอันดับต้นตามการเติบโตของแสงกลางคืน',
'Bars compare each candidate against the top 8. Red = active ranking metric. For distance, shorter bar = closer.': 'แท่งเปรียบเทียบผู้สมัครแต่ละคนกับ 8 อันดับแรก',
'No candidate rows available for the current AOI.': 'ไม่มีข้อมูลผู้สมัครสำหรับพื้นที่ปัจจุบัน',
'Each point is a sampled candidate. Bubble size removed — area_sqm is nearly constant in this dataset.': 'แต่ละจุดคือผู้สมัครที่สุ่มตัวอย่าง',
'Stage funnel (Cambodia-Vietnam workflow)': 'ขั้นตอนการกรอง (กระบวนการกัมพูชา-เวียดนาม)',
'Candidate counts by tier': 'จำนวนผู้สมัครตามระดับ',
'Validation hit rates (500 m)': 'อัตราการตรวจสอบ (500 ม)',
'Validation hit rates (1000 m)': 'อัตราการตรวจสอบ (1000 ม)',
'View in panel ↓': 'ดูในแผง ↓',
'Select a value...': 'เลือกค่า...',
'About & Methodology': 'เกี่ยวกับและวิธีการ',
'✕ Close Methodology': '✕ ปิดวิธีการ',
'ℹ About & Methodology': 'ℹ เกี่ยวกับและวิธีการ',
'About This Tool': 'เกี่ยวกับเครื่องมือนี้',
'Stage 1 — Satellite Embedding Similarity': 'ขั้นตอนที่ 1 — ความคล้ายคลึงของดาวเทียม',
'Stage 2 — Indicator-Based Refinement': 'ขั้นตอนที่ 2 — การปรับแต่งด้วยตัวชี้วัด',
'Tier Classification': 'การจัดระดับ',
'Validation': 'การตรวจสอบ',
'Data Sources': 'แหล่งข้อมูล',
'Candidate Zones by Tier': 'พื้นที่ผู้สมัครตามระดับ',
'AOI Dashboard': 'แดชบอร์ดพื้นที่',
'Year Compare: OFF': 'เปรียบเทียบปี: ปิด',
'Year Compare: ON': 'เปรียบเทียบปี: เปิด',
  },
  'Vietnamese': {
    'Scam Compound Explorer V3': 'Công cụ Khám phá Cơ sở Lừa đảo',
    'AOI Controls': 'Điều khiển khu vực',
    'Regional focus': 'Khu vực nghiên cứu',
    'Reset View': 'Đặt lại góc nhìn',
    'Show Overview': 'Hiển thị tổng quan',
    'AOI satellite: ON': 'Ảnh vệ tinh: Bật',
    'AOI satellite: OFF': 'Ảnh vệ tinh: Tắt',
    'Overview': 'Tổng quan',
    'Stage Funnel': 'Phễu giai đoạn',
    'Validation': 'Xác thực',
    'Evidence Scatter': 'Phân tán bằng chứng',
    'Load Evidence & Ranking': 'Tải bằng chứng và xếp hạng',
    'Priority Review List': 'Danh sách xem xét ưu tiên',
    'Ranking metric': 'Tiêu chí xếp hạng',
    'Layers': 'Lớp dữ liệu',
    'Click Map': 'Nhấp vào bản đồ',
    'Legend': 'Chú giải',
    'Confirmed site': 'Địa điểm xác nhận',
    'Suspected site': 'Địa điểm nghi ngờ',
    'Control site': 'Địa điểm kiểm soát',
    'Candidate density': 'Mật độ ứng viên',
    'High candidate tier': 'Ứng viên cấp cao',
    'Medium candidate tier': 'Ứng viên cấp trung bình',
    'Low candidate tier': 'Ứng viên cấp thấp',
    'Confirmed sites': 'Địa điểm xác nhận',
    'Suspected sites': 'Địa điểm nghi ngờ',
    'Control sites': 'Địa điểm kiểm soát',
    'Country borders': 'Biên giới quốc gia',
    'Province borders': 'Biên giới tỉnh',
    'Key shared borders': 'Biên giới chung quan trọng',
    'Study area boundary': 'Ranh giới khu vực nghiên cứu',
    'AOI satellite — core (Cambodia)': 'Vệ tinh — Campuchia',
    'AOI satellite — peripheral': 'Vệ tinh — Vùng ngoại vi',
    'Selected Location': 'Vị trí đã chọn',
    'Nearest Reported Site': 'Địa điểm báo cáo gần nhất',
    'Candidate Area': 'Khu vực ứng viên',
    'Loading...': 'Đang tải...',
    'Highest dNTL': 'dNTL cao nhất',
    'Highest dNDBI': 'dNDBI cao nhất',
    'Closest to confirmed': 'Gần địa điểm xác nhận nhất',
    'subtitle': 'Ảnh vệ tinh được cắt theo biên giới quốc gia thực tế. Hiển thị biên giới cấp tỉnh.',
    'This chart shows the Cambodia-Vietnam workflow counts, not the current viewport.': 'Biểu đồ này hiển thị số lượng quy trình Campuchia-Việt Nam, không phải khung nhìn hiện tại.',
    'Workflow summary only. Tier counts are shown in Candidate Zones by Tier.': 'Chỉ tóm tắt quy trình. Số lượng theo cấp nằm trong Khu vực ứng viên theo cấp độ.',
'Validation figures are read from precomputed outputs — charts load instantly without running overlap checks inside the app.': 'Số liệu xác thực được đọc từ kết quả tính toán trước.',
'Evidence scatter and the review list are loaded on demand so the map stays light.': 'Phân tán bằng chứng được tải theo yêu cầu.',
'Click "Load Evidence & Ranking" to sample candidates in': 'Nhấp "Tải bằng chứng và xếp hạng" để lấy mẫu ứng viên tại',
'and draw the dNDBI vs dNTL scatter.': 'và vẽ biểu đồ dNDBI vs dNTL.',
'Click "Load Evidence & Ranking" to build the priority review list for the current AOI.': 'Nhấp "Tải bằng chứng và xếp hạng" để xây dựng danh sách xem xét.',
'Click anywhere on the map to inspect the nearest reported site and any candidate zone at that location.': 'Nhấp vào bất kỳ đâu trên bản đồ để kiểm tra địa điểm báo cáo gần nhất.',
'Loading selected location...': 'Đang tải vị trí đã chọn...',
'Selected Location': 'Vị trí đã chọn',
'Nearest Reported Site': 'Địa điểm báo cáo gần nhất',
'Longitude': 'Kinh độ',
'Latitude': 'Vĩ độ',
'Name': 'Tên',
'Status': 'Trạng thái',
'Country': 'Quốc gia',
'Context': 'Bối cảnh',
'Distance': 'Khoảng cách',
'No reported site found': 'Không tìm thấy địa điểm báo cáo',
'Candidate Area': 'Khu vực ứng viên',
'Candidate ID': 'Mã ứng viên',
'Priority': 'Ưu tiên',
'Area': 'Diện tích',
'Distance to confirmed': 'Khoảng cách đến địa điểm xác nhận',
'Distance to border': 'Khoảng cách đến biên giới',
'Ranking metric changed. Click "Load Evidence & Ranking" to rebuild the review list.': 'Tiêu chí xếp hạng đã thay đổi. Nhấp "Tải bằng chứng và xếp hạng" để xây dựng lại danh sách.',
'Top candidates by distance to confirmed': 'Ứng viên hàng đầu theo khoảng cách đến địa điểm xác nhận',
'Top candidates by built-up growth': 'Ứng viên hàng đầu theo tăng trưởng xây dựng',
'Top candidates by night-time light growth': 'Ứng viên hàng đầu theo tăng trưởng ánh sáng ban đêm',
'Bars compare each candidate against the top 8. Red = active ranking metric. For distance, shorter bar = closer.': 'Các thanh so sánh từng ứng viên với top 8.',
'No candidate rows available for the current AOI.': 'Không có dữ liệu ứng viên cho khu vực hiện tại.',
'Each point is a sampled candidate. Bubble size removed — area_sqm is nearly constant in this dataset.': 'Mỗi điểm là một ứng viên được lấy mẫu.',
'Stage funnel (Cambodia-Vietnam workflow)': 'Phễu giai đoạn (quy trình Campuchia-Việt Nam)',
'Candidate counts by tier': 'Số lượng ứng viên theo cấp độ',
'Validation hit rates (500 m)': 'Tỷ lệ xác thực (500 m)',
'Validation hit rates (1000 m)': 'Tỷ lệ xác thực (1000 m)',
'View in panel ↓': 'Xem trong bảng ↓',
'Select a value...': 'Chọn một giá trị...',
'About & Methodology': 'Giới thiệu và Phương pháp',
'✕ Close Methodology': '✕ Đóng Phương pháp',
'ℹ About & Methodology': 'ℹ Giới thiệu và Phương pháp',
'About This Tool': 'Giới thiệu công cụ',
'Stage 1 — Satellite Embedding Similarity': 'Giai đoạn 1 — Độ tương đồng vệ tinh',
'Stage 2 — Indicator-Based Refinement': 'Giai đoạn 2 — Tinh chỉnh dựa trên chỉ số',
'Tier Classification': 'Phân loại cấp độ',
'Validation': 'Xác thực',
'Data Sources': 'Nguồn dữ liệu',
'Candidate Zones by Tier': 'Khu vực ứng viên theo cấp độ',
'AOI Dashboard': 'Bảng điều khiển khu vực',
'Year Compare: OFF': 'So sánh năm: Tắt',
'Year Compare: ON': 'So sánh năm: Bật',
  }
};

function translate(text) {
  if (!TRANSLATIONS[currentLanguage]) { return text; }
  return TRANSLATIONS[currentLanguage][text] || text;
}

var COLORS = {
  confirmed: '#4b0082',
  suspected: '#0072b2',
  control:   '#00bcd4',
  shortlist: '#e11d48',
  high:      '#d73027',
  medium:    '#ffd400',
  low:       '#1a9850',
  boundary:  '#111827',
  sharedBorder: '#a855f7',
  text:      '#1f2937',
  muted:     '#6b7280',
  border:    '#d0d5dd',
  panelBg:   '#ffffff',
  softBg:    '#f8fafc'
};

var CANDIDATE_TIER_PALETTE = [COLORS.low, COLORS.medium, COLORS.high];
var CANDIDATE_PIXEL_RADIUS_M = 750;

// Grayscale basemap — keeps the candidate tier and point layers as the
// primary visual signal instead of competing with satellite colours.
var GRAYSCALE_STYLE = [
  {stylers: [{saturation: -100}, {gamma: 1.15}]},
  {elementType: 'labels.text.fill',   stylers: [{color: '#111827'}]},
  {elementType: 'labels.text.stroke', stylers: [{color: '#ffffff'}, {weight: 4}]},
  {featureType: 'administrative.country', elementType: 'geometry.stroke',
   stylers: [{color: '#374151'}, {weight: 1}]},
  {featureType: 'water',     stylers: [{color: '#dbeafe'}]},
  {featureType: 'landscape', stylers: [{color: '#f3f4f6'}]},
  {featureType: 'poi',       stylers: [{visibility: 'off'}]},
  {featureType: 'transit',   stylers: [{visibility: 'off'}]},
  {featureType: 'road',      stylers: [{visibility: 'simplified'}, {color: '#d1d5db'}]}
];

// ---------------------------------------------------------------------------
// Input preparation
// ---------------------------------------------------------------------------

var scamPoints = ee.FeatureCollection(SCAM_POINTS_ASSET)
  .filter(ee.Filter.inList('site_status', ['confirmed', 'suspected', 'control']))
  .map(function(f) {
    var lon = ee.Number.parse(ee.String(f.get('lon')));
    var lat = ee.Number.parse(ee.String(f.get('lat')));
    return f.setGeometry(ee.Geometry.Point([lon, lat]));
  });

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
var studyCandidates = candidates.filterBounds(STUDY_GEOM);

function filterCandidatesByTier(collection, tierLabel) {
  return collection.filter(ee.Filter.eq('priority_tier', tierLabel));
}

// ---------------------------------------------------------------------------
// Border layers
// ---------------------------------------------------------------------------

// Country borders — LSIB 2017 simplified, lightweight globally
var COUNTRY_BORDERS = ee.FeatureCollection('USDOS/LSIB_SIMPLE/2017');

var ADMIN1_BORDERS      = ee.FeatureCollection('FAO/GAUL/2015/level1');
var STUDY_COUNTRY_NAMES = ['Cambodia', 'Viet Nam', 'Myanmar', 'Thailand', 'Lao PDR'];
var PROJECT_PROVINCE_COUNTRY_NAMES = ['Cambodia', 'Viet Nam', 'Thailand'];

var LSIB_COUNTRY_NAMES = ['Cambodia', 'Vietnam', 'Burma', 'Thailand', 'Laos'];
var SHARED_BORDER_BUFFER_M = 2000;
var camBorderBuffer  = geom_cambodia.buffer(SHARED_BORDER_BUFFER_M);
var vietBorderBuffer = geom_vietnam.buffer(SHARED_BORDER_BUFFER_M);
var thaiBorderBuffer = geom_thailand.buffer(SHARED_BORDER_BUFFER_M);
var myanBorderBuffer = geom_myanmar.buffer(SHARED_BORDER_BUFFER_M);
var keySharedBorderStrips = camBorderBuffer.intersection(vietBorderBuffer, ee.ErrorMargin(100))
  .union(camBorderBuffer.intersection(thaiBorderBuffer, ee.ErrorMargin(100)))
  .union(myanBorderBuffer.intersection(thaiBorderBuffer, ee.ErrorMargin(100)));

function styleCountryBorders(aoi) {
  var countries = COUNTRY_BORDERS
    .filter(ee.Filter.inList('country_na', LSIB_COUNTRY_NAMES))
    .filterBounds(aoi.bounds(1000));

  return countries.style({
    color:     COLORS.boundary,
    fillColor: '00000000',
    width:     1.2
  });
}

function styleAdmin1Borders(aoi) {
  var provinces = ADMIN1_BORDERS
    .filter(ee.Filter.inList('ADM0_NAME', PROJECT_PROVINCE_COUNTRY_NAMES))
    .filterBounds(aoi.bounds(1000))
    .map(function(feature) {
      return feature.simplify(5000);
    });

  return provinces.style({
    color:     '#d1d5db',
    fillColor: '00000000',
    width:     0.8
  });
}

function styleSharedBorders(aoi) {
  var allStrips = keySharedBorderStrips.intersection(aoi, ee.ErrorMargin(100));

  return ee.FeatureCollection([ee.Feature(allStrips)])
    .style({
      color:     COLORS.sharedBorder,
      fillColor: 'a855f730',  // semi-transparent purple fill
      width:     1.5
    });
}
// Sentinel-2 SR median composite clipped to the true AOI boundary.
// Using real country geometry means satellite colour fills only the study
// area, matching the reference map style.
var STUDY_S2_2024_RGB = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
  .filterBounds(STUDY_BOUNDS)
  .filterDate('2024-01-01', '2024-12-31')
  .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 45))
  .select(['B4', 'B3', 'B2'])
  .median()
  .clip(STUDY_GEOM);

function satelliteFocusGeometry(aoiName, aoi) {
  if (aoiName === 'Myanmar-Thailand Border' ||
      aoiName === 'Golden Triangle (future extension)') {
    return geom_thailand.intersection(aoi, ee.ErrorMargin(100));
  }
  return geom_cambodia.intersection(aoi, ee.ErrorMargin(100));
}

function satelliteFocusLabel(aoiName) {
  if (aoiName === 'Myanmar-Thailand Border' ||
      aoiName === 'Golden Triangle (future extension)') {
    return 'AOI satellite — focus (Thailand)';
  }
  return 'AOI satellite — core (Cambodia)';
}

function satelliteCoreOpacity(aoiName) {
  return aoiName === 'Myanmar-Thailand Border' ? 0.82 : 0.75;
}

function satellitePeripheralOpacity(aoiName) {
  return aoiName === 'Myanmar-Thailand Border' ? 0.22 : 0.35;
}

function buildAoiSatelliteStack(aoiName, aoi) {
  var satelliteContext = STUDY_GEOM;
  var s2 = STUDY_S2_2024_RGB;

  var coreGeom = satelliteFocusGeometry(aoiName, aoi);
  var coreMask = ee.Image.constant(1).clip(coreGeom);

  var peripheralGeom = satelliteContext.difference(coreGeom, ee.ErrorMargin(100));
  var peripheralMask = ee.Image.constant(1).clip(peripheralGeom);

  return {
    core:       s2.updateMask(coreMask),
    peripheral: s2.updateMask(peripheralMask)
  };
}

// ---------------------------------------------------------------------------
// Layer helpers
// ---------------------------------------------------------------------------

function stylePointCollection(collection, color, size) {
  return collection.style({
    color:       '#ffffff',
    fillColor:   color,
    pointSize:   size || 7,
    pointShape:  'circle',
    width:       2
  });
}

// AOI outline — thin dark line, no fill, no white rectangle frame
function styleAoi(geometry) {
  return ee.FeatureCollection([ee.Feature(geometry)]).style({
    color:     COLORS.boundary,
    fillColor: '00000000',
    width:     1.5
  });
}

// Candidate tier image — paints classified candidate polygons into one
// categorical layer. Values map to low/medium/high in the layer palette.
function makeCandidateTierImage(tiers, aoi) {
  var PAINT_SCALE = 1000;
  var low = ee.Image().byte()
    .paint(tiers.low, 1)
    .setDefaultProjection('EPSG:3857', null, PAINT_SCALE)
    .focal_max(CANDIDATE_PIXEL_RADIUS_M, 'square', 'meters');
  var medium = ee.Image().byte()
    .paint(tiers.medium, 2)
    .setDefaultProjection('EPSG:3857', null, PAINT_SCALE)
    .focal_max(CANDIDATE_PIXEL_RADIUS_M, 'square', 'meters');
  var high = ee.Image().byte()
    .paint(tiers.high, 3)
    .setDefaultProjection('EPSG:3857', null, PAINT_SCALE)
    .focal_max(CANDIDATE_PIXEL_RADIUS_M, 'square', 'meters');

  return low.blend(medium).blend(high)
    .reproject({crs: 'EPSG:3857', scale: PAINT_SCALE})
    .clip(aoi)
    .selfMask();
}

// ---------------------------------------------------------------------------
// Formatting helpers
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
  if (text.length <= 16) { return text; }
  return text.slice(0, 5) + '...' + text.slice(-4);
}

function formatTierLabel(value) {
  if (!value) { return 'Unknown'; }
  var text = String(value).toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function tierColor(value) {
  if (value === 'high')   { return COLORS.high; }
  if (value === 'medium') { return COLORS.medium; }
  if (value === 'low')    { return COLORS.low; }
  return '#6b7280';
}

function histogramCount(hist, key) {
  if (!hist || hist[key] === undefined || hist[key] === null) { return 0; }
  return Number(hist[key]);
}

function histogramTotal(hist) {
  var total = 0;
  if (!hist) { return total; }
  Object.keys(hist).forEach(function(key) {
    total += Number(hist[key] || 0);
  });
  return total;
}

// ---------------------------------------------------------------------------
// Chart helpers
// ---------------------------------------------------------------------------

function makeWorkflowSummaryPanel() {
  var rows = [
    {
      label: 'Reported sites',
      count: WORKFLOW_COUNTS.reported_confirmed + WORKFLOW_COUNTS.reported_suspected,
      color: COLORS.confirmed
    },
    {
      label: 'Candidate zones',
      count: WORKFLOW_COUNTS.stage1_candidates,
      color: COLORS.sharedBorder
    },
    {
      label: 'Shortlist',
      count: WORKFLOW_COUNTS.shortlist,
      color: COLORS.shortlist
    }
  ];
  var maxLog = Math.log(rows[1].count + 1);

  var widgets = [
    ui.Label('Workflow summary (Cambodia border corridor)', {
      fontWeight: 'bold', fontSize: '12px', color: COLORS.text,
      margin: '0 0 6px 0'
    })
  ];

  rows.forEach(function(row) {
    var widthPx = Math.max(18, Math.round(150 * Math.log(row.count + 1) / maxLog));
    widgets.push(ui.Panel([
      ui.Label(row.label, {
        width: '96px', fontSize: '11px', color: COLORS.text, margin: '3px 6px 0 0'
      }),
      ui.Panel([], null, {
        width: widthPx + 'px', height: '12px', backgroundColor: row.color,
        margin: '4px 6px 0 0'
      }),
      ui.Label(row.count.toLocaleString(), {
        fontSize: '11px', fontWeight: 'bold', color: COLORS.text, margin: '2px 0 0 0'
      })
    ], ui.Panel.Layout.flow('horizontal'), {margin: '2px 0'}));
  });

  return ui.Panel(widgets, ui.Panel.Layout.flow('vertical'), {margin: '0'});
}

function getValidationRows() {
  return VALIDATION_TIER_ORDER.map(function(tierKey) {
    var row = PRECOMPUTED_VALIDATION[tierKey];
    return {
      tier_label:          VALIDATION_TIER_LABELS[tierKey],
      candidate_count:     row.candidate_count,
      suspected_500_pct:   100 * row.suspected_hit_500m / row.suspected_in_aoi,
      suspected_1000_pct:  100 * row.suspected_hit_1000m / row.suspected_in_aoi,
      confirmed_500_pct:   100 * row.non_reference_confirmed_hit_500m / row.non_reference_confirmed_in_aoi,
      confirmed_1000_pct:  100 * row.non_reference_confirmed_hit_1000m / row.non_reference_confirmed_in_aoi,
      controls_500_pct:    100 * row.controls_hit_500m / row.controls_in_aoi,
      controls_1000_pct:   100 * row.controls_hit_1000m / row.controls_in_aoi
    };
  });
}

function makeValidationRateChart(bufferLabel, suspectedField, confirmedField, controlField) {
  var rows = getValidationRows();
  var fc = ee.FeatureCollection(rows.map(function(row) {
    return ee.Feature(null, {
      tier:      row.tier_label,
      suspected: row[suspectedField],
      confirmed: row[confirmedField],
      control:   row[controlField]
    });
  }));
  return ui.Chart.feature.byFeature(fc, 'tier', ['suspected', 'confirmed', 'control'])
    .setChartType('ColumnChart')
    .setOptions({
      title:  'Validation hit rates (' + bufferLabel + ')',
      colors: [COLORS.suspected, COLORS.confirmed, COLORS.control],
      vAxis:  {title: 'Hit rate (%)', viewWindow: {min: 0}},
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
  var high   = tierCollections.high.randomColumn('scatter_rand', 11).sort('scatter_rand').limit(samplePerTier);
  var medium = tierCollections.medium.randomColumn('scatter_rand', 22).sort('scatter_rand').limit(samplePerTier);
  var low    = tierCollections.low.randomColumn('scatter_rand', 33).sort('scatter_rand').limit(samplePerTier);

  var scatterRows = high.merge(medium).merge(low)
    .map(function(f) {
      return ee.Feature(null, {
        row: ee.List([f.get('priority_tier'), f.get('dNDBI_2021_2024'), f.get('dNTL_2021_2024')])
      });
    })
    .aggregate_array('row');

  scatterRows.evaluate(function(rows) {
    if (renderId !== activeRenderId) { return; }

    panel.clear();
    panel.add(ui.Label(
      translate('Each point is a sampled candidate. Bubble size removed — area_sqm is nearly constant in this dataset.'),
      {fontSize: '12px', color: COLORS.muted, whiteSpace: 'pre-wrap', margin: '0 0 8px 0'}
    ));

    if (!rows || !rows.length) {
      panel.add(ui.Label(translate('No candidate rows available for the current AOI.'),
        {fontSize: '12px', color: COLORS.muted}));
      return;
    }

    var dataTable = [[
      {label: 'dNDBI 2021-2024', type: 'number'},
      {label: 'High',   type: 'number'},
      {label: 'Medium', type: 'number'},
      {label: 'Low',    type: 'number'}
    ]];

    rows.forEach(function(row) {
      var tier = row[0];
      var dNDBI = Number(row[1]);
      var dNTL  = Number(row[2]);
      if (isNaN(dNDBI) || isNaN(dNTL)) { return; }
      dataTable.push([
        dNDBI,
        tier === 'high'   ? dNTL : null,
        tier === 'medium' ? dNTL : null,
        tier === 'low'    ? dNTL : null
      ]);
    });

    panel.add(ui.Chart(dataTable, 'ScatterChart', {
      title:       'Candidate evidence scatter (sampled by tier)',
      hAxis:       {title: 'dNDBI 2021-2024'},
      vAxis:       {title: 'dNTL 2021-2024'},
      colors:      [COLORS.high, COLORS.medium, COLORS.low],
      pointSize:   5,
      dataOpacity: 0.72,
      legend:      {position: 'top'},
      chartArea:   {width: '82%', height: '68%'},
      height:      300
    }));
  });
}

function getRankConfig(mode) {
  if (mode === 'Closest to confirmed') {
    return {
      field:      'dist_to_confirmed_m',
      descending: false,
      title:      'Top candidates by distance to confirmed',
      metric:     function(props) {
        return 'Distance to confirmed: ' + formatNumber(props.dist_to_confirmed_m, 0) + ' m';
      }
    };
  }
  if (mode === 'Highest dNDBI') {
    return {
      field:      'dNDBI_2021_2024',
      descending: true,
      title:      'Top candidates by built-up growth',
      metric:     function(props) {
        return 'dNDBI 2021-2024: ' + formatNumber(props.dNDBI_2021_2024, 3);
      }
    };
  }
  return {
    field:      'dNTL_2021_2024',
    descending: true,
    title:      'Top candidates by night-time light growth',
    metric:     function(props) {
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
  if (!geometry) { return null; }
  if (geometry.type === 'Point') {
    return {lon: geometry.coordinates[0], lat: geometry.coordinates[1]};
  }
  if (geometry.type === 'Polygon') {
    coords = geometry.coordinates[0];
  } else if (geometry.type === 'MultiPolygon') {
    coords = geometry.coordinates[0][0];
  }
  if (!coords || !coords.length) { return null; }
  var minLon = coords[0][0], maxLon = coords[0][0];
  var minLat = coords[0][1], maxLat = coords[0][1];
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
  all:             true,
  layerList:       true,
  zoomControl:     true,
  mapTypeControl:  false,
  scaleControl:    true,
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
    position:        'bottom-right',
    padding:         '8px 10px',
    backgroundColor: 'rgba(255,255,255,0.94)',
    border:          '1px solid ' + COLORS.border,
    maxWidth:        '220px'
  }
});
legendPanel.add(ui.Label('Legend', {fontWeight: 'bold', fontSize: '12px', color: COLORS.text, margin: '0 0 6px 0'}));
legendPanel.add(makeLegendPointRow('Confirmed site',  COLORS.confirmed));
legendPanel.add(makeLegendPointRow('Suspected site',  COLORS.suspected));
legendPanel.add(makeLegendPointRow('Control site',    COLORS.control));
legendPanel.add(makeLegendPointRow('High candidate tier',   COLORS.high));
legendPanel.add(makeLegendPointRow('Medium candidate tier', COLORS.medium));
legendPanel.add(makeLegendPointRow('Low candidate tier',    COLORS.low));

map.add(legendPanel);

var leftPanel = ui.Panel({
  style: {width: '430px', padding: '14px', backgroundColor: COLORS.panelBg}
});

var layerPanel      = ui.Panel({style: {margin: '6px 0 0 0'}});
var dashboardPanel = ui.Panel({
  style: {margin: '10px 0 0 0', padding: '10px',
          border: '1px solid ' + COLORS.border, backgroundColor: COLORS.softBg}
});
var kpiPanel        = ui.Panel({style: {margin: '10px 0 0 0'}});
var funnelPanel     = ui.Panel({
  style: {margin: '10px 0 0 0', padding: '10px',
          border: '1px solid ' + COLORS.border, backgroundColor: '#fff'}
});
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
  var noteLabel  = ui.Label('',    {fontSize: '10px', color: COLORS.muted, margin: '4px 0 0 0'});
  var panel = ui.Panel([valueLabel, titleLabel, noteLabel], ui.Panel.Layout.flow('vertical'), {
    width:           width || '48%',
    margin:          '0 8px 8px 0',
    padding:         '10px',
    border:          '1px solid ' + COLORS.border,
    backgroundColor: '#fff'
  });
  return {panel: panel, value: valueLabel, note: noteLabel};
}

var cardReported  = makeCard('Reported Sites In View', '#111827',       '48%');
var cardConfirmed = makeCard('Confirmed',               COLORS.confirmed,'48%');
var cardSuspected = makeCard('Suspected',               COLORS.suspected,'48%');
var cardControl   = makeCard('Control',                 COLORS.control,  '48%');
var cardCandidate = makeCard('Candidate Zones',         COLORS.high,     '100%');

var titleLabel = ui.Label(translate('Scam Compound Explorer V3'), {
  fontSize:   '22px',
  fontWeight: 'bold',
  color:      COLORS.text,
  margin:     '0 0 6px 0'
});

var subtitleLabel = ui.Label(translate('subtitle'), {
  fontSize: '12px', color: COLORS.muted,
  whiteSpace: 'pre-wrap', margin: '0 0 12px 0'
});

var aoiControlsTitle   = sectionTitle(translate('AOI Controls'));
var aoiFocusLabel      = ui.Label(translate('Regional focus'),
  {fontSize: '12px', color: COLORS.muted, margin: '0 0 4px 0'});
var overviewTitle      = sectionTitle(translate('Overview'));
var funnelTitle        = sectionTitle(translate('Stage Funnel'));
var validationTitle    = sectionTitle(translate('Validation'));
var evidenceTitle      = sectionTitle(translate('Evidence Scatter'));
var rankingTitle       = sectionTitle(translate('Priority Review List'));
var rankingMetricLabel = ui.Label(translate('Ranking metric'),
  {fontSize: '12px', color: COLORS.muted, margin: '0 0 4px 0'});
var layersTitle        = sectionTitle(translate('Layers'));
var clickMapTitle      = sectionTitle(translate('Click Map'));

var subtitle = ui.Label(
  'Satellite imagery is clipped to true country boundaries. Province-level borders are shown inside each AOI. Grayscale basemap keeps density and site layers as the primary visual signal.',
  {fontSize: '12px', color: COLORS.muted, whiteSpace: 'pre-wrap', margin: '0 0 12px 0'}
);

// Language selector
var rankModeSelect = ui.Select({
  items: [
    {label: translate('Highest dNTL'),         value: 'Highest dNTL'},
    {label: translate('Highest dNDBI'),        value: 'Highest dNDBI'},
    {label: translate('Closest to confirmed'), value: 'Closest to confirmed'}
  ],
  value: 'Highest dNTL',
  placeholder: translate('Select a value...'),
  style: {stretch: 'horizontal'}
});

var refreshEvidenceButton = ui.Button({
  label:   translate('Load Evidence & Ranking'),
  style:   {stretch: 'horizontal'},
  onClick: function() {
    showLoadingMessage(translate('Loading...'));
    runEvidence();
    hideLoadingMessage();
  }
});
var splitViewShown = false;
var methodologyShown = false;
var methodologyPanel = ui.Panel({
  style: {
    margin:          '10px 0 0 0',
    padding:         '12px',
    border:          '1px solid ' + COLORS.border,
    backgroundColor: COLORS.softBg,
    shown:           false
  }
});

var methodologyButton = ui.Button({
  label:  translate( 'ℹ About & Methodology'),
  style:   {stretch: 'horizontal'},
  onClick: function() {
    methodologyShown = !methodologyShown;
    methodologyPanel.style().set('shown', methodologyShown);
    methodologyButton.setLabel(methodologyShown
      ? translate('✕ Close Methodology')
      : translate('ℹ About & Methodology'));
  }
});
var splitButton = ui.Button({
  label:   'Year Compare: OFF',
  style:   {stretch: 'horizontal'},
  onClick: function() {
    splitViewShown = !splitViewShown;
    splitButton.setLabel(translate('Year Compare: ' + (splitViewShown ? 'ON' : 'OFF')));
    if (splitViewShown) {
      showSplitView();
    } else {
      hideSplitView();
    }
  }
});
var resetButton = ui.Button({
  label:   'Reset View',
  style:   {stretch: 'horizontal'},
  onClick: function() {
    setMapToAoiView(map, aoiSelect.getValue());
  }
});

var overviewButton = ui.Button({
  label:   'Show Overview',
  style:   {stretch: 'horizontal'},
  onClick: function() { aoiSelect.setValue('Southeast Asia overview'); }
});

var basemapButton = ui.Button({
  label:   'AOI satellite: ON',
  style:   {stretch: 'horizontal'},
  onClick: function() {
    aoiSatelliteShown = !aoiSatelliteShown;
    basemapButton.setLabel('AOI satellite: ' + (aoiSatelliteShown ? 'ON' : 'OFF'));
    Object.keys(layerCache).forEach(function(key) {
      if (layerCache[key].aoiSatelliteCore) {
        layerCache[key].aoiSatelliteCore.setShown(aoiSatelliteShown);
      }
      if (layerCache[key].aoiSatellitePeripheral) {
        layerCache[key].aoiSatellitePeripheral.setShown(aoiSatelliteShown);
      }
    });
  }
});
var languageSelect = ui.Select({
  items: [
    {label: 'English',    value: 'English'},
    {label: 'ខ្មែរ',      value: 'Khmer'},
    {label: 'ภาษาไทย',   value: 'Thai'},
    {label: 'Tiếng Việt', value: 'Vietnamese'}
  ],
  value: 'English',
  style: {stretch: 'horizontal'},
  onChange: function(value) {
    currentLanguage = value;
    
    // Clear layer cache so borders re-render with new settings
    layerCache = {};
    renderAoi(aoiSelect.getValue());

    // Titles and subtitles
    titleLabel.setValue(translate('Scam Compound Explorer V3'));
    subtitleLabel.setValue(translate('subtitle'));
    aoiFocusLabel.setValue(translate('Regional focus'));
    rankingMetricLabel.setValue(translate('Ranking metric'));

    // Section titles
    aoiControlsTitle.setValue(translate('AOI Controls'));
    overviewTitle.setValue(translate('Overview'));
    funnelTitle.setValue(translate('Stage Funnel'));
    validationTitle.setValue(translate('Validation'));
    evidenceTitle.setValue(translate('Evidence Scatter'));
    rankingTitle.setValue(translate('Priority Review List'));
    layersTitle.setValue(translate('Layers'));
    clickMapTitle.setValue(translate('Click Map'));

    // Buttons
    resetButton.setLabel(translate('Reset View'));
    overviewButton.setLabel(translate('Show Overview'));
    refreshEvidenceButton.setLabel(translate('Load Evidence & Ranking'));
    basemapButton.setLabel(
      translate(aoiSatelliteShown ? 'AOI satellite: ON' : 'AOI satellite: OFF')
    );

    // Legend
    legendPanel.widgets().get(0).setValue(translate('Legend'));
    legendPanel.widgets().get(1).widgets().get(1).setValue(translate('Confirmed site'));
    legendPanel.widgets().get(2).widgets().get(1).setValue(translate('Suspected site'));
    legendPanel.widgets().get(3).widgets().get(1).setValue(translate('Control site'));
    legendPanel.widgets().get(4).widgets().get(1).setValue(translate('High candidate tier'));
    legendPanel.widgets().get(5).widgets().get(1).setValue(translate('Medium candidate tier'));
    legendPanel.widgets().get(6).widgets().get(1).setValue(translate('Low candidate tier'));

    // Rank mode select
    rankModeSelect.items().reset([
      {label: translate('Highest dNTL'),         value: 'Highest dNTL'},
      {label: translate('Highest dNDBI'),        value: 'Highest dNDBI'},
      {label: translate('Closest to confirmed'), value: 'Closest to confirmed'}
    ]);
    // Rebuild aoiSelect with translated placeholder
    var currentAoi = aoiSelect.getValue();
    aoiSelect.items().reset(Object.keys(AOIS).map(function(key) {
      return {label: key, value: key};
    }));
    aoiSelect.setValue(currentAoi);

    // Layer checkboxes
    var aoiName = aoiSelect.getValue();
    if (layerCache[aoiName]) {
      updateLayerControls(layerCache[aoiName]);
    }

    // Info and evidence panels
    setDefaultInfo();
    setEvidencePlaceholder(aoiName);
    // Methodology and split buttons
    methodologyButton.setLabel(methodologyShown
      ? translate('✕ Close Methodology')
      : translate('ℹ About & Methodology'));
    splitButton.setLabel(translate('Year Compare: ' + (splitViewShown ? 'ON' : 'OFF')));

    // Rebuild methodology panel and dashboard with new language
    buildMethodologyPanel();
    buildDashboard(aoiName);
  }
});

var languagePanel = ui.Panel({
  widgets: [
    ui.Label('🌐', {fontSize: '14px', margin: '6px 4px 0 0', color: '#6b7280'}),
    ui.Label('Language', {fontSize: '12px', margin: '8px 6px 0 0', color: '#6b7280'}),
    languageSelect
  ],
  layout: ui.Panel.Layout.flow('horizontal'),
  style: {margin: '6px 0 0 0'}
});

var aoiSelect = ui.Select({
  items: Object.keys(AOIS),
  value: DEFAULT_AOI,
  placeholder: translate('Select a value...'),
  style: {stretch: 'horizontal'}
});



kpiPanel.add(ui.Panel([cardReported.panel, cardConfirmed.panel], ui.Panel.Layout.flow('horizontal')));
kpiPanel.add(ui.Panel([cardSuspected.panel, cardControl.panel],  ui.Panel.Layout.flow('horizontal')));
kpiPanel.add(cardCandidate.panel);

leftPanel.add(titleLabel);
leftPanel.add(subtitleLabel);
leftPanel.add(languagePanel);          
leftPanel.add(aoiControlsTitle);
leftPanel.add(aoiFocusLabel);
leftPanel.add(aoiSelect);
leftPanel.add(methodologyButton);
leftPanel.add(methodologyPanel);
leftPanel.add(splitButton);
leftPanel.add(resetButton);
leftPanel.add(overviewButton);
leftPanel.add(basemapButton);
leftPanel.add(overviewTitle);
leftPanel.add(kpiPanel);
leftPanel.add(sectionTitle(translate('AOI Dashboard')));
leftPanel.add(dashboardPanel);
leftPanel.add(funnelTitle);
leftPanel.add(funnelPanel);
leftPanel.add(validationTitle);
leftPanel.add(validationPanel);
leftPanel.add(evidenceTitle);
leftPanel.add(ui.Label(
  'Evidence scatter and the review list are loaded on demand so the map stays light.',
  {fontSize: '12px', color: COLORS.muted, whiteSpace: 'pre-wrap', margin: '0 0 8px 0'}
));
leftPanel.add(refreshEvidenceButton);
leftPanel.add(evidencePanel);
leftPanel.add(rankingTitle);
leftPanel.add(rankingMetricLabel);
leftPanel.add(rankModeSelect);
leftPanel.add(rankingPanel);
leftPanel.add(layersTitle);
leftPanel.add(layerPanel);
leftPanel.add(clickMapTitle);
leftPanel.add(infoPanel);

ui.root.clear();
var rootSplitPanel = ui.SplitPanel({
  firstPanel:  leftPanel,
  secondPanel: map,
  orientation: 'horizontal',
  wipe:        false,
  style:       {stretch: 'both'}
});
ui.root.add(rootSplitPanel);

function setMainPanel(secondPanel) {
  rootSplitPanel.setSecondPanel(secondPanel);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

var activeAoiName          = DEFAULT_AOI;
var activeAoi              = AOIS[DEFAULT_AOI];
var activePointsInAoi      = null;
var activeCandidatesInAoi  = null;
var activeTierCollections  = null;
var activeRenderId         = 0;

var aoiDataCache    = {};
var candidateTierCache = {};
var satelliteCache  = {};
var kpiCache        = {};
var layerCache      = {};

var aoiSatelliteShown = true;

function getAoiData(aoiName) {
  if (!aoiDataCache[aoiName]) {
    var geometry = AOIS[aoiName];

    var points          = scamPoints.filterBounds(geometry.bounds(1000));
    var candidateSubset = studyCandidates;

    aoiDataCache[aoiName] = {
      geometry:   geometry,
      points:     points,
      candidates: candidateSubset,
      confirmed:  points.filter(ee.Filter.eq('site_status', 'confirmed')),
      suspected:  points.filter(ee.Filter.eq('site_status', 'suspected')),
      control:    points.filter(ee.Filter.eq('site_status', 'control')),
      tiers: {
        high:   filterCandidatesByTier(candidateSubset, 'high'),
        medium: filterCandidatesByTier(candidateSubset, 'medium'),
        low:    filterCandidatesByTier(candidateSubset, 'low')
      }
    };
  }
  return aoiDataCache[aoiName];
}

// ---------------------------------------------------------------------------
// Layer management
// ---------------------------------------------------------------------------

function buildLayerStack(aoiName) {
  if (layerCache[aoiName]) { return layerCache[aoiName]; }

  var aoiData      = getAoiData(aoiName);
  var candidateTierKey = 'study:candidateTiers';

  if (!candidateTierCache[candidateTierKey]) {
    // Use broad bounds so candidate tier zones cover Thailand too.
    candidateTierCache[candidateTierKey] = makeCandidateTierImage(aoiData.tiers, STUDY_GEOM);
  }
  if (!satelliteCache[aoiName]) {
    satelliteCache[aoiName] = buildAoiSatelliteStack(aoiName, aoiData.geometry);
  }

  var stack = {
    aoiSatellitePeripheral: ui.Map.Layer(
      satelliteCache[aoiName].peripheral,
      {bands: ['B4', 'B3', 'B2'], min: 300, max: 3000, gamma: 1.3, opacity: satellitePeripheralOpacity(aoiName)},
      'AOI satellite — peripheral', aoiSatelliteShown),
    aoiSatelliteCore: ui.Map.Layer(
      satelliteCache[aoiName].core,
      {bands: ['B4', 'B3', 'B2'], min: 300, max: 3000, gamma: 1.3, opacity: satelliteCoreOpacity(aoiName)},
      satelliteFocusLabel(aoiName), aoiSatelliteShown),
    candidateTiers: ui.Map.Layer(candidateTierCache[candidateTierKey], {
      min:     1,
      max:     3,
      palette: CANDIDATE_TIER_PALETTE,
      opacity: 0.85
    }, 'Candidate Zones by Tier', true),
    aoi: ui.Map.Layer(
      styleAoi(aoiData.geometry), {}, 'Study area boundary', true),
    admin1: ui.Map.Layer(
      styleAdmin1Borders(aoiData.geometry), {}, 'Province borders', true),
    borders: ui.Map.Layer(
      styleCountryBorders(aoiData.geometry), {}, 'Country borders', true),
    sharedBorders: ui.Map.Layer(
      styleSharedBorders(aoiData.geometry), {}, 'Key shared borders', true),
    confirmed: ui.Map.Layer(
      stylePointCollection(aoiData.confirmed, COLORS.confirmed, 7), {}, 'Confirmed sites', true),
    suspected: ui.Map.Layer(
      stylePointCollection(aoiData.suspected, COLORS.suspected, 7), {}, 'Suspected sites', true),
    control: ui.Map.Layer(
      stylePointCollection(aoiData.control, COLORS.control, 6), {}, 'Control sites', true)
  };

  layerCache[aoiName] = stack;
  return stack;
}

function applyLayerStack(stack) {
  map.layers().reset([
    stack.aoiSatellitePeripheral,  // bottom: context countries (dimmed)
    stack.aoiSatelliteCore,        // Cambodia (clearer)
    stack.candidateTiers,          // categorical candidate tier zones
    stack.aoi,                     // study area outline
    stack.admin1,                  // province borders
    stack.borders,                 // country borders
    stack.sharedBorders,           // key borders — below points
    stack.confirmed,               // confirmed sites
    stack.suspected,               // suspected sites
    stack.control                  // control sites (top)
  ]);
}

function updateLayerControls(stack) {
  layerPanel.clear();
  [
    {label: translate('Confirmed sites'),                  key: 'confirmed'},
    {label: translate('Suspected sites'),                  key: 'suspected'},
    {label: translate('Control sites'),                    key: 'control'},
    {label: satelliteFocusLabel(activeAoiName),            key: 'aoiSatelliteCore'},
    {label: translate('AOI satellite — peripheral'),       key: 'aoiSatellitePeripheral'},
    {label: translate('Candidate Zones by Tier'),          key: 'candidateTiers'},
    {label: translate('Study area boundary'),              key: 'aoi'},
    {label: translate('Province borders'),                 key: 'admin1'},
    {label: translate('Country borders'),                  key: 'borders'},
    {label: translate('Key shared borders'),               key: 'sharedBorders'}
  ].forEach(function(entry) {
    var layer = stack[entry.key];
    if (!layer) { return; }
    layerPanel.add(ui.Checkbox({
      label:    entry.label,
      value:    layer.getShown(),
      onChange: function(value) { layer.setShown(value); },
      style:    {margin: '0 0 2px 0'}
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
    'High ' + (stats.high || 0) +
    ' | Medium ' + WORKFLOW_COUNTS.stage2_medium +
    ' | Low '    + WORKFLOW_COUNTS.stage2_low
  );
}

function updateKpis(pointsInAoi, candidatesInAoi, renderId, aoiName) {
  if (kpiCache[aoiName]) {
    applyKpiStats(kpiCache[aoiName], aoiName);
    renderDashboardStats(kpiCache[aoiName], aoiName);
    return;
  }

  ee.Dictionary({
    point_status_hist:    ee.Dictionary(pointsInAoi.aggregate_histogram('site_status')),
    candidate_tier_hist:  ee.Dictionary(candidatesInAoi.aggregate_histogram('priority_tier'))
  }).evaluate(function(result) {
    if (renderId !== activeRenderId) { return; }
    result = result || {};
    var pointStatusHist   = result.point_status_hist  || {};
    var candidateTierHist = result.candidate_tier_hist || {};
    var stats = {
      total:      histogramTotal(pointStatusHist),
      confirmed:  histogramCount(pointStatusHist, 'confirmed'),
      suspected:  histogramCount(pointStatusHist, 'suspected'),
      control:    histogramCount(pointStatusHist, 'control'),
      candidates: histogramTotal(candidateTierHist),
      high:       histogramCount(candidateTierHist, 'high'),
      medium:     histogramCount(candidateTierHist, 'medium'),
      low:        histogramCount(candidateTierHist, 'low')
    };
    kpiCache[aoiName] = stats;
    applyKpiStats(stats, aoiName);
    renderDashboardStats(stats, aoiName);
  });
}
function renderDashboardStats(stats, aoiName) {
  if (aoiName !== activeAoiName) { return; }

  dashboardPanel.clear();
  dashboardPanel.add(ui.Label(
    translate('Candidate Zones by Tier'),
    {fontWeight: 'bold', fontSize: '12px', margin: '0 0 8px 0'}
  ));

  var high = stats.high || 0;
  var medium = stats.medium || 0;
  var low = stats.low || 0;
  var maxCount = Math.max(high, medium, low, 1);

  function makeTierBar(label, count, color) {
    var barW = Math.max(4, Math.round((count / maxCount) * 200));
    return ui.Panel([
      ui.Label(label, {
        fontSize: '11px', width: '52px',
        color: COLORS.text, margin: '1px 6px 0 0'
      }),
      ui.Label('', {
        width:           barW + 'px',
        height:          '14px',
        backgroundColor: color,
        margin:          '2px 6px 0 0'
      }),
      ui.Label(String(count), {
        fontSize: '11px', color: COLORS.text, margin: '1px 0 0 0'
      })
    ], ui.Panel.Layout.flow('horizontal'), {margin: '3px 0'});
  }

  dashboardPanel.add(makeTierBar('High',   high,   COLORS.high));
  dashboardPanel.add(makeTierBar('Medium', medium, COLORS.medium));
  dashboardPanel.add(makeTierBar('Low',    low,    COLORS.low));

  var total = high + medium + low;
  var highPct = Math.round(100 * high / Math.max(total, 1));
  dashboardPanel.add(ui.Panel({
    style: {height: '1px', backgroundColor: COLORS.border, margin: '8px 0'}
  }));
  dashboardPanel.add(ui.Label(
    highPct + '% of candidates are High tier — the most likely scam compound locations.',
    {fontSize: '11px', color: highPct > 30 ? COLORS.confirmed : COLORS.text,
     fontWeight: 'bold', margin: '0', whiteSpace: 'pre-wrap'}
  ));
}
function buildDashboard(aoiName) {
  dashboardPanel.clear();
  dashboardPanel.add(ui.Label(
    'Loading dashboard for ' + aoiName + '...',
    {fontSize: '12px', color: COLORS.muted}
  ));

  if (kpiCache[aoiName]) {
    renderDashboardStats(kpiCache[aoiName], aoiName);
  }
}
function buildMethodologyPanel() {
  methodologyPanel.clear();

  function addSection(title, content) {
    methodologyPanel.add(ui.Label(title, {
      fontWeight: 'bold', fontSize: '12px',
      color: COLORS.text, margin: '8px 0 3px 0',
      backgroundColor: '#e5e7eb', padding: '4px 8px'
    }));
    methodologyPanel.add(ui.Label(content, {
      fontSize: '11px', color: COLORS.muted,
      whiteSpace: 'pre-wrap', margin: '2px 0 0 0'
    }));
  }

  methodologyPanel.add(ui.Label('About This Tool', {
    fontWeight: 'bold', fontSize: '14px',
    color: COLORS.text, margin: '0 0 6px 0'
  }));
  methodologyPanel.add(ui.Label(
    'This app identifies potential scam compound locations in Southeast Asia using satellite remote sensing. Starting from 53 confirmed sites documented by Amnesty International and ASPI, it screens a broader area for spatially similar locations.',
    {fontSize: '11px', color: COLORS.muted,
     whiteSpace: 'pre-wrap', margin: '0 0 8px 0'}
  ));

  methodologyPanel.add(ui.Panel({
    style: {height: '1px', backgroundColor: COLORS.border, margin: '4px 0 8px 0'}
  }));

  addSection('Stage 1 — Satellite Embedding Similarity',
    'A Sentinel-2 median composite (2024) is used to compute per-pixel embedding similarity against the 53 confirmed reference sites.\n\n• Scale: 20 m\n• Threshold: p97 percentile\n• Output: Broad screening surface covering ~3.7% of the AOI\n• All suspected sites and non-reference confirmed sites fall within 500 m of the Stage 1 layer'
  );

  addSection('Stage 2 — Indicator-Based Refinement',
    'Candidate zones from Stage 1 are scored against a metrics stack derived from Sentinel-2 and VIIRS night-time lights.\n\n• dNDBI 2021-2024: built-up area growth\n• dNTL 2021-2024: night-time light growth\n• dNDVI 2021-2024: vegetation loss\n• dist_to_confirmed_m: proximity to known sites\n• dist_to_border_m: proximity to national borders'
  );

  addSection('Tier Classification',
    '• High (8,425 zones): development_flag AND activity_flag both triggered\n• Medium (13,059 zones): one flag triggered\n• Low (2,980 zones): neither flag, retained as lower-confidence candidates\n• Operational shortlist (15 zones): strictest distance and NTL conditions'
  );

  addSection('Validation',
    'Held-out recall test across repeated splits shows strong coverage of non-reference confirmed sites at p97.\n\nControl point hit rate remains low (<32% at 500 m), confirming the screening layer is not simply capturing all built-up area.\n\nThe refined layer reduces control hits substantially while preserving recall on suspected and confirmed sites.'
  );

  addSection('Data Sources',
    '• Sentinel-2 SR Harmonised (Copernicus / ESA)\n• VIIRS DNB Monthly Night-time Lights (NOAA)\n• Confirmed/suspected site coordinates: Amnesty International, ASPI\n• Country boundaries: USDOS LSIB 2017\n• Province boundaries: FAO GAUL 2015'
  );

  methodologyPanel.add(ui.Panel({
    style: {height: '1px', backgroundColor: COLORS.border, margin: '8px 0 4px 0'}
  }));

  methodologyPanel.add(ui.Label(
    'This tool is intended for research and policy screening purposes only. Candidate zones are not confirmed scam compound locations.',
    {fontSize: '10px', color: COLORS.muted,
     fontStyle: 'italic', whiteSpace: 'pre-wrap'}
  ));
}
function buildStaticPanels() {
  funnelPanel.clear();
  funnelPanel.add(ui.Label(
    translate('Workflow summary only. Tier counts are shown in Candidate Zones by Tier.'),
    {fontSize: '11px', color: COLORS.muted, whiteSpace: 'pre-wrap', margin: '0 0 6px 0'}
  ));
  funnelPanel.add(makeWorkflowSummaryPanel());

  validationPanel.clear();
  validationPanel.add(ui.Label(
    translate('Validation figures are read from precomputed outputs — charts load instantly without running overlap checks inside the app.'),
    {fontSize: '12px', color: COLORS.muted, whiteSpace: 'pre-wrap', margin: '0 0 8px 0'}
  ));
  validationPanel.add(makeValidationRateChart('500 m',  'suspected_500_pct',  'confirmed_500_pct',  'controls_500_pct'));
  validationPanel.add(makeValidationRateChart('1000 m', 'suspected_1000_pct', 'confirmed_1000_pct', 'controls_1000_pct'));
}

function setEvidencePlaceholder(aoiName) {
  evidencePanel.clear();
  evidencePanel.add(ui.Label(
    translate('Click "Load Evidence & Ranking" to sample candidates in') + ' ' + aoiName + ' ' + translate('and draw the dNDBI vs dNTL scatter.'),
    {fontSize: '12px', color: COLORS.muted, whiteSpace: 'pre-wrap'}
  ));
  rankingPanel.clear();
  rankingPanel.add(ui.Label(
    translate('Click "Load Evidence & Ranking" to build the priority review list for the current AOI.'),
    {fontSize: '12px', color: COLORS.muted, whiteSpace: 'pre-wrap'}
  ));
}
var loadingPanel = null;

function showLoadingMessage(message) {
  hideLoadingMessage();
  loadingPanel = ui.Panel({
    widgets: [ui.Label(message, {
      fontSize: '13px',
      fontWeight: 'bold',
      color: COLORS.text,
      padding: '8px 14px',
      backgroundColor: 'rgba(255,255,255,0.95)'
    })],
    style: {position: 'top-center', margin: '60px 0 0 0',
            border: '1px solid ' + COLORS.border, borderRadius: '6px'}
  });
  map.add(loadingPanel);
}

function hideLoadingMessage() {
  if (loadingPanel) {
    map.remove(loadingPanel);
    loadingPanel = null;
  }
}

function setDefaultInfo() {
  infoPanel.clear();
  infoPanel.add(ui.Label(
    translate('Click anywhere on the map to inspect the nearest reported site and any candidate zone at that location.'),
    {fontSize: '12px', color: COLORS.muted, whiteSpace: 'pre-wrap'}
  ));
}
var mapPopup = null;

function showMapPopup(props, coords) {
  hideMapPopup();
  var tierValue = String(props.priority_tier || 'unknown').toLowerCase();

  mapPopup = ui.Panel({
    widgets: [
      ui.Panel([
        ui.Label(formatTierLabel(props.priority_tier).toUpperCase(), {
          fontSize: '10px', fontWeight: 'bold', color: '#ffffff',
          backgroundColor: tierColor(tierValue), padding: '2px 8px'
        }),
        ui.Label('', {stretch: 'horizontal'}),
        ui.Button({
          label: '✕',
          style: {margin: '0', width: '28px', padding: '0'},
          onClick: function() { hideMapPopup(); }
        })
      ], ui.Panel.Layout.flow('horizontal'),
        {stretch: 'horizontal', margin: '0 0 6px 0'}),

      ui.Label(shortCandidateId(props.candidate_id),
        {fontWeight: 'bold', fontSize: '12px', margin: '0 0 4px 0'}),

      ui.Panel([
        ui.Label('dNDBI', {fontSize: '10px', color: COLORS.muted, width: '50px'}),
        ui.Label(formatNumber(props.dNDBI_2021_2024, 3),
          {fontSize: '11px', fontWeight: 'bold'})
      ], ui.Panel.Layout.flow('horizontal'), {margin: '1px 0'}),

      ui.Panel([
        ui.Label('dNTL',  {fontSize: '10px', color: COLORS.muted, width: '50px'}),
        ui.Label(formatNumber(props.dNTL_2021_2024, 2),
          {fontSize: '11px', fontWeight: 'bold'})
      ], ui.Panel.Layout.flow('horizontal'), {margin: '1px 0'}),

      ui.Panel([
        ui.Label('Dist',  {fontSize: '10px', color: COLORS.muted, width: '50px'}),
        ui.Label(formatNumber(props.dist_to_confirmed_m, 0) + ' m',
          {fontSize: '11px', fontWeight: 'bold'})
      ], ui.Panel.Layout.flow('horizontal'), {margin: '1px 0'}),

      ui.Button({
        label: 'View in panel ↓',
        style: {stretch: 'horizontal', margin: '6px 0 0 0'},
        onClick: function() {
          populateInfoFromCandidate(props);
          hideMapPopup();
        }
      })
    ],
    style: {
      position:        'bottom-center',
      backgroundColor: '#ffffff',
      padding:         '10px',
      border:          '1px solid ' + COLORS.border,
      borderRadius:    '8px',
      width:           '200px',
      margin:          '0 0 20px 0'
    }
  });
  map.add(mapPopup);
}

function hideMapPopup() {
  if (mapPopup) {
    map.remove(mapPopup);
    mapPopup = null;
  }
}
function addInfoRow(label, value) {
  infoPanel.add(ui.Label(label + ': ' + value, {fontSize: '12px', margin: '1px 0'}));
}

function populateInfoFromCandidate(properties) {
  infoPanel.clear();
  infoPanel.add(ui.Label(translate('Candidate Area'), {fontWeight: 'bold', margin: '0 0 4px 0'}));
  addInfoRow(translate('Candidate ID'), properties.candidate_id || 'Unknown');
  addInfoRow(translate('Priority'),     properties.priority_tier || 'Unknown');
  addInfoRow(translate('Area'),         formatNumber(properties.area_sqm, 0) + ' sq m');
  addInfoRow(translate('dNDBI 2021-2024'), formatNumber(properties.dNDBI_2021_2024, 3));
  addInfoRow(translate('dNDVI 2021-2024'), formatNumber(properties.dNDVI_2021_2024, 3));
  addInfoRow(translate('dNTL 2021-2024'),  formatNumber(properties.dNTL_2021_2024, 2));
  addInfoRow(translate('Distance to confirmed'), formatNumber(properties.dist_to_confirmed_m, 0) + ' m');
  addInfoRow(translate('Distance to border'),    formatBorderDistance(properties.dist_to_border_m));
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

function makeMetricBar(label, value, maxAbs, formatter, isPrimary, invertBar) {
  var numericValue = Number(value);
  var hasValue     = !isNaN(numericValue);
  var absVal       = hasValue ? Math.abs(numericValue) : 0;
  var ratio        = (maxAbs > 0) ? Math.min(1, absVal / maxAbs) : 0;
  if (invertBar) { ratio = 1 - ratio; }
  var barWidthPx = Math.max(2, Math.round(ratio * 110));
  var positive   = hasValue && numericValue >= 0;
  var barColor   = isPrimary ? '#dc2626' : (positive ? '#fb923c' : '#9ca3af');

  return ui.Panel([
    ui.Label(label, {
      fontSize:   '10px',
      color:      isPrimary ? COLORS.text : COLORS.muted,
      fontWeight: isPrimary ? 'bold' : 'normal',
      width:      '44px',
      margin:     '2px 6px 0 0'
    }),
    ui.Label('', {
      width:           barWidthPx + 'px',
      height:          '8px',
      backgroundColor: barColor,
      margin:          '5px 8px 0 0'
    }),
    ui.Label(hasValue ? formatter(numericValue) : 'N/A', {
      fontSize:   '10px',
      color:      COLORS.text,
      fontWeight: isPrimary ? 'bold' : 'normal',
      margin:     '1px 0 0 0'
    })
  ], ui.Panel.Layout.flow('horizontal'), {margin: '0'});
}

function updateRanking(candidatesInAoi, renderId) {
  rankingPanel.clear();
  rankingPanel.add(ui.Label('Loading top candidates...', {fontSize: '12px', color: COLORS.muted}));

  var rankMode    = rankModeSelect.getValue();
  var cfg         = getRankConfig(rankMode);
  var topCandidates = buildTopCandidates(candidatesInAoi, rankMode);

  topCandidates.evaluate(function(fc) {
    if (renderId !== activeRenderId) { return; }

    rankingPanel.clear();
    rankingPanel.add(ui.Label(cfg.title, {fontWeight: 'bold', margin: '0 0 4px 0'}));
    rankingPanel.add(ui.Label(
      translate('Bars compare each candidate against the top 8. Red = active ranking metric. For distance, shorter bar = closer.'),
      {fontSize: '11px', color: COLORS.muted, whiteSpace: 'pre-wrap', margin: '0 0 8px 0'}
    ));

    if (!fc || !fc.features || !fc.features.length) {
      rankingPanel.add(ui.Label(translate('No candidate rows available for the current AOI.'),
        {fontSize: '12px', color: COLORS.muted}));
      return;
    }

    var maxDNTL  = 0.001, maxDNDBI = 0.001, maxDist = 1;
    fc.features.forEach(function(feature) {
      var p    = feature.properties || {};
      var nTL  = Number(p.dNTL_2021_2024);
      var nDBI = Number(p.dNDBI_2021_2024);
      var dist = Number(p.dist_to_confirmed_m);
      if (!isNaN(nTL))  { maxDNTL  = Math.max(maxDNTL,  Math.abs(nTL)); }
      if (!isNaN(nDBI)) { maxDNDBI = Math.max(maxDNDBI, Math.abs(nDBI)); }
      if (!isNaN(dist)) { maxDist  = Math.max(maxDist,  dist); }
    });

    var primaryField = cfg.field;

    fc.features.forEach(function(feature, index) {
      var props  = feature.properties || {};
      var center = geometryCenter(feature.geometry);
      var tierValue = String(props.priority_tier || 'unknown').toLowerCase();

      var tierBadge = ui.Label(formatTierLabel(props.priority_tier).toUpperCase(), {
        fontSize:        '9px',
        fontWeight:      'bold',
        color:           '#ffffff',
        backgroundColor: tierColor(tierValue),
        padding:         '2px 6px',
        margin:          '0 8px 0 0'
      });

      var rankIdLabel = ui.Label(
        '#' + (index + 1) + '  ' + shortCandidateId(props.candidate_id),
        {fontSize: '12px', fontWeight: 'bold', color: COLORS.text, margin: '2px 0 0 0'}
      );

      var viewButton = ui.Button({
        label:   'View ↗',
        style:   {margin: '0', width: '60px'},
        onClick: function() {
          if (center) { map.setCenter(center.lon, center.lat, 11); }
          populateInfoFromCandidate(props);
        }
      });

      var header = ui.Panel([
        tierBadge, rankIdLabel,
        ui.Label('', {stretch: 'horizontal', margin: '0'}),
        viewButton
      ], ui.Panel.Layout.flow('horizontal'), {stretch: 'horizontal', margin: '0 0 4px 0'});

      var dNTLBar  = makeMetricBar('dNTL',  props.dNTL_2021_2024,      maxDNTL,
        function(v) { return (v >= 0 ? '+' : '') + v.toFixed(2); },
        primaryField === 'dNTL_2021_2024', false);
      var dNDBIBar = makeMetricBar('dNDBI', props.dNDBI_2021_2024,     maxDNDBI,
        function(v) { return (v >= 0 ? '+' : '') + v.toFixed(3); },
        primaryField === 'dNDBI_2021_2024', false);
      var distBar  = makeMetricBar('Dist',  props.dist_to_confirmed_m, maxDist,
        function(v) { return v >= 1000 ? (v / 1000).toFixed(1) + ' km' : v.toFixed(0) + ' m'; },
        primaryField === 'dist_to_confirmed_m', true);

      rankingPanel.add(ui.Panel(
        [header, dNTLBar, dNDBIBar, distBar],
        ui.Panel.Layout.flow('vertical'),
        {
          stretch:         'horizontal',
          margin:          '0 0 6px 0',
          padding:         '8px 10px',
          border:          '1px solid ' + COLORS.border,
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
  infoPanel.add(ui.Label(translate('Loading selected location...'), {fontSize: '12px', color: COLORS.muted}));

  var point = ee.Geometry.Point([coords.lon, coords.lat]);

  ee.Dictionary({
    nearest:   nearestReportedSite(point),
    candidate: activeCandidatesInAoi.filterBounds(point).first()
  }).evaluate(function(result) {
    infoPanel.clear();
    infoPanel.add(ui.Label(translate('Selected Location'), {fontWeight: 'bold', margin: '0 0 4px 0'}));
    addInfoRow(translate('Longitude'), formatNumber(coords.lon, 5));
    addInfoRow(translate('Latitude'),  formatNumber(coords.lat, 5));

    infoPanel.add(ui.Label(translate('Nearest Reported Site'), {fontWeight: 'bold', margin: '8px 0 4px 0'}));

    var siteFeature = result && result.nearest;
    if (siteFeature && siteFeature.properties) {
      var s = siteFeature.properties;
      addInfoRow(translate('Name'),     s.name         || 'Unknown');
      addInfoRow(translate('Status'),   s.site_status  || 'Unknown');
      addInfoRow(translate('Country'),  s.country      || 'Unknown');
      addInfoRow(translate('Context'),  s.context_type || 'Unknown');
      addInfoRow(translate('Distance'), formatNumber(s.distance_m, 0) + ' m');
    } else {
      addInfoRow(translate('Site'), translate('No reported site found'));
    }

    var candidateFeature = result && result.candidate;
    if (candidateFeature && candidateFeature.properties) {
      populateInfoFromCandidate(candidateFeature.properties);
      showMapPopup(candidateFeature.properties, coords);
    }
  });
});

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
function updateAllLabels() {
  // Title and subtitle
  titleLabel.setValue(translate('Scam Compound Explorer V3'));
  subtitleLabel.setValue(translate('subtitle'));

  // Left panel labels
  aoiFocusLabel.setValue(translate('Regional focus'));
  rankingMetricLabel.setValue(translate('Ranking metric'));

  // Buttons
  resetButton.setLabel(translate('Reset View'));
  overviewButton.setLabel(translate('Show Overview'));
  refreshEvidenceButton.setLabel(translate('Load Evidence & Ranking'));
  basemapButton.setLabel(
    translate(aoiSatelliteShown ? 'AOI satellite: ON' : 'AOI satellite: OFF')
  );

  // Section titles — rebuild them since sectionTitle() creates new labels
  // We need to update their values directly
  aoiControlsTitle.setValue(translate('AOI Controls'));
  overviewTitle.setValue(translate('Overview'));
  funnelTitle.setValue(translate('Stage Funnel'));
  validationTitle.setValue(translate('Validation'));
  evidenceTitle.setValue(translate('Evidence Scatter'));
  rankingTitle.setValue(translate('Priority Review List'));
  layersTitle.setValue(translate('Layers'));
  clickMapTitle.setValue(translate('Click Map'));

  // Legend panel
  legendPanel.widgets().get(0).setValue(translate('Legend'));

  // Legend point rows: each row is a Panel with [● label, text label]
  legendPanel.widgets().get(1).widgets().get(1).setValue(translate('Confirmed site'));
  legendPanel.widgets().get(2).widgets().get(1).setValue(translate('Suspected site'));
  legendPanel.widgets().get(3).widgets().get(1).setValue(translate('Control site'));
  legendPanel.widgets().get(4).widgets().get(1).setValue(translate('High candidate tier'));
  legendPanel.widgets().get(5).widgets().get(1).setValue(translate('Medium candidate tier'));
  legendPanel.widgets().get(6).widgets().get(1).setValue(translate('Low candidate tier'));

  // Rank mode select
  rankModeSelect.items().reset([
    {label: translate('Highest dNTL'),        value: 'Highest dNTL'},
    {label: translate('Highest dNDBI'),       value: 'Highest dNDBI'},
    {label: translate('Closest to confirmed'), value: 'Closest to confirmed'}
  ]);

  // AOI select items — keep values the same, only labels change if needed
  // (AOI names are proper nouns, no translation needed)

  // Layer checkboxes — rebuild layer controls for current stack
  var aoiName = aoiSelect.getValue();
  if (layerCache[aoiName]) {
    updateLayerControls(layerCache[aoiName]);
  }

  // Info panel default text
  setDefaultInfo();

  // Evidence and ranking placeholders
  setEvidencePlaceholder(aoiName);
}
var splitMapLeft  = null;
var splitMapRight = null;
var splitPanelWidget = null;
var splitPanelContainer = null;
var splitMapLinker = null;
var splitDndbiLayer = null;
var splitDntlLayer = null;
var splitOverlayShown = true;
var splitOverlayButtons = [];
var splitCompareCache = {};

function readMapView(sourceMap) {
  return {
    center: sourceMap.getCenter(),
    zoom:   sourceMap.getZoom()
  };
}

function applyMapView(targetMap, view, fallbackAoiName) {
  var center = view && view.center;
  var zoom   = view && view.zoom;
  if (center && center.lon !== undefined && center.lat !== undefined && zoom !== undefined && zoom !== null) {
    targetMap.setCenter(center.lon, center.lat, zoom);
  } else if (center && center.length === 2 && zoom !== undefined && zoom !== null) {
    targetMap.setCenter(center[0], center[1], zoom);
  } else {
    setMapToAoiView(targetMap, fallbackAoiName || activeAoiName);
  }
}

function updateSplitOverlayControls() {
  if (splitDndbiLayer) { splitDndbiLayer.setShown(splitOverlayShown); }
  if (splitDntlLayer)  { splitDntlLayer.setShown(splitOverlayShown); }
  splitOverlayButtons.forEach(function(button) {
    button.setLabel(splitOverlayShown ? 'Hide change layer' : 'Show change layer');
  });
}

function makeSplitOverlayButton(position) {
  var button = ui.Button({
    label: splitOverlayShown ? 'Hide change layer' : 'Show change layer',
    style: {
      position: position,
      padding: '4px 8px',
      margin: '8px',
      backgroundColor: 'rgba(255,255,255,0.92)'
    },
    onClick: function() {
      splitOverlayShown = !splitOverlayShown;
      updateSplitOverlayControls();
    }
  });
  splitOverlayButtons.push(button);
  return button;
}

function getSplitCompareRegion(aoiName, aoiGeometry) {
  return {
    key: aoiName + ':full-aoi',
    geometry: aoiGeometry
  };
}

function buildSplitCompareImages(cacheKey, compareGeometry) {
  if (splitCompareCache[cacheKey]) {
    return splitCompareCache[cacheKey];
  }

  var s2_2021 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(compareGeometry)
    .filterDate('2021-01-01', '2021-12-31')
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 30))
    .select(['B11', 'B8'])
    .median();

  var s2_2024 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(compareGeometry)
    .filterDate('2024-01-01', '2024-12-31')
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 30))
    .select(['B11', 'B8'])
    .median();

  var ndbi2021 = s2_2021.normalizedDifference(['B11', 'B8']).rename('NDBI');
  var ndbi2024 = s2_2024.normalizedDifference(['B11', 'B8']).rename('NDBI');
  var dNDBI = ndbi2024.subtract(ndbi2021).rename('dNDBI')
    .clip(compareGeometry);
  var dNDBIGrowth = dNDBI.updateMask(dNDBI.gt(0.015));

  var ntl2021 = ee.ImageCollection('NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG')
    .filterBounds(compareGeometry)
    .filterDate('2021-01-01', '2021-12-31')
    .select('avg_rad')
    .median();

  var ntl2024 = ee.ImageCollection('NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG')
    .filterBounds(compareGeometry)
    .filterDate('2024-01-01', '2024-12-31')
    .select('avg_rad')
    .median();

  var dNTL = ntl2024.subtract(ntl2021).rename('dNTL')
    .clip(compareGeometry);
  var dNTLGrowth = dNTL.updateMask(dNTL.gt(0.25));

  splitCompareCache[cacheKey] = {
    dNDBIGrowth: dNDBIGrowth,
    dNTLGrowth:  dNTLGrowth
  };
  return splitCompareCache[cacheKey];
}

function showSplitView() {
  var aoiData = getAoiData(activeAoiName);
  var mainView = readMapView(map);
  splitOverlayShown = true;
  var compareRegion = getSplitCompareRegion(activeAoiName, aoiData.geometry);
  var compareImages = buildSplitCompareImages(compareRegion.key, compareRegion.geometry);

/*
  // Build dNDBI change image (2021→2024 built-up growth)
  var s2_2021 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(aoiData.geometry)
    .filterDate('2021-01-01', '2021-12-31')
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 30))
    .select(['B11', 'B8'])
    .median();

  var s2_2024 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(aoiData.geometry)
    .filterDate('2024-01-01', '2024-12-31')
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 30))
    .select(['B11', 'B8'])
    .median();

  // NDBI = (SWIR - NIR) / (SWIR + NIR)
  var ndbi2021 = s2_2021.normalizedDifference(['B11', 'B8']).rename('NDBI');
  var ndbi2024 = s2_2024.normalizedDifference(['B11', 'B8']).rename('NDBI');
  var dNDBI = ndbi2024.subtract(ndbi2021).rename('dNDBI')
    .clip(aoiData.geometry);
  var dNDBIGrowth = dNDBI.updateMask(dNDBI.gt(0.015));

  // Build dNTL change image (2021→2024 night-time light growth)
  var ntl2021 = ee.ImageCollection('NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG')
    .filterBounds(aoiData.geometry)
    .filterDate('2021-01-01', '2021-12-31')
    .select('avg_rad')
    .median()
    .clip(aoiData.geometry);

  var ntl2024 = ee.ImageCollection('NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG')
    .filterBounds(aoiData.geometry)
    .filterDate('2024-01-01', '2024-12-31')
    .select('avg_rad')
    .median()
    .clip(aoiData.geometry);

  var dNTL = ntl2024.subtract(ntl2021).rename('dNTL')
    .clip(aoiData.geometry);
  var dNTLGrowth = dNTL.updateMask(dNTL.gt(0.25));
*/

  splitMapLeft  = ui.Map();
  splitMapRight = ui.Map();

  splitMapLeft.setOptions('Grayscale',  {Grayscale: GRAYSCALE_STYLE});
  splitMapRight.setOptions('Grayscale', {Grayscale: GRAYSCALE_STYLE});
  splitMapLeft.setControlVisibility({layerList: true, mapTypeControl: false, scaleControl: true});
  splitMapRight.setControlVisibility({layerList: true, mapTypeControl: false, scaleControl: true});

  if (!satelliteCache[activeAoiName]) {
    satelliteCache[activeAoiName] = buildAoiSatelliteStack(activeAoiName, aoiData.geometry);
  }
  splitMapLeft.addLayer(
    satelliteCache[activeAoiName].peripheral,
    {bands: ['B4', 'B3', 'B2'], min: 300, max: 3000, gamma: 1.3, opacity: satellitePeripheralOpacity(activeAoiName)},
    'AOI satellite — peripheral', false);
  splitMapLeft.addLayer(
    satelliteCache[activeAoiName].core,
    {bands: ['B4', 'B3', 'B2'], min: 300, max: 3000, gamma: 1.3, opacity: satelliteCoreOpacity(activeAoiName)},
    satelliteFocusLabel(activeAoiName), false);
  splitMapRight.addLayer(
    satelliteCache[activeAoiName].peripheral,
    {bands: ['B4', 'B3', 'B2'], min: 300, max: 3000, gamma: 1.3, opacity: satellitePeripheralOpacity(activeAoiName)},
    'AOI satellite — peripheral', false);
  splitMapRight.addLayer(
    satelliteCache[activeAoiName].core,
    {bands: ['B4', 'B3', 'B2'], min: 300, max: 3000, gamma: 1.3, opacity: satelliteCoreOpacity(activeAoiName)},
    satelliteFocusLabel(activeAoiName), false);

  // dNDBI: green=no change, red=high built-up growth
  splitDndbiLayer = ui.Map.Layer(compareImages.dNDBIGrowth, {
    min: 0.015, max: 0.18,
    palette: ['#fee08b', '#f46d43', '#d73027'],
    opacity: 0.95
  }, 'dNDBI 2021-2024', splitOverlayShown);
  splitMapLeft.layers().add(splitDndbiLayer);

  // dNTL: dark=no change, yellow=high light growth
  splitDntlLayer = ui.Map.Layer(compareImages.dNTLGrowth, {
    min: 0.25, max: 6,
    palette: ['#2c7fb8', '#41b6c4', '#ff1493'],
    opacity: 0.95
  }, 'dNTL 2021-2024', splitOverlayShown);
  splitMapRight.layers().add(splitDntlLayer);

  // Add candidate points on both maps for reference
  var aoiCandidates = getAoiData(activeAoiName).candidates;
  var highCandidates = filterCandidatesByTier(aoiCandidates, 'high');

  splitMapLeft.addLayer(
    stylePointCollection(getAoiData(activeAoiName).confirmed, COLORS.confirmed, 6),
    {}, 'Confirmed sites');
  splitMapRight.addLayer(
    stylePointCollection(getAoiData(activeAoiName).confirmed, COLORS.confirmed, 6),
    {}, 'Confirmed sites');

  // Title labels
  splitMapLeft.add(ui.Label('◀ dNDBI — Built-up Growth 2021→2024', {
    position: 'top-left', fontWeight: 'bold', fontSize: '13px',
    backgroundColor: 'rgba(255,255,255,0.92)', padding: '5px 10px'
  }));
  splitMapRight.add(ui.Label('dNTL — Night Light Growth 2021→2024 ▶', {
    position: 'top-right', fontWeight: 'bold', fontSize: '13px',
    backgroundColor: 'rgba(255,255,255,0.92)', padding: '5px 10px'
  }));
  splitMapLeft.add(makeSplitOverlayButton('top-right'));
  splitMapRight.add(makeSplitOverlayButton('top-left'));

  // Legend for left map (dNDBI)
  var leftLegend = ui.Panel({
    widgets: [
      ui.Label('dNDBI', {fontWeight: 'bold', fontSize: '11px', margin: '0 0 4px 0'}),
      ui.Panel([
        ui.Label('', {width: '12px', height: '10px', backgroundColor: '#fee08b', margin: '0 2px 0 0'}),
        ui.Label('Low growth', {fontSize: '10px', margin: '0'})
      ], ui.Panel.Layout.flow('horizontal'), {margin: '0 0 2px 0'}),
      ui.Panel([
        ui.Label('', {width: '12px', height: '10px', backgroundColor: '#f46d43', margin: '0 2px 0 0'}),
        ui.Label('Moderate growth', {fontSize: '10px', margin: '0'})
      ], ui.Panel.Layout.flow('horizontal'), {margin: '0 0 2px 0'}),
      ui.Panel([
        ui.Label('', {width: '12px', height: '10px', backgroundColor: '#d73027', margin: '0 2px 0 0'}),
        ui.Label('High growth', {fontSize: '10px', margin: '0'})
      ], ui.Panel.Layout.flow('horizontal'), {margin: '0'})
    ],
    style: {
      position: 'bottom-left',
      backgroundColor: 'rgba(255,255,255,0.92)',
      padding: '8px', borderRadius: '4px'
    }
  });

  // Legend for right map (dNTL)
  var rightLegend = ui.Panel({
    widgets: [
      ui.Label('dNTL', {fontWeight: 'bold', fontSize: '11px', margin: '0 0 4px 0'}),
      ui.Panel([
        ui.Label('', {width: '12px', height: '10px', backgroundColor: '#2c7fb8', margin: '0 2px 0 0'}),
        ui.Label('Low growth', {fontSize: '10px', margin: '0'})
      ], ui.Panel.Layout.flow('horizontal'), {margin: '0 0 2px 0'}),
      ui.Panel([
        ui.Label('', {width: '12px', height: '10px', backgroundColor: '#41b6c4', margin: '0 2px 0 0'}),
        ui.Label('Moderate growth', {fontSize: '10px', margin: '0'})
      ], ui.Panel.Layout.flow('horizontal'), {margin: '0 0 2px 0'}),
      ui.Panel([
        ui.Label('', {width: '12px', height: '10px', backgroundColor: '#ff1493', margin: '0 2px 0 0'}),
        ui.Label('High growth', {fontSize: '10px', margin: '0'})
      ], ui.Panel.Layout.flow('horizontal'), {margin: '0'})
    ],
    style: {
      position: 'bottom-right',
      backgroundColor: 'rgba(255,255,255,0.92)',
      padding: '8px', borderRadius: '4px'
    }
  });

  splitMapLeft.add(leftLegend);
  splitMapRight.add(rightLegend);

  splitMapLinker = ui.Map.Linker([splitMapLeft, splitMapRight]);

  applyMapView(splitMapLeft, mainView, activeAoiName);
  applyMapView(splitMapRight, mainView, activeAoiName);

  splitPanelWidget = ui.SplitPanel({
    firstPanel:  splitMapLeft,
    secondPanel: splitMapRight,
    orientation: 'horizontal',
    wipe:        true,
    style:       {stretch: 'both'}
  });

  splitPanelContainer = ui.Panel([splitPanelWidget], null, {
    stretch: 'both',
    margin: '0',
    padding: '0'
  });
  setMainPanel(splitPanelContainer);
  applyMapView(splitMapLeft, mainView, activeAoiName);
  applyMapView(splitMapRight, mainView, activeAoiName);
}

function hideSplitView() {
  var splitView = splitMapLeft ? readMapView(splitMapLeft) : null;
  setMainPanel(map);
  splitMapLeft  = null;
  splitMapRight = null;
  splitPanelWidget = null;
  splitPanelContainer = null;
  splitMapLinker = null;
  splitDndbiLayer = null;
  splitDntlLayer = null;
  splitOverlayButtons = [];
  applyMapView(map, splitView, activeAoiName);
}
function renderAoi(aoiName) {
  activeRenderId += 1;
  var renderId = activeRenderId;
  var aoiData  = getAoiData(aoiName);

  activeAoiName         = aoiName;
  activeAoi             = aoiData.geometry;
  activePointsInAoi     = aoiData.points;
  activeCandidatesInAoi = aoiData.candidates;
  activeTierCollections = aoiData.tiers;

  var stack        = buildLayerStack(aoiName);

  applyLayerStack(stack);
  setMapToAoiView(map, aoiName);

  updateLayerControls(stack);
  updateKpis(aoiData.points, aoiData.candidates, renderId, aoiName);
  setEvidencePlaceholder(aoiName);
  setDefaultInfo();
  buildDashboard(aoiName);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

aoiSelect.onChange(function(value) { renderAoi(value); });

rankModeSelect.onChange(function() {
  rankingPanel.clear();
  rankingPanel.add(ui.Label(
    translate('Ranking metric changed. Click "Load Evidence & Ranking" to rebuild the review list.'),
    {fontSize: '12px', color: COLORS.muted, whiteSpace: 'pre-wrap'}
  ));
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

buildStaticPanels();
buildMethodologyPanel();
renderAoi(DEFAULT_AOI);


