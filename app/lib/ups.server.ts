/**
 * UPS label purchase, billed to the CUSTOMER's own UPS account.
 *
 * Self-contained on purpose: nothing in the ordering path (app-proxy,
 * enrollment, draft-order sync) imports this file. It is used only by the
 * admin Ship page (app/routes/app.linesheets_.$id_.ship.tsx).
 *
 * OFF unless every required env var below is set — `getUpsConfig()` returns
 * null and the admin UI hides the Ship action entirely:
 *
 *   UPS_CLIENT_ID, UPS_CLIENT_SECRET   UPS Developer Portal app credentials
 *   UPS_SHIPPER_NUMBER                 CW&T's own UPS account (the shipper)
 *   UPS_SHIP_FROM_NAME / _PHONE / _ADDRESS1 / _CITY / _STATE / _ZIP
 *   UPS_SHIP_FROM_ADDRESS2, UPS_SHIP_FROM_COUNTRY (default US)   optional
 *   UPS_ENV            "production" buys REAL labels. Anything else (default)
 *                      uses UPS's Customer Integration Environment, which
 *                      returns sample labels that are not valid for shipping.
 *   UPS_LABEL_FORMAT   "GIF" (default; prints on any printer) or "ZPL"
 *                      (4x6 thermal)
 *
 * The shipper is always CW&T; only the transportation charge is redirected,
 * via PaymentInformation.ShipmentCharge → BillReceiver / BillThirdParty.
 * UPS validates the billed account number against that account's postal code.
 *
 * Prices: because the customer's account pays, the Ship response reports the
 * shipper's charges as 0.00. The only price we can show is a rate quote
 * (Rating API "Shop", `rateUpsShipment`) at CW&T's published / negotiated
 * rates — an estimate; UPS bills the customer at their own account's rates.
 * The Rating API is a separate product that must be added to the app in the
 * UPS Developer Portal; until then quotes fail with "Invalid Authentication
 * Information" (code 250002) while labels keep working.
 */

import { UPS_SERVICES, upsServiceLabel } from "./ups-services";

const UPS_HOSTS = {
  TEST: "https://wwwcie.ups.com",
  PRODUCTION: "https://onlinetools.ups.com",
} as const;

const SHIP_API_VERSION = "v2409";
const RATE_API_VERSION = "v2409";
const REQUEST_TIMEOUT_MS = 25_000;

export type UpsEnvironment = keyof typeof UPS_HOSTS;
export type UpsLabelFormat = "GIF" | "ZPL";
export type UpsBillingType = "RECEIVER" | "THIRD_PARTY";

export type UpsAddress = {
  name: string;
  attention?: string | null;
  phone?: string | null;
  address1: string;
  address2?: string | null;
  city: string;
  state: string;
  postalCode: string;
  countryCode: string;
};

export type UpsConfig = {
  clientId: string;
  clientSecret: string;
  shipperNumber: string;
  environment: UpsEnvironment;
  labelFormat: UpsLabelFormat;
  shipFrom: UpsAddress;
};

export type UpsPackageInput = {
  weightLbs: number;
  lengthIn?: number | null;
  widthIn?: number | null;
  heightIn?: number | null;
};

export type UpsBilling = {
  type: UpsBillingType;
  accountNumber: string;
  postalCode: string;
  countryCode: string;
};

export type UpsCreateShipmentInput = {
  shipTo: UpsAddress;
  packages: UpsPackageInput[];
  serviceCode: string;
  billing: UpsBilling;
  // Printed on the label (order name / PO).
  reference?: string | null;
};

export type UpsPackageResult = {
  trackingNumber: string;
  labelFormat: UpsLabelFormat;
  labelBase64: string;
};

// A money amount as UPS returns it ("12.34"), kept as a string so nothing is
// rounded on the way to the database.
export type UpsCharge = { amount: string; currency: string };

export type UpsShipmentResult = {
  shipmentId: string;
  packages: UpsPackageResult[];
  // What UPS says the shipper owes for this label. 0.00 when the customer's
  // account is billed (the normal case here) — see the header comment.
  totalCharge: UpsCharge | null;
  negotiatedCharge: UpsCharge | null;
};

export type UpsRateInput = {
  shipTo: UpsAddress;
  packages: UpsPackageInput[];
};

export type UpsRateQuote = {
  serviceCode: string;
  // UPS published (daily) rate.
  published: UpsCharge;
  // CW&T's contract rate, when UPS returns one for the account.
  negotiated: UpsCharge | null;
};

// UPS account numbers are six letters/digits (the middle of every 1Z number).
export function normalizeUpsAccountNumber(raw: string): string | null {
  const v = raw.replace(/[\s-]/g, "").toUpperCase();
  return /^[A-Z0-9]{6}$/.test(v) ? v : null;
}

