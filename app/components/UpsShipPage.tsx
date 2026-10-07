/**
 * Ship with UPS — the page body shared by both Ship routes (an order sheet's
 * draft order, and any Shopify order / draft order). Buys a UPS label billed
 * to the customer's UPS account on file; see app/lib/ups-ship.server.ts.
 *
 * Also quotes rates before buying (intent "rate") and prints a packing slip
 * for the order, on its own or straight after the label.
 *
 * Posts back to whichever route rendered it (intents "rate" / "buy" / "void").
 */
import { useFetcher } from "@remix-run/react";
import { useEffect, useState } from "react";
import {
  Page,
  Card,
  Text,
  Banner,
  BlockStack,
  InlineStack,
  Select,
  TextField,
  Button,
  ButtonGroup,
  Checkbox,
  Badge,
  Link,
  DataTable,
} from "@shopify/polaris";
import { UPS_SERVICES, formatCharge } from "../lib/ups-services";
import type { ShipPageData } from "../lib/ups-ship.server";

type ShipmentData = ShipPageData["shipments"][number];
type ShipLine = ShipPageData["lines"][number];
type ShipFrom = NonNullable<ShipPageData["shipFrom"]>;
type ShipTo = NonNullable<ShipPageData["shipTo"]>;
type Charge = { amount: string; currency: string };
type RateQuote = { serviceCode: string; label: string; published: Charge; negotiated: Charge | null };

type ActionData = { ok?: boolean; bought?: boolean; voided?: boolean; error?: string };
type RateData = { ok?: boolean; rates?: RateQuote[]; error?: string };

// ── Printing ─────────────────────────────────────────────────────────────────
// Everything prints from a throwaway same-origin iframe — same trick as the
// pick list, since window.print() misbehaves inside the embedded admin.
// Resolves once the print dialog has closed (or after a long fallback), so
// one click can print the label and then the packing slip.
function printDocument(title: string, head: string, body: string, delayMs = 0): Promise<void> {
  return new Promise((resolve) => {
    const iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument;
    const win = iframe.contentWindow;
    if (!doc || !win) {
      iframe.remove();
      resolve();
      return;
    }
    doc.open();
    doc.write(
      '<!doctype html><html><head><meta charset="utf-8"><title>' +
        esc(title) +
        "</title>" +
        head +
        "</head><body>" +
        body +
        "</body></html>"
    );
    doc.close();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      setTimeout(() => iframe.remove(), 500);
      resolve();
    };
    win.onafterprint = finish;
    setTimeout(finish, 120000);
    setTimeout(() => {
      win.focus();
      win.print();
    }, delayMs);
  });
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

// UPS GIF labels arrive landscape (rotated for a 4x6 sheet), so each is turned
// upright on a canvas first.
function uprightLabel(base64: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      if (img.height >= img.width) {
        resolve(img.src);
        return;
      }
      // The 1400x800 GIF is a 4x6 label (1200x800) plus a blank strip that
      // ends up at the bottom once upright — crop it so the label prints at
      // full size on 4x6 stock.
      const canvas = document.createElement("canvas");
      canvas.width = img.height;
      canvas.height = Math.min(img.width, Math.round(img.height * 1.5));
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(img.src);
        return;
      }
      ctx.translate(canvas.width, 0);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(img, 0, 0);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => reject(new Error("label image failed to load"));
    img.src = `data:image/gif;base64,${base64}`;
  });
}

async function printLabels(title: string, labels: string[]): Promise<void> {
  const images = await Promise.all(labels.map(uprightLabel));
  return printDocument(
    title,
    "<style>@page { size: 4in 6in; margin: 0; } body { margin: 0; }" +
      " img { display: block; width: 4in; height: 6in; object-fit: contain; page-break-after: always; }" +
      "</style>",
    images.map((src) => `<img src="${src}">`).join(""),
    // Give the data-URL images a beat to decode before the dialog snapshots them.
    250
  );
}

