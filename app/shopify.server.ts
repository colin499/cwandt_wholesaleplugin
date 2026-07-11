import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import { db } from "./db.server";

// Called on every OAuth completion (install + re-auth).
// Finds the deployed delivery customization function by handle and creates the
// customization record if it doesn't already exist. Safe to call repeatedly —
// it checks for an existing record before creating. No-ops if the function
// hasn't been deployed yet (normal on first `shopify app dev` before build).
async function enableWholesaleShippingFunction(admin: any) {
  try {
    const fnRes = await admin.graphql(`
      query GetDeliveryFunctions {
        shopifyFunctions(first: 25, apiType: DELIVERY_CUSTOMIZATION) {
          nodes { id handle }
        }
      }
    `);
    const fnData = await fnRes.json();
    const fn = (fnData.data?.shopifyFunctions?.nodes ?? []).find(
      (n: { id: string; handle: string }) => n.handle === "wholesale-free-shipping"
    );

    if (!fn) {
      console.log("[afterAuth] wholesale-free-shipping function not deployed yet — skipping delivery customization setup");
      return;
    }

    const existingRes = await admin.graphql(`
      query GetDeliveryCustomizations {
        deliveryCustomizations(first: 25) {
          nodes { id title }
        }
      }
    `);
    const existingData = await existingRes.json();
    const alreadyEnabled = (existingData.data?.deliveryCustomizations?.nodes ?? []).some(
      (n: { id: string; title: string }) => n.title === "Wholesale Free Shipping"
    );

    if (alreadyEnabled) return;

    const createRes = await admin.graphql(`
      mutation EnableDeliveryCustomization($input: DeliveryCustomizationInput!) {
        deliveryCustomizationCreate(deliveryCustomization: $input) {
          deliveryCustomization { id title enabled }
          userErrors { field message }
        }
      }
    `, {
      variables: {
        input: {
          functionId: fn.id,
          title: "Wholesale Free Shipping",
          enabled: true,
        },
      },
    });
    const createData = await createRes.json();
    const errors = createData.data?.deliveryCustomizationCreate?.userErrors ?? [];
    if (errors.length > 0) {
      console.error("[afterAuth] deliveryCustomizationCreate userErrors:", errors);
    }
  } catch (err) {
    console.error("[afterAuth] Failed to enable wholesale shipping function:", err);
  }
}

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY!,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.January25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "http://localhost:3000",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(db),
  distribution: AppDistribution.SingleMerchant,
  // Webhooks are declared in shopify.app.toml ONLY. The old API registration
  // here (registerWebhooks in afterAuth) never took effect reliably — it ran
  // fire-and-forget on OAuth and pinned callbacks to whatever tunnel URL
  // existed at the time. TOML subscriptions with relative URIs follow
  // application_url automatically. Do not reintroduce the API path.
  hooks: {
    afterAuth: async ({ admin }) => {
      await enableWholesaleShippingFunction(admin);
    },
  },
  future: {
    unstable_newEmbeddedAuthStrategy: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.January25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