export class UpsError extends Error {
  code: string | null;
  constructor(message: string, code: string | null = null) {
    super(message);
    this.name = "UpsError";
    this.code = code;
  }
}

export function getUpsConfig(
  env: Record<string, string | undefined> = process.env
): UpsConfig | null {
  const v = (k: string) => (env[k] ?? "").trim();
  const required = [
    "UPS_CLIENT_ID",
    "UPS_CLIENT_SECRET",
    "UPS_SHIPPER_NUMBER",
    "UPS_SHIP_FROM_NAME",
    "UPS_SHIP_FROM_PHONE",
    "UPS_SHIP_FROM_ADDRESS1",
    "UPS_SHIP_FROM_CITY",
    "UPS_SHIP_FROM_STATE",
    "UPS_SHIP_FROM_ZIP",
  ];
  if (required.some((k) => !v(k))) return null;

  return {
    clientId: v("UPS_CLIENT_ID"),
    clientSecret: v("UPS_CLIENT_SECRET"),
    shipperNumber: v("UPS_SHIPPER_NUMBER").toUpperCase(),
    // Real labels only on an explicit opt-in — a typo falls back to TEST.
    environment: v("UPS_ENV").toLowerCase() === "production" ? "PRODUCTION" : "TEST",
    labelFormat: v("UPS_LABEL_FORMAT").toUpperCase() === "ZPL" ? "ZPL" : "GIF",
    shipFrom: {
      name: v("UPS_SHIP_FROM_NAME"),
      phone: v("UPS_SHIP_FROM_PHONE"),
      address1: v("UPS_SHIP_FROM_ADDRESS1"),
      address2: v("UPS_SHIP_FROM_ADDRESS2") || null,
      city: v("UPS_SHIP_FROM_CITY"),
      state: v("UPS_SHIP_FROM_STATE").toUpperCase(),
      postalCode: v("UPS_SHIP_FROM_ZIP"),
      countryCode: (v("UPS_SHIP_FROM_COUNTRY") || "US").toUpperCase(),
    },
  };
}

// ── Request building (pure — no network) ─────────────────────────────────────

const clip = (s: string | null | undefined, max: number) => (s ?? "").trim().slice(0, max);
const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "").slice(0, 15);

function addressBlock(a: UpsAddress) {
  return {
    AddressLine: [clip(a.address1, 35), clip(a.address2, 35)].filter(Boolean),
    City: clip(a.city, 30),
    StateProvinceCode: clip(a.state, 5),
    PostalCode: clip(a.postalCode, 9),
    CountryCode: clip(a.countryCode, 2).toUpperCase(),
  };
}

function partyBlock(a: UpsAddress) {
  const phone = digits(a.phone);
  return {
    Name: clip(a.name, 35),
    AttentionName: clip(a.attention || a.name, 35),
    ...(phone ? { Phone: { Number: phone } } : {}),
    Address: addressBlock(a),
  };
}

function packageBlock(p: UpsPackageInput, reference: string) {
  const hasDims = [p.lengthIn, p.widthIn, p.heightIn].every(
    (d) => typeof d === "number" && d > 0
  );
  return {
    Packaging: { Code: "02", Description: "Customer Supplied Package" },
    ...(hasDims
      ? {
          Dimensions: {
            UnitOfMeasurement: { Code: "IN", Description: "Inches" },
            Length: String(p.lengthIn),
            Width: String(p.widthIn),
            Height: String(p.heightIn),
          },
        }
      : {}),
    PackageWeight: {
      UnitOfMeasurement: { Code: "LBS", Description: "Pounds" },
      Weight: p.weightLbs.toFixed(1),
    },
    ...(reference ? { ReferenceNumber: { Value: reference } } : {}),
  };
}

// The parts of a shipment a rate quote also needs: a US address and sane packages.
export function validateRateInput(input: UpsRateInput): string | null {
  const { shipTo, packages } = input;
  if (!shipTo.address1 || !shipTo.city || !shipTo.state || !shipTo.postalCode) {
    return "The order's shipping address is incomplete.";
  }
  if (shipTo.countryCode.toUpperCase() !== "US") {
    return "Only US shipments are supported for UPS account billing right now.";
  }
  if (packages.length === 0) return "Add at least one package.";
  if (packages.length > 20) return "Too many packages for one shipment (max 20).";
  for (const [i, p] of packages.entries()) {
    const n = packages.length > 1 ? ` (package ${i + 1})` : "";
    if (!(p.weightLbs > 0) || p.weightLbs > 150) {
      return `Weight must be between 0.1 and 150 lbs${n}.`;
    }
    const dims = [p.lengthIn, p.widthIn, p.heightIn];
    const given = dims.filter((d) => d != null).length;
    if (given !== 0 && (given !== 3 || dims.some((d) => !(Number(d) > 0)))) {
      return `Enter all three dimensions, or leave them all blank${n}.`;
    }
  }
  return null;
}