function downloadZpl(filename: string, labels: string[]) {
  const text = labels.map((b64) => atob(b64)).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ── Packing slip ─────────────────────────────────────────────────────────────
// Goes in the box, so unlike the internal pick list it has no checkboxes or
// fill-in lines and no prices: who it's from, who it's to, what's inside, and
// the tracking numbers when a label exists.
type PackingSlipInput = {
  orderName: string | null;
  poNumber: string | null;
  shipFrom: ShipFrom | null;
  shipTo: ShipTo;
  lines: ShipLine[];
  shipment: ShipmentData | null;
};

const PACKING_SLIP_CSS = `
  @page { size: letter; margin: 0.6in; }
  body { margin: 0; font-family: -apple-system, "Helvetica Neue", Arial, sans-serif; color: #000; font-size: 13px; line-height: 1.45; }
  .ps-head { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; border-bottom: 2px solid #000; padding-bottom: 14px; margin-bottom: 18px; }
  .ps-from { font-size: 13px; }
  .ps-from strong { font-size: 16px; display: block; margin-bottom: 2px; }
  .ps-title { text-align: right; }
  .ps-title h1 { font-size: 22px; letter-spacing: 0.06em; margin: 0 0 4px; }
  .ps-title div { font-size: 13px; }
  .ps-to { margin-bottom: 18px; }
  .ps-to strong { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; border-bottom: 2px solid #000; padding: 6px 8px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; }
  td { border-bottom: 1px solid #ccc; padding: 8px; vertical-align: top; }
  .ps-sku { white-space: nowrap; font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
  .ps-qty { text-align: right; font-weight: 700; white-space: nowrap; }
  tfoot td { border-bottom: none; border-top: 2px solid #000; font-weight: 700; }
  .ps-track { margin-top: 22px; font-size: 13px; }
  .ps-track strong { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 4px; }
  .ps-track code { font-family: ui-monospace, Menlo, monospace; }
`;

function packingSlipHtml(d: PackingSlipInput): string {
  const from = d.shipFrom;
  const to = d.shipTo;
  const units = d.lines.reduce((sum, l) => sum + l.quantity, 0);
  const toLines = [
    to.name,
    to.attention && to.attention !== to.name ? to.attention : null,
    to.address1,
    to.address2,
    [to.city, to.state, to.postalCode].filter(Boolean).join(", "),
    to.phone,
  ].filter(Boolean);
  const fromLines = from
    ? [
        from.address1,
        from.address2,
        [from.city, from.state, from.postalCode].filter(Boolean).join(", "),
        from.phone,
      ].filter(Boolean)
    : [];
  const date = new Date(d.shipment?.createdAt ?? Date.now()).toLocaleDateString();

  return `
    <div class="ps-head">
      <div class="ps-from">
        ${from ? `<strong>${esc(from.name)}</strong>` : ""}
        ${fromLines.map((l) => `<div>${esc(l)}</div>`).join("")}
      </div>
      <div class="ps-title">
        <h1>PACKING SLIP</h1>
        ${d.orderName ? `<div>Order ${esc(d.orderName)}</div>` : ""}
        ${d.poNumber ? `<div>PO ${esc(d.poNumber)}</div>` : ""}
        <div>${esc(date)}</div>
      </div>
    </div>
    <div class="ps-to">
      <strong>Ship to</strong>
      ${toLines.map((l) => `<div>${esc(l)}</div>`).join("")}
    </div>
    <table>
      <thead><tr><th>SKU</th><th>Item</th><th class="ps-qty">Qty</th></tr></thead>
      <tbody>
        ${d.lines
          .map(
            (l) =>
              `<tr><td class="ps-sku">${esc(l.sku || "—")}</td><td>${esc(l.title)}${
                l.variantTitle ? ` — ${esc(l.variantTitle)}` : ""
              }</td><td class="ps-qty">${l.quantity}</td></tr>`
          )
          .join("")}
      </tbody>
      <tfoot><tr><td colspan="2">${d.lines.length} line${d.lines.length === 1 ? "" : "s"}</td><td class="ps-qty">${units}</td></tr></tfoot>
    </table>
    ${
      d.shipment
        ? `<div class="ps-track"><strong>Shipped via ${esc(d.shipment.serviceLabel)}</strong>${d.shipment.packages
            .map(
              (p, i) =>
                `<div>${d.shipment!.packages.length > 1 ? `Package ${i + 1}: ` : "Tracking: "}<code>${esc(
                  p.trackingNumber
                )}</code></div>`
            )
            .join("")}</div>`
        : ""
    }`;
}

function printPackingSlip(d: PackingSlipInput): Promise<void> {
  return printDocument(
    `Packing slip ${d.orderName ?? ""}`.trim(),
    `<style>${PACKING_SLIP_CSS}</style>`,
    packingSlipHtml(d)
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

type PackageRow = { weight: string; length: string; width: string; height: string };
const EMPTY_PACKAGE: PackageRow = { weight: "", length: "", width: "", height: "" };

const BILLING_OPTIONS = [
  { label: "Receiver's account (ships to the account holder)", value: "RECEIVER" },
  { label: "Third-party account (ships somewhere else)", value: "THIRD_PARTY" },
];

function ShipmentCard({
  shipment,
  orderName,
  slip,
}: {
  shipment: ShipmentData;
  orderName: string;
  // Set when the order has lines and an address, so a packing slip can print.
  slip: Omit<PackingSlipInput, "shipment"> | null;
}) {
  const fetcher = useFetcher<ActionData>();
  const voiding = fetcher.state !== "idle";
  const [printing, setPrinting] = useState(false);
  const active = shipment.status === "ACTIVE";
  const labels = shipment.packages.map((p) => p.labelBase64).filter(Boolean);
  const isZpl = shipment.packages[0]?.labelFormat === "ZPL";
  const title = `UPS label ${orderName}`;

  const run = async (job: () => Promise<void>) => {
    setPrinting(true);
    try {
      await job();
    } finally {
      setPrinting(false);
    }
  };
  const slipFor = slip ? { ...slip, shipment } : null;

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <InlineStack gap="200" blockAlign="center">
            <Text as="h2" variant="headingMd">{shipment.serviceLabel}</Text>
            <Badge tone={active ? "success" : undefined}>{active ? "Label bought" : "Voided"}</Badge>
            {shipment.environment === "TEST" && <Badge tone="attention">Test label</Badge>}
            {shipment.estimatedCharge && (
              <Text as="span" tone="subdued">
                est. {formatCharge(shipment.estimatedCharge)} at UPS list rates
              </Text>
            )}
          </InlineStack>
          <Text as="span" tone="subdued" variant="bodySm">
            {new Date(shipment.createdAt).toLocaleString()} · billed to UPS account {shipment.billedAccount}
          </Text>
        </InlineStack>
        <BlockStack gap="100">
          {shipment.packages.map((p, i) => (
            <Text as="p" key={i}>
              Package {i + 1}
              {p.weightLbs ? ` (${p.weightLbs} lb)` : ""}:{" "}
              <Link url={`https://www.ups.com/track?tracknum=${p.trackingNumber}`} target="_blank">
                {p.trackingNumber}
              </Link>
            </Text>
          ))}
        </BlockStack>
        {fetcher.data?.error && <Banner tone="critical">{fetcher.data.error}</Banner>}
        {active && (
          <InlineStack gap="300" blockAlign="center" wrap>
            <ButtonGroup>
              {labels.length > 0 && !isZpl && slipFor && (
                <Button
                  variant="primary"
                  loading={printing}
                  onClick={() =>
                    run(async () => {
                      await printLabels(title, labels);
                      await printPackingSlip(slipFor);
                    })
                  }
                >
                  Print label + packing slip
                </Button>
              )}
              {labels.length > 0 &&
                (isZpl ? (
                  <Button onClick={() => downloadZpl(`${orderName || "label"}-ups.zpl`, labels)}>
                    Download label (ZPL)
                  </Button>
                ) : (
                  <Button disabled={printing} onClick={() => run(() => printLabels(title, labels))}>
                    Print label{labels.length === 1 ? "" : "s"}
                  </Button>
                ))}
              {slipFor && (
                <Button disabled={printing} onClick={() => run(() => printPackingSlip(slipFor))}>
                  Print packing slip
                </Button>
              )}
            </ButtonGroup>
            <Button
              tone="critical"
              variant="plain"
              loading={voiding}
              onClick={() =>
                fetcher.submit({ intent: "void", shipmentId: shipment.id }, { method: "post" })
              }
            >
              Void label
            </Button>
          </InlineStack>
        )}
      </BlockStack>
    </Card>
  );
}

export function UpsShipPage({
  data,
  backAction,
  flag,
}: {
  data: ShipPageData;
  backAction: { content: string; url: string };
  // Shown next to the title, e.g. "BACKORDER".
  flag?: string | null;
}) {
  const {
    target, orderName, poNumber, shipTo, shipFrom, lines, addressError, addressAccessMessage,
    notFound, cancelled, notSubmitted, upsEnabled, environment, customer, shipments,
  } = data;

  const fetcher = useFetcher<ActionData>();
  const rateFetcher = useFetcher<RateData>();
  const buying = fetcher.state !== "idle";
  const quoting = rateFetcher.state !== "idle";
  const [serviceCode, setServiceCode] = useState<string>(UPS_SERVICES[0].code);
  const [billingType, setBillingType] = useState("RECEIVER");
  const [packages, setPackages] = useState<PackageRow[]>([{ ...EMPTY_PACKAGE }]);
  const [additional, setAdditional] = useState(false);
  // Which package details the current quotes were fetched for — quotes are
  // hidden as soon as the packages change.
  const [quotedFor, setQuotedFor] = useState<string | null>(null);

  const packagesJson = JSON.stringify(packages);
  const rates: RateQuote[] | null =
    quotedFor === packagesJson && rateFetcher.data?.rates ? rateFetcher.data.rates : null;
  const rateFor = (code: string) => rates?.find((r) => r.serviceCode === code) ?? null;
  const selectedRate = rateFor(serviceCode);

  // Fresh form after a purchase, so a stray second click can't repeat it.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.bought) {
      setPackages([{ ...EMPTY_PACKAGE }]);
      setAdditional(false);
      setQuotedFor(null);
    }
  }, [fetcher.state, fetcher.data]);

  const setPackageField = (index: number, field: keyof PackageRow, value: string) =>
    setPackages((rows) => rows.map((r, i) => (i === index ? { ...r, [field]: value } : r)));

  const hasActiveLabel = shipments.some((s) => s.status === "ACTIVE");
  const billable =
    !!customer?.billUpsAccount && !!customer.upsAccountNumber && !!customer.upsAccountPostalCode;
  const shippable = !!target && !notFound && !cancelled && !notSubmitted;
  const packagesComplete = packages.every((p) => p.weight.trim() !== "");
  const canQuote = upsEnabled && shippable && !!shipTo && packagesComplete && !buying;
  const canBuy =
    upsEnabled &&
    billable &&
    shippable &&
    !!shipTo &&
    (!hasActiveLabel || additional) &&
    packagesComplete;

  const quote = () => {
    setQuotedFor(packagesJson);
    rateFetcher.submit({ intent: "rate", packages: packagesJson }, { method: "post" });
  };

  const buy = () =>
    fetcher.submit(
      {
        intent: "buy",
        serviceCode,
        billingType,
        additional: String(additional),
        packages: packagesJson,
        ...(selectedRate
          ? {
              estimatedAmount: selectedRate.published.amount,
              estimatedCurrency: selectedRate.published.currency,
            }
          : {}),
      },
      { method: "post" }
    );

  // The packing slip needs an address and at least one line.
  const slip: Omit<PackingSlipInput, "shipment"> | null =
    shipTo && lines.length > 0 ? { orderName, poNumber, shipFrom, shipTo, lines } : null;
  // A slip printed from the page header carries the newest live label's tracking.
  const newestActive = shipments.find((s) => s.status === "ACTIVE") ?? null;

  const serviceOptions = UPS_SERVICES.map((s) => {
    const r = rateFor(s.code);
    return { label: r ? `${s.label} — ${formatCharge(r.published)}` : s.label, value: s.code };
  });

  return (
    <Page
      title={`Ship ${orderName ?? "order"} with UPS`}
      titleMetadata={flag ? <Text as="span" tone="critical" fontWeight="bold">{flag}</Text> : undefined}
      backAction={backAction}
      secondaryActions={
        slip
          ? [
              {
                content: "Print packing slip",
                onAction: () => void printPackingSlip({ ...slip, shipment: newestActive }),
              },
            ]
          : undefined
      }
    >
      <BlockStack gap="400">
        {!upsEnabled && (
          <Banner tone="warning" title="UPS isn't connected yet">
            <Text as="p">
              Labels can be bought here once the app's UPS credentials are set.
            </Text>
          </Banner>
        )}
        {upsEnabled && environment === "TEST" && (
          <Banner tone="warning" title="Test mode">
            <Text as="p">
              The app is connected to UPS's test environment. Labels made here are samples —
              they are not valid for shipping and nobody is charged.
            </Text>
          </Banner>
        )}
        {notSubmitted && (
          <Banner tone="warning" title="Not submitted yet">
            <Text as="p">This sheet is still a customer draft — there is no order to ship.</Text>
          </Banner>
        )}
        {notFound && (
          <Banner tone="critical" title="Order not found">
            <Text as="p">Shopify has no such order. It may have been deleted.</Text>
          </Banner>
        )}
        {cancelled && (
          <Banner tone="critical" title="Order cancelled">
            <Text as="p">This order is cancelled — there is nothing to ship.</Text>
          </Banner>
        )}
        {addressError === "ACCESS" && (
          <Banner tone="critical" title="Can't read the shipping address">
            <Text as="p">{addressAccessMessage}</Text>
          </Banner>
        )}
        {addressError === "OTHER" && (
          <Banner tone="critical">
            <Text as="p">Couldn't load the order from Shopify. Reload to try again.</Text>
          </Banner>
        )}
        {!addressError && !shipTo && shippable && (
          <Banner tone="critical" title="No shipping address">
            <Text as="p">Add a shipping address to the order in Shopify, then reload.</Text>
          </Banner>
        )}
        {shippable && !addressError && !customer && (
          <Banner tone="info" title="Customer isn't in the wholesale app">
            <Text as="p">
              UPS account billing is set per wholesale customer. Add this order's customer under
              Customers, then enter their UPS account in the UPS column.
            </Text>
          </Banner>
        )}
        {customer && !billable && (
          <Banner tone="info" title="Customer isn't billed on a UPS account">
            <Text as="p">
              To bill {customer.name}'s UPS account, add the account number and billing ZIP and
              tick "Bill this account for shipping" under Customers → UPS.
            </Text>
          </Banner>
        )}

        <Card>
          <InlineStack align="space-between" blockAlign="start" gap="600">
            <BlockStack gap="100">
              <Text as="h2" variant="headingMd">Ship to</Text>
              {shipTo ? (
                <>
                  <Text as="p">{shipTo.name}</Text>
                  {shipTo.attention && shipTo.attention !== shipTo.name && (
                    <Text as="p">{shipTo.attention}</Text>
                  )}
                  <Text as="p">{shipTo.address1}</Text>
                  {shipTo.address2 && <Text as="p">{shipTo.address2}</Text>}
                  <Text as="p">
                    {[shipTo.city, shipTo.state, shipTo.postalCode].filter(Boolean).join(", ")}{" "}
                    {shipTo.countryCode}
                  </Text>
                </>
              ) : (
                <Text as="p" tone="subdued">—</Text>
              )}
            </BlockStack>
            <BlockStack gap="100">
              <Text as="h2" variant="headingMd">Shipping billed to</Text>
              {billable ? (
                <>
                  <Text as="p">{customer?.name}</Text>
                  <Text as="p">
                    UPS account {customer?.upsAccountNumber} · ZIP {customer?.upsAccountPostalCode}
                  </Text>
                </>
              ) : (
                <Text as="p" tone="subdued">No UPS account on file</Text>
              )}
              {poNumber && <Text as="p" tone="subdued">PO: {poNumber}</Text>}
            </BlockStack>
          </InlineStack>
        </Card>

        {shipments.map((s) => (
          <ShipmentCard key={s.id} shipment={s} orderName={orderName ?? ""} slip={slip} />
        ))}

        {upsEnabled && billable && shippable && (
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                {hasActiveLabel ? "Buy an additional label" : "Buy label"}
              </Text>
              {hasActiveLabel && (
                <Checkbox
                  label="This order needs another label (the customer's UPS account is charged again)"
                  checked={additional}
                  onChange={setAdditional}
                  disabled={buying}
                />
              )}
              <BlockStack gap="200">
                {packages.map((p, i) => (
                  <InlineStack key={i} gap="200" blockAlign="end" wrap>
                    <div style={{ width: 120 }}>
                      <TextField
                        label={`Package ${i + 1} weight`}
                        type="number"
                        suffix="lb"
                        autoComplete="off"
                        value={p.weight}
                        onChange={(v) => setPackageField(i, "weight", v)}
                        disabled={buying}
                      />
                    </div>
                    {(["length", "width", "height"] as const).map((dim) => (
                      <div key={dim} style={{ width: 100 }}>
                        <TextField
                          label={dim[0].toUpperCase() + dim.slice(1)}
                          type="number"
                          suffix="in"
                          autoComplete="off"
                          value={p[dim]}
                          onChange={(v) => setPackageField(i, dim, v)}
                          disabled={buying}
                        />
                      </div>
                    ))}
                    {packages.length > 1 && (
                      <Button
                        variant="plain"
                        tone="critical"
                        disabled={buying}
                        onClick={() => setPackages((rows) => rows.filter((_, j) => j !== i))}
                      >
                        Remove
                      </Button>
                    )}
                  </InlineStack>
                ))}
                <InlineStack gap="400" blockAlign="center">
                  <Button
                    variant="plain"
                    disabled={buying || packages.length >= 20}
                    onClick={() => setPackages((rows) => [...rows, { ...EMPTY_PACKAGE }])}
                  >
                    Add another package
                  </Button>
                  <Button loading={quoting} disabled={!canQuote} onClick={quote}>
                    {rates ? "Refresh rates" : "Get rates"}
                  </Button>
                </InlineStack>
              </BlockStack>

              {rateFetcher.data?.error && quotedFor === packagesJson && (
                <Banner tone="warning">{rateFetcher.data.error}</Banner>
              )}
              {rates && (
                <BlockStack gap="100">
                  <DataTable
                    columnContentTypes={rates.some((r) => r.negotiated) ? ["text", "numeric", "numeric"] : ["text", "numeric"]}
                    headings={
                      rates.some((r) => r.negotiated)
                        ? ["Service", "UPS list rate", "CW&T rate"]
                        : ["Service", "UPS list rate"]
                    }
                    rows={rates.map((r) =>
                      rates.some((q) => q.negotiated)
                        ? [r.label, formatCharge(r.published), r.negotiated ? formatCharge(r.negotiated) : "—"]
                        : [r.label, formatCharge(r.published)]
                    )}
                    increasedTableDensity
                  />
                  <Text as="p" tone="subdued" variant="bodySm">
                    Estimates. UPS bills {customer?.name ?? "the customer"}'s account at that
                    account's own rates; the list rate is what an account without a contract pays.
                  </Text>
                </BlockStack>
              )}

              <InlineStack gap="400" wrap>
                <div style={{ minWidth: 240 }}>
                  <Select
                    label="Service"
                    options={serviceOptions}
                    value={serviceCode}
                    onChange={setServiceCode}
                    disabled={buying}
                  />
                </div>
                <div style={{ minWidth: 320 }}>
                  <Select
                    label="Bill as"
                    options={BILLING_OPTIONS}
                    value={billingType}
                    onChange={setBillingType}
                    disabled={buying}
                  />
                </div>
              </InlineStack>
              {fetcher.data?.error && <Banner tone="critical">{fetcher.data.error}</Banner>}
              {fetcher.data?.bought && fetcher.state === "idle" && (
                <Banner tone="success">
                  Label bought — print it, with the packing slip, from the card above.
                </Banner>
              )}
              <InlineStack>
                <Button variant="primary" loading={buying} disabled={!canBuy} onClick={buy}>
                  {environment === "TEST" ? "Create test label" : "Buy label"} — bill UPS account{" "}
                  {customer?.upsAccountNumber ?? ""}
                  {selectedRate ? ` (est. ${formatCharge(selectedRate.published)})` : ""}
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        )}

        {lines.length > 0 && (
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">
                Items ({lines.reduce((sum, l) => sum + l.quantity, 0)} units)
              </Text>
              <DataTable
                columnContentTypes={["text", "text", "numeric"]}
                headings={["SKU", "Item", "Qty"]}
                rows={lines.map((l) => [
                  l.sku || "—",
                  l.variantTitle ? `${l.title} — ${l.variantTitle}` : l.title,
                  l.quantity,
                ])}
                increasedTableDensity
              />
            </BlockStack>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}
