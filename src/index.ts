interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * IMF PortWatch MCP — global maritime trade & chokepoint signals (free, no auth)
 *
 * PortWatch is the IMF's open dashboard for tracking shipping activity, port
 * disruptions, and chokepoint throughput. Data is published daily as ArcGIS
 * FeatureServer layers — we surface the four most-useful ones for live
 * geopolitical / trade bet research:
 *
 * - chokepoints_list:        the 8 major chokepoints (Suez, Panama, Hormuz,
 *                            Bab-el-Mandeb, Bosphorus, Malacca, Gibraltar,
 *                            Cape of Good Hope) with annual traffic mix
 * - chokepoint_daily_traffic: per-chokepoint vessel counts by day —
 *                            this is the signal for "Suez transits dropped
 *                            from 70/day to 30/day post-Houthi attacks"
 * - port_search:             1500+ named ports with country / trade share
 * - recent_disruptions:      port-affecting events (cyclones, floods,
 *                            conflicts) with alert level and impact area
 *
 * Source: https://portwatch.imf.org (open ArcGIS FeatureServer; no key).
 */


const BASE = 'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/ArcGIS/rest/services';

// Friendly-name → portid map for the major chokepoints. PortWatch's
// portid scheme (chokepoint1..28) is not memorable and the numbering is
// non-obvious (e.g. chokepoint7 is Cape of Good Hope, not Hormuz), so
// we accept names and translate. Mapping reflects the actual PortWatch
// portid assignment as of 2026-05. If you add an alias for a chokepoint
// not below, the resolver also falls back to a portname LIKE search.
const CHOKEPOINT_ALIASES: Record<string, string> = {
  suez: 'chokepoint1', 'suez canal': 'chokepoint1',
  panama: 'chokepoint2', 'panama canal': 'chokepoint2',
  bosphorus: 'chokepoint3', bosporus: 'chokepoint3', 'bosphorus strait': 'chokepoint3', 'bosporus strait': 'chokepoint3',
  'bab-el-mandeb': 'chokepoint4', 'bab el mandeb': 'chokepoint4', 'bab al-mandab': 'chokepoint4', 'bab al-mandab strait': 'chokepoint4',
  malacca: 'chokepoint5', 'strait of malacca': 'chokepoint5', 'malacca strait': 'chokepoint5',
  hormuz: 'chokepoint6', 'strait of hormuz': 'chokepoint6',
  'cape of good hope': 'chokepoint7', 'good hope': 'chokepoint7',
  gibraltar: 'chokepoint8', 'strait of gibraltar': 'chokepoint8', 'gibraltar strait': 'chokepoint8',
  dover: 'chokepoint9', 'strait of dover': 'chokepoint9', 'dover strait': 'chokepoint9', 'english channel': 'chokepoint9',
  // Secondary chokepoints — same scheme, less commonly cited
  oresund: 'chokepoint10', 'oresund strait': 'chokepoint10',
  taiwan: 'chokepoint11', 'taiwan strait': 'chokepoint11',
  korea: 'chokepoint12', 'korea strait': 'chokepoint12',
  tsugaru: 'chokepoint13', 'tsugaru strait': 'chokepoint13',
  luzon: 'chokepoint14', 'luzon strait': 'chokepoint14',
  lombok: 'chokepoint15', 'lombok strait': 'chokepoint15',
  ombai: 'chokepoint16', 'ombai strait': 'chokepoint16',
  bohai: 'chokepoint17', 'bohai strait': 'chokepoint17',
  torres: 'chokepoint18', 'torres strait': 'chokepoint18',
  sunda: 'chokepoint19', 'sunda strait': 'chokepoint19',
  makassar: 'chokepoint20', 'makassar strait': 'chokepoint20',
  magellan: 'chokepoint21', 'magellan strait': 'chokepoint21',
  yucatan: 'chokepoint22', 'yucatan channel': 'chokepoint22',
  windward: 'chokepoint23', 'windward passage': 'chokepoint23',
  mona: 'chokepoint24', 'mona passage': 'chokepoint24',
  balabac: 'chokepoint25', 'balabac strait': 'chokepoint25',
  bering: 'chokepoint26', 'bering strait': 'chokepoint26',
  mindoro: 'chokepoint27', 'mindoro strait': 'chokepoint27',
  kerch: 'chokepoint28', 'kerch strait': 'chokepoint28',
};

