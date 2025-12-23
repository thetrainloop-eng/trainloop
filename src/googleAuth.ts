import fs from "fs";
import path from "path";
import { google } from "googleapis";

const TOKENS_PATH = path.join(process.cwd(), "data", "google_tokens.json");

export function getOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI in .env");
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function saveTokens(tokens: any) {
  fs.mkdirSync(path.dirname(TOKENS_PATH), { recursive: true });
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2), "utf8");
}

export function loadTokens() {
  if (!fs.existsSync(TOKENS_PATH)) return null;
  return JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8"));
}

export function getAuthedClientOrNull() {
  const oauth2Client = getOAuthClient();
  const tokens = loadTokens();
  if (!tokens) return null;
  oauth2Client.setCredentials(tokens);
  return oauth2Client;
}
