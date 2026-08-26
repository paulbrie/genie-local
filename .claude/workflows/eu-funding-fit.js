export const meta = {
  name: 'eu-funding-fit',
  description: 'Find currently-open EU funding calls that fit a given company, with adversarial deadline/fit verification',
  whenToUse: 'When you need a fact-checked list of open EU grants/calls (Horizon Europe, Digital Europe, EIC, national co-funded programmes) matching a specific company\'s industry and capabilities.',
  phases: [
    { title: 'Scope', detail: 'Build search angles from the company profile' },
    { title: 'Search', detail: 'Parallel web search, one agent per angle' },
    { title: 'Fetch', detail: 'Dedup URLs, extract candidate calls with structured fields' },
    { title: 'Verify', detail: '3-vote adversarial check: open on date X? id matches? fit real?' },
    { title: 'Synthesize', detail: 'Bucket calls in code; write recommendation' },
  ],
}

// ---------------------------------------------------------------------------
// Config — args may be a plain string (freeform company description) or an
// object. `today` is REQUIRED because the workflow sandbox has no clock.
// ---------------------------------------------------------------------------
const cfg = (typeof args === 'string') ? { company: args } : (args || {})
const today = cfg.today
if (!today) {
  throw new Error("eu-funding-fit: pass args.today as 'YYYY-MM-DD' — the sandbox has no clock, so the pipeline can't tell which deadlines are still open without it.")
}
const company     = cfg.company     || 'the target company'
const profile      = cfg.profile     || ''
const capabilities = cfg.capabilities || []
const verticals    = cfg.verticals   || []
const country      = cfg.country     || ''
const programmes   = cfg.programmes  || [
  'Horizon Europe (Cluster 4 Digital/Industry/Space; EIC Accelerator/Pathfinder/Transition)',
  'Digital Europe Programme (DIGITAL)',
  'EIC and EIT Digital',
  country ? `national/EU co-funded programmes open to ${country} SMEs` : 'national/EU co-funded SME programmes',
]
const MAX_SOURCES = cfg.maxSources || 18

const brief = [
  `Company: ${company}`,
  profile && `Profile: ${profile}`,
  capabilities.length && `Capabilities: ${capabilities.join(', ')}`,
  verticals.length && `Sector verticals: ${verticals.join(', ')}`,
  country && `Home country: ${country}`,
  `Reference date (today): ${today}. A call counts as OPEN only if its submission deadline is on or after ${today}.`,
].filter(Boolean).join('\n')

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const ANGLE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['angles'],
  properties: {
    angles: {
      type: 'array', minItems: 4, maxItems: 6,
      items: {
        type: 'object', additionalProperties: false,
        required: ['key', 'query', 'rationale'],
        properties: {
          key: { type: 'string' },
          query: { type: 'string' },
          rationale: { type: 'string' },
        },
      },
    },
  },
}

const SEARCH_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['url', 'title', 'relevance', 'snippet'],
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          relevance: { type: 'string', enum: ['high', 'medium', 'low'] },
          snippet: { type: 'string' },
        },
      },
    },
  },
}

const CALL = {
  type: 'object', additionalProperties: false,
  required: ['callId', 'programme', 'title', 'deadline', 'link'],
  properties: {
    callId:      { type: 'string', description: 'Official call/topic ID, e.g. DIGITAL-2026-AI-DATA-10-COMPLIANCE' },
    programme:   { type: 'string' },
    title:       { type: 'string' },
    fit:         { type: 'string', description: 'Why this fits the company; empty if unclear' },
    fundingType: { type: 'string' },
    budget:      { type: 'string' },
    eligibility: { type: 'string' },
    consortium:  { type: 'string', description: 'Consortium/partner requirements, or "single applicant"' },
    deadline:    { type: 'string', description: 'Submission deadline as found, ideally ISO YYYY-MM-DD' },
    link:        { type: 'string' },
  },
}

const EXTRACT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['sourceQuality', 'calls'],
  properties: {
    sourceQuality: { type: 'string', enum: ['primary', 'secondary', 'unreliable'] },
    publishDate:   { type: 'string' },
    calls:         { type: 'array', items: CALL },
  },
}

const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['open', 'idMatches', 'fitReal', 'category', 'confidence', 'evidence'],
  properties: {
    open:      { type: 'boolean', description: `true iff submission deadline is on/after ${today}` },
    idMatches: { type: 'boolean', description: 'true iff the call/topic ID matches the official source document' },
    fitReal:   { type: 'boolean', description: 'true iff the fit is genuine (not just a label keyword match) AND the company could realistically apply or partner' },
    category:  { type: 'string', enum: ['OPEN_FIT', 'OPEN_NOT_ACTIONABLE', 'CLOSED', 'IRRELEVANT'] },
    correctedDeadline: { type: 'string' },
    correctedCallId:   { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    evidence:   { type: 'string' },
  },
}

