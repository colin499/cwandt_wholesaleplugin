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

  var SK_STATUS = "wh_status";   // "1" | "0"
  var SK_PRICES = "wh_prices_";  // + productId → JSON

  /* -------------------------------------------------------------------------
     1. Determine wholesale status — synchronous, no async fetch
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
     2. Price formatting
     ---------------------------------------------------------------------- */

  function formatMoney(cents) {
    return (cents / 100).toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
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
     4. Backorder submission
     ---------------------------------------------------------------------- */

  function submitBackorder(btn, msgEl, variantId, productId, qty) {
    btn.disabled = true;
    btn.textContent = "Placing backorder…";

    var body = new URLSearchParams();
    body.set("variant_id", String(variantId));
    body.set("product_id", String(productId || ""));
    body.set("quantity", String(qty || 1));

    fetch("/apps/wholesale/backorder", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        if (data && data.ok) {
          btn.setAttribute("hidden", "");
          if (msgEl) {
            msgEl.className = "wh-backorder-msg wh-backorder-msg--success";
            msgEl.removeAttribute("hidden");
            var successText = document.createTextNode(
              "Backorder placed" + (data.order_name ? " (" + data.order_name + ")" : "") + ". "
            );
            msgEl.appendChild(successText);
            if (data.invoice_url) {
              var link = document.createElement("a");
              link.href = data.invoice_url;
              link.className = "wh-backorder-link";
              link.textContent = "Review & pay →";
              msgEl.appendChild(link);
            }
          }
        } else {
          throw new Error(data.error || "Backorder failed");
        }
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = "Place Backorder";
        if (msgEl) {
          msgEl.textContent = "Could not place backorder. Please contact us.";
          msgEl.className = "wh-backorder-msg wh-backorder-msg--error";
          msgEl.removeAttribute("hidden");
        }
        console.error("[wholesale] backorder error:", err);
      });
  }

  /* -------------------------------------------------------------------------
     5. Build the backorder form and attach it to the price block
     ---------------------------------------------------------------------- */

  function buildBackorderForm(variant, productId, productForm) {
    var wrap = document.createElement("div");
    wrap.className = "wh-backorder-form";

    var note = document.createElement("p");
    note.className = "wh-backorder-note";
    note.textContent =
      "This item is out of stock. Place a backorder and we’ll ship when available.";

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "wh-backorder-btn";
    btn.textContent = "Place Backorder";

    var msg = document.createElement("div");
    msg.className = "wh-backorder-msg";
    msg.setAttribute("hidden", "");

    wrap.appendChild(note);
    wrap.appendChild(btn);
    wrap.appendChild(msg);

    btn.addEventListener("click", function () {
      var qty = 1;
      if (productForm) {
        var qtyInput = productForm.querySelector('[name="quantity"]');
        if (qtyInput) qty = parseInt(qtyInput.value, 10) || 1;
      }
      submitBackorder(btn, msg, variant.id, productId, qty);
    });

    return wrap;
  }

  /* -------------------------------------------------------------------------
     6. Price block updater — fills in variant prices and shows the block
     ---------------------------------------------------------------------- */

  function applyVariantPrice(variantsData, selectedVariantId, productForm) {
    var block    = document.getElementById("wh-price-block");
    var skeleton = document.querySelector(".wh-price-skeleton");
    var priceEl  = document.getElementById("wh-price-amount");
    var moqEl    = document.getElementById("wh-price-moq");
    var stockEl  = document.getElementById("wh-price-stock");
    var noteEl   = document.getElementById("wh-discount-note");

    if (!block || !variantsData) return;

    var variant = null;
    for (var i = 0; i < variantsData.length; i++) {
      if (variantsData[i].id === selectedVariantId) {
        variant = variantsData[i];
        break;
      }
    }
    if (!variant) variant = variantsData[0];
    if (!variant) return;

    if (priceEl) priceEl.textContent = formatMoney(variant.wh_price);

    if (moqEl) {
      if (variant.moq > 1) {
        moqEl.textContent = "Minimum order: " + variant.moq + " units";
        moqEl.removeAttribute("hidden");
      } else {
        moqEl.setAttribute("hidden", "");
      }
    }

    var isOutOfStock = !variant.available || variant.in_stock <= 0;

    if (stockEl) {
      if (isOutOfStock) {
        stockEl.textContent = "Out of stock";
        stockEl.className = "wh-price-stock wh-price-stock--out";
      } else {
        stockEl.textContent = "";
        stockEl.className = "wh-price-stock";
      }
    }

    if (noteEl) {
      noteEl.textContent = variant.discount_percent + "% off retail";
    }

    // Backorder button — show when out of stock, hide when in stock
    var productId = block.dataset ? block.dataset.whProductId : block.getAttribute("data-wh-product-id");
    var existingForm = block.querySelector(".wh-backorder-form");

    if (isOutOfStock) {
      if (!existingForm) {
        var backorderForm = buildBackorderForm(variant, productId, productForm);
        block.appendChild(backorderForm);
      } else {
        // Update variant id for the existing button (variant changed while form was open)
        existingForm.removeAttribute("hidden");
        var oldBtn = existingForm.querySelector(".wh-backorder-btn");
        var oldMsg = existingForm.querySelector(".wh-backorder-msg");
        if (oldBtn) {
          oldBtn.disabled = false;
          oldBtn.textContent = "Place Backorder";
          oldBtn.removeAttribute("hidden");
          // Re-wire click with new variant
          var newBtn = oldBtn.cloneNode(true);
          oldBtn.parentNode.replaceChild(newBtn, oldBtn);
          var capturedVariant = variant;
          var capturedProductId = productId;
          var capturedForm = productForm;
          newBtn.addEventListener("click", function () {
            var qty = 1;
            if (capturedForm) {
              var qtyInput = capturedForm.querySelector('[name="quantity"]');
              if (qtyInput) qty = parseInt(qtyInput.value, 10) || 1;
            }
            submitBackorder(newBtn, oldMsg, capturedVariant.id, capturedProductId, qty);
          });
        }
        if (oldMsg) {
          oldMsg.textContent = "";
          oldMsg.className = "wh-backorder-msg";
          oldMsg.setAttribute("hidden", "");
        }
      }
    } else {
      if (existingForm) existingForm.setAttribute("hidden", "");
    }

    block.removeAttribute("hidden");
    if (skeleton) skeleton.setAttribute("hidden", "");
  }

  /* -------------------------------------------------------------------------
     7. Get the currently selected variant ID from the product form
     ---------------------------------------------------------------------- */

  function getSelectedVariantId(productForm) {
    var input = productForm
      ? productForm.querySelector('[name="id"]')
      : document.querySelector('[name="id"]');
    return input ? parseInt(input.value, 10) : null;
  }

  /* -------------------------------------------------------------------------
     8. Listen for variant selector changes and re-apply prices
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
     9. Clear cached status on logout
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
     10. Main init
     ---------------------------------------------------------------------- */

  function init() {
    var isWholesale = getWholesaleStatus();

    if (!isWholesale) {
      document.querySelectorAll(".wh-price-skeleton").forEach(function (el) {
        el.setAttribute("hidden", "");
      });
      return;
    }

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
        if (err || !data || !data.wholesale) {
          block.querySelectorAll(".wh-price-skeleton").forEach(function (el) {
            el.setAttribute("hidden", "");
          });
          return;
        }

        var selectedId = getSelectedVariantId(productForm);
        applyVariantPrice(data.variants, selectedId, productForm);
        watchVariantChanges(productForm, data.variants);
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
