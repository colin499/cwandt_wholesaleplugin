/**
 * CW&T Wholesale UI — client-side controller
 *
 * HOW THE LOGIN-DELAY BUG IS FIXED
 * ---------------------------------
 * Old approach (broken): JavaScript calls fetch('/account') after page load
 * to determine if the customer is wholesale → async → retail prices flash first.
 *
 * New approach (fixed): The server-side Liquid badge block renders a
 * <meta name="wh-customer" content="1|0"> tag synchronously during HTML
 * generation. JavaScript reads this tag immediately — no async call, no wait,
 * no race condition. The customer's identity is known BEFORE any script runs.
 *
 * Additionally, the wholesale-price Liquid block uses {% style %} to emit
 * CSS that hides retail price elements server-side, so even if JS is slow
 * to load, retail prices are never painted for wholesale customers.
 *
 * sessionStorage is used so that within a browser session, subsequent page
 * loads resolve even faster (skip the meta tag read entirely).
 */

(function () {
  "use strict";

  // Idempotent: the script is loaded by both the badge block (site-wide) and the
  // price block (product pages), so on a product page it can be included twice.
  if (window.__whWholesaleInit) return;
  window.__whWholesaleInit = true;

  var SK_STATUS = "wh_status";    // "1" | "0"
  var SK_PRICES = "wh_prices4_";  // + productId → JSON (v4: adds dist_price)

  /* -------------------------------------------------------------------------
     1. Determine wholesale status
        Fast path: sessionStorage cache (instant, all pages after first visit)
        Fast path: <meta name="wh-customer"> set by badge block (instant, product pages)
        Async fallback: /apps/wholesale/status endpoint (other pages, first visit only)
     ---------------------------------------------------------------------- */

  function resolveWholesaleStatus(callback) {
    var cached = sessionStorage.getItem(SK_STATUS);
    if (cached !== null) { callback(cached === "1"); return; }

    var meta = document.querySelector('meta[name="wh-customer"]');
    if (meta) {
      var fromMeta = meta.getAttribute("content") === "1";
      sessionStorage.setItem(SK_STATUS, fromMeta ? "1" : "0");
      callback(fromMeta);
      return;
    }

    // No meta tag on this page — ask the server (result cached in sessionStorage).
    fetch("/apps/wholesale/status", { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var isWholesale = !!(data && data.wholesale);
        sessionStorage.setItem(SK_STATUS, isWholesale ? "1" : "0");
        callback(isWholesale);
      })
      .catch(function () {
        sessionStorage.setItem(SK_STATUS, "0");
        callback(false);
      });
  }

  /* -------------------------------------------------------------------------
     2. Price formatting
     ---------------------------------------------------------------------- */

  function formatMoney(cents, currency) {
    return (cents / 100).toLocaleString("en-US", {
      style: "currency",
      currency: currency || "USD",
      minimumFractionDigits: 2,
    });
  }

  /* -------------------------------------------------------------------------
     3. Fetch wholesale prices from the App Proxy (with sessionStorage cache)
     ---------------------------------------------------------------------- */

  function fetchWholesalePrices(productId, qty, callback) {
    var cacheKey = SK_PRICES + productId;
    var raw = sessionStorage.getItem(cacheKey);

    if (raw) {
      try {
        callback(null, JSON.parse(raw));
        return;
      } catch (_) {
        sessionStorage.removeItem(cacheKey);
      }
    }

    var url =
      "/apps/wholesale/prices?product_id=" +
      encodeURIComponent(productId) +
      "&qty=" +
      encodeURIComponent(qty || 1);

    fetch(url, { credentials: "same-origin" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        if (data && data.wholesale) {
          try {
            sessionStorage.setItem(cacheKey, JSON.stringify(data));
          } catch (_) { /* storage full */ }
        }
        callback(null, data);
      })
      .catch(function (err) {
        callback(err, null);
      });
  }

  /* -------------------------------------------------------------------------
     4. Price block updater — fills in variant prices and shows the block
     ---------------------------------------------------------------------- */

  function applyVariantPrice(variantsData, selectedVariantId, productForm) {
    var block    = document.getElementById("wh-price-block");
    var skeleton = document.querySelector(".wh-price-skeleton"); // sibling of the block, not a child
    var priceEl  = document.getElementById("wh-price-amount");
    var distEl   = document.getElementById("wh-price-dist");
    var distRow  = document.getElementById("wh-row-dist");
    var msrpEl   = document.getElementById("wh-price-msrp");
    var msrpRow  = document.getElementById("wh-row-msrp");
    var moqEl    = document.getElementById("wh-price-moq");
    var moqRow   = document.getElementById("wh-row-moq");
    var caseEl   = document.getElementById("wh-price-case");
    var caseRow  = document.getElementById("wh-row-case");
    var stockEl  = document.getElementById("wh-price-stock");
    var stockRow = document.getElementById("wh-row-stock");
    var noteEl   = document.getElementById("wh-discount-note");

    if (!block || !variantsData) return;

    var variant = null;
    for (var i = 0; i < variantsData.length; i++) {
      if (variantsData[i].id === selectedVariantId) {
        variant = variantsData[i];
        break;
      }
    }
    // Only fall back to the first variant when no selection could be read.
    // A selected variant that is missing from the list is NOT wholesale
    // (not in the CMS, hidden, or product inactive) — say so instead of
    // silently showing another variant's price.
    if (!variant && !selectedVariantId) variant = variantsData[0];
    if (!variant) {
      if (priceEl) priceEl.textContent = "—";
      if (distRow) distRow.setAttribute("hidden", "");
      if (msrpRow) msrpRow.setAttribute("hidden", "");
      if (moqRow) moqRow.setAttribute("hidden", "");
      if (caseRow) caseRow.setAttribute("hidden", "");
      if (stockRow) stockRow.setAttribute("hidden", "");
      if (noteEl) noteEl.textContent = "This option is not available for wholesale.";
      block.removeAttribute("hidden");
      if (skeleton) skeleton.setAttribute("hidden", "");
      return;
    }

    if (priceEl) priceEl.textContent = formatMoney(variant.wh_price);

    // Distributor accounts get an extra row with their effective price.
    if (distEl && distRow) {
      if (variant.dist_price != null) {
        distEl.textContent = formatMoney(variant.dist_price);
        distRow.removeAttribute("hidden");
      } else {
        distRow.setAttribute("hidden", "");
      }
    }

    if (msrpEl && msrpRow) {
      if (variant.retail_price > 0) {
        msrpEl.textContent = formatMoney(variant.retail_price);
        msrpRow.removeAttribute("hidden");
      } else {
        msrpRow.setAttribute("hidden", "");
      }
    }

    if (moqEl && moqRow) {
      if (variant.moq > 1) {
        moqEl.textContent = variant.moq + " UNITS";
        moqRow.removeAttribute("hidden");
      } else {
        moqRow.setAttribute("hidden", "");
      }
    }

    if (caseEl && caseRow) {
      caseEl.textContent =
        variant.case_size && variant.case_size > 1 ? String(variant.case_size) : "N/A";
      caseRow.removeAttribute("hidden");
    }

    // Enforce the MOQ on the theme's quantity input: floor at the MOQ and
    // pre-fill it. (Exempt customers receive moq: 1 from the server, so this
    // self-disables for them.) The cart page can still lower quantities —
    // this is the PDP path only; hard enforcement lives where the app creates
    // orders (the orderable linesheet).
    applyMoqToQuantityInput(productForm, variant.moq);

    var isOutOfStock = !variant.available || variant.in_stock <= 0;

    if (stockEl && stockRow) {
      if (isOutOfStock) {
        stockEl.textContent = "OUT OF STOCK";
      } else if (variant.in_stock > 10) {
        stockEl.textContent = "10+"; // mirrors the theme's own inventory display
      } else {
        stockEl.textContent = String(variant.in_stock);
      }
      stockRow.removeAttribute("hidden");
    }

    if (noteEl) {
      // Clear any leftover message (e.g. "not available for wholesale" from a
      // previous variant selection). No discount note is shown by design.
      noteEl.textContent = "";
    }

    // No PDP backorder UI: out-of-stock items are ordered on the linesheet
    // like everything else — submission splits them onto a backorder draft.
    block.removeAttribute("hidden");
    if (skeleton) skeleton.setAttribute("hidden", "");
  }

  /* -------------------------------------------------------------------------
     6b. MOQ → quantity input
     ---------------------------------------------------------------------- */

  function applyMoqToQuantityInput(productForm, moq) {
    var scope = productForm || document;
    var qtyInput = scope.querySelector('input[name="quantity"]');
    if (!qtyInput) return;

    if (moq > 1) {
      qtyInput.min = String(moq);
      var current = parseInt(qtyInput.value, 10) || 0;
      if (current < moq) {
        qtyInput.value = String(moq);
        // Let theme quantity widgets (steppers, cart estimates) react.
        qtyInput.dispatchEvent(new Event("change", { bubbles: true }));
      }
    } else {
      // Variant without MOQ (or exempt customer): restore the theme default.
      if (qtyInput.min && parseInt(qtyInput.min, 10) > 1) qtyInput.min = "1";
    }
  }

  /* -------------------------------------------------------------------------
     5. Get the currently selected variant ID from the product form
     ---------------------------------------------------------------------- */

  function getSelectedVariantId(productForm) {
    var input = productForm
      ? productForm.querySelector('[name="id"]')
      : document.querySelector('[name="id"]');
    return input ? parseInt(input.value, 10) : null;
  }

  /* -------------------------------------------------------------------------
     6. Listen for variant selector changes and re-apply prices
     ---------------------------------------------------------------------- */

  function watchVariantChanges(productForm, variantsData) {
    if (!productForm) return;

    productForm.addEventListener("variant:change", function (e) {
      var id = e.detail && e.detail.variant && e.detail.variant.id;
      if (id) applyVariantPrice(variantsData, id, productForm);
    });

    var idInput = productForm.querySelector('[name="id"]');
    if (idInput) {
      idInput.addEventListener("change", function () {
        applyVariantPrice(variantsData, parseInt(this.value, 10), productForm);
      });
    }
  }

  /* -------------------------------------------------------------------------
     7. Clear cached status on logout
     ---------------------------------------------------------------------- */

  document.querySelectorAll('a[href*="/account/logout"]').forEach(function (a) {
    a.addEventListener("click", function () {
      sessionStorage.removeItem(SK_STATUS);
      Object.keys(sessionStorage).forEach(function (k) {
        if (k.startsWith(SK_PRICES)) sessionStorage.removeItem(k);
      });
    });
  });

  /* -------------------------------------------------------------------------
     9a. Account dropdown → wholesale Orders page
         The theme's account menu (.wh-account-menu) links "Orders" to Shopify's
         hosted customer-accounts page. Wholesale customers order via draft
         orders on the linesheet, so their history lives at /pages/orders
         (wholesale-orders block) — repoint the link. This script only loads
         for wholesale-tagged customers, so retail buyers keep the theme link.
     ---------------------------------------------------------------------- */

  document.querySelectorAll(".wh-account-menu a").forEach(function (a) {
    var isOrdersLink =
      a.textContent.trim().toLowerCase() === "orders" ||
      /\/account\/orders\b/.test(a.getAttribute("href") || "");
    if (isOrdersLink) a.setAttribute("href", "/pages/orders");
  });

  // The dropdown trigger itself ("WHOLESALE : NAME") linked to Shopify's
  // hosted account page, which shows a generic order list — confusing next to
  // the wholesale order history. Send wholesale customers to the order
  // history instead; profile/addresses stay reachable via "Account Info".
  document.querySelectorAll("a.wh-account").forEach(function (a) {
    a.setAttribute("href", "/pages/orders");
  });

  /* -------------------------------------------------------------------------
     9b. Header top-right: ORDER SHEET | ORDER HISTORY
         The wholesale-global embed hides the theme's header cart link while
         the cart is empty (CSS, server-side, wholesale customers only) and
         renders a <template> with the two wholesale nav links; this inserts
         them where the cart button is/was. Same selector on both sides: if
         the theme header changes, the hide and the insert fail together and
         the header reverts to the normal cart button.
     ---------------------------------------------------------------------- */

  function installHeaderNav() {
    var tpl = document.getElementById("wh-header-nav-tpl");
    var cartLink = document.querySelector(".header__cart .custom-cart-icon");
    if (!tpl || !tpl.content || !cartLink) return;
    if (document.querySelector(".wh-header-nav")) return; // idempotent
    cartLink.parentNode.insertBefore(tpl.content.cloneNode(true), cartLink);
  }

  /* -------------------------------------------------------------------------
     10. Main init
     ---------------------------------------------------------------------- */

  function runWholesaleUI() {
    var priceBlocks = document.querySelectorAll("[data-wh-product-id]");
    priceBlocks.forEach(function (block) {
      var productId = block.dataset
        ? block.dataset.whProductId
        : block.getAttribute("data-wh-product-id");
      if (!productId) return;

      var productForm =
        block.closest("form[action*='/cart/add']") ||
        document.querySelector("form[action*='/cart/add']");

      var qty = 1;
      var qtyInput = productForm && productForm.querySelector('[name="quantity"]');
      if (qtyInput) qty = parseInt(qtyInput.value, 10) || 1;

      fetchWholesalePrices(productId, qty, function (err, data) {
        // The skeleton is a SIBLING of the price block (it shows while the
        // block is hidden), so it must be queried document-wide — a
        // block-scoped query finds nothing and leaves it pulsing forever.
        var skeletons = document.querySelectorAll(".wh-price-skeleton");

        if (err || !data || !data.wholesale) {
          skeletons.forEach(function (el) { el.setAttribute("hidden", ""); });
          return;
        }

        // Product is not in the wholesale program: hide the wholesale UI and
        // reveal the retail price the price block's CSS pre-emptively hid —
        // otherwise the customer sees no price at all on retail-only products.
        if (data.product_wholesale === false || !data.variants || data.variants.length === 0) {
          skeletons.forEach(function (el) { el.setAttribute("hidden", ""); });
          document.documentElement.classList.add("wh-show-retail");
          return;
        }

        var selectedId = getSelectedVariantId(productForm);
        applyVariantPrice(data.variants, selectedId, productForm);
        watchVariantChanges(productForm, data.variants);
      });
    });
  }

  function init() {
    resolveWholesaleStatus(function (isWholesale) {
      if (!isWholesale) {
        document.querySelectorAll(".wh-price-skeleton").forEach(function (el) {
          el.setAttribute("hidden", "");
        });
        return;
      }
      installHeaderNav();  // header: ORDER SHEET | ORDER HISTORY
      runWholesaleUI();    // product-page price block
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
