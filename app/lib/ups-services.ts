// UPS service list — shared by the server-side UPS client and the admin Ship
// page UI (kept out of ups.server.ts so the browser bundle can import it).

// US domestic services offered on the Ship page.
export const UPS_SERVICES = [
  { code: "03", label: "UPS Ground" },
  { code: "12", label: "UPS 3 Day Select" },
  { code: "02", label: "UPS 2nd Day Air" },
  { code: "13", label: "UPS Next Day Air Saver" },
  { code: "01", label: "UPS Next Day Air" },
] as const;

export function upsServiceLabel(code: string): string {
  return UPS_SERVICES.find((s) => s.code === code)?.label ?? `UPS service ${code}`;
}
