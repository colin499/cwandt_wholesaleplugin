/**
 * Ship with UPS — the page body shared by both Ship routes (an order sheet's
 * draft order, and any Shopify order / draft order). Buys a UPS label billed
 * to the customer's UPS account on file; see app/lib/ups-ship.server.ts.
 *
 * Posts back to whichever route rendered it (intents "buy" / "void").
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
  Checkbox,
  Badge,
  Link,
} from "@shopify/polaris";
import { UPS_SERVICES } from "../lib/ups-services";
import type { ShipPageData } from "../lib/ups-ship.server";

// ── Label printing ───────────────────────────────────────────────────────────
// UPS GIF labels arrive landscape (rotated for a 4x6 sheet), so each is turned
// upright on a canvas, then printed from a throwaway iframe — same trick as
// the pick list, since window.print() misbehaves inside the embedded admin.
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

async function printLabels(title: string, labels: string[]) {
  const images = await Promise.all(labels.map(uprightLabel));
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;
  if (!doc || !win) {
    iframe.remove();
    return;
  }
  doc.open();
  doc.write(
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>" +
      title.replace(/</g, "&lt;") +
      "</title><style>@page { size: 4in 6in; margin: 0; } body { margin: 0; }" +
      " img { display: block; width: 4in; height: 6in; object-fit: contain; page-break-after: always; }" +
      "</style></head><body>" +
      images.map((src) => `<img src="${src}">`).join("") +
      "</body></html>"
  );
  doc.close();
  let removed = false;
  const cleanup = () => {
    if (removed) return;
    removed = true;
    setTimeout(() => iframe.remove(), 500);
  };
  win.onafterprint = cleanup;
  setTimeout(cleanup, 120000);
  // Give the data-URL images a beat to decode before the dialog snapshots them.
  setTimeout(() => {
    win.focus();
    win.print();
  }, 250);
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

type ShipmentData = ShipPageData["shipments"][number];
type ActionData = { ok?: boolean; bought?: boolean; voided?: boolean; error?: string };

type PackageRow = { weight: string; length: string; width: string; height: string };
const EMPTY_PACKAGE: PackageRow = { weight: "", length: "", width: "", height: "" };

const BILLING_OPTIONS = [
  { label: "Receiver's account (ships to the account holder)", value: "RECEIVER" },
  { label: "Third-party account (ships somewhere else)", value: "THIRD_PARTY" },
];

function ShipmentCard({ shipment, orderName }: { shipment: ShipmentData; orderName: string }) {
  const fetcher = useFetcher<ActionData>();
  const voiding = fetcher.state !== "idle";
  const active = shipment.status === "ACTIVE";
  const labels = shipment.packages.map((p) => p.labelBase64).filter(Boolean);
  const isZpl = shipment.packages[0]?.labelFormat === "ZPL";

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <InlineStack gap="200" blockAlign="center">
            <Text as="h2" variant="headingMd">{shipment.serviceLabel}</Text>
            <Badge tone={active ? "success" : undefined}>{active ? "Label bought" : "Voided"}</Badge>
            {shipment.environment === "TEST" && <Badge tone="attention">Test label</Badge>}
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
          <InlineStack gap="200">
            {labels.length > 0 &&
              (isZpl ? (
                <Button onClick={() => downloadZpl(`${orderName || "label"}-ups.zpl`, labels)}>
                  Download label (ZPL)
                </Button>
              ) : (
                <Button onClick={() => printLabels(`UPS label ${orderName}`, labels)}>
                  Print label{labels.length === 1 ? "" : "s"}
                </Button>
              ))}
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
    target, orderName, poNumber, shipTo, addressError, addressAccessMessage, notFound,
    cancelled, notSubmitted, upsEnabled, environment, customer, shipments,
  } = data;

  const fetcher = useFetcher<ActionData>();
  const buying = fetcher.state !== "idle";
  const [serviceCode, setServiceCode] = useState<string>(UPS_SERVICES[0].code);
  const [billingType, setBillingType] = useState("RECEIVER");
  const [packages, setPackages] = useState<PackageRow[]>([{ ...EMPTY_PACKAGE }]);
  const [additional, setAdditional] = useState(false);

  // Fresh form after a purchase, so a stray second click can't repeat it.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.bought) {
      setPackages([{ ...EMPTY_PACKAGE }]);
      setAdditional(false);
    }
  }, [fetcher.state, fetcher.data]);

  const setPackageField = (index: number, field: keyof PackageRow, value: string) =>
    setPackages((rows) => rows.map((r, i) => (i === index ? { ...r, [field]: value } : r)));

  const hasActiveLabel = shipments.some((s) => s.status === "ACTIVE");
  const billable =
    !!customer?.billUpsAccount && !!customer.upsAccountNumber && !!customer.upsAccountPostalCode;
  const shippable = !!target && !notFound && !cancelled && !notSubmitted;
  const canBuy =
    upsEnabled &&
    billable &&
    shippable &&
    !!shipTo &&
    (!hasActiveLabel || additional) &&
    packages.every((p) => p.weight.trim() !== "");

  const buy = () =>
    fetcher.submit(
      {
        intent: "buy",
        serviceCode,
        billingType,
        additional: String(additional),
        packages: JSON.stringify(packages),
      },
      { method: "post" }
    );

  return (
    <Page
      title={`Ship ${orderName ?? "order"} with UPS`}
      titleMetadata={flag ? <Text as="span" tone="critical" fontWeight="bold">{flag}</Text> : undefined}
      backAction={backAction}
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
          <ShipmentCard key={s.id} shipment={s} orderName={orderName ?? ""} />
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
              <InlineStack gap="400" wrap>
                <div style={{ minWidth: 240 }}>
                  <Select
                    label="Service"
                    options={UPS_SERVICES.map((s) => ({ label: s.label, value: s.code }))}
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
                <InlineStack>
                  <Button
                    variant="plain"
                    disabled={buying || packages.length >= 20}
                    onClick={() => setPackages((rows) => [...rows, { ...EMPTY_PACKAGE }])}
                  >
                    Add another package
                  </Button>
                </InlineStack>
              </BlockStack>
              {fetcher.data?.error && <Banner tone="critical">{fetcher.data.error}</Banner>}
              {fetcher.data?.bought && fetcher.state === "idle" && (
                <Banner tone="success">Label bought — print it from the card above.</Banner>
              )}
              <InlineStack>
                <Button variant="primary" loading={buying} disabled={!canBuy} onClick={buy}>
                  {environment === "TEST" ? "Create test label" : "Buy label"} — bill UPS account{" "}
                  {customer?.upsAccountNumber ?? ""}
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}
