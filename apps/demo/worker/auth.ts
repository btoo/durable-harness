import { HarnessFault } from "@durable-harness/core";
import { personaSchema, type Persona } from "./protocol.js";

export interface Session {
  sandbox: string;
  persona: Persona;
  expiresAt: number;
}
const encode = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const decode = (text: string) =>
  Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (character) =>
    character.charCodeAt(0),
  );
async function key(secret: string) {
  if (!secret || secret.length < 32)
    throw new HarnessFault(
      "NOT_CONFIGURED",
      "Set a random SESSION_SECRET before starting the application.",
    );
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
export async function signSession(session: Session, secret: string): Promise<string> {
  const body = encode(new TextEncoder().encode(JSON.stringify(session)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await key(secret),
    new TextEncoder().encode(body),
  );
  return `${body}.${encode(new Uint8Array(signature))}`;
}
export async function readSession(request: Request, secret: string): Promise<Session | undefined> {
  const token = request.headers
    .get("cookie")
    ?.split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith("dh_session="))
    ?.slice(11);
  if (!token) return undefined;
  try {
    const [body, signature] = token.split(".");
    if (
      !body ||
      !signature ||
      !(await crypto.subtle.verify(
        "HMAC",
        await key(secret),
        decode(signature),
        new TextEncoder().encode(body),
      ))
    )
      return undefined;
    const parsed = JSON.parse(new TextDecoder().decode(decode(body))) as Session;
    if (
      !personaSchema.safeParse(parsed.persona).success ||
      !/^[0-9a-f-]{36}$/.test(parsed.sandbox) ||
      parsed.expiresAt <= Date.now()
    )
      return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}
export function sessionCookie(token: string, url: URL): string {
  return `dh_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${url.protocol === "https:" ? "; Secure" : ""}`;
}
