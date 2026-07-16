/**
 * Customer enrollment + Shopify projection sync.
 *
 * The local WholesaleCustomer row is the single source of truth for account
 * state. Shopify carries two WRITE-ONLY projections of it, each existing
 * because of a platform constraint:
 *
 *   - customer tags (`wholesale`, plus `distributor` / `b2b` by type) — the
 *     only signal Liquid can read cheaply (wholesale-badge / wholesale-price
 *     blocks gate on `customer.tags contains 'wholesale'`)
 *   - the `wholesale.status` customer metafield — the only signal Shopify
 *     Functions can read (free-shipping delivery customization)
 *
 * Both are written exclusively by syncCustomerToShopify(). Nothing in the app
 * reads them back as authority; inbound customer webhooks reconcile
 * name/email only (see webhooks.tsx).
 */

import { db } from "../db.server";

// Fixed ids seeded by the add_pricing_profiles migration.
export const PRICING_PROFILE_IDS = {
  WHOLESALE: "pp_wholesale",
  DISTRIBUTOR: "pp_distributor",
  B2B: "pp_b2b",
} as const;

export function defaultProfileIdForType(customerType: string): string {
  switch (customerType) {
    case "DISTRIBUTOR":
      return PRICING_PROFILE_IDS.DISTRIBUTOR;
    case "B2B":
      return PRICING_PROFILE_IDS.B2B;
    default:
      return PRICING_PROFILE_IDS.WHOLESALE;
  }
}

/** Tags this app manages on Shopify customers. Never touch any other tag. */
const MANAGED_TAGS = ["wholesale", "distributor", "b2b"] as const;

function typeTag(customerType: string): string | null {
  if (customerType === "DISTRIBUTOR") return "distributor";
  if (customerType === "B2B") return "b2b";
  return null;
}

/**
 * Effective discount: per-customer override, else profile rate, else 50.
 */
export function resolveDiscountPercent(customer: {
  discountPercent: number | null;
  pricingProfile?: { discountPercent: number } | null;
}): number {
  return customer.discountPercent ?? customer.pricingProfile?.discountPercent ?? 50;
}

/** Minimal shape of the Admin GraphQL client from authenticate.admin(). */
type AdminClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> }
  ) => Promise<{ json: () => Promise<any> }>;
};

/**
 * Pushes the customer's current DB state out to Shopify: managed tags and the
 * wholesale.status / wholesale.minimum_order_value metafields. Call after
 * every mutation of a WholesaleCustomer row. Idempotent.
 */
