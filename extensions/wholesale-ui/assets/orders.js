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
    DRAFT: "Draft",
    SUBMITTED: "Submitted",
    INVOICE_SENT: "Invoice sent",
    PREPARING: "Preparing to ship",
    PARTIALLY_SHIPPED: "Partially shipped",
    SHIPPED: "Shipped",
    CANCELLED: "Cancelled",
    REFUNDED: "Refunded",
  };

  // Plain-language explanation shown when an order is expanded. One sentence,
  // no status jargon — the STATUS column already names the state.
  var STATUS_TIP = {
    DRAFT: "Your order is in draft mode. CW&T won't see it until you submit.",
    SUBMITTED: "CW&T has received your order. Pay the invoice when you're ready and we'll prepare for shipment. Items will be reserved for 24 hours.",
    INVOICE_SENT: "We've emailed your invoice. Once it's paid we'll start preparing your shipment.",
    PREPARING: "Your order is confirmed and we're preparing to ship.",
    PARTIALLY_SHIPPED: "Part of this order is on its way. The rest ships when it's ready.",
    SHIPPED: "Your order is on its way.",
    CANCELLED: "This order was cancelled. If that's unexpected, please get in touch.",
    REFUNDED: "This order was returned and refunded.",
  };

  // SUBMITTED has two special flavors that change what happens next, and a
  // PREPARING order can carry a balance after items were added to it.
  function statusTip(order) {
    if (order.status === "SUBMITTED" || order.status === "INVOICE_SENT") {
      if (order.freight_quote) {
        return "This order includes items that require a shipping quote, we'll email your invoice once shipping is quoted.";
      }
      if (order.backorder) {
        return "Everything on this order is on backorder. We'll send your invoice when stock arrives and is ready to ship.";
      }
    }
    if (order.status === "PREPARING" && order.balance_due_cents > 0) {
      return "Items were added to this order. Please pay the remaining balance of " +
        formatMoney(order.balance_due_cents) + " and we'll ship everything together.";
    }
    return STATUS_TIP[order.status] || "";
  }

  // Edit context rides in sessionStorage: the linesheet reads it to load the
  // EDITING session and submit an in-place order update.
  var EDIT_KEY = "wh-edit-order";
  function setEditContext(ctx) {
    try { sessionStorage.setItem(EDIT_KEY, JSON.stringify(ctx)); } catch (e) { /* ignore */ }
  }
  function clearEditContext() {
    try { sessionStorage.removeItem(EDIT_KEY); } catch (e) { /* ignore */ }
  }

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

  // Linesheet page URL (set in init from the block's data attribute).
  var sheetUrl = "/pages/linesheet";

  // True when the working draft has items (set by renderList) — Reorder
  // replaces the draft, so it confirms first when that would lose anything.
  var hasDraftItems = false;

  function editButtonHTML(o, secondary) {
    return (
      '<button type="button" class="wh-ls-btn wh-ls-btn--small wh-orders-edit' +
      (secondary ? " wh-orders-action-2" : "") + '"' +
      ' data-order-id="' + esc(o.id) + '"' +
      ' data-draft-order-id="' + esc(o.draft_order_id) + '"' +
      ' data-order-name="' + esc(o.order_name) + '"' +
      ' data-paid="' + (o.status === "PREPARING" ? "1" : "") + '"' +
      ' title="Open this order on the sheet and update it in place">Edit</button>'
    );
  }

  // ACTIONS column: primary action (or note) first, then EDIT while the
  // order is still editable. Unpaid orders edit fully in place; a paid but
  // unshipped order (PREPARING) accepts additions only, and carries a PAY
  // BALANCE link once items were added. From first shipment on: Reorder.
  function actionsHTML(o) {
    if (o.status === "DRAFT") {
      return (
        '<button type="button" class="wh-ls-btn wh-ls-btn--small wh-ls-btn--cart wh-orders-submit"' +
        ' data-order-id="' + esc(o.id) + '">Submit order</button>' +
        '<a class="wh-ls-btn wh-ls-btn--small wh-orders-action-2" href="' + esc(sheetUrl) + '">Edit</a>'
      );
    }
    if (o.status === "SUBMITTED" || o.status === "INVOICE_SENT") {
      var html;
      if (o.invoice_url) {
        html =
          '<a class="wh-ls-btn wh-ls-btn--small wh-ls-btn--cart" href="' + esc(o.invoice_url) +
          '" target="_blank" rel="noopener">Make payment</a>';
      } else {
        html =
          '<span class="wh-orders-note">' +
          (o.freight_quote
            ? "Freight quote pending"
            : o.backorder
              ? "Invoiced when stock ships"
              : "Awaiting invoice") +
          "</span>";
      }
      if (o.draft_order_id) html += editButtonHTML(o, true);
      return html;
    }
    if (o.status === "PREPARING") {
      var h = "";
      if (o.pay_balance_url && o.balance_due_cents > 0) {
        h +=
          '<a class="wh-ls-btn wh-ls-btn--small wh-ls-btn--cart" href="' + esc(o.pay_balance_url) +
          '" target="_blank" rel="noopener">Pay balance</a>';
      }
      if (o.draft_order_id) h += editButtonHTML(o, h !== "");
      return h;
    }
    if (o.status === "PARTIALLY_SHIPPED" || o.status === "SHIPPED" || o.status === "CANCELLED" || o.status === "REFUNDED") {
      return (
        '<button type="button" class="wh-ls-btn wh-ls-btn--small wh-orders-reorder"' +
        ' data-order-id="' + esc(o.id) + '"' +
        ' title="Create a new draft order with these quantities">Reorder</button>'
      );
    }
    return "";
  }

  function renderList(container, orders) {
    orders = orders || [];
    hasDraftItems = orders.some(function (o) { return o.status === "DRAFT"; });

    var html = '<table class="wh-ls-table wh-orders-table"><thead><tr>';
    html += "<th>Order</th><th>Date</th><th>PO #</th><th>Items</th><th>Total</th><th>Status</th><th>Actions</th>";
    html += "</tr></thead><tbody>";

    // The yellow draft slot always leads the table: the working draft when
    // one exists (rendered below), otherwise an invitation to start one.
    if (!hasDraftItems) {
      html +=
        '<tr class="wh-orders-create-row"><td colspan="7">' +
        '<a class="wh-ls-btn wh-ls-btn--small" href="' + esc(sheetUrl) + '">Create Draft Order</a>' +
        "</td></tr>";
    }

    orders.forEach(function (o) {
      var name = esc(o.order_name);
      html +=
        '<tr class="wh-orders-row' + (o.status === "DRAFT" ? " wh-orders-row--draft" : "") + '"' +
        ' data-order-id="' + esc(o.id) + '" data-status="' + esc(o.status) + '" tabindex="0">' +
        "<td>" + name + "</td>" +
        "<td>" + esc(formatDate(o.submitted_at)) + "</td>" +
        "<td>" + esc(o.po_number || "—") + "</td>" +
        "<td>" + o.item_count + "</td>" +
        "<td>" + formatMoney(o.subtotal_cents) + "</td>" +
        '<td class="wh-orders-status">' + esc(statusText(o.status)) + "</td>" +
        '<td class="wh-orders-actions">' + actionsHTML(o) + "</td>" +
        "</tr>";
    });

    html += "</tbody></table>";
    container.innerHTML = html;
  }

  /* -------------------------------------------------------------------------
     Expandable order detail
     ---------------------------------------------------------------------- */

  // Detail header: purely informational — plain-language status explanation
  // plus tracking links. ALL actions (Submit / Make payment / Edit / Reorder)
  // live in the row's ACTIONS column, which stays visible above the detail.
  function buildDetailHTML(order) {
    var html = '<div class="wh-orders-detail-head">';
    html += '<span class="wh-orders-tip">' + esc(statusTip(order));
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
    html += "</span>";
    html += "</div>";

    html += '<table class="wh-ls-table wh-orders-detail-table"><thead><tr>';
    html += "<th>Product</th><th>Variant</th><th>SKU</th><th>Qty</th><th>Price</th><th>Total</th>";
    html += "</tr></thead><tbody>";
    order.lines.forEach(function (l) {
      var unit = l.unit_price_cents;
      // Line titles link to the variant's PDP in a new tab (plain-text look).
      var link = function (text) {
        return l.product_url
          ? '<a href="' + esc(l.product_url) + '" target="_blank" rel="noopener" class="wh-orders-line-link">' + text + "</a>"
          : text;
      };
      html +=
        "<tr>" +
        "<td>" + link(esc(l.product_title)) + "</td>" +
        "<td>" + link(esc(l.variant_title || "—")) + "</td>" +
        "<td>" + esc(l.sku || "—") + "</td>" +
        "<td>" + l.quantity + "</td>" +
        "<td>" + (unit === null ? "—" : formatMoney(unit)) + "</td>" +
        "<td>" + (unit === null ? "—" : formatMoney(unit * l.quantity)) + "</td>" +
        "</tr>";
    });
    // Subtotal rides as a table row so the amount aligns under the line
    // totals; the pad cell keeps the label from spanning the full width.
    // (subtotal_cents is the amount AS SUBMITTED — line prices are current
    // CMS prices, so the column may not sum to it if prices changed.)
    html += "</tbody><tfoot><tr>";
    html += '<td colspan="4" class="wh-orders-subtotal-pad"></td>';
    html += '<td class="wh-orders-subtotal-cell">Subtotal</td>';
    html += '<td class="wh-orders-subtotal-cell">' + formatMoney(order.subtotal_cents) + "</td>";
    html += "</tr></tfoot></table>";

    if (order.ship_own_label) {
      html += '<p class="wh-orders-detail-foot">Customer provides own shipping label</p>';
    }

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
     Reorder — copy this order into the active draft, go to the order sheet.
     Edit — start an EDITING session (the draft is never touched) and go to
     the sheet, which submits an in-place update of the existing order.
     ---------------------------------------------------------------------- */

  function reorder(btn, linesheetUrl) {
    if (
      hasDraftItems &&
      !window.confirm("Start a new order from this one? Anything on your draft sheet will be replaced.")
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
        clearEditContext(); // a reorder is a fresh order, never an edit
        window.location.href = linesheetUrl;
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = original;
        console.error("[orders] reorder error:", err);
        alert("Could not load this order into the sheet. Please try again.");
      });
  }

  function editOrder(btn, linesheetUrl) {
    var original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Loading…";
    fetch("/apps/wholesale/linesheet-edit-begin", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draft_id: btn.getAttribute("data-order-id") }),
    })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        if (!data || !data.ok) throw new Error("Bad response");
        setEditContext({
          id: data.draft_order_id,
          name: data.order_name,
          paid: btn.getAttribute("data-paid") === "1",
        });
        window.location.href = linesheetUrl;
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = original;
        console.error("[orders] edit-begin error:", err);
        alert("Could not open this order for editing. Please try again.");
      });
  }

  /* -------------------------------------------------------------------------
     Submit — turn the DRAFT sheet into a real order (Shopify draft order).
     This is the one moment an order becomes visible to CW&T.
     ---------------------------------------------------------------------- */

  function buildSubmitMessage(data) {
    var msg;
    if (data.all_backorder) {
      msg = "Backorder " + (data.order_name || "") + " submitted (" +
        formatMoney(data.subtotal_cents) + "). Everything on this order is " +
        "currently out of stock. We'll send your invoice when it's ready to ship.";
    } else {
      msg = "Order " + (data.order_name || "") + " submitted (" +
        formatMoney(data.subtotal_cents) + ")." +
        (data.payment_terms === "NET_30" ? " Payment terms: Net 30." :
         data.payment_terms === "NET_60" ? " Payment terms: Net 60." : "");
      if (data.order_queued) {
        msg += " It's headed to our fulfillment queue. We'll invoice per your terms.";
      }
      if (data.backorder_name) {
        msg += " " + data.backorder_count + " out-of-stock item" +
          (data.backorder_count === 1 ? " is" : "s are") +
          " on separate backorder " + data.backorder_name +
          ". We'll invoice that when it is ready to ship.";
      }
      if (data.freight_quote) {
        msg += " This order includes items that require a shipping quote. We'll email your invoice once shipping is quoted.";
      }
    }
    return msg;
  }

  function showResult(resultEl, ok, message, invoiceUrl) {
    if (!resultEl) return;
    resultEl.textContent = "";
    resultEl.className = "wh-ls-order-result " + (ok ? "wh-ls-order-result--success" : "wh-ls-order-result--error");
    resultEl.appendChild(document.createTextNode(message + " "));
    if (invoiceUrl) {
      var link = document.createElement("a");
      link.href = invoiceUrl;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "Make payment →";
      resultEl.appendChild(link);
    }
    resultEl.hidden = false;
    resultEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function submitDraft(btn, resultEl, reloadList) {
    var original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Submitting…";
    if (resultEl) resultEl.hidden = true;

    var body = { draft_id: btn.getAttribute("data-order-id") };

    fetch("/apps/wholesale/linesheet-order", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(function (r) {
        return r
          .json()
          .catch(function () { throw new Error("HTTP " + r.status); })
          .then(function (data) {
            if (!r.ok) {
              var e = new Error((data && data.error) || "HTTP " + r.status);
              e.userFacing = !!(data && data.error);
              e.editExpired = !!(data && data.edit_expired);
              throw e;
            }
            return data;
          });
      })
      .then(function (data) {
        if (!data || !data.ok) throw new Error((data && data.error) || "Order failed");
        showResult(resultEl, true, buildSubmitMessage(data), data.invoice_url);
        reloadList();
      })
      .catch(function (err) {
        showResult(
          resultEl, false,
          err && err.userFacing ? err.message : "Could not submit order. Please try again or contact us."
        );
        console.error("[orders] submit error:", err);
        btn.disabled = false;
        btn.textContent = original;
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
    sheetUrl = linesheetUrl; // module-level: actionsHTML builds the Edit link from it

    // Result banner for submit feedback, above the table.
    var resultEl = document.createElement("div");
    resultEl.id = "wh-orders-result";
    resultEl.className = "wh-ls-order-result";
    resultEl.setAttribute("role", "status");
    resultEl.setAttribute("aria-live", "polite");
    resultEl.hidden = true;
    content.parentNode.insertBefore(resultEl, content);

    function loadList(openDraft) {
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
          if (openDraft) {
            var draftRow = content.querySelector('.wh-orders-row[data-status="DRAFT"]');
            if (draftRow) toggleDetail(draftRow);
          }
        })
        .catch(function (err) {
          if (loading) loading.setAttribute("hidden", "");
          content.innerHTML =
            '<p class="wh-ls-error">Unable to load orders. Please refresh the page or contact us.</p>';
          content.removeAttribute("hidden");
          console.error("[orders] list error:", err);
        });
    }

    // Arriving from the sheet's "Review Wholesale Order →" button: open the
    // draft for review immediately.
    loadList(window.location.hash === "#draft");

    content.addEventListener("click", function (e) {
      var submitBtn = e.target && e.target.closest ? e.target.closest(".wh-orders-submit") : null;
      if (submitBtn) {
        submitDraft(submitBtn, resultEl, function () { loadList(false); });
        return;
      }
      var editBtn = e.target && e.target.closest ? e.target.closest(".wh-orders-edit") : null;
      if (editBtn) {
        editOrder(editBtn, linesheetUrl);
        return;
      }
      var reorderBtn = e.target && e.target.closest ? e.target.closest(".wh-orders-reorder") : null;
      if (reorderBtn) {
        reorder(reorderBtn, linesheetUrl);
        return;
      }
      // Links (tracking / Make payment / Edit-draft) behave normally.
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