export function validateShipmentInput(input: UpsCreateShipmentInput): string | null {
  const base = validateRateInput(input);
  if (base) return base;
  const { billing } = input;
  if (!UPS_SERVICES.some((s) => s.code === input.serviceCode)) {
    return "Choose a UPS service.";
  }
  if (!normalizeUpsAccountNumber(billing.accountNumber)) {
    return "The customer's UPS account number must be 6 letters/digits.";
  }
  if (!billing.postalCode.trim()) {
    return "The customer's UPS account needs its billing postal code.";
  }
  return null;
}

export function buildShipmentRequest(config: UpsConfig, input: UpsCreateShipmentInput) {
  const reference = clip(input.reference, 35);
  const account = normalizeUpsAccountNumber(input.billing.accountNumber) ?? "";
  const billTo =
    input.billing.type === "THIRD_PARTY"
      ? {
          BillThirdParty: {
            AccountNumber: account,
            Address: {
              PostalCode: clip(input.billing.postalCode, 9),
              CountryCode: clip(input.billing.countryCode || "US", 2).toUpperCase(),
            },
          },
        }
      : {
          BillReceiver: {
            AccountNumber: account,
            Address: { PostalCode: clip(input.billing.postalCode, 9) },
          },
        };

  const pkgs = input.packages.map((p) => packageBlock(p, reference));

  return {
    ShipmentRequest: {
      Request: {
        RequestOption: "nonvalidate",
        TransactionReference: { CustomerContext: reference || "CW&T wholesale" },
      },
      Shipment: {
        Description: "CW&T wholesale order",
        Shipper: { ...partyBlock(config.shipFrom), ShipperNumber: config.shipperNumber },
        ShipTo: partyBlock(input.shipTo),
        ShipFrom: partyBlock(config.shipFrom),
        PaymentInformation: {
          ShipmentCharge: { Type: "01", ...billTo },
        },
        ShipmentRatingOptions: { NegotiatedRatesIndicator: "Y" },
        Service: { Code: input.serviceCode, Description: upsServiceLabel(input.serviceCode) },
        Package: pkgs.length === 1 ? pkgs[0] : pkgs,
      },
      LabelSpecification:
        config.labelFormat === "ZPL"
          ? {
              LabelImageFormat: { Code: "ZPL", Description: "ZPL" },
              LabelStockSize: { Height: "6", Width: "4" },
            }
          : {
              LabelImageFormat: { Code: "GIF", Description: "GIF" },
              HTTPUserAgent: "Mozilla/4.5",
            },
    },
  };
}

// {CurrencyCode, MonetaryValue} → UpsCharge, or null when absent/garbled.
function parseCharge(node: any): UpsCharge | null {
  const amount = String(node?.MonetaryValue ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(amount)) return null;
  return { amount, currency: String(node?.CurrencyCode ?? "USD") || "USD" };
}