export async function syncCustomerToShopify(
  admin: AdminClient,
  shopifyCustomerId: string
): Promise<void> {
  const customer = await db.wholesaleCustomer.findUnique({
    where: { shopifyCustomerId },
    include: { pricingProfile: true },
  });
  if (!customer) throw new Error(`No WholesaleCustomer for id ${shopifyCustomerId}`);

  const gid = `gid://shopify/Customer/${shopifyCustomerId}`;
  const approved = customer.status === "APPROVED";

  // Desired managed-tag set from DB state. Everything managed but not desired
  // is removed, so type changes and suspensions propagate.
  const desired = approved
    ? ["wholesale", typeTag(customer.customerType)].filter(Boolean) as string[]
    : [];

  // Shopify normalizes tag casing shop-wide: writing 'wholesale' on a store
  // whose registry knows legacy 'Wholesale' yields 'Wholesale'. Additions can
  // stay canonical (readers compare case-insensitively), but removals only
  // match exact casing — target whatever casing the customer actually has.
  const toRemoveLower: string[] = MANAGED_TAGS.filter((t) => !desired.includes(t));
  const tagsRes = await admin.graphql(
    `query CurrentCustomerTags($id: ID!) { customer(id: $id) { tags } }`,
    { variables: { id: gid } }
  );
  const tagsBody = await tagsRes.json();
  const currentTags: string[] = tagsBody.data?.customer?.tags ?? [];
  const toRemove = currentTags.filter((t) =>
    toRemoveLower.includes(t.toLowerCase())
  );

  const metafields: Array<Record<string, string>> = [
    {
      ownerId: gid,
      namespace: "wholesale",
      key: "status",
      value: approved ? "approved" : "inactive",
      type: "single_line_text_field",
    },
  ];

  // Per-customer override wins; profile minimum is the fallback. The global
  // OrderMinimumConfig fallback lives server-side (getEffectiveOrderMinimum),
  // so it is deliberately NOT projected onto the customer.
  const effectiveMinimum =
    customer.minimumOrderValue ?? customer.pricingProfile?.minimumOrderValue ?? null;
  if (effectiveMinimum !== null) {
    metafields.push({
      ownerId: gid,
      namespace: "wholesale",
      key: "minimum_order_value",
      value: String(effectiveMinimum),
      type: "single_line_text_field",
    });
  }

  // Each mutation reports failures via userErrors inside a 200 response —
  // they do NOT throw. Check every one so a denied write can't fail silently.
  const runMutation = async (label: string, query: string, variables: Record<string, unknown>) => {
    const res = await admin.graphql(query, { variables });
    const body = await res.json();
    const payload = body.data?.[Object.keys(body.data ?? {})[0] ?? ""] ?? {};
    const userErrors = payload.userErrors ?? [];
    if (userErrors.length > 0) {
      throw new Error(`${label}: ${userErrors.map((e: any) => e.message).join("; ")}`);
    }
  };

  const ops: Promise<unknown>[] = [];

  if (desired.length > 0) {
    ops.push(
      runMutation(
        "tagsAdd",
        `mutation AddManagedTags($id: ID!, $tags: [String!]!) {
          tagsAdd(id: $id, tags: $tags) {
            node { id }
            userErrors { field message }
          }
        }`,
        { id: gid, tags: desired }
      )
    );
  }
  if (toRemove.length > 0) {
    ops.push(
      runMutation(
        "tagsRemove",
        `mutation RemoveManagedTags($id: ID!, $tags: [String!]!) {
          tagsRemove(id: $id, tags: $tags) {
            node { id }
            userErrors { field message }
          }
        }`,
        { id: gid, tags: toRemove }
      )
    );
  }
  ops.push(
    runMutation(
      "metafieldsSet",
      `mutation SetWholesaleMetafields($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id }
          userErrors { field message }
        }
      }`,
      { metafields }
    )
  );
  // Tax exemption is a native Shopify customer field — checkout and draft
  // orders honor it automatically once set. Projected like the tags: DB is
  // the source, this sync is the only writer.
  ops.push(
    runMutation(
      "customerUpdate(taxExempt)",
      `mutation SetTaxExempt($input: CustomerInput!) {
        customerUpdate(input: $input) {
          customer { id }
          userErrors { field message }
        }
      }`,
      { input: { id: gid, taxExempt: customer.taxExempt } }
    )
  );

  await Promise.all(ops);

  // No effective minimum → make sure a stale metafield isn't left behind.
  if (effectiveMinimum === null) {
    const mfRes = await admin.graphql(
      `query GetMinimumMetafield($id: ID!) {
        customer(id: $id) {
          metafield(namespace: "wholesale", key: "minimum_order_value") { id }
        }
      }`,
      { variables: { id: gid } }
    );
    const mfData = await mfRes.json();
    const metafieldId = mfData.data?.customer?.metafield?.id;
    if (metafieldId) {
      await admin.graphql(
        `mutation DeleteMinimumMetafield($input: [ID!]!) {
          metafieldsDelete(metafields: $input) {
            userErrors { field message }
          }
        }`,
        { variables: { input: [metafieldId] } }
      );
    }
  }
}

