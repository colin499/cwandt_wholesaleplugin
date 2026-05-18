/**
 * CW&T Wholesale Line Sheet — client-side renderer
 *
 * Fetches all wholesale product data from the App Proxy (/apps/wholesale/linesheet-data),
 * renders a grouped product table, and wires up Print, Download PDF, and Add to Cart actions.
 *
 * Reads wholesale status from sessionStorage / <meta name="wh-customer"> (same mechanism
 * as wholesale.js) — no async customer status fetch required.
 *
 * Bundle sizes are read from the data-bundle-sizes attribute on .wh-linesheet (set by the
 * Liquid block from merchant-configurable settings, default "6,12,24").
 *
 * html2pdf.js must be loaded before this script runs (loaded via the Liquid block).
 */

(function () {
  "use strict";

  var SK_STATUS    = "wh_status";
  var SK_LINESHEET = "wh_linesheet_v1"; // versioned key — bump if response shape changes

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
     Bundle size config — read from data-bundle-sizes attribute on .wh-linesheet
     ---------------------------------------------------------------------- */

  function parseBundleSizes(container) {
    var raw = container ? container.getAttribute("data-bundle-sizes") : "";
    if (!raw) return [6, 12, 24];
    var sizes = raw
      .split(",")
      .map(function (s) { return parseInt(s.trim(), 10); })
      .filter(function (n) { return !isNaN(n) && n > 0; });
    return sizes.length > 0 ? sizes : [6, 12, 24];
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

  function buildQtySelectHTML(variantId, bundleSizes, disabled) {
    var disabledAttr = disabled ? " disabled" : "";
    var opts = '<option value="0">—</option>';
    bundleSizes.forEach(function (size) {
      opts += "<option value=\"" + size + "\">" + size + "</option>";
    });
    return (
      "<select class=\"wh-ls-qty-select\"" +
      " data-variant-id=\"" + variantId + "\"" +
      disabledAttr + ">" + opts + "</select>"
    );
  }

  /* -------------------------------------------------------------------------
     Build the full line sheet HTML from API response data
     ---------------------------------------------------------------------- */

  function buildHTML(data, bundleSizes) {
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
          // Backorder variants (available but no inventory) must not go through /cart/add.js —
          // they need the Draft Order flow (wholesale.js on the product page handles this).
          // TODO: support backorders from the line sheet by splitting the cart submission:
          //   in-stock items → /cart/add.js, backorder items → POST /apps/wholesale/backorder.
          //   Until then, disable the qty select so customers use the product page for backorders.
          var isBackorder = variant.available && variant.in_stock === 0;
          var selectDisabled = outOfStock || isBackorder;

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

          // Qty select — disabled for out-of-stock and backorder variants (see TODO above)
          html += '<td class="wh-ls-col-qty wh-no-print">';
          html += buildQtySelectHTML(variant.id, bundleSizes, selectDisabled);
          html += "</td>";

          html += "</tr>";
        });
      });

      html += "</tbody></table></section>";
    });

    return html;
  }

  /* -------------------------------------------------------------------------
     Cart helpers — read selected quantities, update count display, submit
     ---------------------------------------------------------------------- */

  function getCartItems(content) {
    var items = [];
    content.querySelectorAll(".wh-ls-qty-select").forEach(function (select) {
      var qty = parseInt(select.value, 10) || 0;
      if (qty > 0) {
        items.push({
          id: parseInt(select.getAttribute("data-variant-id"), 10),
          quantity: qty,
        });
      }
    });
    return items;
  }

  function updateCartCount(content, cartCountEl) {
    if (!cartCountEl) return;
    var selects = content.querySelectorAll(".wh-ls-qty-select");
    var total = 0;
    selects.forEach(function (select) {
      total += parseInt(select.value, 10) || 0;
    });
    if (total > 0) {
      cartCountEl.textContent = total + " item" + (total === 1 ? "" : "s") + " selected";
      cartCountEl.hidden = false;
    } else {
      cartCountEl.textContent = "";
      cartCountEl.hidden = true;
    }
  }

  function submitCart(content, addBtn, cartCountEl) {
    var items = getCartItems(content);
    if (items.length === 0) {
      alert("Select quantities before adding to cart.");
      return;
    }

    var original = addBtn.textContent;
    addBtn.disabled = true;
    addBtn.textContent = "Adding…";

    fetch("/cart/add.js", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ items: items }),
    })
      .then(function (r) {
        if (!r.ok) {
          return r.json().then(function (d) {
            throw new Error(d.description || "Failed to add to cart");
          });
        }
        return r.json();
      })
      .then(function () {
        addBtn.textContent = "Added to cart!";
        // Reset all selects to zero
        content.querySelectorAll(".wh-ls-qty-select").forEach(function (s) {
          s.value = "0";
        });
        updateCartCount(content, cartCountEl);
        setTimeout(function () {
          addBtn.disabled = false;
          addBtn.textContent = original;
        }, 2500);
      })
      .catch(function (err) {
        addBtn.textContent = "Error — try again";
        console.error("[linesheet] Cart add error:", err.message);
        setTimeout(function () {
          addBtn.disabled = false;
          addBtn.textContent = original;
        }, 3000);
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
    var container = document.querySelector(".wh-linesheet");
    var content   = document.getElementById("wh-linesheet-content");
    var loading   = document.getElementById("wh-linesheet-loading");
    var printBtn  = document.getElementById("wh-ls-print");
    var dlBtn     = document.getElementById("wh-ls-download");
    var addBtn    = document.getElementById("wh-ls-add-to-cart");
    var cartCount = document.getElementById("wh-ls-cart-count");

    if (!content) return;

    var bundleSizes = parseBundleSizes(container);

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

      content.innerHTML = buildHTML(data, bundleSizes);
      content.removeAttribute("hidden");

      // Wire qty selects → live cart count
      content.querySelectorAll(".wh-ls-qty-select").forEach(function (select) {
        select.addEventListener("change", function () {
          updateCartCount(content, cartCount);
        });
      });

      if (printBtn) {
        printBtn.addEventListener("click", function () { window.print(); });
      }

      if (dlBtn) {
        dlBtn.addEventListener("click", function () { downloadPDF(content, dlBtn); });
      }

      if (addBtn) {
        addBtn.addEventListener("click", function () { submitCart(content, addBtn, cartCount); });
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