export function parseShipmentResponse(body: any, labelFormat: UpsLabelFormat): UpsShipmentResult {
  const results = body?.ShipmentResponse?.ShipmentResults;
  const shipmentId = results?.ShipmentIdentificationNumber;
  // One package comes back as an object, several as an array.
  const raw = results?.PackageResults;
  const list: any[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const packages = list.map((p) => ({
    trackingNumber: String(p?.TrackingNumber ?? ""),
    labelFormat,
    labelBase64: String(p?.ShippingLabel?.GraphicImage ?? ""),
  }));
  if (!shipmentId || packages.length === 0 || packages.some((p) => !p.trackingNumber)) {
    throw new UpsError("UPS returned a response without tracking numbers.");
  }
  return {
    shipmentId: String(shipmentId),
    packages,
    totalCharge: parseCharge(results?.ShipmentCharges?.TotalCharges),
    negotiatedCharge: parseCharge(results?.NegotiatedRateCharges?.TotalCharge),
  };
}

// Rate quote for every service at once ("Shop"). Rated as CW&T the shipper,
// with no payment redirection: that is the only way to get a real figure,
// since a receiver-billed shipment rates as 0.00 for the shipper.
export function buildRateRequest(config: UpsConfig, input: UpsRateInput) {
  return {
    RateRequest: {
      Request: {
        TransactionReference: { CustomerContext: "CW&T wholesale rate quote" },
      },
      Shipment: {
        Shipper: { ...partyBlock(config.shipFrom), ShipperNumber: config.shipperNumber },
        ShipTo: partyBlock(input.shipTo),
        ShipFrom: partyBlock(config.shipFrom),
        ShipmentRatingOptions: { NegotiatedRatesIndicator: "Y" },
        Package: input.packages.map((p) => {
          // Same block as a shipment, under the Rating API's field names.
          const { Packaging, ReferenceNumber: _ref, ...rest } = packageBlock(p, "");
          return { PackagingType: Packaging, ...rest };
        }),
      },
    },
  };
}

export function parseRateResponse(body: any): UpsRateQuote[] {
  const raw = body?.RateResponse?.RatedShipment;
  const list: any[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const quotes: UpsRateQuote[] = [];
  for (const r of list) {
    const serviceCode = String(r?.Service?.Code ?? "");
    const published = parseCharge(r?.TotalCharges);
    if (!serviceCode || !published) continue;
    quotes.push({
      serviceCode,
      published,
      negotiated: parseCharge(r?.NegotiatedRateCharges?.TotalCharge),
    });
  }
  // Only the services the Ship page offers, in its order.
  return UPS_SERVICES.flatMap((s) => quotes.filter((q) => q.serviceCode === s.code));
}

// ── Network ──────────────────────────────────────────────────────────────────

function errorFromBody(body: any, status: number): UpsError {
  const first = body?.response?.errors?.[0];
  if (first?.message) return new UpsError(String(first.message), String(first.code ?? "") || null);
  return new UpsError(`UPS request failed (HTTP ${status}).`);
}

async function upsFetch(url: string, init: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    throw new UpsError(
      `Couldn't reach UPS (${err instanceof Error ? err.message : String(err)}).`
    );
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw errorFromBody(body, res.status);
  return body;
}

let cachedToken: { key: string; token: string; expiresAt: number } | null = null;

async function getAccessToken(config: UpsConfig): Promise<string> {
  const key = `${config.environment}:${config.clientId}`;
  if (cachedToken && cachedToken.key === key && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }
  const body = await upsFetch(`${UPS_HOSTS[config.environment]}/security/v1/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "x-merchant-id": config.shipperNumber,
      Authorization:
        "Basic " + Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64"),
    },
    body: "grant_type=client_credentials",
  });
  if (!body?.access_token) throw new UpsError("UPS did not return an access token.");
  cachedToken = {
    key,
    token: String(body.access_token),
    expiresAt: Date.now() + Number(body.expires_in ?? 3600) * 1000,
  };
  return cachedToken.token;
}

function apiHeaders(token: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    transId: crypto.randomUUID().replace(/-/g, ""),
    transactionSrc: "cwt-wholesale",
  };
}

// Buys the label. In PRODUCTION this creates a real, billable shipment.
export async function createUpsShipment(
  config: UpsConfig,
  input: UpsCreateShipmentInput
): Promise<UpsShipmentResult> {
  const invalid = validateShipmentInput(input);
  if (invalid) throw new UpsError(invalid);

  const token = await getAccessToken(config);
  const body = await upsFetch(
    `${UPS_HOSTS[config.environment]}/api/shipments/${SHIP_API_VERSION}/ship`,
    {
      method: "POST",
      headers: apiHeaders(token),
      body: JSON.stringify(buildShipmentRequest(config, input)),
    }
  );
  return parseShipmentResponse(body, config.labelFormat);
}

// Quotes every offered service. Throws UpsError (code 250002, "Invalid
// Authentication Information") when the Rating product isn't enabled for the
// app — the caller turns that into a setup hint.
export async function rateUpsShipment(
  config: UpsConfig,
  input: UpsRateInput
): Promise<UpsRateQuote[]> {
  const invalid = validateRateInput(input);
  if (invalid) throw new UpsError(invalid);

  const token = await getAccessToken(config);
  const body = await upsFetch(
    `${UPS_HOSTS[config.environment]}/api/rating/${RATE_API_VERSION}/Shop`,
    {
      method: "POST",
      headers: apiHeaders(token),
      body: JSON.stringify(buildRateRequest(config, input)),
    }
  );
  const quotes = parseRateResponse(body);
  if (quotes.length === 0) throw new UpsError("UPS returned no rates for this shipment.");
  return quotes;
}

export async function voidUpsShipment(config: UpsConfig, shipmentId: string): Promise<void> {
  const token = await getAccessToken(config);
  const body = await upsFetch(
    `${UPS_HOSTS[config.environment]}/api/shipments/${SHIP_API_VERSION}/void/cancel/${encodeURIComponent(shipmentId)}`,
    { method: "DELETE", headers: apiHeaders(token) }
  );
  const code = body?.VoidShipmentResponse?.SummaryResult?.Status?.Code;
  if (String(code) !== "1") {
    const desc = body?.VoidShipmentResponse?.SummaryResult?.Status?.Description;
    throw new UpsError(desc ? `UPS did not void the shipment: ${desc}` : "UPS did not void the shipment.");
  }
}