/**
 * Handles CUSTOMERS_CREATE / CUSTOMERS_UPDATE webhooks. RECONCILES — never
 * enrolls. A customer tagged `wholesale` by hand in Shopify Admin is
 * deliberately ignored: the old behavior of silently creating an APPROVED
 * account at the default discount bypassed the review flow entirely.
 *
 * For customers the app does know, this:
 *   1. keeps identity fields (email/name) in sync, and
 *   2. self-heals tag drift: managed tags are pure projections of DB state,
 *      so ANY hand-edit in Shopify Admin — adding or removing — is simply
 *      rewritten to match the database. Removing the tag from an approved
 *      customer does NOT offboard them; the tag comes back on the next
 *      webhook. All account-state changes (approve, suspend, type change)
 *      happen in the app, which then re-projects.
 *
 * Loop safety: syncCustomerToShopify triggers another CUSTOMERS_UPDATE, but
 * after a sync the tags match DB state, so the re-entrant call finds no
 * drift and only touches identity fields.
 */
export async function reconcileCustomerFromWebhook(
  payload: Record<string, unknown>,
  admin: AdminClient | undefined
): Promise<void> {
  const shopifyCustomerId = String(payload.id ?? "");
  if (!shopifyCustomerId) return;

  const customer = await db.wholesaleCustomer.findUnique({
    where: { shopifyCustomerId },
  });
  if (!customer) return; // unknown customer — enrollment only happens in the app

  await db.wholesaleCustomer.update({
    where: { shopifyCustomerId },
    data: {
      email: String((payload.email as string) ?? "") || customer.email,
      firstName: String((payload.first_name as string) ?? "") || customer.firstName,
      lastName: String((payload.last_name as string) ?? "") || customer.lastName,
    },
  });

  // Exact drift check: the managed tags present on the Shopify customer must
  // equal the set the DB says they should have. Anything else → re-project.
  const tags = String(payload.tags ?? "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const presentManaged = MANAGED_TAGS.filter((t) => tags.includes(t)).sort();
  const desiredManaged = (
    customer.status === "APPROVED"
      ? (["wholesale", typeTag(customer.customerType)].filter(Boolean) as string[])
      : []
  ).sort();

  const drifted =
    presentManaged.length !== desiredManaged.length ||
    presentManaged.some((t, i) => t !== desiredManaged[i]);

  if (drifted && admin) {
    await syncCustomerToShopify(admin, shopifyCustomerId);
  }
}

export type BackfillResult = {
  scanned: number;
  enrolled: Array<{ email: string; customerType: string }>;
  healed: Array<{ email: string; reason: string }>;
  skippedNoEmail: number;
  truncated: boolean;
  dryRun: boolean;
};

/**
 * Backfill + reconcile sweep. Pages through every Shopify customer carrying a
 * managed tag and:
 *   - customers with NO local row → enrolls them as APPROVED (trusting the
 *     legacy tag as the source of record from before this app), typed by tag
 *     (distributor > b2b > wholesale)
 *   - customers WITH a local row → re-projects if their tags or
 *     wholesale.status metafield have drifted from DB state (heals edits
 *     that happened while the app was down and webhooks were dropped)
 *
 * Needed before go-live: customer webhooks only fire on create/update going
 * forward, so accounts tagged before the app was installed are invisible to
 * it until this runs. With dryRun (the default) nothing is written — the
 * result reports what WOULD happen.
 */
export async function backfillFromShopify(
  admin: AdminClient,
  { dryRun = true }: { dryRun?: boolean } = {}
): Promise<BackfillResult> {
  const result: BackfillResult = {
    scanned: 0,
    enrolled: [],
    healed: [],
    skippedNoEmail: 0,
    truncated: false,
    dryRun,
  };

  const MAX_PAGES = 40; // 40 × 50 = 2000 tagged customers; raise if ever needed
  let cursor: string | null = null;
  const seenIds = new Set<string>();
  let sweptAllPages = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await admin.graphql(
      `query TaggedCustomers($cursor: String) {
        customers(
          first: 50
          after: $cursor
          query: "tag:wholesale OR tag:distributor OR tag:b2b"
        ) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              legacyResourceId
              email
              firstName
              lastName
              tags
              metafield(namespace: "wholesale", key: "status") { value }
            }
          }
        }
      }`,
      { variables: { cursor } }
    );
    const data = await res.json();
    const conn = data.data?.customers;
    if (!conn) break;

    for (const edge of conn.edges ?? []) {
      const node = edge.node;
      result.scanned++;

      const shopifyCustomerId = String(node.legacyResourceId);
      seenIds.add(shopifyCustomerId);
      const tags: string[] = (node.tags ?? []).map((t: string) => t.toLowerCase());
      const existing = await db.wholesaleCustomer.findUnique({
        where: { shopifyCustomerId },
      });

      if (!existing) {
        if (!node.email) {
          result.skippedNoEmail++;
          continue;
        }
        const customerType = tags.includes("distributor")
          ? "DISTRIBUTOR"
          : tags.includes("b2b")
            ? "B2B"
            : "WHOLESALE";
        result.enrolled.push({ email: node.email, customerType });
        if (!dryRun) {
          await db.wholesaleCustomer.create({
            data: {
              shopifyCustomerId,
              email: node.email,
              firstName: node.firstName ?? null,
              lastName: node.lastName ?? null,
              status: "APPROVED",
              customerType,
              pricingProfileId: defaultProfileIdForType(customerType),
              discountPercent: null,
              paymentTerms: "CREDIT_CARD",
              approvedAt: new Date(),
              approvedBy: "backfill",
            },
          });
          await syncCustomerToShopify(admin, shopifyCustomerId);
        }
        continue;
      }

      // Known customer — check both projections for drift.
      const approved = existing.status === "APPROVED";
      const desiredManaged = (
        approved
          ? (["wholesale", typeTag(existing.customerType)].filter(Boolean) as string[])
          : []
      ).sort();
      const presentManaged = MANAGED_TAGS.filter((t) => tags.includes(t)).sort();
      const tagsDrifted =
        presentManaged.length !== desiredManaged.length ||
        presentManaged.some((t, i) => t !== desiredManaged[i]);
      const desiredStatus = approved ? "approved" : "inactive";
      const metafieldDrifted = (node.metafield?.value ?? null) !== desiredStatus;

      if (tagsDrifted || metafieldDrifted) {
        result.healed.push({
          email: existing.email,
          reason: tagsDrifted ? "tags out of sync" : "status metafield out of sync",
        });
        if (!dryRun) {
          await syncCustomerToShopify(admin, shopifyCustomerId);
        }
      }
    }

    if (!conn.pageInfo?.hasNextPage) {
      sweptAllPages = true;
      break;
    }
    cursor = conn.pageInfo.endCursor;
  }

  if (!sweptAllPages) result.truncated = true; // hit MAX_PAGES with more remaining

  // Second pass: APPROVED rows whose Shopify customer carries NO managed tag
  // never matched the tag query above, but are drifted by definition (an
  // approved account must have the wholesale tag). Only sound if the sweep
  // saw every tagged customer — skip when truncated.
  if (sweptAllPages) {
    const approvedRows = await db.wholesaleCustomer.findMany({
      where: { status: "APPROVED", shopifyCustomerId: { notIn: [...seenIds] } },
      select: { shopifyCustomerId: true, email: true },
    });
    for (const row of approvedRows) {
      result.healed.push({ email: row.email, reason: "wholesale tag missing entirely" });
      if (!dryRun) {
        await syncCustomerToShopify(admin, row.shopifyCustomerId);
      }
    }
  }

  return result;
}

