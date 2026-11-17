import { pgVector } from "../corpus/deps.js";
import { ArguStore } from "./store.js";

let store: ArguStore | undefined;

/** Stockage de l'argumentaire, sur la même base que le corpus et le bot. */
export function arguStore(): ArguStore {
  store ??= new ArguStore(pgVector().pool);
  return store;
}
