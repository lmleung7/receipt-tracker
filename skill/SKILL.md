---
name: "receipt-tracker"
description: "Use this skill whenever a receipt image is uploaded and the user wants it interpreted, recorded, and/or stored. Triggers include: uploading a receipt photo, 'log my receipt', 'save this receipt', 'record this purchase', 'store in Drive', 'archive this receipt', or similar. Extracts the purchase into a structured JSON record and saves it to Google Drive."
---

# Receipt Tracker Skill

## Overview
Given an uploaded receipt image, this skill:
1. Interprets the full purchase history from the image
2. Cleans and consolidates the data (cancellations, discounts)
3. Converts it into a structured JSON record
4. Uploads the JSON to Google Drive under `<root>/receipt-tracker/<shop>/<purchase-date>/`
5. Confirms back to the user with a summary table and reconciliation check

The user's own tooling reads these JSON files directly (a Google Apps Script web app over the Drive folder) — there is no separate Sheet to update.

## Step 1 — Interpret the Receipt Image

Extract:
- **Shop name** (e.g. "Sainsbury's")
- **Store location/address**
- **Purchase date** (format `YYYY-MM-DD`)
- **Purchase time** if available
- **All line items**: name, unit price, quantity, line total
- **Cancelled items**: include them, marked `"status": "cancelled"`, with `0` net contribution to totals — do not fold into active item quantities, and do not show them as deletable/invisible; they exist in the JSON for audit
- **Discounts/promotions**: attach inline to the relevant item's `discount` field (negative number) — never as a separate line item
- **Receipt-level totals**: balance due, total savings, payment method
- **Loyalty info** if present (e.g. Nectar points)

### Cancellation handling rule
If an item appears, then "ITEM CANCELLED", then potentially reappears:
- Each distinct line (including cancelled ones) becomes its own JSON object with `"status": "active"` or `"status": "cancelled"`
- Cancelled items have `"line_total": 0` and `"net_total": 0`, but original price/qty stay recorded for audit
- Sum only `status: "active"` items when reconciling against `balance_due`

## Step 2 — Build JSON

### Required field names — never deviate
Every receipt/invoice/booking JSON, from any source (uploaded photo, Gmail scan, bill, booking confirmation), uses these exact top-level keys. Do not substitute a synonym, shorter form, or camelCase — this applies identically no matter which document type or merchant triggered the extraction:

| Required key | Never use instead |
|---|---|
| `purchase_date` (`YYYY-MM-DD`) | `date`, `purchaseDate`, `purchase-date` |
| `shop` | `merchant`, `store`, `vendor` |
| `store_location` | `store`, `location`, `address` |
| `receipt_id` | `id`, `order_id`, `reference` |
| `items` | — |
| `summary.balance_due` | `total`, `total_due`, `amount` |
| `processed_at` | `timestamp`, `created_at` |

Before saving, check the built object has `purchase_date` as a top-level key holding an ISO `YYYY-MM-DD` string. If it's missing or under any other key, that's a bug in the extraction — fix it, don't save a variant schema. One schema, no exceptions, regardless of document type.

Schema:

```json
{
  "shop": "Sainsbury's",
  "store_location": "Wickham High Street",
  "purchase_date": "2025-06-13",
  "purchase_time": "14:03:43",
  "receipt_id": "4894-52130-R67",
  "items": [
    {
      "name": "Amour Sugar Waffles",
      "unit_price": 2.00,
      "qty": 2,
      "line_total": 4.00,
      "discount": 0,
      "net_total": 4.00,
      "status": "active"
    },
    {
      "name": "TTD Strawberries 400g",
      "unit_price": 4.50,
      "qty": 2,
      "line_total": 9.00,
      "discount": -3.50,
      "net_total": 5.50,
      "status": "active"
    },
    {
      "name": "SO Skimmed Milk 2.272L",
      "unit_price": 2.65,
      "qty": 1,
      "line_total": 2.65,
      "discount": 0,
      "net_total": 0,
      "status": "cancelled"
    }
  ],
  "summary": {
    "gross_total": 0,
    "total_discount": -4.95,
    "balance_due": 17.80,
    "payment_method": "Gift Card",
    "loyalty_points_earned": 17,
    "loyalty_points_balance": 9390
  },
  "source_image": "<original filename, for reference only — image itself is not uploaded, see note below>",
  "processed_at": "<ISO timestamp of processing>"
}
```

Notes:
- `gross_total` = sum of `line_total` for active items only
- Reconcile: `sum(net_total for active items) == balance_due`. If mismatch, add a `"reconciliation_warning"` field explaining the gap.
- Use the receipt's actual date/time/ID, never placeholders.

Save locally first:
```python
import json
from datetime import datetime, timezone

receipt_data = { ... }  # built from extraction above
receipt_data["processed_at"] = datetime.now(timezone.utc).isoformat()

with open('/home/claude/receipt.json', 'w') as f:
    json.dump(receipt_data, f, indent=2)
```

Validate before uploading: `sum(item['net_total'] for item in items if item['status']=='active') == summary['balance_due']`.

## Step 3 — Upload JSON to Google Drive

### Folder structure
`<root>/receipt-tracker/<shop>/<purchase-date>/`

Example: `receipt-tracker/Sainsburys/2025-06-13/`

Sanitize shop name for folder use (remove apostrophes/special chars, e.g. `Sainsbury's` → `Sainsburys`).

### Steps
1. Use `tool_search` to load Google Drive tools if not already loaded.
2. **Check/create folder chain**: search for `receipt-tracker` folder in root; if missing, create it. Then check/create `<shop>` subfolder inside it, then `<purchase-date>` subfolder inside that.
   - `Google Drive:search_files` with a query like `title = '<name>' and mimeType = 'application/vnd.google-apps.folder' and parentId = '<parent_id>'`
   - `Google Drive:create_file` with `contentMimeType: application/vnd.google-apps.folder` and `parentId: <parent_folder_id>` to create missing folders
3. **Upload the JSON only** as `receipt_<date>.json` into the date folder, with `contentMimeType: application/json` and `disableConversionToGoogleType: true`.
4. Confirm the file ID is returned successfully.

### Note on the original image — do not upload it
The Drive `create_file` tool only accepts base64-encoded content. Encoding a
photo this way burns a large amount of context/tokens for little benefit
versus the user just dragging the file into Drive themselves (near-instant,
full fidelity, zero token cost). So:
- Never base64-encode and upload the receipt image to Drive.
- Use `present_files` to make the image available for the user to download
  and save/upload manually if they want it archived there too.
- Only the JSON (small, text, cheap) goes through the Drive API.

If folder creation or upload requires user approval (OAuth consent), tell the user explicitly and pause rather than retrying silently.

## Step 4 — Confirm to User

Report back:
- Summary table of items (active only, consolidated discounts/cancellations) in chat
- Drive folder path the JSON was saved to
- Any reconciliation warning if totals didn't match
- Note that the original image is available to download but wasn't auto-uploaded to Drive (token-cost tradeoff), and that dragging it in manually is an option

## Error Handling
- If Drive upload fails (auth/approval issue), tell the user directly — don't pretend it succeeded. If it's an OAuth/credential error, surface it via `suggest_connectors` so they can re-authenticate.
- If OCR/interpretation is uncertain on any field, flag it rather than guessing silently (e.g. "shop name unclear, assumed Sainsbury's based on header").
- If the receipt total doesn't reconcile after accounting for all cancellations and discounts, show the discrepancy to the user rather than silently rounding or guessing.