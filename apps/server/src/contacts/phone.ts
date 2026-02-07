/**
 * Normalize an Indian phone number to E.164 format (+91XXXXXXXXXX).
 *
 * Handles:
 * - Already E.164: +919812345678 -> +919812345678
 * - With country code: 919812345678 -> +919812345678
 * - With leading zero: 09812345678 -> +919812345678
 * - Bare 10-digit: 9812345678 -> +919812345678
 * - With spaces/dashes: +91 98123 45678 -> +919812345678
 * - With parentheses: (091) 9812345678 -> +919812345678
 *
 * Indian mobile numbers are always 10 digits, starting with 6, 7, 8, or 9.
 */
export function normalizeIndianPhone(input: string): string {
  // Strip all non-digit characters except leading +
  const cleaned = input.replace(/[^+\d]/g, '');

  // Remove leading + for uniform processing
  const digits = cleaned.replace(/^\+/, '');

  let number: string;

  if (digits.startsWith('91') && digits.length === 12) {
    // Already has country code: 919812345678
    number = digits.slice(2);
  } else if (digits.startsWith('0') && digits.length === 11) {
    // Leading zero: 09812345678
    number = digits.slice(1);
  } else if (digits.length === 10) {
    // Bare 10-digit number
    number = digits;
  } else {
    throw new Error(`Invalid Indian phone number: "${input}"`);
  }

  // Validate: Indian mobile numbers start with 6-9
  if (!/^[6-9]\d{9}$/.test(number)) {
    throw new Error(
      `Invalid Indian mobile number: "${input}" (must start with 6-9 and be 10 digits)`,
    );
  }

  return `+91${number}`;
}
