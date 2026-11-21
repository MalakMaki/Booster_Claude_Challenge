# Booster Concierge

**Type in a brand. Get a sourced profile, a fit check, the right person and a personal email, where every claim has a receipt.**

Built for the Claude × Booster pitch competition (Claude Builder Club, UCL).

## What it does

1. **Research live.** Claude uses web search and web fetch to research the brand. You watch every search and every page it reads in the live trail.
2. **Summarise and find the person.** A one-minute profile: what they sell, price point and London stores. It recommends a **named contact** (Head of E-commerce or Digital, the founder for smaller brands, or the UK/EMEA director or London flagship's Store Director for big maisons) with where they were found and their public LinkedIn. It also lists the brand's **published** emails and phone numbers (press, wholesale, partnerships, stores), each with its source. It never guesses an email address.
3. **Check the fit, with code, not vibes.**
   - **Shopify:** the server reads the brand's own website code and looks for Shopify fingerprints (`cdn.shopify.com`, theme scripts, headers, `/products.json`). Shopify is a plus, not a requirement: maisons like Gucci, Chanel or Valentino on custom platforms still pass, with integration marked [CONFIRM].
   - **Central London:** every store postcode is checked against W1, SW1, WC and EC.
   - **A good tool says no.** If the brand fails the fit, no email is written.
4. **Receipts.** Every fact comes with a verbatim quote from its source page. The server fetches that page and checks the quote really appears on it.
5. **Draft the email.** Claude writes it sentence by sentence and tags each claim with the facts it relies on. Click any sentence to see its receipt.
   - A claim with no receipt, or a failed receipt, is **blocked**. You can't copy the email until it's removed.
   - Anything about Booster beyond what's public ("delivers from the nearest boutique within the hour, central London") appears as a **[CONFIRM]** placeholder, never invented.
6. **Owner simulator.** One click and the recipient "reads" your draft first: would they reply, what works, what puts them off, the first question they'd ask Booster, and one fix.
7. **Hand it over.** Copy and send it yourself. It never sends anything.

## Run it

Needs Node 18 or newer and an Anthropic API key (the secret starting `sk-ant-`, not the key ID).

```bash
npm install
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env
npm start
# open http://localhost:3000
```

The first line in the terminal shows which key was loaded and from where. A `.env` file wins over a key already set in your shell.

Optional: `MODEL` (default `claude-opus-5-5`), `SENDER_NAME`, `SENDER_TITLE`, `PORT`.

## How it's built

- `server.js`: Express server. Claude API (`@anthropic-ai/sdk`) with the `web_search` and `web_fetch` server tools plus a custom `check_shopify` tool that runs our own code. Results stream to the page over Server-Sent Events.
- `public/index.html`: the whole interface, no build step.
- `pitch-deck.pdf`: the pitch.
- Postcode lookups for stores use the public postcodes.io API.

## Rules we hold ourselves to

- **Public sources only.** Every fact links to where it was found.
- **No made-up facts.** If it can't be sourced, it stays out, and the code enforces it.
- **Human in the loop.** Nothing is sent automatically.