const RECO_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['summary', 'recommendation', 'caveats'],
  properties: {
    summary:        { type: 'string' },
    recommendation: { type: 'string' },
    caveats:        { type: 'string' },
  },
}

// ---------------------------------------------------------------------------
// Phase 1 — Scope
// ---------------------------------------------------------------------------
phase('Scope')
const scoped = await agent(
  `Decompose an EU-funding search into complementary angles for this company.\n\n${brief}\n\n` +
  `Programmes to cover across the angles: ${programmes.join('; ')}.\n` +
  `Each angle = a distinct search lens (one per major programme, plus one broad EU Funding & Tenders Portal angle, plus a sector-vertical angle if the verticals warrant it). ` +
  `Queries must bias toward OFFICIAL/PRIMARY sources (ec.europa.eu funding-tenders portal, HaDEA, EIC, national ministry sites) and toward calls whose deadline is on/after ${today}.`,
  { label: 'scope', phase: 'Scope', schema: ANGLE_SCHEMA },
)
const angles = (scoped && scoped.angles) || []
log(`Scoped into ${angles.length} angles: ${angles.map(a => a.key).join(', ')}`)

// ---------------------------------------------------------------------------
// Phase 2 — Search (parallel, one per angle; barrier so we can dedup URLs)
// ---------------------------------------------------------------------------
phase('Search')
const searchResults = await parallel(angles.map(a => () =>
  agent(
    `## Web Searcher: ${a.key}\n\n${brief}\n\nAngle rationale: ${a.rationale}\nStart from this query and iterate: ${a.query}\n\n` +
    `Return the most relevant sources for OPEN calls (deadline on/after ${today}). Prefer official/primary pages and the exact call fiche where possible. ` +
    `Include the call/topic ID in the title when you can. Do NOT invent URLs — only report pages you actually saw in results.`,
    { label: `search:${a.key}`, phase: 'Search', schema: SEARCH_SCHEMA },
  ).then(r => ({ angle: a.key, results: (r && r.results) || [] }))
))

// Dedup URLs across angles; rank primary+high first.
const seenUrl = new Set()
const qualityRank = { high: 0, medium: 1, low: 2 }
const ranked = []
for (const sr of searchResults.filter(Boolean)) {
  for (const r of sr.results) {
    if (!r.url || seenUrl.has(r.url)) continue
    seenUrl.add(r.url)
    ranked.push({ ...r, angle: sr.angle })
  }
}
ranked.sort((x, y) => (qualityRank[x.relevance] ?? 3) - (qualityRank[y.relevance] ?? 3))
const toFetch = ranked.slice(0, MAX_SOURCES)
log(`Search → ${ranked.length} unique URLs; fetching top ${toFetch.length}`)

// ---------------------------------------------------------------------------
// Phase 3 — Fetch + extract candidate calls (pipeline: no barrier needed yet)
// ---------------------------------------------------------------------------
phase('Fetch')
const extracted = await parallel(toFetch.map(s => () =>
  agent(
    `## Source Extractor\n\n${brief}\n\nFetch this URL and extract every EU funding CALL it describes: ${s.url}\n\n` +
    `For each call give the official call/topic ID, programme, title, submission deadline (ISO if possible), funding type, budget, eligibility (esp. ${country || 'SME'} eligibility), consortium requirements, a one-line fit note for this company, and the official link. ` +
    `Extract calls even if they look closed — the verify stage decides. If the page lists no concrete call, return an empty calls array. Rate the source quality.`,
    { label: `fetch:${s.url.slice(0, 48)}`, phase: 'Fetch', schema: EXTRACT_SCHEMA },
  ).then(r => ({ url: s.url, quality: (r && r.sourceQuality) || 'unreliable', calls: (r && r.calls) || [] }))
))

// Merge candidate calls; dedup by normalized callId (keep the richest record).
const byId = new Map()
const sourcesMeta = []
for (const e of extracted.filter(Boolean)) {
  sourcesMeta.push({ url: e.url, quality: e.quality, callCount: e.calls.length })
  for (const c of e.calls) {
    const id = (c.callId || c.title || c.link || '').trim().toUpperCase()
    if (!id) continue
    const prev = byId.get(id)
    if (!prev || JSON.stringify(c).length > JSON.stringify(prev).length) {
      byId.set(id, { ...c, sourceUrl: e.url, sourceQuality: e.quality })
    }
  }
}
const candidates = [...byId.values()]
log(`Fetch → ${candidates.length} unique candidate calls from ${sourcesMeta.length} sources`)

