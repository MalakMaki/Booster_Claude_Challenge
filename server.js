// Booster Concierge: type in a company, get a sourced profile, a fit check,
// the right person to contact and a personal email. It never sends anything.
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { fileURLToPath } from "node:url";
import path from "node:path";

import fs from "node:fs";
// .env next to this file wins over the shell, so a stale exported key can't override it.
let KEY_SOURCE = process.env.ANTHROPIC_API_KEY ? "shell environment" : "none";
try {
  const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), ".env");
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "").trim();
    if (m[1] === "ANTHROPIC_API_KEY") KEY_SOURCE = ".env file";
  }
} catch {}
const API_KEY = String(process.env.ANTHROPIC_API_KEY || "").trim().replace(/^['"]|['"]$/g, "");

const MODEL = process.env.MODEL || "claude-opus-5-5";
const PORT = Number(process.env.PORT || 3000);
const SENDER = process.env.SENDER_NAME || "Malak";
const SENDER_TITLE = process.env.SENDER_TITLE || "Partnerships, Booster";

// Use the API key only, so a stray ANTHROPIC_AUTH_TOKEN or ANTHROPIC_BASE_URL in the shell can't hijack it.
// Works with classic keys (sk-ant-api03, sent as x-api-key) and user-linked keys (sk-ant-usr, tried as a bearer token if x-api-key is refused).
const asKey = new Anthropic({ apiKey: API_KEY, authToken: null, baseURL: "https://api.anthropic.com" });
const asBearer = new Anthropic({ apiKey: null, authToken: API_KEY, baseURL: "https://api.anthropic.com" });
let client = API_KEY.startsWith("sk-ant-usr") ? asBearer : asKey;
let switched = false;
const app = express();
const here = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(here, "public")));

const BOOSTER_PUBLIC = "Booster delivers online orders from the customer's nearest London boutique within the hour, starting in central London.";
const BOOSTER = `${BOOSTER_PUBLIC}
Booster's ideal partner: a physical boutique in central London (postcode areas W1, SW1, WC, EC), premium or luxury, sells online on Shopify, products that fit in a bike bag (fashion, accessories, beauty, small goods).
Not a fit: warehouse-only or marketplace-only sellers, brands with no London store, bulky goods (furniture, large homeware).
Shopify is a strong plus (easy integration) but not required: big luxury maisons (e.g. Gucci, Chanel, Valentino) on custom platforms are still a fit if they have a central London boutique; for them, integration is a point to confirm with Booster.
Right contact: Head of E-commerce or Digital; the founder for smaller brands; Retail or Operations Director. For global maisons, aim at the UK or EMEA level (UK Managing Director, UK/EMEA E-commerce or Client Experience Director, Retail Director, or the London flagship's Store Director), not the global CEO.`;

// ---------- deterministic checks (no AI) ----------

const CENTRAL = /^(W1[A-Z]|SW1[A-Z]|WC[12][A-Z]|EC[1-4][A-Z]?)$/;
export function postcodeArea(pc = "") {
  const out = String(pc).toUpperCase().replace(/\s+/g, " ").trim().split(" ")[0];
  return { outcode: out, central: CENTRAL.test(out) };
}

