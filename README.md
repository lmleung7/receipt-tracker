# Receipt Tracker

Two pieces, no credentials in this repo:

1. **Claude skill** (`skill/SKILL.md`) — turns a photo of a receipt into a structured JSON record and saves it to Google Drive.
2. **Google Apps Script web app** (`apps-script/`) — reads those JSON records straight out of Drive and gives you search + summary, no spreadsheet needed.

## How it fits together

```
receipt photo → Claude (skill) → JSON → Drive folder
                                           │
                                           ▼
                                  Apps Script web app
                                  (lookup + summaries)
```

Drive folder layout the skill writes to, and the app reads from:

```
<root>/receipt-tracker/<shop>/<purchase-date>/receipt_<date>.json
```

## JSON schema

Every record uses these top-level keys — the app depends on this shape:

```json
{
  "shop": "Sainsbury's",
  "store_location": "Wickham High Street",
  "purchase_date": "2025-06-13",
  "purchase_time": "14:03:43",
  "receipt_id": "4894-52130-R67",
  "items": [
    { "name": "...", "unit_price": 2.00, "qty": 2, "line_total": 4.00, "discount": 0, "net_total": 4.00, "status": "active" }
  ],
  "summary": {
    "gross_total": 0,
    "total_discount": -4.95,
    "balance_due": 17.80,
    "payment_method": "Gift Card",
    "loyalty_points_earned": 17,
    "loyalty_points_balance": 9390
  },
  "processed_at": "2025-06-13T14:10:00Z"
}
```

Cancelled/discounted items stay in `items` (never deleted) — see `skill/SKILL.md` for the full extraction rules.

## Setup

### 1. Install the Claude skill
Copy `skill/SKILL.md` into your Claude skills folder (or upload it as a project skill). Nothing to configure — it just needs Google Drive tool access to upload files.

### 2. Deploy the Apps Script app
1. Go to [script.google.com](https://script.google.com) → New project.
2. Paste `apps-script/Code.gs` and `apps-script/Index.html` in, and set the manifest from `apps-script/appsscript.json` (Project Settings → "Show appsscript.json").
3. In the script editor: **Project Settings → Script Properties** → add a property `ROOT_FOLDER_ID` set to the Drive folder ID that contains your `receipt-tracker` folder. (This is *your* ID — don't commit it anywhere.)
4. **Deploy → New deployment → Web app.** Execute as "Me", access to "Only myself" (or your household, if shared).
5. Open the deployed URL — it lists shops, lets you filter by date/shop, and shows total spend.

No API keys or secrets are needed: Apps Script runs under your own Google account and authorizes Drive access via the standard OAuth consent screen the first time you deploy.

## What the app gives you
- Search by shop, date range, or item name
- Running total spend and per-shop breakdown
- Flags any receipt where `sum(net_total)` doesn't match `summary.balance_due`

## Security notes
- No credentials, tokens, or folder/sheet IDs are stored in this repo.
- `ROOT_FOLDER_ID` lives only in your own Script Properties, never in code.
- The web app defaults to private ("Only myself") access on deploy — change deliberately if you want to share it.