const tools: McpToolExport['tools'] = [
  {
    name: 'chokepoints_list',
    description:
      'List the 8 major maritime chokepoints PortWatch tracks (Suez, Panama, Bosphorus, Gibraltar, Dover, Malacca, Hormuz, Bab-el-Mandeb) with annual vessel counts, traffic mix by cargo type (container / dry bulk / tanker / RoRo / general), and top industries by volume. Use to discover what a chokepoint normally carries — for live daily throughput call chokepoint_daily_traffic.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'chokepoint_daily_traffic',
    description:
      'Daily vessel counts and aggregate capacity (deadweight tonnage) transiting a specific chokepoint. Returns time series ordered most-recent-first, with per-cargo-type breakdown (container / dry bulk / general cargo / RoRo / tanker). Use for "is Suez traffic back to normal after the Houthi attacks", "Hormuz throughput vs 30d average", or any bet predicated on a chokepoint disruption persisting. Accepts friendly names (suez / panama / hormuz / bab-el-mandeb / etc.) or PortWatch portid (chokepoint1..8).',
    inputSchema: {
      type: 'object',
      properties: {
        chokepoint: { type: 'string', description: 'Friendly name (e.g. "Hormuz", "Suez Canal") or portid ("chokepoint7")' },
        days: { type: 'number', description: 'Lookback window in days (default 30, max 365). Data is daily.' },
      },
      required: ['chokepoint'],
    },
  },
  {
    name: 'port_search',
    description:
      'Search the PortWatch port database (1,500+ ports globally) by name, country, or ISO3. Returns matching ports with country, continent, latitude/longitude, annual vessel counts by cargo type, top industries, and the port\'s share of the country\'s maritime imports/exports. Useful for identifying which ports would be affected by a country-level disruption, or finding the LOCODE / portid for a named port.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text portname match (e.g. "Rotterdam", "Houston", "Singapore")' },
        country: { type: 'string', description: 'Country filter — full name ("Netherlands") or ISO3 ("NLD")' },
        limit: { type: 'number', description: 'Max results (default 20, max 100)' },
      },
    },
  },
  {
    name: 'recent_disruptions',
    description:
      'Port-affecting disruption events tracked by PortWatch — tropical cyclones, floods, earthquakes, conflict events — with start/end dates, alert level (GREEN/ORANGE/RED), severity, affected port count, and impacted population. Filter by country, alert level, or year. Use for "what disrupted shipping in the last month", "which port closures hit our supply chain", or to validate a bet on whether a current disruption is escalating.',
    inputSchema: {
      type: 'object',
      properties: {
        country: { type: 'string', description: 'Filter to a single country name (e.g. "Mozambique")' },
        alert_level: { type: 'string', description: 'RED | ORANGE | GREEN — minimum alert level to include' },
        year: { type: 'number', description: 'Filter to events from this calendar year' },
        limit: { type: 'number', description: 'Max events to return (default 25, max 100)' },
      },
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'chokepoints_list':
      return chokepointsList();
    case 'chokepoint_daily_traffic':
      return chokepointDailyTraffic(
        reqStr(args, 'chokepoint', '"Hormuz"'),
        clamp((args.days as number) ?? 30, 1, 365),
      );
    case 'port_search':
      return portSearch(
        args.query as string | undefined,
        args.country as string | undefined,
        clamp((args.limit as number) ?? 20, 1, 100),
      );
    case 'recent_disruptions':
      return recentDisruptions(
        args.country as string | undefined,
        args.alert_level as string | undefined,
        args.year as number | undefined,
        clamp((args.limit as number) ?? 25, 1, 100),
      );
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Implementations ──────────────────────────────────────────────────

type EsriFeature<T = Record<string, unknown>> = { attributes: T };
type EsriResponse<T = Record<string, unknown>> = { features?: EsriFeature<T>[]; error?: { code?: number; message?: string } };

async function esriQuery<T = Record<string, unknown>>(
  service: string,
  params: Record<string, string>,
): Promise<EsriResponse<T>> {
  const url = `${BASE}/${service}/FeatureServer/0/query?${new URLSearchParams({
    where: '1=1',
    outFields: '*',
    f: 'json',
    ...params,
  })}`;
  // Cache 15 min at the CF edge — PortWatch updates daily and the same
  // chokepoint queries get hammered when multiple agents resolve the
  // same bet. Errors get a short TTL so transient failures don't pin.
  const res = await fetch(url, {
    cf: {
      cacheTtlByStatus: { '200-299': 900, '400-499': 30, '500-599': 5 },
      cacheEverything: true,
    },
  } as RequestInit);
  if (!res.ok) {
    throw new Error(`PortWatch ArcGIS error: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const body = (await res.json()) as EsriResponse<T>;
  if (body.error) {
    throw new Error(`PortWatch query error: ${body.error.message ?? JSON.stringify(body.error)}`);
  }
  return body;
}

interface ChokepointAttrs {
  portid: string;
  portname: string;
  fullname: string;
  lat: number;
  lon: number;
  vessel_count_total: number;
  vessel_count_container: number;
  vessel_count_dry_bulk: number;
  vessel_count_general_cargo: number;
  vessel_count_RoRo: number;
  vessel_count_tanker: number;
  industry_top1: string;
  industry_top2: string;
  industry_top3: string;
}

async function chokepointsList() {
  const body = await esriQuery<ChokepointAttrs>('PortWatch_chokepoints_database', {
    orderByFields: 'portid ASC',
  });
  const feats = body.features ?? [];
  return {
    source: 'IMF PortWatch — annual aggregates',
    count: feats.length,
    chokepoints: feats.map((f) => {
      const a = f.attributes;
      return {
        portid: a.portid,
        name: a.portname,
        full_name: a.fullname,
        lat: a.lat,
        lon: a.lon,
        annual_vessel_count_total: a.vessel_count_total,
        annual_by_cargo_type: {
          container: a.vessel_count_container,
          dry_bulk: a.vessel_count_dry_bulk,
          general_cargo: a.vessel_count_general_cargo,
          roro: a.vessel_count_RoRo,
          tanker: a.vessel_count_tanker,
        },
        top_industries: [a.industry_top1, a.industry_top2, a.industry_top3].filter(Boolean),
        // Convenience: include the friendly-name aliases that resolve to this portid
        friendly_aliases: Object.entries(CHOKEPOINT_ALIASES)
          .filter(([, id]) => id === a.portid)
          .map(([alias]) => alias),
      };
    }),
  };
}

interface ChokepointDailyAttrs {
  date: string;
  portid: string;
  portname: string;
  n_container: number;
  n_dry_bulk: number;
  n_general_cargo: number;
  n_roro: number;
  n_tanker: number;
  n_cargo: number;
  n_total: number;
  capacity_container: number;
  capacity_dry_bulk: number;
  capacity_general_cargo: number;
  capacity_roro: number;
  capacity_tanker: number;
  capacity_cargo: number;
  capacity: number;
}

async function chokepointDailyTraffic(chokepoint: string, days: number) {
  const key = chokepoint.toLowerCase().trim();
  // Resolution order: alias map → raw portid → portname LIKE fallback.
  // The fallback rescues names not in the alias map (or if IMF re-numbers
  // chokepoints in the future) by doing a server-side LIKE on portname.
  let portid: string | null = CHOKEPOINT_ALIASES[key] ?? (/^chokepoint\d+$/.test(key) ? key : null);
  if (!portid) {
    const safe = key.replace(/'/g, "''").toUpperCase();
    const fallback = await esriQuery<{ portid: string; portname: string }>('PortWatch_chokepoints_database', {
      where: `UPPER(portname) LIKE '%${safe}%'`,
      outFields: 'portid,portname',
      resultRecordCount: '1',
    });
    portid = fallback.features?.[0]?.attributes.portid ?? null;
  }
  if (!portid) {
    return {
      found: false,
      reason: 'unknown_chokepoint',
      input: chokepoint,
      hint: `Unknown chokepoint "${chokepoint}". Pass one of: ${Object.keys(CHOKEPOINT_ALIASES).slice(0, 8).join(', ')}, or a PortWatch portid like "chokepoint1". Call chokepoints_list to enumerate the full set.`,
    };
  }
  // PortWatch ArcGIS layers can return at most 2000 rows per page; 365d
  // is well under that for a single chokepoint.
  const body = await esriQuery<ChokepointDailyAttrs>('Daily_Chokepoints_Data', {
    where: `portid='${portid}'`,
    orderByFields: 'date DESC',
    resultRecordCount: String(days),
  });
  const feats = body.features ?? [];
  if (feats.length === 0) {
    return { found: false, reason: 'no_data', portid, hint: 'PortWatch may not have populated data for this chokepoint yet.' };
  }
  const series = feats.map((f) => {
    const a = f.attributes;
    return {
      date: a.date,
      n_total: a.n_total,
      n_container: a.n_container,
      n_dry_bulk: a.n_dry_bulk,
      n_general_cargo: a.n_general_cargo,
      n_roro: a.n_roro,
      n_tanker: a.n_tanker,
      capacity_dwt: a.capacity,
    };
  });
  // Headline stats: latest day + 7d/30d averages for quick momentum read.
  const totals = series.map((s) => s.n_total);
  const last7 = totals.slice(0, Math.min(7, totals.length));
  const last30 = totals.slice(0, Math.min(30, totals.length));
  const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
  return {
    source: 'IMF PortWatch — daily vessel transits',
    portid,
    portname: feats[0].attributes.portname,
    days_returned: feats.length,
    latest: series[0],
    summary: {
      avg_vessels_7d: +avg(last7).toFixed(1),
      avg_vessels_30d: +avg(last30).toFixed(1),
      // 7d vs 30d ratio surfaces momentum: <0.85 = recent slowdown,
      // >1.15 = recent surge. Same shape as our other momentum signals.
      recent_vs_baseline_ratio: avg(last30) > 0 ? +(avg(last7) / avg(last30)).toFixed(3) : null,
    },
    series,
  };
}

interface PortAttrs {
  portid: string;
  portname: string;
  country: string;
  ISO3: string;
  continent: string;
  fullname: string;
  lat: number;
  lon: number;
  LOCODE: string;
  vessel_count_total: number;
  vessel_count_container: number;
  vessel_count_tanker: number;
  vessel_count_dry_bulk: number;
  industry_top1: string;
  industry_top2: string;
  industry_top3: string;
  share_country_maritime_import: number;
  share_country_maritime_export: number;
}

async function portSearch(query: string | undefined, country: string | undefined, limit: number) {
  const where: string[] = [];
  if (query) {
    // ArcGIS LIKE with case-insensitive — use UPPER on both sides.
    const safe = query.replace(/'/g, "''");
    where.push(`UPPER(portname) LIKE '%${safe.toUpperCase()}%'`);
  }
  if (country) {
    const safe = country.replace(/'/g, "''");
    // Try both ISO3 (3-char) and country name
    if (/^[A-Z]{3}$/i.test(country)) {
      where.push(`ISO3='${safe.toUpperCase()}'`);
    } else {
      where.push(`UPPER(country) LIKE '%${safe.toUpperCase()}%'`);
    }
  }
  const whereClause = where.length > 0 ? where.join(' AND ') : '1=1';
  const body = await esriQuery<PortAttrs>('PortWatch_ports_database', {
    where: whereClause,
    orderByFields: 'vessel_count_total DESC',
    resultRecordCount: String(limit),
  });
  const feats = body.features ?? [];
  return {
    source: 'IMF PortWatch — port reference (annual aggregates)',
    matched: feats.length,
    ports: feats.map((f) => {
      const a = f.attributes;
      return {
        portid: a.portid,
        portname: a.portname,
        full_name: a.fullname,
        country: a.country,
        iso3: a.ISO3,
        continent: a.continent,
        locode: a.LOCODE,
        lat: a.lat,
        lon: a.lon,
        annual_vessels: a.vessel_count_total,
        annual_by_cargo: {
          container: a.vessel_count_container,
          tanker: a.vessel_count_tanker,
          dry_bulk: a.vessel_count_dry_bulk,
        },
        top_industries: [a.industry_top1, a.industry_top2, a.industry_top3].filter(Boolean),
        country_maritime_import_share: a.share_country_maritime_import,
        country_maritime_export_share: a.share_country_maritime_export,
      };
    }),
  };
}

interface DisruptionAttrs {
  eventid: number;
  eventtype: string;
  eventname: string;
  htmlname: string;
  alertlevel: string;
  country: string;
  fromdate: number; // epoch ms
  todate: number;   // epoch ms
  year: number;
  severitytext: string;
  lat: number;
  long: number;
  affectedports: string;
  n_affectedports: number;
  affectedpopulation: string;
}

const ALERT_PRIORITY: Record<string, number> = { GREEN: 1, ORANGE: 2, RED: 3 };

async function recentDisruptions(
  country: string | undefined,
  alertLevel: string | undefined,
  year: number | undefined,
  limit: number,
) {
  const where: string[] = [];
  if (country) {
    const safe = country.replace(/'/g, "''");
    where.push(`UPPER(country) LIKE '%${safe.toUpperCase()}%'`);
  }
  if (year && Number.isFinite(year)) {
    where.push(`year=${Math.floor(year)}`);
  }
  // alertlevel filter applies as a minimum (RED-or-higher etc.)
  const minPri = alertLevel ? (ALERT_PRIORITY[alertLevel.toUpperCase()] ?? 1) : 0;
  const whereClause = where.length > 0 ? where.join(' AND ') : '1=1';
  const body = await esriQuery<DisruptionAttrs>('portwatch_disruptions_database', {
    where: whereClause,
    orderByFields: 'fromdate DESC',
    resultRecordCount: String(Math.min(200, limit * 3)),
  });
  let feats = body.features ?? [];
  if (minPri > 0) {
    feats = feats.filter((f) => (ALERT_PRIORITY[(f.attributes.alertlevel ?? '').toUpperCase()] ?? 0) >= minPri);
  }
  feats = feats.slice(0, limit);
  return {
    source: 'IMF PortWatch — port-affecting disruption events',
    matched: feats.length,
    disruptions: feats.map((f) => {
      const a = f.attributes;
      return {
        eventid: a.eventid,
        type: a.eventtype,
        name: a.eventname ?? a.htmlname,
        alert_level: a.alertlevel,
        country: a.country,
        from_date: a.fromdate ? new Date(a.fromdate).toISOString().slice(0, 10) : null,
        to_date: a.todate ? new Date(a.todate).toISOString().slice(0, 10) : null,
        severity: a.severitytext,
        lat: a.lat,
        lon: a.long,
        affected_ports_count: a.n_affectedports,
        affected_population: a.affectedpopulation,
      };
    }),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

function reqStr(args: Record<string, unknown>, key: string, example: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`Required argument "${key}" missing. Pass a string like ${example}.`);
  }
  return v.trim();
}

function clamp(n: number | undefined, lo: number, hi: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : lo;
  return Math.max(lo, Math.min(hi, Math.floor(v)));
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
