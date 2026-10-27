// Types for netdev.js, which every game client shares unchanged (so it stays JavaScript).

export const DEV_PUBLIC_KEY: string;

/** A dev's display name: capitals, digits and spaces, at most 16, e.g. "ANDRE". */
export function cleanDevName(value: unknown): string;
export function verifyDevPass(pass: unknown, host: string, options?: { publicKey?: string; now?: number }): Promise<{ name: string } | null>;
export function signDevPass(privateKey: string, claims: { name: string; host: string; ttl?: number; now?: number }): Promise<{ pass: string; exp: number }>;
/** This browser's dev pass, or null for everyone else (and off https andrenijman.com). */
export function devPass(): Promise<{ name: string; pass: string } | null>;
/** The room code from a ?join=CODE link, or null. */
export function joinCode(): string | null;
/** Drops ?join= from the address bar once it has been used. */
export function clearJoinCode(): void;
/** Who this tab plays as, and in which room ('' or null: none), for the admin page's live view. */
export function setPlayer(name: string, room: string | null): void;
/** "DEV ANDRE HAS JOINED" in the middle of the screen for four seconds. */
export function showDevJoined(name: string): void;