export type EnrollInput = {
  email: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  phone?: string;
  /** "WHOLESALE" | "DISTRIBUTOR" | "B2B" — defaults to WHOLESALE */
  customerType?: string;
  /** Defaults to the profile matching customerType */
  pricingProfileId?: string;
  /** Per-customer rate override; omit/null to use the profile rate */
  discountPercent?: number | null;
  /** Defaults to the profile's paymentTerms */
  paymentTerms?: string;
  minimumOrderValue?: number | null;
  approvedBy?: string;
};

/**
 * The single enrollment path: finds or creates the Shopify customer record,
 * upserts the local row as APPROVED, and syncs projections. Used by both the
 * admin "add customer" flow and application approval.
 *
 * Creating a Shopify customer record does NOT create a storefront login —
 * with new customer accounts the customer just signs in by email OTP, so
 * there is no password or invite to manage.
 */
export async function enrollCustomer(admin: AdminClient, input: EnrollInput) {
  const email = input.email.trim().toLowerCase();
  const customerType = input.customerType ?? "WHOLESALE";
  const pricingProfileId = input.pricingProfileId ?? defaultProfileIdForType(customerType);

  const profile = await db.pricingProfile.findUnique({ where: { id: pricingProfileId } });
  if (!profile) throw new Error(`Unknown pricing profile: ${pricingProfileId}`);

  // Already enrolled? Reuse the known Shopify id rather than relying on
  // Shopify's customer search, whose index is eventually consistent (a
  // just-created customer can be missed, causing a duplicate-create error).
  const known = await db.wholesaleCustomer.findFirst({
    where: { email },
    select: { shopifyCustomerId: true },
  });
  if (known) {
    return finishEnrollment(admin, known.shopifyCustomerId, input, {
      email,
      customerType,
      pricingProfileId,
      profilePaymentTerms: profile.paymentTerms,
    });
  }

  // Find-or-create the Shopify customer record.
  const findRes = await admin.graphql(
    `query FindCustomerByEmail($query: String!) {
      customers(first: 1, query: $query) {
        edges { node { id legacyResourceId } }
      }
    }`,
    { variables: { query: `email:${email}` } }
  );
  const findData = await findRes.json();
  const existing = findData.data?.customers?.edges?.[0]?.node;

  let shopifyCustomerId: string;
  if (existing) {
    shopifyCustomerId = existing.legacyResourceId;
  } else {
    const createRes = await admin.graphql(
      `mutation CreateCustomer($input: CustomerInput!) {
        customerCreate(input: $input) {
          customer { id legacyResourceId }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          input: {
            email,
            firstName: input.firstName || undefined,
            lastName: input.lastName || undefined,
            phone: input.phone || undefined,
          },
        },
      }
    );
    const createData = await createRes.json();
    const errors = createData.data?.customerCreate?.userErrors ?? [];
    shopifyCustomerId = createData.data?.customerCreate?.customer?.legacyResourceId ?? "";
    if (!shopifyCustomerId) {
      throw new Error(
        `customerCreate failed: ${errors.map((e: any) => e.message).join("; ") || "unknown error"}`
      );
    }
  }

  return finishEnrollment(admin, shopifyCustomerId, input, {
    email,
    customerType,
    pricingProfileId,
    profilePaymentTerms: profile.paymentTerms,
  });
}

async function finishEnrollment(
  admin: AdminClient,
  shopifyCustomerId: string,
  input: EnrollInput,
  resolved: {
    email: string;
    customerType: string;
    pricingProfileId: string;
    profilePaymentTerms: string;
  }
) {
  const { email, customerType, pricingProfileId, profilePaymentTerms } = resolved;

  const customer = await db.wholesaleCustomer.upsert({
    where: { shopifyCustomerId },
    create: {
      shopifyCustomerId,
      email,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      company: input.company ?? null,
      phone: input.phone ?? null,
      status: "APPROVED",
      customerType,
      pricingProfileId,
      discountPercent: input.discountPercent ?? null,
      paymentTerms: input.paymentTerms ?? profilePaymentTerms,
      minimumOrderValue: input.minimumOrderValue ?? null,
      approvedAt: new Date(),
      approvedBy: input.approvedBy ?? null,
    },
    update: {
      email,
      firstName: input.firstName ?? undefined,
      lastName: input.lastName ?? undefined,
      company: input.company ?? undefined,
      phone: input.phone ?? undefined,
      status: "APPROVED",
      customerType,
      pricingProfileId,
      discountPercent: input.discountPercent ?? null,
      paymentTerms: input.paymentTerms ?? profilePaymentTerms,
      minimumOrderValue: input.minimumOrderValue ?? undefined,
      approvedAt: new Date(),
      approvedBy: input.approvedBy ?? undefined,
    },
  });

  await syncCustomerToShopify(admin, shopifyCustomerId);
  return customer;
}
