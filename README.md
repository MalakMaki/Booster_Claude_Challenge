# Booster Concierge

**Type in a brand. Get a sourced profile, a fit check, the right person and a personal email, where every claim has a receipt.**

Built for the Claude × Booster pitch competition (Claude Builder Club, UCL).

## What it does

1. **Research live.** Claude uses web search and web fetch to research the brand. You watch every search and every page it reads in the live trail.
2. **Summarise.** A one-minute profile: what they sell, price point, London stores, website, who to contact and where that name was found.
3. **Check the fit, with code, not vibes.**
   - **Shopify:** the server reads the brand's own website code and looks for Shopify fingerprints (`cdn.shopify.com`, theme scripts, headers, `/products.json`).
   - **Central London:** every store postcode is checked against W1, SW1, WC and EC.
   - **A good tool says no.** If the brand fails the fit, no email is written.
4. **Receipts.** Every fact comes with a verbatim quote from its source page. The server fetches that page and checks the quote really appears on it.
5. **Draft the email.** Claude writes it sentence by sentence and tags each claim with the facts it relies on. Click any sentence to see its receipt.
   - A claim with no receipt, or a failed receipt, is **blocked**. You can't copy the email until it's removed.
   - Anything about Booster beyond what's public ("delivers from the nearest boutique within the hour, central London") appears as a **[CONFIRM]** placeholder, never invented.
6. **Hand it over.** Copy and send it yourself. It never sends anything.

## Run it

Needs Node 18 or newer and an Anthropic API key.

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start
# open http://localhost:3000
```

Windows PowerShell: `$env:ANTHROPIC_API_KEY="sk-ant-..."; npm start`

Optional: `MODEL` (default `claude-opus-5-5`), `SENDER_NAME`, `SENDER_TITLE`, `PORT`.

## How it's built

- `server.js`: Express server. Claude API (`@anthropic-ai/sdk`) with the `web_search` and `web_fetch` server tools plus a custom `check_shopify` tool that runs our own code. Results stream to the page over Server-Sent Events.
- `public/index.html`: the whole interface, no build step.
- Postcode lookups for stores use the public postcodes.io API.

## Rules we hold ourselves to

- **Public sources only.** Every fact links to where it was found.
- **No made-up facts.** If it can't be sourced, it stays out, and the code enforces it.
- **Human in the loop.** Nothing is sent automatically.