// ---------------------------------------------------------------------------
// Phase 4 — Verify (3-vote adversarial per call; majority rules)
// ---------------------------------------------------------------------------
phase('Verify')
const VOTERS = 3
const verified = await parallel(candidates.map(c => () =>
  parallel(Array.from({ length: VOTERS }, (_, i) => () =>
    agent(
      `## Adversarial verifier (voter ${i + 1}) — try to REFUTE that this is a live, fitting call.\n\n${brief}\n\n` +
      `Candidate call:\n${JSON.stringify(c, null, 2)}\n\n` +
      `Independently check against OFFICIAL sources (open the EU Funding & Tenders portal / call fiche — do not trust the candidate's own numbers):\n` +
      `1. OPEN? Is the real submission deadline on/after ${today}? Beware two-stage calls where stage 2 is closed to new entrants — treat those as OPEN_NOT_ACTIONABLE, not OPEN_FIT.\n` +
      `2. ID MATCH? Does the call/topic ID actually name THIS call in the official document (not a sibling call with copied dates)?\n` +
      `3. FIT REAL? Genuine fit for ${company}, and can it realistically apply or partner — or is it a keyword match / single-award-to-one-consortium that doesn't fit?\n` +
      `Pick the category. Default to the LESS favorable category when uncertain. Give corrected deadline/ID if the candidate's were wrong.`,
      { label: `verify:${(c.callId || c.title || '').slice(0, 32)}#${i + 1}`, phase: 'Verify', schema: VERDICT_SCHEMA },
    )
  )).then(votes => {
    const v = votes.filter(Boolean)
    if (!v.length) return null
    const count = k => v.filter(x => x[k]).length
    const cats = {}
    for (const x of v) cats[x.category] = (cats[x.category] || 0) + 1
    // Mode category; tie broken toward the more conservative (less favorable) bucket.
    const order = ['OPEN_FIT', 'OPEN_NOT_ACTIONABLE', 'IRRELEVANT', 'CLOSED']
    let category = order[order.length - 1]
    let best = -1
    for (const cat of order) {
      const n = cats[cat] || 0
      if (n > best) { best = n; category = cat }
    }
    const corrected = v.find(x => x.correctedDeadline)?.correctedDeadline
    const correctedId = v.find(x => x.correctedCallId)?.correctedCallId
    return {
      ...c,
      callId: correctedId || c.callId,
      deadline: corrected || c.deadline,
      category,
      votesOpen: count('open'),
      votesFit: count('fitReal'),
      votesIdMatch: count('idMatches'),
      evidence: v.map(x => x.evidence).filter(Boolean)[0] || '',
    }
  })
))

const calls = verified.filter(Boolean)
const openFit           = calls.filter(c => c.category === 'OPEN_FIT')
const openNotActionable = calls.filter(c => c.category === 'OPEN_NOT_ACTIONABLE')
const excluded          = calls.filter(c => c.category === 'CLOSED' || c.category === 'IRRELEVANT')
log(`Verify → ${openFit.length} open+fit, ${openNotActionable.length} open-not-actionable, ${excluded.length} excluded`)

// ---------------------------------------------------------------------------
// Phase 5 — Synthesize (deterministic buckets in code; one guarded prose pass)
// ---------------------------------------------------------------------------
phase('Synthesize')
let prose = { summary: '', recommendation: '', caveats: '' }
try {
  prose = await agent(
    `Write a short executive summary + recommendation for ${company} based ONLY on these verified EU calls.\n\n${brief}\n\n` +
    `OPEN + fit:\n${JSON.stringify(openFit, null, 2)}\n\nOPEN but not actionable:\n${JSON.stringify(openNotActionable, null, 2)}\n\n` +
    `Rank the open+fit calls by urgency (nearest deadline / directness of fit). Note any that need a consortium/lead partner. Keep it tight.`,
    { label: 'synthesize', phase: 'Synthesize', schema: RECO_SCHEMA },
  ) || prose
} catch (e) {
  log(`Synthesis prose failed (${e.message}); returning structured buckets only`)
}

return {
  company, today,
  summary: prose.summary,
  recommendation: prose.recommendation,
  caveats: prose.caveats,
  openFit,
  openNotActionable,
  excluded,
  sources: sourcesMeta,
  stats: {
    angles: angles.length,
    urlsFound: ranked.length,
    sourcesFetched: sourcesMeta.length,
    candidates: candidates.length,
    openFit: openFit.length,
    openNotActionable: openNotActionable.length,
    excluded: excluded.length,
  },
}
