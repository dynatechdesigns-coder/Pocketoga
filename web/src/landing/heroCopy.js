// The hero's honest early-access wording, in one place so the tests can check
// it. No claim that anyone can sign up today, and no customers, numbers or
// reviews. Plain JavaScript.
import { CONTACT_URL } from "../config.js";

export const EARLY_ACCESS_PILL = "Early access";
export const DEMO_BUTTON = "Try the demo shop";
export const LOGIN_BUTTON = "Log in to my shop";
export const CONTACT_LINE = "WhatsApp is built and waiting for Meta approval.";
export const CONTACT_LINK_TEXT = "Message the builder";

// The contact link, or null while CONTACT_URL is not set (the line then shows
// as plain text). Only web and mail links are ever used.
export const contactHref = (url = CONTACT_URL) => (/^(https?:\/\/|mailto:)/i.test(String(url ?? "").trim()) ? String(url).trim() : null);
