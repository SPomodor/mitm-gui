import { useSyncExternalStore } from "react";
import english from "../electron/locales/en.json";

export type LanguagePreference = "auto" | "ru" | "en";
export type Locale = "ru" | "en";
const dictionary: Record<string, string> = english;
const listeners = new Set<() => void>();
let preference: LanguagePreference = window.chls.language.preference;
const systemLocale = window.chls.language.systemLocale;
export function resolveLocale(
  choice: LanguagePreference,
  system: string,
): Locale {
  return choice === "auto"
    ? /^ru(?:-|_|$)/i.test(system)
      ? "ru"
      : "en"
    : choice;
}
export function getLocale(): Locale {
  return resolveLocale(preference, systemLocale);
}
export function getLanguagePreference() {
  return preference;
}
function publish(choice: LanguagePreference) {
  preference = choice;
  document.documentElement.lang = getLocale();
  listeners.forEach((listener) => listener());
}
window.chls.onLanguage(publish);
publish(preference);
export function setLanguage(choice: LanguagePreference) {
  return window.chls.setLanguage(choice);
}
export function useLocale() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, getLocale);
}
export function useLanguagePreference() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, getLanguagePreference);
}
export function t(source: string, values: unknown[] = []): string {
  const text = getLocale() === "en" ? (dictionary[source] ?? source) : source;
  return text.replace(/\{(\d+)\}/g, (match, index) =>
    Number(index) < values.length ? String(values[Number(index)]) : match,
  );
}

const entries = Object.entries(dictionary);
const reverse = Object.fromEntries(entries.map(([ru, en]) => [en, ru]));
function messagePattern(text: string) {
  const order: number[] = [];
  const escaped = text
    .split(/(\{\d+\})/)
    .map((part) => {
      if (/^\{\d+\}$/.test(part)) {
        order.push(Number(part.slice(1, -1)));
        return "([\\s\\S]*?)";
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return { pattern: new RegExp("^" + escaped + "$"), order };
}
const messages = entries
  .filter(([key]) => /\{\d+\}/.test(key))
  .map(([ru, en]) => ({
    ru,
    en,
    russian: messagePattern(ru),
    english: messagePattern(en),
  }));
// Only use for app-owned messages, never for traffic, code or user names.
export function localizeMessage(text: string, depth = 0): string {
  if (depth > 3) return text;
  if (dictionary[text]) return t(text);
  if (reverse[text]) return t(reverse[text]);
  for (const message of messages) {
    for (const candidate of [message.russian, message.english]) {
      const match = candidate.pattern.exec(text);
      if (!match) continue;
      const values: string[] = [];
      candidate.order.forEach((index, capture) => {
        values[index] = localizeMessage(match[capture + 1], depth + 1);
      });
      return t(message.ru, values);
    }
  }
  const marker = text.indexOf(": Error: ");
  if (marker >= 0) return localizeMessage(text.slice(marker + 9), depth + 1);
  return text;
}
