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
  var SK_LINESHEET = "wh_linesheet_v2"; // versioned key — bump if response shape changes

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
        callback(null, JSON.parse(cached));
        return;
      } catch (_) {
        sessionStorage.removeItem(SK_LINESHEET);
      }
    }

    fetch("/apps/wholesale/linesheet-data", { credentials: "same-origin" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        if (data && data.wholesale) {
          try {
            sessionStorage.setItem(SK_LINESHEET, JSON.stringify(data));
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

  function buildQtyInputHTML(variant) {
    // Numeric input; 0 = not ordering, otherwise the server enforces MOQ
    // (and we pre-validate client-side). Out-of-stock variants stay
    // orderable — draft orders don't reserve inventory, so backorder lines
    // ride along in the same order.
    return (
      '<input type="number" class="wh-ls-qty-input" inputmode="numeric"' +
      ' min="0" step="1" value="" placeholder="0"' +
      ' data-variant-id="' + variant.id + '"' +
      ' data-moq="' + (variant.moq || 1) + '"' +
      ' data-price="' + variant.wh_price + '">'
    );
  }

  /* -------------------------------------------------------------------------
     Build the full line sheet HTML from API response data
     ---------------------------------------------------------------------- */

  function buildHTML(data) {
    if (!data.collections || data.collections.length === 0) {
      return '<p class="wh-ls-empty">No products are available in your line sheet.</p>';
    }

    var html = "";

    data.collections.forEach(function (collection) {
      if (!collection.products || collection.products.length === 0) return;

      html += '<section class="wh-ls-collection">';
      html += '<h2 class="wh-ls-collection-title">' + esc(collection.title) + "</h2>";

      html += '<table class="wh-ls-table">';
      html += "<thead><tr>";
      html += '<th class="wh-ls-col-img"></th>';
      html += "<th>Product</th>";
      html += "<th>SKU</th>";
      html += "<th>Options</th>";
      html += "<th>Retail</th>";
      html += "<th>Wholesale</th>";
      html += "<th>MOQ</th>";
      html += "<th>Stock</th>";
      html += '<th class="wh-ls-col-qty wh-no-print">Qty</th>';
      html += "</tr></thead>";
      html += "<tbody>";

      collection.products.forEach(function (product) {
        var variants = product.variants;
        if (!variants || variants.length === 0) return;

        var rowspan = variants.length;

        variants.forEach(function (variant, idx) {
          var isFirst = idx === 0;
          var outOfStock = !variant.available;

          html += '<tr class="' + (isFirst ? "wh-ls-row-first" : "wh-ls-row-cont") + '">';

          if (isFirst) {
            html += '<td class="wh-ls-col-img" rowspan="' + rowspan + '">';
            if (product.image_url) {
              html +=
                '<img src="' +
                esc(product.image_url) +
                '" alt="' +
                esc(product.title) +
                '" class="wh-ls-img" loading="lazy">';
            }
            html += "</td>";

            html += '<td class="wh-ls-col-title" rowspan="' + rowspan + '">';
            html +=
              '<a href="/products/' +
              esc(product.handle) +
              '" class="wh-ls-product-link wh-no-print-link">' +
              esc(product.title) +
              "</a>";
            html +=
              '<span class="wh-print-only-title">' + esc(product.title) + "</span>";
            html += "</td>";
          }

          var optionLabel =
            variant.title === "Default Title" ? "—" : variant.title;

          html += "<td>" + esc(variant.sku || "—") + "</td>";
          html += "<td>" + esc(optionLabel) + "</td>";
          html +=
            '<td class="wh-ls-col-price">' +
            formatMoney(variant.retail_price, variant.currency_code) +
            "</td>";
          html +=
            '<td class="wh-ls-col-price wh-ls-col-wh">' +
            formatMoney(variant.wh_price, variant.currency_code) +
            "</td>";
          html += "<td>" + (variant.moq > 1 ? variant.moq : "1") + "</td>";

          var stockText, stockClass;
          if (outOfStock) {
            stockText = "Out of stock";
            stockClass = "wh-ls-stock--out";
          } else if (variant.in_stock > 0) {
            stockText = String(variant.in_stock);
            stockClass = "";
          } else {
            stockText = "Backorder";
            stockClass = "wh-ls-stock--backorder";
          }
          html += '<td class="' + stockClass + '">' + esc(stockText) + "</td>";

          html += '<td class="wh-ls-col-qty wh-no-print">';
          html += buildQtyInputHTML(variant);
          html += "</td>";

          html += "</tr>";
        });
      });

      html += "</tbody></table></section>";
    });

    return html;
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
          price: parseInt(input.getAttribute("data-price"), 10) || 0,
          input: input,
        });
      }
    });
    return lines;
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
      l.input.classList.toggle("wh-ls-qty--below-moq", l.quantity < l.moq);
      if (l.quantity < l.moq) moqShort.push(l);
    });

    if (lines.length === 0) {
      summaryEl.textContent = "";
      summaryEl.hidden = true;
      return;
    }
    var text = units + " unit" + (units === 1 ? "" : "s") + " · " + formatMoney(subtotal);
    if (moqShort.length > 0) {
      text += " — " + moqShort.length + " item" + (moqShort.length === 1 ? "" : "s") + " below MOQ";
    } else if (orderMinimumCents !== null && subtotal < orderMinimumCents) {
      text += " — minimum " + formatMoney(orderMinimumCents);
    }
    summaryEl.textContent = text;
    summaryEl.hidden = false;
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

  function submitOrder(content, submitBtn, summaryEl, resultEl) {
    var lines = getOrderLines(content);
    if (lines.length === 0) {
      showOrderResult(resultEl, false, "Enter quantities before submitting.");
      return;
    }
    var short = lines.filter(function (l) { return l.quantity < l.moq; });
    if (short.length > 0) {
      showOrderResult(
        resultEl, false,
        "Some quantities are below the minimum order quantity — highlighted in the Qty column."
      );
      return;
    }

    var original = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting order…";
    if (resultEl) resultEl.hidden = true;

    fetch("/apps/wholesale/linesheet-order", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lines: lines.map(function (l) {
          return { variant_id: l.variant_id, quantity: l.quantity };
        }),
      }),
    })
      .then(function (r) {
        return r
          .json()
          .catch(function () { throw new Error("HTTP " + r.status); })
          .then(function (data) {
            if (!r.ok) {
              var e = new Error((data && data.error) || "HTTP " + r.status);
              e.userFacing = !!(data && data.error);
              throw e;
            }
            return data;
          });
      })
      .then(function (data) {
        if (!data || !data.ok) throw new Error((data && data.error) || "Order failed");
        var msg = "Order " + (data.order_name || "") + " submitted (" +
          formatMoney(data.subtotal_cents) + ")." +
          (data.payment_terms === "NET_30" ? " Payment terms: Net 30." :
           data.payment_terms === "NET_60" ? " Payment terms: Net 60." : "");
        showOrderResult(resultEl, true, msg, data.invoice_url);
        content.querySelectorAll(".wh-ls-qty-input").forEach(function (i) { i.value = ""; });
        updateSummary(content, summaryEl);
        submitBtn.disabled = false;
        submitBtn.textContent = original;
      })
      .catch(function (err) {
        showOrderResult(
          resultEl, false,
          err && err.userFacing ? err.message : "Could not submit order. Please try again or contact us."
        );
        console.error("[linesheet] order error:", err);
        submitBtn.disabled = false;
        submitBtn.textContent = original;
      });
  }

  /* -------------------------------------------------------------------------
     PDF download via html2pdf.js
     ---------------------------------------------------------------------- */

  function downloadPDF(contentEl, btn) {
    if (typeof html2pdf === "undefined") {
      alert("PDF export is loading — please try again in a moment.");
      return;
    }

    var original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Generating PDF…";

    html2pdf()
      .set({
        margin: [8, 8],
        filename: "cwandt-wholesale-linesheet.pdf",
        image: { type: "jpeg", quality: 0.88 },
        html2canvas: { scale: 2, useCORS: true, logging: false },
        jsPDF: { unit: "mm", format: "a4", orientation: "landscape" },
        pagebreak: { mode: ["avoid-all", "css"] },
      })
      .from(contentEl)
      .save()
      .then(function () {
        btn.disabled = false;
        btn.textContent = original;
      })
      .catch(function () {
        btn.disabled = false;
        btn.textContent = original;
      });
  }

  /* -------------------------------------------------------------------------
     Main init
     ---------------------------------------------------------------------- */

  function init() {
    var content   = document.getElementById("wh-linesheet-content");
    var loading   = document.getElementById("wh-linesheet-loading");
    var printBtn  = document.getElementById("wh-ls-print");
    var dlBtn     = document.getElementById("wh-ls-download");
    var submitBtn = document.getElementById("wh-ls-submit-order");
    var summaryEl = document.getElementById("wh-ls-summary");
    var resultEl  = document.getElementById("wh-ls-order-result");

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

      content.innerHTML = buildHTML(data);
      content.removeAttribute("hidden");

      // Wire qty inputs → live summary (subtotal, MOQ shortfalls, minimum)
      content.addEventListener("input", function (e) {
        if (e.target && e.target.classList.contains("wh-ls-qty-input")) {
          updateSummary(content, summaryEl);
        }
      });

      if (printBtn) {
        printBtn.addEventListener("click", function () { window.print(); });
      }

      if (dlBtn) {
        dlBtn.addEventListener("click", function () { downloadPDF(content, dlBtn); });
      }

      if (submitBtn) {
        submitBtn.addEventListener("click", function () {
          submitOrder(content, submitBtn, summaryEl, resultEl);
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
