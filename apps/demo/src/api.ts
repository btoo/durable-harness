import type { DemoApplication } from "../worker/application.js";
import type { DemoCommand, Persona } from "../worker/protocol.js";

export type DemoState = ReturnType<DemoApplication["state"]>;
export type { DemoCommand, Persona };
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const result = (await response.json()) as T & { error?: { message: string; code: string } };
  if (!response.ok)
    throw new Error(result.error?.message ?? `Request failed (${response.status}).`);
  return result;
}
export function setPersona(persona: Persona) {
  return request("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ persona }),
  });
}
export function command(workspaceId: string, value: DemoCommand) {
  return request(`/api/command?workspace=${encodeURIComponent(workspaceId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}
