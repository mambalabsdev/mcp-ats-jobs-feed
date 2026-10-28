# ATS Jobs Feed MCP Server

[![Smithery](https://smithery.ai/badge/mambabuilt/mcp-ats-jobs-feed)](https://smithery.ai/servers/mambabuilt/mcp-ats-jobs-feed) [![Glama score](https://glama.ai/mcp/servers/mambalabsdev/mcp-ats-jobs-feed/badges/score.svg)](https://glama.ai/mcp/servers/mambalabsdev/mcp-ats-jobs-feed) [![MCP Registry](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fregistry.modelcontextprotocol.io%2Fv0%2Fservers%3Fsearch%3Dcom.mambabuilt%252Fmcp-ats-jobs-feed%26limit%3D1&query=%24.servers%5B0%5D._meta%5B%22io.modelcontextprotocol.registry%2Fofficial%22%5D.status&label=mcp%20registry&color=blue)](https://registry.modelcontextprotocol.io/v0/servers?search=com.mambabuilt/mcp-ats-jobs-feed&limit=1) [![npm version](https://img.shields.io/npm/v/@mambalabsdev/mcp-ats-jobs-feed)](https://www.npmjs.com/package/@mambalabsdev/mcp-ats-jobs-feed) [![npm downloads](https://img.shields.io/npm/dm/@mambalabsdev/mcp-ats-jobs-feed)](https://www.npmjs.com/package/@mambalabsdev/mcp-ats-jobs-feed) [![license](https://img.shields.io/github/license/mambalabsdev/mcp-ats-jobs-feed)](https://github.com/mambalabsdev/mcp-ats-jobs-feed/blob/main/LICENSE) [![mcpservers.org](https://img.shields.io/badge/mcpservers.org-listed-blue)](https://mcpservers.org/servers/mambalabsdev/mcp-ats-jobs-feed)

An MCP server for the Mamba Labs ATS Jobs Feed actor on Apify. Give it company domains or job board URLs. It returns every open job on each company's own ATS board, one row per job with the company domain.

## What's Inside

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Prerequisites](#prerequisites)
- [Example prompts](#example-prompts)
- [Tool](#tool)
- [Inputs](#inputs)
- [Pricing](#pricing)
- [Your keys](#your-keys)
- [Full actor documentation](#full-actor-documentation)
- [License](#license)

## What it does

- **Boards**: Greenhouse, Lever, Ashby, Workday, Workable, SmartRecruiters, Personio, Recruitee, Rippling, Oracle Recruiting, SuccessFactors, Teamtailor, BambooHR, ADP, UKG, Paylocity, and Breezy, read through their public job board APIs and careers sites.
- **Discovery**: a domain is matched to its board through the ATS link on the company site, then by the company name as a board name; a board that names another employer is rejected.
- **Rows**: one `job` row per open job and one free `company` row per company with `jobs_on_board`, `jobs_matched`, and `jobs_returned`, or `row_status` `no_board` and the reason.
- **Filters and schedules**: title keywords, excluded words, locations, departments, remote only, posted within N days, and `only_new` with a `state_key`.

All of the work runs on Apify. This package is a thin client that starts the actor run, waits for it, and hands back the dataset rows.

## Quick start

You need Node.js 18 or newer and an Apify account with an API token.

Add this to your Claude Desktop config (`claude_desktop_config.json`), Cursor, or any MCP client:

```json
{
  "mcpServers": {
    "mamba-ats-jobs-feed": {
      "command": "npx",
      "args": [
        "-y",
        "@mambalabsdev/mcp-ats-jobs-feed"
      ],
      "env": {
        "APIFY_TOKEN": "your-apify-token"
      }
    }
  }
}
```

Restart the client. The `list_company_ats_jobs` tool appears.

## Prerequisites

- Node.js 18 or newer.
- An Apify API token from [console.apify.com/account/integrations](https://console.apify.com/account/integrations), set as `APIFY_TOKEN`. The server lists its tool without a token; a call needs one.

## Example prompts

- "List the open account executive and SDR roles at stripe.com, linear.app, and notion.so."
- "Which of these 30 target accounts posted a remote sales job in the last 14 days?"
- "Every day, tell me which new jobs appeared on Gusto's and Figma's boards."

## Tool

`list_company_ats_jobs`. One tool. Example arguments:

```json
{
  "companies": [
    "linear.app",
    "notion.so"
  ],
  "title_keywords": [
    "account executive"
  ]
}
```

## Inputs

Every buyer facing input of the actor, unchanged. Omitted inputs take the actor's own defaults. Numbers and booleans are sent as strings.

| Input | Type | Description |
|---|---|---|
| `companies` | array | One per line: a company domain (stripe.com), a homepage or careers page URL, or a job board URL (https://jobs.lever.co/palantir, https://job-boards.greenhouse.io/stripe, https://jobs.ashbyhq.com/linear, https://workday.wd5.myworkdayjobs.com/Workday). To tie a board URL to a domain, join them with an equals sign: gusto.com=https://job-boards.greenhouse.io/gusto. Up to 500 per run |
| `title_keywords` | array | Optional. Return only jobs whose title contains one of these words or phrases, matched as whole words and ignoring case, for example account executive, sales, engineer |
| `exclude_title_keywords` | array | Optional. Drop jobs whose title contains one of these words or phrases, for example intern |
| `locations` | array | Optional. Return only jobs whose location text contains one of these, ignoring case, for example new york, london, germany. The word remote matches remote jobs |
| `departments` | array | Optional. Return only jobs whose department or team contains one of these, ignoring case. Boards that publish no department return nothing under this filter |
| `remote_only` | string | true returns only jobs the board marks remote or whose location says remote |
| `posted_within_days` | string | Optional. Return only jobs posted in the last N days. Jobs with no posting date are left out when this is set. Workday shows 30+ days for older postings, so those count as 30 days old |
| `max_jobs_per_company` | string | Job rows returned per company, newest first, after the filters. Default 1000, up to 5000. The whole board is read either way, up to 5,000 postings |
| `include_description` | string | true adds the job description as plain text, up to 20,000 characters, for the jobs returned. No extra charge. Runs take longer on Workday boards, which need one read per job |
| `only_new` | string | true returns only jobs that were not on the board at the last run with the same state key. The first run returns every matching job and records the board |
| `state_key` | string | Names the saved state for only new jobs. Use one key per schedule, for example sales-accounts-daily |
| `reset_state` | string | true forgets the saved state for this state key and treats every board as a first run |
| `platforms` | array | Optional. Limit board discovery to these: greenhouse, lever, ashby, workday, workable, smartrecruiters, personio, recruitee, rippling, oracle_hcm, successfactors, teamtailor, bamboohr, adp, ukg, paylocity, breezy. Empty means all |
| `max_charge_usd` | string | Optional. The run stops before it would charge more than this |

## Pricing

Pay per event on Apify, billed to your Apify account. Prices in USD.

| Event | Free plan | Bronze | Silver | Gold |
|---|---|---|---|---|
| `job-row`, one open job returned after your filters | $0.002 | $0.0019 | $0.0018 | $0.0017 |
| `apify-actor-start`, per run start | $0.001 | $0.001 | $0.001 | $0.001 |

Company rows, rows for a company with no board found, and the row for a refused input are free.

## Your keys

The actor needs no key. It reads public job board APIs and public careers pages and holds no key of any kind. Mamba Labs pays the platform costs of the run.

## Full actor documentation

[apify.com/mambalabs/ats-jobs-feed](https://apify.com/mambalabs/ats-jobs-feed)

## License

MIT. See [LICENSE](LICENSE).
