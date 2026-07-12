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
  var SK_PRICES = "wh_prices2_";  // + productId → JSON (v2: adds product_wholesale flag)
  var SK_CATALOG = "wh_catalog_"; // + handle → JSON (catalog-card price)

  // Catalog-card "Wholesale $X" labels on collection/search/home pages.
  // Targets the Horizon card structure (live DOM 2026-06-22):
  //   • card root:  .product-card__content
  //   • real price: <product-price> .price__regular > span.price   (e.g. "$1.00")
  //   • label is inserted right after the <product-price> block (below retail,
  //     in the card content area — never over the .card-gallery image).
  var ENABLE_CATALOG_LABELS = true;

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
        // Read the body even on error statuses — the server sends specific,
        // user-facing reasons (e.g. the MOQ minimum) in { error }.
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
        if (data && data.ok) {
          btn.setAttribute("hidden", "");
          if (msgEl) {
            msgEl.textContent = ""; // clear any previous error before writing
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
          throw new Error((data && data.error) || "Backorder failed");
        }
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = "Place Backorder";
        if (msgEl) {
          msgEl.textContent = err && err.userFacing
            ? err.message
            : "Could not place backorder. Please contact us.";
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
    var skeleton = document.querySelector(".wh-price-skeleton"); // sibling of the block, not a child
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
    // Only fall back to the first variant when no selection could be read.
    // A selected variant that is missing from the list is NOT wholesale
    // (not in the CMS, hidden, or product inactive) — say so instead of
    // silently showing another variant's price.
    if (!variant && !selectedVariantId) variant = variantsData[0];
    if (!variant) {
      if (priceEl) priceEl.textContent = "—";
      if (moqEl) moqEl.setAttribute("hidden", "");
      if (stockEl) { stockEl.textContent = ""; stockEl.className = "wh-price-stock"; }
      if (noteEl) noteEl.textContent = "This option is not available for wholesale.";
      var unavailForm = block.querySelector(".wh-backorder-form");
      if (unavailForm) unavailForm.setAttribute("hidden", "");
      block.removeAttribute("hidden");
      if (skeleton) skeleton.setAttribute("hidden", "");
      return;
    }

    if (priceEl) priceEl.textContent = formatMoney(variant.wh_price);

    if (moqEl) {
      if (variant.moq > 1) {
        moqEl.textContent = "Minimum order: " + variant.moq + " units";
        moqEl.removeAttribute("hidden");
      } else {
        moqEl.setAttribute("hidden", "");
      }
    }

    // Enforce the MOQ on the theme's quantity input: floor at the MOQ and
    // pre-fill it. (Exempt customers receive moq: 1 from the server, so this
    // self-disables for them.) The cart page can still lower quantities —
    // this is the PDP path only; hard enforcement lives where the app creates
    // orders (backorder, orderable linesheet).
    applyMoqToQuantityInput(productForm, variant.moq);

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
     9b. Catalog-card price labels (collection / search / home pages)
         Shows "Wholesale $X" next to the retail price on each product card.
         Append-only: never hides the theme's price, so no flicker and no
         dependency on theme-specific price-hiding selectors.
     ---------------------------------------------------------------------- */

  // Find product cards on the page and the product handle each one links to.
  // Horizon-first: each card is a `.product-card__content` whose price lives in a
  // <product-price> element. We query the card roots directly (one entry per card,
  // so no per-anchor duplicates), with a generic fallback for other themes.
  function collectProductCards() {
    var roots = document.querySelectorAll(".product-card__content");
    if (roots.length === 0) {
      // Fallback for non-Horizon themes: common grid/card containers.
      roots = document.querySelectorAll(
        'li.grid__item, .grid__item, .card-wrapper'
      );
    }

    var cards = [];
    for (var i = 0; i < roots.length; i++) {
      var root = roots[i];
      if (root.__whLabeled) continue;
      // Skip the main product block on a PDP — handled by the price block.
      if (root.querySelector("[data-wh-product-id]")) continue;

      var link = root.querySelector('a[href*="/products/"]');
      if (!link) continue;
      var m = (link.getAttribute("href") || "").match(/\/products\/([^/?#]+)/);
      if (!m) continue;

      root.__whLabeled = true;
      cards.push({ container: root, handle: decodeURIComponent(m[1]) });
    }
    return cards;
  }

  // Locate the card's visible retail price element.
  function findCardPriceEl(container) {
    // Horizon: <product-price> wraps the regular price in .price__regular .price.
    var pp = container.querySelector("product-price");
    if (pp) {
      return pp.querySelector(".price__regular .price") || pp.querySelector(".price") || pp;
    }
    // Generic fallback: a leaf price element that isn't inside the media/gallery.
    var candidates = container.querySelectorAll('[class*="price"]');
    for (var i = candidates.length - 1; i >= 0; i--) {
      var el = candidates[i];
      if (el.querySelector('[class*="price"]')) continue; // prefer leaf-ish
      if (el.closest('[class*="media"], [class*="gallery"], [class*="image"]')) continue;
      if (/\d/.test(el.textContent || "")) return el;
    }
    return null;
  }

  function injectCardLabel(container, info) {
    if (container.querySelector(".wh-card-price")) return;
    var label = document.createElement("span");
    label.className = "wh-card-price";
    var prefix = info.varies ? "Wholesale from " : "Wholesale ";
    label.textContent = prefix + formatMoney(info.wh_min, info.currency_code);

    // Preferred (Horizon): place the label directly after the whole
    // <product-price> block, so it sits below the retail price in the card's
    // content area — never overlaying the image.
    var pp = container.querySelector("product-price");
    if (pp && pp.parentNode) {
      pp.parentNode.insertBefore(label, pp.nextSibling);
      return;
    }

    var priceEl = findCardPriceEl(container);
    if (priceEl && priceEl.parentNode) {
      priceEl.parentNode.insertBefore(label, priceEl.nextSibling);
    } else {
      container.appendChild(label); // safe fallback: end of card
    }
  }

  // Batch-fetch wholesale prices for a list of handles, with per-handle cache.
  function fetchCatalogPrices(handles, callback) {
    var result = {};
    var missing = [];
    handles.forEach(function (h) {
      var raw = sessionStorage.getItem(SK_CATALOG + h);
      if (raw) {
        try { result[h] = JSON.parse(raw); return; } catch (_) {}
      }
      missing.push(h);
    });

    if (missing.length === 0) { callback({ products: result }); return; }

    // Chunk to stay under the endpoint's 50-handle cap.
    var chunks = [];
    for (var i = 0; i < missing.length; i += 50) chunks.push(missing.slice(i, i + 50));

    Promise.all(
      chunks.map(function (chunk) {
        var url =
          "/apps/wholesale/catalog-prices?handles=" +
          encodeURIComponent(chunk.join(","));
        return fetch(url, { credentials: "same-origin" })
          .then(function (r) { return r.ok ? r.json() : null; })
          .catch(function () { return null; });
      })
    ).then(function (responses) {
      responses.forEach(function (data) {
        if (!data || !data.products) return;
        Object.keys(data.products).forEach(function (h) {
          result[h] = data.products[h];
          try { sessionStorage.setItem(SK_CATALOG + h, JSON.stringify(data.products[h])); } catch (_) {}
        });
      });
      callback({ products: result });
    });
  }

  function runCatalogLabels() {
    // Never run on a product page — the price block owns the main product's
    // wholesale price there. Without this, the catalog label is injected next to
    // the theme's PDP price, duplicating the price block.
    if (/\/products\//.test(window.location.pathname)) return;
    if (document.querySelector("[data-wh-product-id]")) return;

    var cards = collectProductCards();
    if (cards.length === 0) return;

    var handles = cards.map(function (c) { return c.handle; });
    var unique = handles.filter(function (h, i) { return handles.indexOf(h) === i; });

    fetchCatalogPrices(unique, function (data) {
      if (!data || !data.products) return;
      cards.forEach(function (c) {
        var info = data.products[c.handle];
        if (info) injectCardLabel(c.container, info);
      });
    });
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
      runWholesaleUI();    // product-page price block
      if (ENABLE_CATALOG_LABELS) runCatalogLabels(); // collection / search / home card labels
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
