import { AsYouType, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

export type SupportedCountry = {
  readonly code: CountryCode;
  readonly dialCode: string;
  readonly flag: string;
  readonly name: string;
};

export const SUPPORTED_COUNTRIES: readonly SupportedCountry[] = [
  { code: 'GB', dialCode: '+44', flag: '🇬🇧', name: 'United Kingdom' },
  { code: 'US', dialCode: '+1', flag: '🇺🇸', name: 'United States' },
  { code: 'IE', dialCode: '+353', flag: '🇮🇪', name: 'Ireland' },
  { code: 'FR', dialCode: '+33', flag: '🇫🇷', name: 'France' },
  { code: 'DE', dialCode: '+49', flag: '🇩🇪', name: 'Germany' },
  { code: 'ES', dialCode: '+34', flag: '🇪🇸', name: 'Spain' },
  { code: 'AU', dialCode: '+61', flag: '🇦🇺', name: 'Australia' },
];

export function formatPhoneAsYouType(raw: string, country: CountryCode): string {
  return new AsYouType(country).input(raw);
}

export function toE164(raw: string, country: CountryCode): string | null {
  const parsed = parsePhoneNumberFromString(raw, country);
  if (!parsed?.isValid()) return null;
  return parsed.number;
}

export function maskPhoneNumber(e164: string | null): string {
  if (!e164) return '';

  const parsed = parsePhoneNumberFromString(e164);
  const national = parsed?.nationalNumber || e164.replace(/\D/g, '');
  const last4 = national.slice(-4);
  if (!last4) return '';
  if (!parsed?.countryCallingCode) return `•••• ${last4}`;
  return `+${parsed.countryCallingCode} •••• ••${last4}`;
}
