/**
 * Receipt Tracker — Apps Script backend
 *
 * Reads receipt JSON files out of a Drive folder tree:
 *   <ROOT_FOLDER_ID>/receipt-tracker/<shop>/<purchase-date>/*.json
 *
 * No credentials are stored in this file. Set ROOT_FOLDER_ID as a
 * Script Property (Project Settings → Script Properties) — never hardcode it here.
 */

const CACHE_KEY = 'ALL_RECEIPTS_V1';
const CACHE_SECONDS = 300; // 5 min — receipts don't change that often

function getRootFolderId_() {
  const id = PropertiesService.getScriptProperties().getProperty('ROOT_FOLDER_ID');
  if (!id) {
    throw new Error(
      'ROOT_FOLDER_ID is not set. Go to Project Settings → Script Properties and add it.'
    );
  }
  return id;
}

/** Serves the web app UI. */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Receipt Tracker')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * Walks <root>/receipt-tracker/<shop>/<date>/*.json and returns
 * an array of parsed receipt objects, each tagged with its Drive file id.
 */
function loadAllReceipts_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(CACHE_KEY);
  if (cached) return JSON.parse(cached);

  const root = DriveApp.getFolderById(getRootFolderId_());
  const trackerFolders = root.getFoldersByName('receipt-tracker');
  const receipts = [];

  if (trackerFolders.hasNext()) {
    const trackerRoot = trackerFolders.next();
    const shopFolders = trackerRoot.getFolders();
    while (shopFolders.hasNext()) {
      const shopFolder = shopFolders.next();
      const dateFolders = shopFolder.getFolders();
      while (dateFolders.hasNext()) {
        const dateFolder = dateFolders.next();
        const files = dateFolder.getFilesByType(MimeType.PLAIN_TEXT);
        // JSON uploaded with contentMimeType application/json can land as
        // PLAIN_TEXT or its own type depending on upload path — check both.
        const jsonFiles = dateFolder.getFiles();
        while (jsonFiles.hasNext()) {
          const file = jsonFiles.next();
          if (!file.getName().toLowerCase().endsWith('.json')) continue;
          try {
            const data = JSON.parse(file.getBlob().getDataAsString());
            data._fileId = file.getId();
            data._fileName = file.getName();
            receipts.push(data);
          } catch (e) {
            // Skip unparseable files rather than failing the whole load.
            receipts.push({
              shop: shopFolder.getName(),
              purchase_date: dateFolder.getName(),
              _error: 'Could not parse ' + file.getName() + ': ' + e.message,
            });
          }
        }
      }
    }
  }

  cache.put(CACHE_KEY, JSON.stringify(receipts), CACHE_SECONDS);
  return receipts;
}

/** Force a fresh read on next call (bypass the 5-minute cache). */
function invalidateCache() {
  CacheService.getScriptCache().remove(CACHE_KEY);
  return true;
}

/**
 * Main lookup entry point called from the UI.
 * @param {Object} filters { shop, dateFrom, dateTo, itemQuery }
 */
function searchReceipts(filters) {
  filters = filters || {};
  let receipts = loadAllReceipts_().filter(r => !r._error);

  if (filters.shop) {
    const shop = filters.shop.toLowerCase();
    receipts = receipts.filter(r => (r.shop || '').toLowerCase().includes(shop));
  }
  if (filters.dateFrom) {
    receipts = receipts.filter(r => r.purchase_date >= filters.dateFrom);
  }
  if (filters.dateTo) {
    receipts = receipts.filter(r => r.purchase_date <= filters.dateTo);
  }
  if (filters.itemQuery) {
    const q = filters.itemQuery.toLowerCase();
    receipts = receipts.filter(r =>
      (r.items || []).some(i => (i.name || '').toLowerCase().includes(q))
    );
  }

  receipts.sort((a, b) => (b.purchase_date || '').localeCompare(a.purchase_date || ''));
  return receipts;
}

/**
 * Summary stats over the (optionally filtered) receipt set:
 * total spend, per-shop breakdown, receipt count, and any reconciliation
 * mismatches worth flagging.
 */
function summarize(filters) {
  const receipts = searchReceipts(filters);

  let totalSpend = 0;
  const byShop = {};
  const warnings = [];

  receipts.forEach(r => {
    const due = (r.summary && r.summary.balance_due) || 0;
    totalSpend += due;

    const shop = r.shop || 'Unknown';
    byShop[shop] = (byShop[shop] || 0) + due;

    const activeSum = (r.items || [])
      .filter(i => i.status === 'active')
      .reduce((sum, i) => sum + (i.net_total || 0), 0);
    if (r.summary && Math.abs(activeSum - r.summary.balance_due) > 0.01) {
      warnings.push({
        shop: r.shop,
        purchase_date: r.purchase_date,
        receipt_id: r.receipt_id,
        expected: r.summary.balance_due,
        computed: activeSum,
      });
    }
  });

  return {
    receiptCount: receipts.length,
    totalSpend: Math.round(totalSpend * 100) / 100,
    byShop: Object.entries(byShop)
      .map(([shop, total]) => ({ shop, total: Math.round(total * 100) / 100 }))
      .sort((a, b) => b.total - a.total),
    warnings,
  };
}

/** List of distinct shop names, for the UI's filter dropdown. */
function listShops() {
  const receipts = loadAllReceipts_().filter(r => !r._error);
  const shops = new Set(receipts.map(r => r.shop).filter(Boolean));
  return Array.from(shops).sort();
}
