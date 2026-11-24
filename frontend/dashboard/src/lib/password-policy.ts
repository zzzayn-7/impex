// The rules for a password of the organization portal, the SAME ones the Auth Service enforces (services/auth-service/app/security.py: password_problems). They are here only so the
// person can see what is missing while they type; the Auth Service is the one that decides.

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 256;

export type PasswordCheck = { id: string; label: string; ok: boolean };

export function passwordChecks(password: string, email: string): PasswordCheck[] {
  const local = email.split("@")[0].toLowerCase();
  return [
    { id: "length", label: `At least ${MIN_PASSWORD_LENGTH} characters`, ok: password.length >= MIN_PASSWORD_LENGTH },
    { id: "lower", label: "A lowercase letter", ok: /[a-z]/.test(password) },
    { id: "upper", label: "An uppercase letter", ok: /[A-Z]/.test(password) },
    { id: "digit", label: "A digit", ok: /[0-9]/.test(password) },
    { id: "symbol", label: "A symbol (e.g. ! @ # $ %)", ok: /[^A-Za-z0-9]/.test(password) },
    { id: "email", label: "No part of your email address", ok: !(local.length >= 3 && password.toLowerCase().includes(local)) },
  ];
}

export const passwordIsStrong = (password: string, email: string): boolean => password.length <= MAX_PASSWORD_LENGTH && passwordChecks(password, email).every((c) => c.ok);
