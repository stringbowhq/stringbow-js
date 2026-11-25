// Whether a device time zone places the user in the EU, EEA or UK. The browser SDK uses it to decide
// what it may offer before the server has confirmed a region; the server makes the binding check.

// IANA zones that sit in the EU / EEA / UK. "Europe/*" zones outside that set are listed as exceptions.
const EUROPE_NOT_BLOCKED = new Set([
  'Europe/Istanbul', 'Europe/Moscow', 'Europe/Kiev', 'Europe/Kyiv', 'Europe/Minsk', 'Europe/Belgrade', 'Europe/Sarajevo',
  'Europe/Skopje', 'Europe/Podgorica', 'Europe/Tirane', 'Europe/Chisinau', 'Europe/Zurich', 'Europe/Andorra', 'Europe/Monaco',
  'Europe/San_Marino', 'Europe/Vatican', 'Europe/Kaliningrad', 'Europe/Samara', 'Europe/Volgograd', 'Europe/Saratov',
  'Europe/Ulyanovsk', 'Europe/Astrakhan', 'Europe/Kirov', 'Europe/Simferopol', 'Europe/Zaporozhye', 'Europe/Uzhgorod',
  'Europe/Busingen', 'Europe/Tiraspol',
]);
const NON_EUROPE_BLOCKED = new Set([
  'Atlantic/Reykjavik', 'Atlantic/Canary', 'Atlantic/Madeira', 'Atlantic/Azores', 'Atlantic/Faroe', 'Africa/Ceuta',
  'Arctic/Longyearbyen', 'Asia/Nicosia', 'Asia/Famagusta', 'GB', 'Eire', 'Iceland', 'Portugal', 'Poland',
]);

/** True when the device time zone places the user in the EU, EEA or UK. */
export function timezoneIsEuUk(tz: string | null | undefined): boolean {
  if (!tz) return false;
  if (NON_EUROPE_BLOCKED.has(tz)) return true;
  return tz.startsWith('Europe/') && !EUROPE_NOT_BLOCKED.has(tz);
}
