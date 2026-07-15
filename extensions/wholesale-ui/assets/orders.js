/**
 * CW&T Wholesale Orders — storefront order history page
 *
 * Fetches the customer's submitted order sheets from the App Proxy
 * (/apps/wholesale/orders) and renders them as a table with live status.
 * Clicking a row expands the order's line detail (fetched on first open).
 * Reorder copies the order into the active draft (POST /linesheet-duplicate)
 * and redirects to the order sheet page, which prefills from the draft.
 */

(function () {
  "use strict";

  // Customer-facing status copy — keys come from /apps/wholesale/orders.
  var STATUS_TEXT = {
    SUBMITTED: "Submitted",
    INVOICE_SENT: "Invoice sent",
    PREPARING: "Preparing to ship",
    PARTIALLY_SHIPPED: "Partially shipped",
    SHIPPED: "Shipped",
    CANCELLED: "Cancelled",
  };

  function statusText(key) {
    return STATUS_TEXT[key] || key;
  }

  function esc(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatMoney(cents) {
    return (cents / 100).toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
    });
  }

  function formatDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  }

  /* -------------------------------------------------------------------------
     Orders list table
     ---------------------------------------------------------------------- */

  function renderList(container, orders) {
    if (!orders || orders.length === 0) {
      container.innerHTML = '<p class="wh-ls-empty">No orders yet.</p>';
      return;
    }

    var html = '<table class="wh-ls-table wh-orders-table"><thead><tr>';
    html += "<th>Order</th><th>Date</th><th>PO #</th><th>Items</th><th>Total</th><th>Status</th>";
    html += "</tr></thead><tbody>";

    orders.forEach(function (o) {
      html +=
        '<tr class="wh-orders-row" data-order-id="' + esc(o.id) + '" tabindex="0">' +
        "<td>" + esc(o.order_name) + "</td>" +
        "<td>" + esc(formatDate(o.submitted_at)) + "</td>" +
        "<td>" + esc(o.po_number || "—") + "</td>" +
        "<td>" + o.item_count + "</td>" +
        "<td>" + formatMoney(o.subtotal_cents) + "</td>" +
        '<td class="wh-orders-status">' + esc(statusText(o.status)) + "</td>" +
        "</tr>";
    });

    html += "</tbody></table>";
    container.innerHTML = html;
  }

  /* -------------------------------------------------------------------------
     Expandable order detail
     ---------------------------------------------------------------------- */

  function buildDetailHTML(order) {
    var html = '<div class="wh-orders-detail-head">';
    html += "<span>" + esc(statusText(order.status));
    (order.tracking || []).forEach(function (t) {
      var carrier = t.company && t.company !== "Other" ? t.company : "Tracking";
      var label = carrier + (t.number ? " " + t.number : "");
      // Shopify only provides a tracking URL for carriers it recognizes —
      // fall back to a search on the number so it's always clickable.
      var url =
        t.url ||
        (t.number ? "https://www.google.com/search?q=" + encodeURIComponent(t.number) : null);
      html += url
        ? ' · <a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(label) + "</a>"
        : " · " + esc(label);
    });
    if (order.invoice_url && (order.status === "SUBMITTED" || order.status === "INVOICE_SENT")) {
      html += ' · <a href="' + esc(order.invoice_url) + '" target="_blank" rel="noopener">Review &amp; pay &rarr;</a>';
    }
    html += "</span>";
    html +=
      '<button type="button" class="wh-ls-btn wh-ls-btn--small wh-orders-reorder"' +
      ' data-order-id="' + esc(order.id) + '"' +
      ' title="Start a new order sheet with these quantities">Reorder</button>';
    html += "</div>";

    html += '<table class="wh-ls-table wh-orders-detail-table"><thead><tr>';
    html += "<th>Product</th><th>Variant</th><th>SKU</th><th>Qty</th><th>Price</th><th>Total</th>";
    html += "</tr></thead><tbody>";
    order.lines.forEach(function (l) {
      var unit = l.unit_price_cents;
      html +=
        "<tr>" +
        "<td>" + esc(l.product_title) + "</td>" +
        "<td>" + esc(l.variant_title || "—") + "</td>" +
        "<td>" + esc(l.sku || "—") + "</td>" +
        "<td>" + l.quantity + "</td>" +
        "<td>" + (unit === null ? "—" : formatMoney(unit)) + "</td>" +
        "<td>" + (unit === null ? "—" : formatMoney(unit * l.quantity)) + "</td>" +
        "</tr>";
    });
    html += "</tbody></table>";

    html += '<p class="wh-orders-detail-foot">';
    html += "TOTAL AS SUBMITTED : " + formatMoney(order.subtotal_cents);
    if (order.ship_own_label) html += " · Customer provides own shipping label";
    html += "</p>";

    return html;
  }

  function toggleDetail(row) {
    var next = row.nextElementSibling;
    if (next && next.classList.contains("wh-orders-detail")) {
      next.remove();
      return;
    }
    // Close any other open detail so only one order is expanded at a time.
    var table = row.closest("table");
    table.querySelectorAll(".wh-orders-detail").forEach(function (d) { d.remove(); });

    var detailRow = document.createElement("tr");
    detailRow.className = "wh-orders-detail";
    var cell = document.createElement("td");
    cell.colSpan = row.cells.length;
    cell.innerHTML = '<p class="wh-ls-loading">Loading order&hellip;</p>';
    detailRow.appendChild(cell);
    row.parentNode.insertBefore(detailRow, row.nextSibling);

    fetch("/apps/wholesale/orders?id=" + encodeURIComponent(row.getAttribute("data-order-id")), {
      credentials: "same-origin",
    })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        if (!data || !data.order) throw new Error("Bad response");
        cell.innerHTML = buildDetailHTML(data.order);
      })
      .catch(function (err) {
        cell.innerHTML = '<p class="wh-ls-error">Unable to load this order. Please try again.</p>';
        console.error("[orders] detail error:", err);
      });
  }

  /* -------------------------------------------------------------------------
     Reorder — copy this order into the active draft, go to the order sheet
     ---------------------------------------------------------------------- */

  function reorder(btn, linesheetUrl) {
    if (
      !window.confirm(
        "Load this order into a new order sheet? This replaces anything currently on your draft sheet."
      )
    ) {
      return;
    }
    var original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Loading…";
    fetch("/apps/wholesale/linesheet-duplicate", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draft_id: btn.getAttribute("data-order-id") }),
    })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function () {
        window.location.href = linesheetUrl;
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = original;
        console.error("[orders] reorder error:", err);
        alert("Could not load this order into a new sheet. Please try again.");
      });
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
    var root = document.querySelector(".wh-orders");
    var loading = document.getElementById("wh-orders-loading");
    var content = document.getElementById("wh-orders-content");
    if (!root || !content) return;

    var linesheetUrl = root.getAttribute("data-linesheet-url") || "/pages/linesheet";

    fetch("/apps/wholesale/orders", { credentials: "same-origin" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        if (loading) loading.setAttribute("hidden", "");
        if (!data || !data.wholesale) throw new Error("Not wholesale");
        renderList(content, data.orders);
        content.removeAttribute("hidden");
      })
      .catch(function (err) {
        if (loading) loading.setAttribute("hidden", "");
        content.innerHTML =
          '<p class="wh-ls-error">Unable to load orders. Please refresh the page or contact us.</p>';
        content.removeAttribute("hidden");
        console.error("[orders] list error:", err);
      });

    content.addEventListener("click", function (e) {
      var reorderBtn = e.target && e.target.closest ? e.target.closest(".wh-orders-reorder") : null;
      if (reorderBtn) {
        reorder(reorderBtn, linesheetUrl);
        return;
      }
      // Links inside the detail (tracking / invoice) should behave normally.
      if (e.target && e.target.closest && e.target.closest("a")) return;
      var row = e.target && e.target.closest ? e.target.closest(".wh-orders-row") : null;
      if (row) toggleDetail(row);
    });

    content.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" && e.key !== " ") return;
      var row = e.target && e.target.classList && e.target.classList.contains("wh-orders-row")
        ? e.target
        : null;
      if (row) {
        e.preventDefault();
        toggleDetail(row);
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
