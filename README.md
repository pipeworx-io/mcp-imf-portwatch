# mcp-imf-portwatch

IMF PortWatch MCP — global maritime trade & chokepoint signals (free, no auth)

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1679+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `chokepoints_list` | List the 8 major maritime chokepoints PortWatch tracks (Suez, Panama, Bosphorus, Gibraltar, Dover, Malacca, Hormuz, Bab-el-Mandeb) with annual vessel counts, traffic mix by cargo type (container / dry bulk / tanker / RoRo / general), and top industries by volume. Use to discover what a chokepoint normally carries — for live daily throughput call chokepoint_daily_traffic. |
| `chokepoint_daily_traffic` | Daily vessel counts and aggregate capacity (deadweight tonnage) transiting a specific chokepoint. Returns time series ordered most-recent-first, with per-cargo-type breakdown (container / dry bulk / general cargo / RoRo / tanker). Use for "is Suez traffic back to normal after the Houthi attacks", "Hormuz throughput vs 30d average", or any bet predicated on a chokepoint disruption persisting. Accepts friendly names (suez / panama / hormuz / bab-el-mandeb / etc.) or PortWatch portid (chokepoint1..8). |
| `port_search` | Search the PortWatch port database (1,500+ ports globally) by name, country, or ISO3. Returns matching ports with country, continent, latitude/longitude, annual vessel counts by cargo type, top industries, and the port's share of the country's maritime imports/exports. Useful for identifying which ports would be affected by a country-level disruption, or finding the LOCODE / portid for a named port. |
| `recent_disruptions` | Port-affecting disruption events tracked by PortWatch — tropical cyclones, floods, earthquakes, conflict events — with start/end dates, alert level (GREEN/ORANGE/RED), severity, affected port count, and impacted population. Filter by country, alert level, or year. Use for "what disrupted shipping in the last month", "which port closures hit our supply chain", or to validate a bet on whether a current disruption is escalating. |
| `chokepoint_status` | Chokepoint traffic status for one maritime chokepoint: the most recent settled day of vessel transits scored against a trailing baseline, so an agent can tell at a glance whether shipping through that strait or canal is above, below, or at its normal run rate. Answers "is shipping through the Strait of Hormuz down", "Suez Canal transit volume this week", "Panama Canal ship counts vs normal", "maritime chokepoint disruption check", "tanker traffic anomaly at Bab el-Mandeb". Returns the latest day (total vessels, per-vessel-type counts, aggregate capacity in deadweight tonnage), data_lag_days plus a freshness_note, the baseline mean with delta / percent deviation / direction (above, below, normal), 7-day and 30-day means, the same percent deviation per vessel type (tanker, container, dry_bulk, general_cargo, roro — a tanker-only drop at Hormuz is the tradeable signal), and the min and max daily total in the window with their dates. Source is IMF PortWatch daily AIS-derived transit counts, published with a multi-day lag, so the "latest" day is the most recent settled day rather than a live count. Accepts forgiving names — "Hormuz", "Strait of Hormuz", "hormuz", "Suez", "Panama", "Bab el-Mandeb", "Malacca", "Taiwan", "Bosphorus", "Gibraltar", "Dover" — or a PortWatch portid like "chokepoint6". Examples: chokepoint_status({chokepoint: "Hormuz"}); chokepoint_status({chokepoint: "Suez Canal", baseline_days: 30}); chokepoint_status({chokepoint: "Panama"}). |
| `chokepoint_compare` | Compare chokepoint traffic status across 2 to 6 maritime chokepoints side by side and rank them by how far each one has deviated from its own trailing baseline, so an agent can spot which strait or canal is the anomalous one. Answers "which maritime chokepoint is disrupted right now", "Suez Canal transit volume vs Bab el-Mandeb", "compare Panama Canal ship counts to Hormuz", "tanker traffic anomaly across chokepoints". For each chokepoint returns the latest settled day and its total, the baseline mean over the window, the delta, the percent deviation, the direction (above, below, normal), and the per-vessel-type percent deviation; results are sorted with the largest absolute deviation first. Reports data_lag_days and a freshness_note for the whole comparison. Source is IMF PortWatch daily AIS-derived transit counts, published with a multi-day lag, so every "latest" figure is the most recent settled day rather than a live count. Names are matched forgivingly ("Hormuz", "Strait of Hormuz", "Suez", "Panama", "Bab el-Mandeb", "Malacca", "Taiwan", "Bosphorus", "Gibraltar", "Dover") or accept a portid. Examples: chokepoint_compare({chokepoints: ["Hormuz", "Suez", "Bab el-Mandeb"]}); chokepoint_compare({chokepoints: ["Suez", "Cape of Good Hope"], days: 90}); chokepoint_compare({chokepoints: ["Panama", "Suez", "Malacca", "Hormuz"], days: 14}). |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "imf-portwatch": {
      "url": "https://gateway.pipeworx.io/imf-portwatch/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/imf-portwatch/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1679+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/chokepoints_list \
  -H 'Content-Type: application/json' \
  -d '{}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/chokepoints_list`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "imf-portwatch": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-imf-portwatch"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-imf-portwatch
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Imf Portwatch data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
