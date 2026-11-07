"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { api, jsonBody } from "@/lib/sales-browser";
import { checkFullName } from "@/lib/setup-validation";
import { Card, Field, Notice, ReadOnly, SaveBar, inputClass } from "./settings-ui";

export type AdminInfo = { id: string; full_name: string; email: string; role: string; organization_id: string };

/** The signed-in administrator's OWN profile. Only the display name is editable, and it is saved through the Auth Service for the person the
 *  session belongs to: no role, e-mail, organization or other administrator can be reached from here. */
export default function ProfileSection({ admin, organizationName, setDirty, onSaved }: { admin: AdminInfo; organizationName: string; setDirty: (key: string, dirty: boolean) => void; onSaved: (message: string) => void }) {
  const router = useRouter();
  const [saved, setSaved] = useState(admin.full_name);
  const [name, setName] = useState(admin.full_name);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const checked = checkFullName(name);
  const dirty = name !== saved;
  const shown = fieldError ?? (touched && !checked.ok ? checked.message : undefined);
  useEffect(() => { setDirty("profile", dirty); }, [dirty, setDirty]);

  async function save() {
    if (busyRef.current) return;
    setError(null);
    if (!checked.ok) {
      setTouched(true);
      return setFieldError(checked.message);
    }
    if (checked.value === saved) return;
    busyRef.current = true;
    setBusy(true);
    const r = await api("/api/settings/profile", { method: "PATCH", ...jsonBody({ fullName: checked.value }) });
    busyRef.current = false;
    setBusy(false);
    if (r.status === 401) return router.replace("/login");
    if (!r.ok) {
      const fe = (r.data?.fieldErrors ?? {}) as Record<string, string>;
      if (fe.fullName) setFieldError(fe.fullName);
      return setError(r.error);
    }
    const stored = r.data?.user?.full_name ?? checked.value;
    setSaved(stored);
    setName(stored);
    onSaved("Your name was saved.");
    router.refresh(); // the portal header shows the new name on the next render
  }

  return (
    <Card id="profile" title="Administrator profile" description="Your own account. Only you can change your display name; your e-mail address and role are managed by the platform.">
      <div className="grid gap-5 sm:grid-cols-2">
        <Field id="profile-name" label="Your full name" error={shown} className="sm:col-span-2">
          <input id="profile-name" value={name} onChange={(e) => { setName(e.target.value); setFieldError(undefined); setError(null); }} onBlur={() => setTouched(true)} maxLength={100} autoComplete="name"
            aria-invalid={Boolean(shown)} aria-describedby={shown ? "profile-name-error" : undefined} className={inputClass} />
        </Field>
      </div>
      {error && <div className="mt-4"><Notice kind="error">{error}</Notice></div>}
      <SaveBar dirty={dirty} busy={busy} onSave={() => void save()} onDiscard={() => { setName(saved); setFieldError(undefined); setTouched(false); setError(null); }} />
      <dl className="mt-6 grid gap-3 sm:grid-cols-2" aria-label="Account details">
        <ReadOnly label="Email address" value={admin.email} />
        <ReadOnly label="Role" value={admin.role === "organization-admin" ? "Organization administrator" : admin.role} />
        <ReadOnly label="Organization" value={organizationName} />
        <ReadOnly label="Organization ID" value={admin.organization_id} mono />
        <ReadOnly label="User ID" value={admin.id} mono />
      </dl>
    </Card>
  );
}
