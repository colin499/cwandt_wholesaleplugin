/**
 * CW&T Wholesale Line Sheet — client-side renderer
 *
 * Fetches all wholesale product data from the App Proxy (/apps/wholesale/linesheet-data),
 * renders a grouped product table with quantity inputs, and submits the order as
 * ONE Shopify draft order at exact CMS wholesale prices (POST /linesheet-order) —
 * the theme cart is NOT used, because it would check out at retail prices.
 * Print and Download PDF are unchanged.
 *
 * Reads wholesale status from sessionStorage / <meta name="wh-customer"> (same mechanism
 * as wholesale.js) — no async customer status fetch required.
 *
 * html2pdf.js must be loaded before this script runs (loaded via the Liquid block).
 */

(function () {
  "use strict";

  var SK_STATUS    = "wh_status";
  var SK_LINESHEET = "wh_linesheet_v7"; // versioned key — bump if cache shape changes (v7: moq_exempt + real MOQs)
  // Cache lifetime: just long enough to make rapid page-hopping instant.
  // Anything longer makes admin-side changes (MOQ exemption, prices, program
  // membership) look broken — a change should survive at most one reload.
  var LINESHEET_TTL_MS = 60 * 1000;

  /* -------------------------------------------------------------------------
     Wholesale status check (mirrors wholesale.js — synchronous)
     ---------------------------------------------------------------------- */

  function getWholesaleStatus() {
    var cached = sessionStorage.getItem(SK_STATUS);
    if (cached !== null) return cached === "1";
    var meta = document.querySelector('meta[name="wh-customer"]');
    var isWholesale = !!meta && meta.getAttribute("content") === "1";
    sessionStorage.setItem(SK_STATUS, isWholesale ? "1" : "0");
    return isWholesale;
  }

  /* -------------------------------------------------------------------------
     Currency-aware money formatter
     (linesheet.js uses currency_code from the API — unlike wholesale.js which
     still hardcodes USD and will be updated in Phase 2)
     ---------------------------------------------------------------------- */

  function formatMoney(cents, currencyCode) {
    return (cents / 100).toLocaleString("en-US", {
      style: "currency",
      currency: currencyCode || "USD",
      minimumFractionDigits: 2,
    });
  }

  /* -------------------------------------------------------------------------
     Fetch all product + pricing data from App Proxy (with sessionStorage cache)
     ---------------------------------------------------------------------- */

  function fetchLinesheetData(callback) {
    var cached = sessionStorage.getItem(SK_LINESHEET);
    if (cached) {
      try {
        var wrapped = JSON.parse(cached);
        if (wrapped && wrapped.t && wrapped.data && Date.now() - wrapped.t < LINESHEET_TTL_MS) {
          callback(null, wrapped.data);
          return;
        }
      } catch (_) { /* fall through to refetch */ }
      sessionStorage.removeItem(SK_LINESHEET);
    }

    fetch("/apps/wholesale/linesheet-data", { credentials: "same-origin" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        if (data && data.wholesale) {
          try {
            sessionStorage.setItem(SK_LINESHEET, JSON.stringify({ t: Date.now(), data: data }));
          } catch (_) { /* storage full — skip cache */ }
        }
        callback(null, data);
      })
      .catch(function (err) {
        callback(err, null);
      });
  }

  /* -------------------------------------------------------------------------
     XSS-safe string escaping for innerHTML builds
     ---------------------------------------------------------------------- */

  function esc(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* -------------------------------------------------------------------------
     Build the qty <select> for a variant row
     bundleSizes are parsed ints from block settings — safe to interpolate directly
     ---------------------------------------------------------------------- */

  // A distributor's effective unit price is dist_price; wh_price for others.
  function effectivePrice(variant) {
    return variant.dist_price != null ? variant.dist_price : variant.wh_price;
  }

  // True when the current customer sees distributor pricing (server sends
  // dist_price only to distributor accounts). Set from response data.
  var hasDistPricing = false;

  // MOQ-exempt customers still SEE real MOQs (informational, with a courtesy
  // note at the top of the sheet) but nothing blocks below-MOQ quantities.
  var moqExempt = false;

  function buildQtyInputHTML(variant) {
    // Numeric input; 0 = not ordering, otherwise the server enforces MOQ
    // (and we pre-validate client-side). Out-of-stock variants stay
    // orderable — draft orders don't reserve inventory, so backorder lines
    // ride along in the same order.
    var caseSize = variant.case_size && variant.case_size > 1 ? variant.case_size : 0;
    var html =
      '<input type="number" class="wh-ls-qty-input" inputmode="numeric"' +
      ' min="0" step="1" value="" placeholder="0"' +
      ' data-variant-id="' + variant.id + '"' +
      ' data-moq="' + (variant.moq || 1) + '"' +
      ' data-case="' + caseSize + '"' +
      ' data-price="' + effectivePrice(variant) + '">';
    if (caseSize) {
      // Soft case-pack encouragement: one click adds a full case.
      html +=
        '<button type="button" class="wh-ls-case-btn wh-no-print"' +
        ' data-target-variant="' + variant.id + '"' +
        ' title="Adds one case of ' + caseSize + '">+CASE</button>';
    }
    return html;
  }

  /* -------------------------------------------------------------------------
     Build the full line sheet HTML from API response data
     ---------------------------------------------------------------------- */

  function stockCell(variant) {
    // Anything not in stock is orderable as a backorder — say so.
    var out = !variant.available || variant.in_stock <= 0;
    var stockText = out ? "BACKORDER" : String(variant.in_stock);
    return '<td class="wh-ls-col-stock">' + esc(stockText) + "</td>";
  }

  // Cells shared by variant rows and single-variant product rows:
  // SKU | Retail | Wholesale | MOQ | Stock | Qty
  function variantCellsHTML(variant) {
    var html = "";
    html += "<td>" + esc(variant.sku || "—") + "</td>";
    html +=
      '<td class="wh-ls-col-price">' +
      formatMoney(variant.retail_price, variant.currency_code) +
      "</td>";
    html +=
      '<td class="wh-ls-col-price wh-ls-col-wh">' +
      formatMoney(variant.wh_price, variant.currency_code) +
      "</td>";
    if (hasDistPricing) {
      html +=
        '<td class="wh-ls-col-price wh-ls-col-dist">' +
        (variant.dist_price != null
          ? formatMoney(variant.dist_price, variant.currency_code)
          : "—") +
        "</td>";
    }
    html += '<td class="wh-ls-col-moq">' + (variant.moq > 1 ? variant.moq : "1") + "</td>";
    html += stockCell(variant);
    html += '<td class="wh-ls-col-qty wh-no-print">' + buildQtyInputHTML(variant) + "</td>";
    return html;
  }

  function productTitleHTML(product) {
    return (
      '<a href="/products/' +
      esc(product.handle) +
      '" class="wh-ls-product-link wh-no-print-link">' +
      esc(product.title) +
      "</a>" +
      '<span class="wh-print-only-title">' + esc(product.title) + "</span>"
    );
  }

  function imageCellHTML(imageUrl, alt) {
    // Small thumbnail that expands to a popup overlay on hover.
    // Blue placeholder box when there is no image yet.
    var html = '<td class="wh-ls-col-img"><span class="wh-ls-thumb">';
    if (imageUrl) {
      html +=
        '<img src="' + esc(imageUrl) + '" alt="' + esc(alt) +
        '" class="wh-ls-img" loading="lazy">';
      html +=
        '<span class="wh-ls-thumb-pop"><img src="' + esc(imageUrl) +
        '" alt="" loading="lazy"></span>';
    } else {
      html += '<span class="wh-ls-img-ph" aria-hidden="true"></span>';
    }
    html += "</span></td>";
    return html;
  }

  function sortableTh(label, key, numeric, extraClass) {
    return (
      '<th class="wh-ls-sortable' + (extraClass ? " " + extraClass : "") +
      '" data-sort-key="' + key + '"' + (numeric ? ' data-sort-numeric="1"' : "") +
      ">" + label + ' <span class="wh-ls-sort" aria-hidden="true">&#9662;</span></th>'
    );
  }

  function buildHTML(data) {
    if (!data.collections || data.collections.length === 0) {
      return '<p class="wh-ls-empty">No products are available in your line sheet.</p>';
    }

    hasDistPricing = data.collections.some(function (c) {
      return (c.products || []).some(function (p) {
        return (p.variants || []).some(function (v) { return v.dist_price != null; });
      });
    });

    var html = "";

    data.collections.forEach(function (collection) {
      if (!collection.products || collection.products.length === 0) return;

      html += '<section class="wh-ls-collection">';
      // "Other" is the fallback bucket for products with no collection — the
      // heading is noise there, so only real collection names get one.
      if (collection.title && collection.title.toLowerCase() !== "other") {
        html += '<h2 class="wh-ls-collection-title">' + esc(collection.title) + "</h2>";
      }

      html += '<table class="wh-ls-table">';
      html += "<thead><tr>";
      html += '<th class="wh-ls-col-img"></th>';
      html += sortableTh("Product", "product", false, "wh-ls-col-title");
      html += '<th class="wh-ls-col-variant">Variant</th>';
      html += "<th>SKU</th>";
      html += sortableTh("Retail", "retail", true);
      html += "<th>Wholesale</th>";
      if (hasDistPricing) html += "<th>Distributor</th>";
      html += '<th class="wh-ls-col-moq">MOQ</th>';
      html += '<th class="wh-ls-col-stock">Stock</th>';
      html += sortableTh("Qty", "qty", true, "wh-ls-col-qty wh-no-print");
      html += "</tr></thead>";
      html += "<tbody>";

      collection.products.forEach(function (product) {
        var variants = product.variants;
        if (!variants || variants.length === 0) return;

        // One flat row per variant — image and product name repeat per row.
        variants.forEach(function (variant) {
          var optionLabel = variant.title === "Default Title" ? "—" : variant.title;
          var stockSort = !variant.available ? -1 : variant.in_stock > 0 ? variant.in_stock : 0;
          html +=
            "<tr" +
            ' data-product="' + esc(product.title) + '"' +
            ' data-variant="' + esc(optionLabel) + '"' +
            ' data-sku="' + esc(variant.sku || "") + '"' +
            ' data-retail="' + variant.retail_price + '"' +
            ' data-wholesale="' + variant.wh_price + '"' +
            ' data-moq="' + (variant.moq > 1 ? variant.moq : 1) + '"' +
            ' data-stock="' + stockSort + '"' +
            ">";
          html += imageCellHTML(variant.image_url || product.image_url, product.title);
          html += '<td class="wh-ls-col-title">' + productTitleHTML(product) + "</td>";
          html += '<td class="wh-ls-col-variant">' + esc(optionLabel) + "</td>";
          html += variantCellsHTML(variant);
          html += "</tr>";
        });
      });

      html += "</tbody></table></section>";
    });

    return html;
  }

  /* -------------------------------------------------------------------------
     Group collapse/expand + data export (CSV / Google Sheets)
     ---------------------------------------------------------------------- */

  var lastData = null; // most recent linesheet-data response, for exports

  /* -------------------------------------------------------------------------
     Column sorting — click a header to sort that collection's rows;
     click again to reverse. Rows carry data-* attributes for the keys.
     ---------------------------------------------------------------------- */

  function wireSorting(content) {
    content.querySelectorAll(".wh-ls-table").forEach(function (table) {
      var ths = table.querySelectorAll("th.wh-ls-sortable");
      ths.forEach(function (th) {
        th.addEventListener("click", function () {
          var key = th.getAttribute("data-sort-key");
          var numeric = th.getAttribute("data-sort-numeric") === "1";
          var dir = th.getAttribute("data-sort-dir") === "asc" ? "desc" : "asc";
          ths.forEach(function (other) {
            other.removeAttribute("data-sort-dir");
            var c = other.querySelector(".wh-ls-sort");
            if (c) c.innerHTML = "&#9662;";
          });
          th.setAttribute("data-sort-dir", dir);
          var caret = th.querySelector(".wh-ls-sort");
          if (caret) caret.innerHTML = dir === "asc" ? "&#9652;" : "&#9662;";

          // Qty is a live input, not a data-* attribute — read its current value.
          function rowValue(row) {
            if (key === "qty") {
              var input = row.querySelector(".wh-ls-qty-input");
              return input ? input.value : "";
            }
            return row.getAttribute("data-" + key) || "";
          }

          var tbody = table.querySelector("tbody");
          var rows = Array.prototype.slice.call(tbody.querySelectorAll("tr"));
          rows.sort(function (a, b) {
            var av = rowValue(a);
            var bv = rowValue(b);
            var cmp = numeric
              ? (parseFloat(av) || 0) - (parseFloat(bv) || 0)
              : av.localeCompare(bv, undefined, { numeric: true, sensitivity: "base" });
            return dir === "asc" ? cmp : -cmp;
          });
          rows.forEach(function (r) { tbody.appendChild(r); });
        });
      });
    });
  }

  // Rows for CSV/TSV: [Product, Variant, SKU, Retail, Wholesale, (Distributor,) MOQ, Case, Stock, Qty]
  function buildExportRows(content) {
    var header = ["Product", "Variant", "SKU", "Retail", "Wholesale"];
    if (hasDistPricing) header.push("Distributor");
    header = header.concat(["MOQ", "Case Size", "Stock", "Qty"]);
    var rows = [header];
    if (!lastData || !lastData.collections) return rows;
    lastData.collections.forEach(function (collection) {
      (collection.products || []).forEach(function (product) {
        (product.variants || []).forEach(function (variant) {
          var qtyInput = content.querySelector(
            '.wh-ls-qty-input[data-variant-id="' + variant.id + '"]'
          );
          var row = [
            product.title,
            variant.title === "Default Title" ? "" : variant.title,
            variant.sku || "",
            (variant.retail_price / 100).toFixed(2),
            (variant.wh_price / 100).toFixed(2),
          ];
          if (hasDistPricing) {
            row.push(variant.dist_price != null ? (variant.dist_price / 100).toFixed(2) : "");
          }
          rows.push(row.concat([
            variant.moq > 1 ? variant.moq : 1,
            variant.case_size && variant.case_size > 1 ? variant.case_size : "",
            !variant.available || variant.in_stock <= 0 ? "Backorder" : variant.in_stock,
            qtyInput && qtyInput.value ? qtyInput.value : "",
          ]));
        });
      });
    });
    return rows;
  }

  function downloadCSV(content) {
    var csv = buildExportRows(content)
      .map(function (row) {
        return row
          .map(function (cell) {
            var s = String(cell);
            return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
          })
          .join(",");
      })
      .join("\n");
    var blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "cwandt-wholesale-linesheet.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }

  function openGoogleSheet(content, resultEl) {
    var tsv = buildExportRows(content)
      .map(function (row) { return row.join("\t"); })
      .join("\n");
    var finish = function (copied) {
      window.open("https://sheets.new", "_blank", "noopener");
      if (resultEl) {
        showOrderResult(
          resultEl,
          copied,
          copied
            ? "Linesheet copied to clipboard, paste (⌘V) into the new Google Sheet."
            : "Could not copy automatically, use Download CSV and import it into Google Sheets."
        );
      }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(tsv).then(
        function () { finish(true); },
        function () { finish(false); }
      );
    } else {
      finish(false);
    }
  }

  /* -------------------------------------------------------------------------
     Order helpers — collect lines, live subtotal vs order minimum, submit
     ---------------------------------------------------------------------- */

  function getOrderLines(content) {
    var lines = [];
    content.querySelectorAll(".wh-ls-qty-input").forEach(function (input) {
      var qty = parseInt(input.value, 10) || 0;
      if (qty > 0) {
        lines.push({
          variant_id: parseInt(input.getAttribute("data-variant-id"), 10),
          quantity: qty,
          moq: parseInt(input.getAttribute("data-moq"), 10) || 1,
          caseSize: parseInt(input.getAttribute("data-case"), 10) || 0,
          price: parseInt(input.getAttribute("data-price"), 10) || 0,
          product: variantProductMap[String(input.getAttribute("data-variant-id"))] || "",
          input: input,
        });
      }
    });
    return lines;
  }

  // variant id → product handle, for counting distinct products in the summary
  var variantProductMap = {};

  function rebuildVariantProductMap(data) {
    variantProductMap = {};
    if (!data || !data.collections) return;
    data.collections.forEach(function (collection) {
      (collection.products || []).forEach(function (product) {
        (product.variants || []).forEach(function (variant) {
          variantProductMap[String(variant.id)] = product.handle;
        });
      });
    });
  }

  // Edit mode: variants on the order being edited show effective stock
  // (live stock + the order's own reserved units) instead of BACKORDER.
  function creditEditStock(content, lines) {
    if (!lastData || !lines) return;
    var byId = {};
    (lastData.collections || []).forEach(function (c) {
      (c.products || []).forEach(function (p) {
        (p.variants || []).forEach(function (v) { byId[String(v.id)] = v; });
      });
    });
    lines.forEach(function (l) {
      var v = byId[String(l.variant_id)];
      if (!v) return;
      var showsBackorder = !v.available || v.in_stock <= 0;
      if (!showsBackorder) return;
      var effective = (v.in_stock || 0) + l.quantity;
      if (effective <= 0) return;
      var input = content.querySelector(
        '.wh-ls-qty-input[data-variant-id="' + l.variant_id + '"]'
      );
      var row = input && input.closest ? input.closest("tr") : null;
      if (!row) return;
      var cell = row.querySelector(".wh-ls-col-stock");
      if (cell) cell.textContent = String(effective);
      row.setAttribute("data-stock", String(effective));
    });
  }

  var orderMinimumCents = null; // fetched at init; null = unknown

  function fetchOrderMinimum() {
    fetch("/apps/wholesale/order-minimums", { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data && typeof data.minimumOrderValue === "number") {
          orderMinimumCents = Math.round(data.minimumOrderValue * 100);
        }
      })
      .catch(function () { /* advisory only — server enforces */ });
  }

  function updateSummary(content, summaryEl) {
    if (!summaryEl) return;
    var lines = getOrderLines(content);
    var subtotal = 0;
    var units = 0;
    var moqShort = [];
    lines.forEach(function (l) {
      subtotal += l.price * l.quantity;
      units += l.quantity;
      var below = !moqExempt && l.quantity < l.moq;
      l.input.classList.toggle("wh-ls-qty--below-moq", below);
      if (below) moqShort.push(l);
    });

    // Rows with a quantity entered get the lightyellow "in your order" tint.
    content.querySelectorAll(".wh-ls-qty-input").forEach(function (input) {
      var row = input.closest("tr");
      if (row) {
        row.classList.toggle("wh-ls-row--filled", (parseInt(input.value, 10) || 0) > 0);
      }
    });

    if (lines.length === 0) {
      summaryEl.textContent = "0 PRODUCTS : 0 VARIANTS : 0 ITEMS : " + formatMoney(0);
      setText("wh-ls-print-summary", summaryEl.textContent);
      return;
    }
    var products = {};
    lines.forEach(function (l) { if (l.product) products[l.product] = true; });
    var productCount = Object.keys(products).length;

    var text =
      productCount + " PRODUCT" + (productCount === 1 ? "" : "S") +
      " : " + lines.length + " VARIANT" + (lines.length === 1 ? "" : "S") +
      " : " + units + " ITEM" + (units === 1 ? "" : "S") +
      " : " + formatMoney(subtotal);
    // Print summary shows the clean totals (MOQ/minimum notes are screen-only).
    setText("wh-ls-print-summary", text);
    if (moqShort.length > 0) {
      text += " : " + moqShort.length + " item" + (moqShort.length === 1 ? "" : "s") + " below MOQ";
    } else if (orderMinimumCents !== null && subtotal < orderMinimumCents) {
      text += " : minimum " + formatMoney(orderMinimumCents);
    }
    summaryEl.textContent = text;
  }

  /* -------------------------------------------------------------------------
     Draft persistence — autosave quantities, prefill on load, order history
     ---------------------------------------------------------------------- */

  var saveTimer = null;
  var saveStateEl = null;

  function setSaveState(text) {
    if (saveStateEl) saveStateEl.textContent = text;
  }

  // Mirror a value into an element by id (screen panel ↔ print header).
  function setText(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function getPoNumber() {
    var el = document.getElementById("wh-ls-po");
    return el ? el.value.trim() : "";
  }

  function getShipOwnLabel() {
    var el = document.getElementById("wh-ls-own-label");
    return !!(el && el.checked);
  }

  function collectDraftPayload(content) {
    var lines = getOrderLines(content);
    var subtotal = 0;
    lines.forEach(function (l) { subtotal += l.price * l.quantity; });
    var payload = {
      lines: lines.map(function (l) {
        return { variant_id: l.variant_id, quantity: l.quantity };
      }),
      subtotal_cents: subtotal,
      po_number: getPoNumber(),
      ship_own_label: getShipOwnLabel(),
    };
    // In edit mode every save targets the EDITING session, never the draft.
    var ctx = getEditContext();
    if (ctx) payload.edit_of = ctx.id;
    return payload;
  }

  function saveDraftNow(content) {
    setSaveState("Saving…");
    fetch("/apps/wholesale/linesheet-draft", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(collectDraftPayload(content)),
    })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        setSaveState("Draft saved");
      })
      .catch(function (err) {
        setSaveState("Draft not saved, check connection");
        console.error("[linesheet] draft save error:", err);
      });
  }

  function scheduleDraftSave(content) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { saveDraftNow(content); }, 800);
  }

  function applyDraftLines(content, lines) {
    if (!lines || lines.length === 0) return;
    lines.forEach(function (l) {
      var input = content.querySelector(
        '.wh-ls-qty-input[data-variant-id="' + l.variant_id + '"]'
      );
      if (input) input.value = String(l.quantity);
    });
  }

  function loadDraft(content, summaryEl, prefill) {
    var ctx = getEditContext();
    var url =
      "/apps/wholesale/linesheet-draft" +
      (ctx ? "?edit_of=" + encodeURIComponent(ctx.id) : "");
    fetch(url, { credentials: "same-origin" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        // The edit session is gone (cancelled elsewhere / expired) — drop
        // edit mode and load the normal working draft instead.
        if (ctx && data.edit_missing) {
          clearEditContext();
          loadDraft(content, summaryEl, prefill);
          return;
        }
        if (data.customer) {
          setText("wh-ls-cust-name", data.customer.name || "—");
          setText("wh-ls-cust-company", data.customer.company || "—");
          setText("wh-ls-cust-email", data.customer.email || "—");
          setText("wh-ls-print-name", data.customer.name || "—");
          setText("wh-ls-print-company", data.customer.company || "—");
          setText("wh-ls-print-email", data.customer.email || "—");
        }
        if (prefill && data.draft) {
          if (data.draft.lines) applyDraftLines(content, data.draft.lines);
          // Edit mode: the order's own reservation consumed the live stock,
          // so its items can read BACKORDER on reopen. Credit those units in
          // the STOCK display (the server applies the same credit on submit).
          if (ctx && data.draft.lines) creditEditStock(content, data.draft.lines);
          var poEl = document.getElementById("wh-ls-po");
          if (poEl && data.draft.po_number) poEl.value = data.draft.po_number;
          setText("wh-ls-print-po", getPoNumber() || "—");
          var ownEl = document.getElementById("wh-ls-own-label");
          if (ownEl) ownEl.checked = !!data.draft.ship_own_label;
          updateSummary(content, summaryEl);
          if (data.draft.lines && data.draft.lines.length > 0) {
            setSaveState(ctx ? "Editing " + (ctx.name || "order") : "Draft restored");
          }
        }
      })
      .catch(function (err) {
        // Draft persistence is an enhancement — the sheet still works without it.
        console.error("[linesheet] draft load error:", err);
      });
  }

  /* -------------------------------------------------------------------------
     Edit mode — set by the Orders page ("Edit order"): sessionStorage carries
     the unpaid draft order this sheet submission should REPLACE. The banner
     keeps the state visible and cancellable, so an abandoned edit can't
     silently swallow a later, unrelated order.
     ---------------------------------------------------------------------- */

  var EDIT_KEY = "wh-edit-order";

  function getEditContext() {
    try {
      var ctx = JSON.parse(sessionStorage.getItem(EDIT_KEY) || "null");
      return ctx && ctx.id ? ctx : null;
    } catch (e) {
      return null;
    }
  }

  function clearEditContext() {
    try { sessionStorage.removeItem(EDIT_KEY); } catch (e) { /* ignore */ }
    var banner = document.getElementById("wh-ls-edit-banner");
    if (banner) banner.remove();
    var bar = document.querySelector(".wh-ls-sticky");
    if (bar) bar.classList.remove("wh-ls-sticky--editing");
  }

  // Edit mode renders as two compact lines in the sticky bar:
  //   line 1 — EDITING #D1788 : 2 PRODUCTS : … (save-state + summary)
  //   line 2 — NOTES : how the edit behaves + the cancel link (this banner,
  //            pushed to its own full-width row by CSS order/flex-basis)
  function renderEditBanner(summaryEl) {
    var ctx = getEditContext();
    if (!ctx || !summaryEl || !summaryEl.parentNode) return;
    var bar = summaryEl.parentNode;
    bar.classList.add("wh-ls-sticky--editing");
    var banner = document.createElement("div");
    banner.id = "wh-ls-edit-banner";
    banner.appendChild(document.createTextNode(
      ctx.paid
        ? "NOTES : Order " + (ctx.name || "") + " is already paid, so you can add items " +
          "or increase quantities (for reductions, contact us). Any balance due is payable " +
          "from Order History. "
        : "NOTES : Submitting updates that order in place. "
    ));
    var cancel = document.createElement("a");
    cancel.href = "#";
    cancel.textContent = "Cancel edit (keep order as is)";
    cancel.addEventListener("click", function (e) {
      e.preventDefault();
      clearEditContext();
      // Drop the edit session server-side, then reload — the sheet comes
      // back showing the untouched working draft either way.
      fetch("/apps/wholesale/linesheet-edit-cancel", {
        method: "POST",
        credentials: "same-origin",
      }).then(
        function () { window.location.reload(); },
        function () { window.location.reload(); }
      );
    });
    banner.appendChild(cancel);
    bar.appendChild(banner);
  }

  function showOrderResult(resultEl, ok, message, invoiceUrl) {
    if (!resultEl) return;
    resultEl.textContent = "";
    resultEl.className = "wh-ls-order-result " + (ok ? "wh-ls-order-result--success" : "wh-ls-order-result--error");
    resultEl.appendChild(document.createTextNode(message + " "));
    if (invoiceUrl) {
      var link = document.createElement("a");
      link.href = invoiceUrl;
      link.textContent = "Review & pay →";
      resultEl.appendChild(link);
    }
    resultEl.hidden = false;
    resultEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  // The sheet is an editing surface only — orders are SUBMITTED from the
  // Orders page review (one place an order becomes real). This validates,
  // force-saves the draft, and hands off to review.
  function reviewOrder(content, reviewBtn, resultEl) {
    var lines = getOrderLines(content);
    if (lines.length === 0) {
      showOrderResult(resultEl, false, "Enter quantities before reviewing your order.");
      return;
    }
    var short = moqExempt ? [] : lines.filter(function (l) { return l.quantity < l.moq; });
    if (short.length > 0) {
      showOrderResult(
        resultEl, false,
        "Some quantities are below the minimum order quantity. See highlights in Qty column."
      );
      return;
    }

    // Soft case nudge: quantities that don't pack into full cases get ONE
    // suggestion; continuing again proceeds as entered. Never a block.
    var offCase = lines.filter(function (l) {
      return l.caseSize > 0 && l.quantity % l.caseSize !== 0;
    });
    if (offCase.length > 0 && !reviewBtn.__whCaseNudged) {
      reviewBtn.__whCaseNudged = true;
      var parts = offCase.map(function (l) {
        var up = Math.ceil(l.quantity / l.caseSize) * l.caseSize;
        return l.quantity + " → " + up + " (" + (up / l.caseSize) + " full case" + (up / l.caseSize === 1 ? "" : "s") + " of " + l.caseSize + ")";
      });
      showOrderResult(
        resultEl, false,
        "These items pack in cases: " + parts.join("; ") +
        ". Adjust quantities, or press Review again to continue as entered."
      );
      return;
    }
    reviewBtn.__whCaseNudged = false;

    // Edit mode submits directly from the sheet: save the edit session, then
    // update the existing order in place (same order #, same invoice).
    var editCtx = getEditContext();
    if (editCtx) {
      submitEditedOrder(content, reviewBtn, resultEl, editCtx);
      return;
    }

    var original = reviewBtn.textContent;
    reviewBtn.disabled = true;
    reviewBtn.textContent = "Saving…";
    if (resultEl) resultEl.hidden = true;
    if (saveTimer) clearTimeout(saveTimer);

    var ordersUrl = reviewBtn.getAttribute("data-orders-url") || "/pages/orders";
    fetch("/apps/wholesale/linesheet-draft", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(collectDraftPayload(content)),
    })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        window.location.href = ordersUrl + "#draft";
      })
      .catch(function (err) {
        console.error("[linesheet] review save error:", err);
        showOrderResult(
          resultEl, false,
          "Could not save your order sheet. Please check your connection and try again."
        );
        reviewBtn.disabled = false;
        reviewBtn.textContent = original;
      });
  }

  function submitEditedOrder(content, btn, resultEl, ctx) {
    var original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Updating order…";
    if (resultEl) resultEl.hidden = true;
    if (saveTimer) clearTimeout(saveTimer);

    var ordersUrl = btn.getAttribute("data-orders-url") || "/pages/orders";
    // Force-save the edit session, then submit it as an in-place update.
    fetch("/apps/wholesale/linesheet-draft", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(collectDraftPayload(content)),
    })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return fetch("/apps/wholesale/linesheet-order", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ edit_of: ctx.id }),
        });
      })
      .then(function (r) {
        return r
          .json()
          .catch(function () { throw new Error("HTTP " + r.status); })
          .then(function (data) {
            if (!r.ok || !data.ok) {
              var e = new Error((data && data.error) || "HTTP " + r.status);
              e.userFacing = !!(data && data.error);
              e.editExpired = !!(data && data.edit_expired);
              throw e;
            }
            return data;
          });
      })
      .then(function () {
        clearEditContext();
        // Land on Order History — the updated order (and unchanged draft)
        // are both visible there.
        window.location.href = ordersUrl;
      })
      .catch(function (err) {
        if (err && err.editExpired) clearEditContext();
        showOrderResult(
          resultEl, false,
          err && err.userFacing
            ? err.message
            : "Could not update the order. Please try again or contact us."
        );
        console.error("[linesheet] edit submit error:", err);
        btn.disabled = false;
        btn.textContent = original;
      });
  }

  /* -------------------------------------------------------------------------
     PDF download via html2pdf.js
     ---------------------------------------------------------------------- */

  function downloadPDF(btn) {
    if (typeof html2pdf === "undefined") {
      alert("PDF export is loading, please try again in a moment.");
      return;
    }

    // Export the whole sheet in print layout: .wh-pdf-mode applies the same
    // hide/show rules as @media print (header + summary visible, toolbar and
    // qty column hidden) since html2canvas ignores print media queries.
    var sheet = document.querySelector(".wh-linesheet");
    if (!sheet) return;

    var original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Generating PDF…";
    sheet.classList.add("wh-pdf-mode");

    function done() {
      sheet.classList.remove("wh-pdf-mode");
      btn.disabled = false;
      btn.textContent = original;
    }

    html2pdf()
      .set({
        margin: [8, 8],
        filename: "cwandt-wholesale-order-sheet.pdf",
        image: { type: "jpeg", quality: 0.88 },
        html2canvas: { scale: 2, useCORS: true, logging: false },
        jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
        pagebreak: { mode: ["avoid-all", "css"] },
      })
      .from(sheet)
      .save()
      .then(done)
      .catch(done);
  }

  /* -------------------------------------------------------------------------
     Main init
     ---------------------------------------------------------------------- */

  // The theme's main Page section keeps a 600px min-height even when the page
  // body is empty, pushing the app section to the bottom — collapse it. Only
  // hides sections whose page content is truly empty, so adding body text to
  // the page in Shopify Admin brings the section back.
  function collapseEmptyPageSection() {
    document.querySelectorAll(".shopify-section .page-content .rte").forEach(function (rte) {
      if (rte.children.length === 0 && rte.textContent.trim() === "") {
        var section = rte.closest(".shopify-section");
        if (section && !section.querySelector(".wh-linesheet")) {
          section.style.display = "none";
        }
      }
    });
  }

  function init() {
    collapseEmptyPageSection();
    var content   = document.getElementById("wh-linesheet-content");
    var loading   = document.getElementById("wh-linesheet-loading");
    var printBtn  = document.getElementById("wh-ls-print");
    var exportBtn = document.getElementById("wh-ls-export");
    var exportMenu = document.getElementById("wh-ls-export-menu");
    var submitBtn = document.getElementById("wh-ls-submit-order");
    var summaryEl = document.getElementById("wh-ls-summary");
    var resultEl  = document.getElementById("wh-ls-order-result");
    saveStateEl   = document.getElementById("wh-ls-save-state");

    if (!content) return;

    fetchOrderMinimum();

    if (!getWholesaleStatus()) {
      if (loading) {
        loading.textContent = "Wholesale account required to view line sheet.";
      }
      return;
    }

    fetchLinesheetData(function (err, data) {
      if (loading) loading.setAttribute("hidden", "");

      if (err || !data || !data.wholesale) {
        content.innerHTML =
          '<p class="wh-ls-error">Unable to load line sheet. Please refresh the page or contact us.</p>';
        content.removeAttribute("hidden");
        return;
      }

      lastData = data;
      moqExempt = !!data.moq_exempt;
      rebuildVariantProductMap(data);
      content.innerHTML =
        (moqExempt
          ? '<p class="wh-ls-moq-note">Although it is not required for your account, please try to meet MOQ where possible.</p>'
          : "") + buildHTML(data);
      content.removeAttribute("hidden");
      wireSorting(content);
      updateSummary(content, summaryEl); // show the zeroed totals immediately

      // Pin the totals bar just below the site's sticky header.
      var stickyBar = document.querySelector(".wh-ls-sticky");
      var siteHeader = document.querySelector(".header-wrapper");
      if (stickyBar && siteHeader) {
        stickyBar.style.top = siteHeader.offsetHeight + "px";
      }

      // Restore the saved draft into the qty inputs.
      loadDraft(content, summaryEl, true);

      // Arriving from Orders → "Edit": show the banner and relabel the
      // submit button — edit mode submits from the sheet, updating the
      // existing order in place.
      renderEditBanner(summaryEl);
      var editCtx = getEditContext();
      if (editCtx && submitBtn) {
        submitBtn.textContent = "Submit Changes to " + (editCtx.name || "Order") + " →";
      }

      // Wire qty inputs → live summary (subtotal, MOQ shortfalls, minimum)
      content.addEventListener("input", function (e) {
        if (e.target && e.target.classList.contains("wh-ls-qty-input")) {
          if (submitBtn) submitBtn.__whCaseNudged = false;
          updateSummary(content, summaryEl);
          scheduleDraftSave(content);
        }
      });

      // "+ case" buttons add one full case to the row's quantity.
      content.addEventListener("click", function (e) {
        var btn = e.target && e.target.closest ? e.target.closest(".wh-ls-case-btn") : null;
        if (!btn) return;
        var input = content.querySelector(
          '.wh-ls-qty-input[data-variant-id="' + btn.getAttribute("data-target-variant") + '"]'
        );
        if (!input) return;
        var caseSize = parseInt(input.getAttribute("data-case"), 10) || 0;
        if (!caseSize) return;
        var current = parseInt(input.value, 10) || 0;
        // Snap up to the next full case boundary.
        input.value = String(Math.floor(current / caseSize) * caseSize + caseSize);
        if (submitBtn) submitBtn.__whCaseNudged = false;
        updateSummary(content, summaryEl);
        scheduleDraftSave(content);
      });

      // Sheet date: today until submitted (a submitted sheet becomes an order;
      // this page always shows the working draft). Mirrored into the print header.
      var todayText = new Date().toLocaleDateString("en-US", {
        year: "numeric", month: "short", day: "numeric",
      });
      setText("wh-ls-date", todayText);
      setText("wh-ls-print-date", todayText);
      setText("wh-ls-print-po", "—");

      // PO input + own-label checkbox autosave with the draft
      var poEl = document.getElementById("wh-ls-po");
      if (poEl) poEl.addEventListener("input", function () {
        setText("wh-ls-print-po", getPoNumber() || "—");
        scheduleDraftSave(content);
      });
      var ownEl = document.getElementById("wh-ls-own-label");
      if (ownEl) ownEl.addEventListener("change", function () { scheduleDraftSave(content); });

      if (printBtn) {
        printBtn.addEventListener("click", function () { window.print(); });
      }

      // Clear Sheet: zero every quantity (PO and shipping choice stay) and
      // save, so the emptied sheet is what persists.
      var clearBtn = document.getElementById("wh-ls-clear");
      if (clearBtn) {
        clearBtn.addEventListener("click", function () {
          if (!window.confirm("Clear all quantities from the sheet?")) return;
          content.querySelectorAll(".wh-ls-qty-input").forEach(function (input) {
            input.value = "";
            input.classList.remove("wh-ls-qty--below-moq");
          });
          if (submitBtn) submitBtn.__whCaseNudged = false;
          updateSummary(content, summaryEl);
          saveDraftNow(content);
        });
      }

      if (exportBtn && exportMenu) {
        exportBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          var open = exportMenu.hidden;
          exportMenu.hidden = !open;
          exportBtn.setAttribute("aria-expanded", open ? "true" : "false");
        });
        document.addEventListener("click", function () {
          exportMenu.hidden = true;
          exportBtn.setAttribute("aria-expanded", "false");
        });
        exportMenu.addEventListener("click", function (e) {
          var item = e.target && e.target.closest ? e.target.closest(".wh-ls-export-item") : null;
          if (!item) return;
          exportMenu.hidden = true;
          var kind = item.getAttribute("data-export");
          if (kind === "csv") downloadCSV(content);
          if (kind === "pdf") downloadPDF(exportBtn);
          if (kind === "gsheet") openGoogleSheet(content, resultEl);
        });
      }

      if (submitBtn) {
        submitBtn.addEventListener("click", function () {
          reviewOrder(content, submitBtn, resultEl);
        });
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