async function timedFetch(url, ms = 9000, init = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, {
      redirect: "follow",
      signal: ctl.signal,
      headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36", accept: "text/html,application/json;q=0.9,*/*;q=0.8" },
      ...init,
    });
  } finally {
    clearTimeout(t);
  }
}

// Looks at the brand's own website code for Shopify fingerprints.
export async function checkShopify(website) {
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`);
  } catch {
    return { is_shopify: null, signals: ["Not a valid web address"], checked_url: website };
  }
  const signals = [];
  let status = null;
  try {
    const res = await timedFetch(url.origin + "/");
    status = res.status;
    const h = res.headers;
    if (h.get("x-shopid")) signals.push("x-shopid response header");
    if (h.get("x-shopify-stage")) signals.push("x-shopify-stage response header");
    if ((h.get("powered-by") || "").toLowerCase().includes("shopify")) signals.push("powered-by: Shopify header");
    const body = (await res.text()).slice(0, 600000);
    if (body.includes("cdn.shopify.com")) signals.push("loads assets from cdn.shopify.com");
    if (/Shopify\.(theme|shop|locale)/.test(body)) signals.push("Shopify theme script on the page");
    if (body.includes(".myshopify.com")) signals.push("references a .myshopify.com store");
  } catch (e) {
    signals.push(`Homepage could not be read (${e.name === "AbortError" ? "timed out" : "blocked"})`);
  }
  try {
    const res = await timedFetch(url.origin + "/products.json?limit=1", 7000);
    if (res.ok && (res.headers.get("content-type") || "").includes("json")) {
      const j = await res.json();
      if (Array.isArray(j.products)) signals.push("public Shopify /products.json endpoint responds");
    }
  } catch {}
  const positive = signals.filter((s) => !s.startsWith("Homepage could not"));
  return {
    is_shopify: positive.length ? true : status && status < 400 ? false : null,
    signals: signals.length ? signals : ["No Shopify fingerprints found"],
    checked_url: url.origin,
  };
}

// Public UK postcode lookup (postcodes.io) for the map.
async function geocode(pc) {
  const clean = String(pc || "").trim();
  if (!clean) return null;
  try {
    const full = await timedFetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(clean)}`, 6000);
    if (full.ok) {
      const j = await full.json();
      return { lat: j.result.latitude, lng: j.result.longitude };
    }
    const out = clean.split(/\s+/)[0];
    const o = await timedFetch(`https://api.postcodes.io/outcodes/${encodeURIComponent(out)}`, 6000);
    if (o.ok) {
      const j = await o.json();
      return { lat: j.result.latitude, lng: j.result.longitude, approx: true };
    }
  } catch {}
  return null;
}

// Receipts: does the quoted evidence really appear on the source page?
const pageCache = new Map();
function norm(t) {
  return String(t || "")
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;|&lsquo;|[\u2018\u2019]/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;|[\u201C\u201D]/g, '"').replace(/[\u2013\u2014]/g, "-")
    .toLowerCase().replace(/[^a-z0-9£$€%'"&\- ]+/g, " ").replace(/\s+/g, " ").trim();
}
async function pageText(url) {
  if (pageCache.has(url)) return pageCache.get(url);
  const p = (async () => {
    try {
      const r = await timedFetch(url, 9000);
      if (!r.ok) return null;
      return norm(await r.text());
    } catch { return null; }
  })();
  pageCache.set(url, p);
  return p;
}
export async function verifyReceipt(fact) {
  if (!fact?.source || !fact?.quote) return { status: "missing", note: "No quote or source given" };
  const page = await pageText(fact.source);
  if (page === null) return { status: "unreachable", note: "Source page blocks automated reading; open the link to check" };
  const q = norm(fact.quote);
  if (q.length < 8) return { status: "missing", note: "Quote too short to check" };
  if (page.includes(q)) return { status: "verified", note: "Quote found word for word on the page" };
  // tolerate small differences: 90% of the quote's 5-word runs must appear
  const w = q.split(" ");
  if (w.length >= 6) {
    let hit = 0, n = 0;
    for (let i = 0; i + 5 <= w.length; i++) { n++; if (page.includes(w.slice(i, i + 5).join(" "))) hit++; }
    if (hit / n >= 0.9) return { status: "verified", note: "Quote found on the page (minor formatting differences)" };
  }
  return { status: "not_found", note: "Quote not found on the page" };
}

// ---------- Claude helpers ----------

function parseJSON(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(raw);
}

let fallbacksOk = true;
// One streamed request. Reports searches, fetches and text as they happen.
async function streamOnce(params, on) {
  const run = async (useFallbacks) => {
    const req = useFallbacks
      ? client.beta.messages.stream({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
      : client.messages.stream(params);
    const blocks = {};
    for await (const ev of req) {
      if (ev.type === "content_block_start") {
        blocks[ev.index] = { type: ev.content_block.type, name: ev.content_block.name, json: "" };
      } else if (ev.type === "content_block_delta") {
        if (ev.delta.type === "input_json_delta") blocks[ev.index].json += ev.delta.partial_json;
        if (ev.delta.type === "text_delta") on.text?.(ev.delta.text);
      } else if (ev.type === "content_block_stop") {
        const b = blocks[ev.index];
        if (b?.type === "server_tool_use") {
          try {
            const input = JSON.parse(b.json || "{}");
            if (b.name === "web_search") on.event?.("search", { query: input.query });
            if (b.name === "web_fetch") on.event?.("fetch", { url: input.url });
          } catch {}
        }
      }
    }
    return req.finalMessage();
  };
  const attempt = async () => {
    if (fallbacksOk) {
      try {
        return await run(true);
      } catch (e) {
        if (e?.status === 400 && /fallback|beta/i.test(String(e.message))) {
          fallbacksOk = false;
        } else throw e;
      }
    }
    return run(false);
  };
  try {
    return await attempt();
  } catch (e) {
    if (e?.status === 401 && !switched) {
      switched = true;
      client = client === asKey ? asBearer : asKey;
      console.log(`Key refused as ${client === asKey ? "bearer token" : "x-api-key"}; retrying the other way.`);
      return attempt();
    }
    throw e;
  }
}

const SHOPIFY_TOOL = {
  name: "check_shopify",
  description:
    "Checks a website's own code for Shopify fingerprints (Shopify CDN, theme scripts, headers, /products.json). Returns {is_shopify: true|false|null, signals}. Call it once with the brand's official website.",
  input_schema: {
    type: "object",
    properties: { website: { type: "string", description: "The brand's official website, e.g. https://example.com" } },
    required: ["website"],
  },
};

const RESEARCH_PROMPT = (company) => `You are the research desk for Booster, a London start-up.
${BOOSTER}

Research the company "${company}" using web search and web fetch. Work fast: about 4 to 6 searches and 2 to 3 page fetches.
Find: what they sell and at what price point; their official website; every physical London store with its full address and postcode; how they sell online; one or two niche, recent or specific facts that would make an email feel personal (a new store, a collection, a collaboration, press coverage, founder story); and the best person to contact. Actively search for them by name: try searches like "${company} head of ecommerce", "${company} digital director", "${company} founder", "${company} linkedin". Recommend one named person with their title and the public page where you found them (company site, press article, public LinkedIn search result). Then collect the brand's published contact channels from their contact, press or stockist pages: press, wholesale or partnerships emails, store phone numbers, customer care. Only give an email or phone number exactly as it is published; never construct or guess one (no "firstname@brand.com" patterns).
Then call check_shopify with their official website.

Rules: public sources only. Every fact must carry the URL where you found it AND a verbatim quote copied exactly from that page (it will be checked by code against the live page, so copy it character for character; prefer pages you fetched). Aim for 5 to 8 facts, including the London store address(es). If you cannot source something, leave it out or mark it unknown. Never guess an email address.

Finish with ONLY a JSON object in a \`\`\`json fence, shaped exactly like this:
{
  "company": "official name",
  "website": "https://...",
  "summary": "two sentences a busy person can read in 20 seconds",
  "category": "e.g. womenswear, menswear, accessories, beauty, jewellery",
  "price_point": "e.g. luxury, premium, mid-market, with one example price if found",
  "london_stores": [{"name": "", "address": "", "postcode": "", "source": "url"}],
  "online": {"sells_online": true, "platform": "Shopify / other / unknown", "source": "url"},
  "facts": [{"fact": "short claim in your words", "quote": "the exact sentence or phrase copied word for word from the source page that proves it (10 to 30 words, no ellipses)", "source": "url"}],
  "hooks": [{"hook": "one specific, personal opening line idea", "fact_index": 0}],
  "contact": {"name": "real person's name", "title": "", "why": "why this person", "found_at": "url where the name and title appear", "linkedin": "public profile url or null", "email": "only if publicly listed, else null", "phone": "only if publicly listed, else null"},
  "channels": [{"label": "e.g. Press office, Wholesale, Partnerships, Customer care, Bruton Street store", "value": "email address or phone number exactly as published", "source": "url"}],
  "alt_contacts": [{"name": "or null", "title": "", "found_at": "url or null"}],
  "fit": {
    "verdict": "good fit | possible | not a fit",
    "reason": "one sentence",
    "checks": [
      {"criterion": "Physical store in central London", "result": "yes | no | unknown", "evidence": "", "source": "url or null"},
      {"criterion": "Premium or luxury", "result": "yes | no | unknown", "evidence": "", "source": "url or null"},
      {"criterion": "Sells online on Shopify", "result": "yes | no | unknown", "evidence": "", "source": "url or null"},
      {"criterion": "Products fit in a bike bag", "result": "yes | no | unknown", "evidence": "", "source": "url or null"},
      {"criterion": "Not marketplace or warehouse only", "result": "yes | no | unknown", "evidence": "", "source": "url or null"}
    ]
  }
}`;

async function research(company, on) {
  const messages = [{ role: "user", content: RESEARCH_PROMPT(company) }];
  const tools = [
    { type: "web_search_20260209", name: "web_search", max_uses: 6, user_location: { type: "approximate", city: "London", country: "GB", timezone: "Europe/London" } },
    { type: "web_fetch_20260209", name: "web_fetch", max_uses: 4 },
    SHOPIFY_TOOL,
  ];
  let shopify = null;
  let last;
  for (let i = 0; i < 8; i++) {
    last = await streamOnce({ model: MODEL, max_tokens: 32000, output_config: { effort: "medium" }, tools, messages }, on);
    messages.push({ role: "assistant", content: last.content });
    if (last.stop_reason === "pause_turn") continue;
    if (last.stop_reason === "tool_use") {
      const results = [];
      for (const b of last.content) {
        if (b.type !== "tool_use") continue;
        if (b.name === "check_shopify") {
          on.event?.("status", { step: "fit", message: `Checking ${b.input?.website} for Shopify` });
          shopify = await checkShopify(String(b.input?.website || ""));
          on.event?.("shopify", shopify);
          results.push({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify(shopify) });
        } else {
          results.push({ type: "tool_result", tool_use_id: b.id, content: "Unknown tool", is_error: true });
        }
      }
      messages.push({ role: "user", content: results });
      continue;
    }
    break;
  }
  if (last.stop_reason === "refusal") throw new Error("Claude declined to research this company.");
  const text = last.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const profile = parseJSON(text);
  if (!shopify && profile.website) {
    shopify = await checkShopify(profile.website);
    on.event?.("shopify", shopify);
  }
  return { profile, shopify };
}

const EMAIL_PROMPT = (p, facts, shopify) => `Write a first outreach email from ${SENDER}, ${SENDER_TITLE}, to ${p.contact?.name || "the right person"} (${p.contact?.title || "Head of E-commerce"}) at ${p.company}.

What is publicly known about Booster (the ONLY Booster facts you may state): ${BOOSTER_PUBLIC}
Anything else about Booster (fees, pricing, Shopify integration, how riders handle and package items, insurance, existing partners, results) is unconfirmed. If the email needs it, write it as a placeholder like [CONFIRM: fee per order] instead of inventing it.

Numbered facts about ${p.company}, each with a checked source (use ONLY these about them):
${facts.map((f, i) => `[${i}] ${f.fact}${f.receipt.status === "verified" ? "" : " (receipt not verified)"}`).join("\n")}
Their site runs on Shopify: ${shopify?.is_shopify === true ? "yes, checked in their website code" : "unknown"}.

How it should read: one thoughtful person writing to another. Warm, specific, unhurried. British English. No exclamation marks, no buzzwords (seamless, revolutionary, game-changing, elevate, synergy, leverage). Open with one specific, true detail about them. Paint one real customer moment that fits what they sell, tied to their own store's street if known. Say plainly what Booster does. One small, low-risk ask: a 15-minute call or a short trial on a few products. 110 to 150 words in total.

Return ONLY a \`\`\`json fence:
{"subject": "under 8 words",
 "sentences": [
   {"text": "one sentence", "kind": "greeting | fact | booster | moment | ask | signoff", "facts": [indexes of the numbered facts this sentence relies on]}
 ]}
Rules for kinds: "fact" = states anything about ${p.company} and MUST list the fact indexes it relies on. "booster" = states something about Booster. "moment" = an illustrative customer scenario, clearly hypothetical. Greeting: "Dear ${p.contact?.name ? p.contact.name.split(" ")[0] : "[Name]"},". Sign-off sentence: "${SENDER}, ${SENDER_TITLE}".`;

async function draftEmail(profile, facts, shopify) {
  const msg = await streamOnce(
    { model: MODEL, max_tokens: 6000, output_config: { effort: "low" }, messages: [{ role: "user", content: EMAIL_PROMPT(profile, facts, shopify) }] },
    {}
  );
  const out = parseJSON(msg.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
  // Gate: a claim about them ships only with a verified receipt.
  out.sentences = (out.sentences || []).map((s) => {
    const ids = (s.facts || []).filter((i) => facts[i]);
    let check = "ok";
    if (s.kind === "fact") {
      if (!ids.length) check = "no_receipt";
      else if (ids.some((i) => facts[i].receipt.status === "not_found" || facts[i].receipt.status === "missing")) check = "bad_receipt";
      else if (ids.some((i) => facts[i].receipt.status === "unreachable")) check = "unchecked";
    }
    if (s.kind === "booster" && !/\[CONFIRM/i.test(s.text) && !/within the hour|nearest/i.test(s.text)) check = "booster_unconfirmed";
    return { ...s, facts: ids, check };
  });
  return out;
}

// ---------- routes ----------

function sse(res) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  res.on("close", () => clearInterval(ping));
  return send;
}

app.get("/api/run", async (req, res) => {
  const company = String(req.query.company || "").slice(0, 120).trim();
  const send = sse(res);
  if (!company) return send("error", { message: "Type a company name first." }), res.end();
  try {
    send("status", { step: "research", message: `Researching ${company}` });
    const { profile, shopify } = await research(company, { event: send });

    send("status", { step: "summary", message: "Building the profile" });
    const stores = await Promise.all(
      (profile.london_stores || []).slice(0, 6).map(async (s) => ({ ...s, ...postcodeArea(s.postcode), geo: await geocode(s.postcode) }))
    );
    profile.london_stores = stores;

    // The Shopify check from the website itself overrides what the text research said.
    const checks = profile.fit?.checks || [];
    const shop = checks.find((c) => /shopify/i.test(c.criterion));
    if (shop && shopify?.is_shopify !== null && shopify) {
      shop.result = shopify.is_shopify ? "yes" : "custom";
      shop.evidence = shopify.is_shopify
        ? `Checked the website code directly: ${shopify.signals.join("; ")}`
        : `Checked the website code: no Shopify, so a custom platform. Still a fit; integration route is a [CONFIRM] with Booster.`;
      shop.source = shopify.checked_url;
      shop.verified = true;
    }
    const central = checks.find((c) => /central london/i.test(c.criterion));
    if (central && stores.length) {
      const hit = stores.find((s) => s.central);
      central.result = hit ? "yes" : "no";
      central.evidence = hit ? `${hit.address || hit.name} is in ${hit.outcode}, inside Booster's area` : `London stores found (${stores.map((s) => s.outcode).join(", ")}) are outside W1, SW1, WC and EC`;
      central.source = hit?.source || stores[0]?.source || null;
      central.verified = true;
    }
    send("status", { step: "receipts", message: "Checking every quote against its source page" });
    const facts = (profile.facts || []).slice(0, 10);
    await Promise.all(facts.map(async (f) => { f.receipt = await verifyReceipt(f); }));
    profile.facts = facts;
    send("profile", { profile, shopify });

    for (const c of checks) if (/shopify/i.test(c.criterion) && c.result === "no") c.result = "custom";
    const fails = checks.filter((c) => c.result === "no").length;
    if (/not a fit/i.test(profile.fit?.verdict || "") || fails >= 2) {
      send("status", { step: "email", message: "Not a fit, so no email. A good tool says no." });
      send("done", { emailed: false });
      return res.end();
    }

    send("status", { step: "email", message: `Drafting the email to ${profile.contact?.name || profile.contact?.title || "the right person"}` });
    const email = await draftEmail(profile, facts, shopify);
    send("email", email);
    send("done", { emailed: true });
  } catch (e) {
    console.error(e);
    send("error", { message: e?.status === 401 ? `The API key was rejected (${KEY_SOURCE}, ${API_KEY.slice(0, 10)}…, ${API_KEY.length} chars): ${e?.error?.error?.message || e.message}` : e?.message || "Something went wrong." });
  }
  res.end();
});

// Owner simulator: the boutique's own decision-maker reads the draft before you send it.
app.post("/api/critique", express.json({ limit: "200kb" }), async (req, res) => {
  try {
    const { email = "", company = "", contact = "", summary = "" } = req.body || {};
    const prompt = `Role-play the real recipient of this cold email: ${contact || "the Head of E-commerce"} at ${company}, a London fashion brand (${summary}).
You get dozens of pitches a week. You protect the brand's image and your clients' experience. Read the email below honestly, as that person would.

EMAIL:
"""${String(email).slice(0, 6000)}"""

Reply with ONLY a \`\`\`json fence:
{"would_reply": "yes | maybe | no",
 "first_impression": "one sentence, in the owner's voice",
 "what_works": "one short point",
 "what_puts_me_off": "one short point",
 "question_i_would_ask": "the first question you'd ask Booster",
 "one_fix": "one concrete edit that would make you more likely to reply"}`;
    const msg = await streamOnce({ model: MODEL, max_tokens: 3000, output_config: { effort: "low" }, messages: [{ role: "user", content: prompt }] }, {});
    res.json(parseJSON(msg.content.filter((b) => b.type === "text").map((b) => b.text).join("")));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e?.message || "Owner simulator failed." });
  }
});

// Find: suggest boutiques in a postcode area, each with a source link.
app.get("/api/find", async (req, res) => {
  const area = String(req.query.area || "W1").toUpperCase().slice(0, 4);
  const send = sse(res);
  try {
    send("status", { message: `Searching ${area} for boutiques` });
    const prompt = `Using web search, find 8 independent or designer fashion, accessories, jewellery or beauty boutiques with a physical store in the London ${area} postcode area that would suit Booster.
${BOOSTER}
Prefer smaller premium brands with their own website (more likely to be on Shopify and to say yes) over global maisons. Only include stores you found a public source for.
Finish with ONLY a \`\`\`json fence containing an array: [{"name": "", "street": "", "why": "one short sentence", "source": "url"}]`;
    const msg = await streamOnce(
      {
        model: MODEL, max_tokens: 16000, output_config: { effort: "low" },
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 4, user_location: { type: "approximate", city: "London", country: "GB", timezone: "Europe/London" } }],
        messages: [{ role: "user", content: prompt }],
      },
      { event: send }
    );
    const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const list = JSON.parse(fence ? fence[1] : text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));
    send("found", { area, list });
  } catch (e) {
    console.error(e);
    send("error", { message: e?.message || "Search failed." });
  }
  res.end();
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(`API key from ${KEY_SOURCE}: ${API_KEY ? API_KEY.slice(0, 10) + "…" + API_KEY.slice(-4) + " (" + API_KEY.length + " chars)" : "missing"}`);
  if (!API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set. Put ANTHROPIC_API_KEY=sk-ant-... in a .env file here, or run: ANTHROPIC_API_KEY=sk-ant-... npm start");
    process.exit(1);
  }
  app.listen(PORT, () => console.log(`Booster Concierge running at http://localhost:${PORT}`));
}
