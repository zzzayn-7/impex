// Mirrors the Auth Service's password policy for privileged accounts. The Auth Service is the
// authority and re-checks everything; this gives instant feedback and a clean error before the request.

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;

export type PasswordCheck = { id: string; label: string; ok: boolean };

export function passwordChecks(password: string, email: string): PasswordCheck[] {
  const localPart = email.split("@")[0].toLowerCase();
  return [
    { id: "length", label: `At least ${MIN_PASSWORD_LENGTH} characters`, ok: password.length >= MIN_PASSWORD_LENGTH },
    { id: "lower", label: "A lowercase letter", ok: /[a-z]/.test(password) },
    { id: "upper", label: "An uppercase letter", ok: /[A-Z]/.test(password) },
    { id: "digit", label: "A digit", ok: /[0-9]/.test(password) },
    { id: "symbol", label: "A symbol (e.g. ! @ # $ %)", ok: /[^A-Za-z0-9]/.test(password) },
    {
      id: "email",
      label: "No part of your email address",
      ok: localPart.length < 3 || !password.toLowerCase().includes(localPart),
    },
  ];
}

export function passwordProblems(password: string, email: string): string[] {
  const problems = passwordChecks(password, email).filter((c) => !c.ok).map((c) => c.label);
  if (password.length > MAX_PASSWORD_LENGTH) problems.push(`At most ${MAX_PASSWORD_LENGTH} characters`);
  return problems;
}
