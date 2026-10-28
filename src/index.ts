#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(here, "..", "package.json"), "utf8"),
) as { version: string; name: string };

// Distinctive UA so Apify run meta.userAgent marks MCP-originated runs.
const USER_AGENT = `mambalabs-mcp ${pkg.name}@${pkg.version}`;

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

// Drop undefined values so optional inputs are not sent to the actor.
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// How long the actor run itself is allowed to take, in seconds. One value for
// every Mamba Labs wrapper, set 2026-10-05.
const ACTOR_RUN_TIMEOUT_SECS = 1800;

// How long this wrapper waits for that run, in milliseconds. The actor's own
// timeout plus two minutes, so the run's own TIMED-OUT status is what the
// caller sees rather than the wrapper giving up first and reporting nothing.
const WRAPPER_WAIT_MS = (ACTOR_RUN_TIMEOUT_SECS + 120) * 1000;
const POLL_INTERVAL_MS = 3000;

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED", "ABORTING"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Shared caller. actorPath is the actor's immutable Apify actor ID (a stable key
// that survives Store renames). The /v2/acts/{id} endpoint accepts it directly,
// so a Store rename never breaks these calls.
//
// START AND POLL, NOT RUN-SYNC. Apify's synchronous endpoints carry a platform
// ceiling of 300 seconds on the HTTP wait itself and answer 408 past it whatever
// the timeout parameter says, so a long run reads as a timeout even though the
// actor goes on to finish. Starting the run, polling it to a terminal status and
// then reading the dataset is the only way to wait as long as the actor needs.
//
// The token is read here rather than at module load, so the tool registers
// unconditionally and a server started without APIFY_TOKEN still advertises its
// capabilities instead of reporting none.
async function runActor(
  actorPath: string,
  actorLabel: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const APIFY_TOKEN = process.env.APIFY_TOKEN;
  if (!APIFY_TOKEN) {
    return { isError: true, content: [{ type: "text", text: "APIFY_TOKEN is not set. Create a token at https://console.apify.com/account/integrations and set it as the APIFY_TOKEN environment variable." }] };
  }

  const headers = {
    Authorization: `Bearer ${APIFY_TOKEN}`,
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };

  const httpError = async (response: Response): Promise<string> => {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = ` ${body.error.message}`;
    } catch {
      detail = "";
    }
    switch (response.status) {
      case 400:
        return `The ${actorLabel} run was rejected as invalid input.${detail}`;
      case 401:
        return "Invalid Apify token. Check your APIFY_TOKEN environment variable.";
      case 402:
        return "Insufficient Apify credits. Check your account balance at https://console.apify.com/billing";
      default:
        return `Apify request to ${actorLabel} failed with status ${response.status}.${detail}`;
    }
  };

  // 1. Start the run.
  let started: Response;
  try {
    started = await fetch(
      `https://api.apify.com/v2/acts/${actorPath}/runs?timeout=${ACTOR_RUN_TIMEOUT_SECS}`,
      { method: "POST", headers, body: JSON.stringify(input) },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not reach the Apify API: ${message}` }] };
  }
  if (!started.ok) {
    return { isError: true, content: [{ type: "text", text: await httpError(started) }] };
  }

  let run: { id?: string; status?: string; defaultDatasetId?: string };
  try {
    run = ((await started.json()) as { data?: typeof run }).data ?? {};
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run start returned a response that could not be parsed: ${message}` }] };
  }
  const runId = run.id;
  if (!runId) {
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run start returned no run id, so there is nothing to wait for.` }] };
  }

  // 2. Poll to a terminal status.
  const deadline = Date.now() + WRAPPER_WAIT_MS;
  let status = run.status ?? "READY";
  let datasetId = run.defaultDatasetId;
  while (!TERMINAL.has(status)) {
    if (Date.now() >= deadline) {
      return {
        isError: true,
        content: [{ type: "text", text: `The ${actorLabel} run ${runId} was still ${status} after ${Math.round(WRAPPER_WAIT_MS / 1000)} seconds and this call stopped waiting. The run itself is still on Apify: read it at https://console.apify.com/actors/runs/${runId}` }],
      };
    }
    await sleep(POLL_INTERVAL_MS);
    let poll: Response;
    try {
      poll = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, { headers });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text", text: `Lost contact with the Apify API while waiting for ${actorLabel} run ${runId}: ${message}` }] };
    }
    if (!poll.ok) {
      return { isError: true, content: [{ type: "text", text: await httpError(poll) }] };
    }
    const body = (await poll.json()) as { data?: { status?: string; defaultDatasetId?: string } };
    status = body.data?.status ?? status;
    datasetId = body.data?.defaultDatasetId ?? datasetId;
  }

  // 3. A run that did not succeed is a failure the caller must see, never an
  // empty success. Surfacing it here is what keeps a crashed run from reading
  // as "no results found".
  if (status !== "SUCCEEDED") {
    return {
      isError: true,
      content: [{ type: "text", text: `The ${actorLabel} run did not succeed (run ID: ${runId}, status: ${status}).` }],
    };
  }
  if (!datasetId) {
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run ${runId} succeeded but reported no dataset, so there is nothing to return.` }] };
  }

  // 4. Read the dataset.
  let ds: Response;
  try {
    ds = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?format=json`, { headers });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not read the ${actorLabel} dataset: ${message}` }] };
  }
  if (!ds.ok) {
    return { isError: true, content: [{ type: "text", text: await httpError(ds) }] };
  }

  let items: unknown;
  try {
    items = await ds.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run returned a response that could not be parsed: ${message}` }] };
  }

  if (!Array.isArray(items)) {
    const asObj = items as { error?: { type?: string; message?: string } };
    const detail = asObj?.error?.message
      ? `${asObj.error.message}`
      : JSON.stringify(items);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run did not return a dataset. ${detail}` }] };
  }

  return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
}

const server = new McpServer({
  name: "mamba-ats-jobs-feed",
  version: pkg.version,
});

// ATS Jobs Feed (immutable actor ID izP0rfIgf5YaRZfIh). Every buyer facing input of the actor
// is exposed. The actor takes numbers and booleans as strings, so those inputs are strings here too.
server.registerTool(
  "list_company_ats_jobs",
  {
    title: "List open jobs from company ATS boards",
    description:
      "List every open job for a list of companies, read from their own applicant tracking system boards: Greenhouse, Lever, Ashby, Workday, Workable, SmartRecruiters, Personio, Recruitee, Rippling, Oracle Recruiting, SuccessFactors, Teamtailor, BambooHR, ADP, UKG, Paylocity, and Breezy. Give companies as domains (stripe.com) or board URLs (https://jobs.lever.co/palantir). The board is found from the company site or by name, and a board that names another employer is rejected. Returns one row per job (title, department, location, remote flag, posting date, link, company domain) plus one free company row per company with the board found and job counts, or why no board was read. Optional filters on title, location, department, remote, and posting age; optional descriptions; only_new with a state_key returns only jobs not seen on the last run. A run that does not succeed is returned as an error with its run ID. Read-only; requires an APIFY_TOKEN; Apify charges per job row returned and once per run start; company rows are free.",
    annotations: {
      title: "List open jobs from company ATS boards",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      companies: z.array(z.string()).optional().describe("One per line: a company domain (stripe.com), a homepage or careers page URL, or a job board URL (https://jobs.lever.co/palantir, https://job-boards.greenhouse.io/stripe, https://jobs.ashbyhq.com/linear, https://workday.wd5.myworkdayjobs.com/Workday). To tie a board URL to a domain, join them with an equals sign: gusto.com=https://job-boards.greenhouse.io/gusto. Up to 500 per run"),
      title_keywords: z.array(z.string()).optional().describe("Optional. Return only jobs whose title contains one of these words or phrases, matched as whole words and ignoring case, for example account executive, sales, engineer"),
      exclude_title_keywords: z.array(z.string()).optional().describe("Optional. Drop jobs whose title contains one of these words or phrases, for example intern"),
      locations: z.array(z.string()).optional().describe("Optional. Return only jobs whose location text contains one of these, ignoring case, for example new york, london, germany. The word remote matches remote jobs"),
      departments: z.array(z.string()).optional().describe("Optional. Return only jobs whose department or team contains one of these, ignoring case. Boards that publish no department return nothing under this filter"),
      remote_only: z.enum(["false", "true"]).optional().describe("true returns only jobs the board marks remote or whose location says remote"),
      posted_within_days: z.string().optional().describe("Optional. Return only jobs posted in the last N days. Jobs with no posting date are left out when this is set. Workday shows 30+ days for older postings, so those count as 30 days old"),
      max_jobs_per_company: z.string().optional().describe("Job rows returned per company, newest first, after the filters. Default 1000, up to 5000. The whole board is read either way, up to 5,000 postings"),
      include_description: z.enum(["false", "true"]).optional().describe("true adds the job description as plain text, up to 20,000 characters, for the jobs returned. No extra charge. Runs take longer on Workday boards, which need one read per job"),
      only_new: z.enum(["false", "true"]).optional().describe("true returns only jobs that were not on the board at the last run with the same state key. The first run returns every matching job and records the board"),
      state_key: z.string().optional().describe("Names the saved state for only new jobs. Use one key per schedule, for example sales-accounts-daily"),
      reset_state: z.enum(["false", "true"]).optional().describe("true forgets the saved state for this state key and treats every board as a first run"),
      platforms: z.array(z.string()).optional().describe("Optional. Limit board discovery to these: greenhouse, lever, ashby, workday, workable, smartrecruiters, personio, recruitee, rippling, oracle_hcm, successfactors, teamtailor, bamboohr, adp, ukg, paylocity, breezy. Empty means all"),
      max_charge_usd: z.string().optional().describe("Optional. The run stops before it would charge more than this"),
    },
  },
  async (args) => runActor("izP0rfIgf5YaRZfIh", "ATS Jobs Feed", compact(args as Record<string, unknown>)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
