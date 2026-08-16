// Meta call-to-action button types supported on ad creatives. Mirrors the
// list the variation factory accepts (app/(app)/campaigns/factory/actions.ts).
// Pure + dependency-free so client components can import the options for a
// dropdown and the server can reuse the same set for validation.
export const META_CTA_TYPES = [
  "LEARN_MORE",
  "SHOP_NOW",
  "SIGN_UP",
  "GET_OFFER",
  "BOOK_TRAVEL",
  "DOWNLOAD",
  "CONTACT_US",
  "SUBSCRIBE",
  "MESSAGE_PAGE",
  "WHATSAPP_MESSAGE",
] as const;

export type MetaCtaType = (typeof META_CTA_TYPES)[number];

export const META_CTA_OPTIONS: { value: MetaCtaType; label: string }[] = [
  { value: "SIGN_UP", label: "Sign Up" },
  { value: "LEARN_MORE", label: "Learn More" },
  { value: "SHOP_NOW", label: "Shop Now" },
  { value: "GET_OFFER", label: "Get Offer" },
  { value: "BOOK_TRAVEL", label: "Book Now" },
  { value: "DOWNLOAD", label: "Download" },
  { value: "CONTACT_US", label: "Contact Us" },
  { value: "SUBSCRIBE", label: "Subscribe" },
  { value: "MESSAGE_PAGE", label: "Send Message" },
  { value: "WHATSAPP_MESSAGE", label: "WhatsApp" },
];

export function isMetaCtaType(v: string): v is MetaCtaType {
  return (META_CTA_TYPES as readonly string[]).includes(v);
}
