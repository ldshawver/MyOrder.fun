import { useState } from "react";
import { useAuth } from "@clerk/react";
import type { UserProfile } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const PHONE_REGEX = /^\+?[\d\s-]{7,20}$/;
const AVATAR_PATH = /^\/api\/profile-images\/[0-9a-f-]{36}$/i;

type Props = {
  user: UserProfile;
  onSaved: () => Promise<void>;
  onSignOut: () => void;
};

export default function ProfileCompletion({ user, onSaved, onSignOut }: Props) {
  const { getToken } = useAuth();
  const emailLocked = Boolean(user.email?.trim());
  const [firstName, setFirstName] = useState(user.firstName ?? "");
  const [lastName, setLastName] = useState(user.lastName ?? "");
  const [phone, setPhone] = useState(user.contactPhone ?? "");
  const [email, setEmail] = useState(user.email ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  async function save() {
    if (saving) return;
    const nextFirst = firstName.trim();
    const nextLast = lastName.trim();
    const nextPhone = phone.trim();
    const nextEmail = email.trim();
    if (!nextFirst || !nextLast) {
      setMessage("Enter your first and last name.");
      return;
    }
    if (!PHONE_REGEX.test(nextPhone)) {
      setMessage("Enter a phone number with 7 to 20 digits. Spaces and dashes are allowed.");
      return;
    }
    if (!emailLocked && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail)) {
      setMessage("Enter the email address for this account.");
      return;
    }
    const hasPhoto = Boolean(file) || AVATAR_PATH.test(user.avatarUrl ?? "") || Boolean(user.avatarUrl?.trim());
    if (!hasPhoto) {
      setMessage("Upload a profile picture.");
      return;
    }
    setSaving(true);
    setMessage("");
    try {
      const token = await getToken();
      if (!token) throw new Error("Your session expired. Sign in again.");
      const bindEmail = emailLocked ? user.email.trim() : nextEmail;
      let profileImageUploadId: string | undefined;
      if (file) {
        if (file.size > 3_000_000) throw new Error("Choose a PNG, JPEG, or WebP image up to 3 MB.");
        const formData = new FormData();
        formData.set("file", file);
        formData.set("email", bindEmail);
        const upload = await fetch(`${import.meta.env.BASE_URL}api/profile-images`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: formData,
        });
        const uploaded = await upload.json().catch(() => ({}));
        if (!upload.ok || typeof uploaded.uploadId !== "string") throw new Error(uploaded.error ?? "Profile picture upload failed.");
        profileImageUploadId = uploaded.uploadId;
      }
      const response = await fetch(`${import.meta.env.BASE_URL}api/users/me`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: nextFirst,
          lastName: nextLast,
          contactPhone: nextPhone,
          ...(emailLocked ? {} : { email: nextEmail }),
          ...(profileImageUploadId ? { profileImageUploadId } : {}),
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? "Could not save your profile.");
      if (result.profileCompletionRequired === true) {
        setMessage("First name, last name, phone, email, and a profile picture are all required.");
        return;
      }
      await onSaved();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save your profile.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-4">
      <section className="w-full max-w-md space-y-4 rounded-md border border-border bg-card p-6 shadow-xl" aria-labelledby="profile-completion-title">
        <div>
          <h1 id="profile-completion-title" className="text-xl font-semibold">Finish your profile</h1>
          <p className="mt-1 text-sm text-muted-foreground">Add your first and last name, phone number, email, and a profile picture before continuing.</p>
        </div>
        <div className="space-y-3">
          <div>
            <Label htmlFor="completion-first-name">First name</Label>
            <Input id="completion-first-name" value={firstName} maxLength={100} onChange={(event) => setFirstName(event.target.value)} autoComplete="given-name" />
          </div>
          <div>
            <Label htmlFor="completion-last-name">Last name</Label>
            <Input id="completion-last-name" value={lastName} maxLength={100} onChange={(event) => setLastName(event.target.value)} autoComplete="family-name" />
          </div>
          <div>
            <Label htmlFor="completion-phone">Phone</Label>
            <Input id="completion-phone" value={phone} maxLength={20} onChange={(event) => setPhone(event.target.value)} autoComplete="tel" />
          </div>
          <div>
            <Label htmlFor="completion-email">Email</Label>
            <Input id="completion-email" type="email" value={emailLocked ? user.email : email} maxLength={200} readOnly={emailLocked} onChange={(event) => setEmail(event.target.value)} autoComplete="email" />
          </div>
          <div>
            <Label htmlFor="completion-photo">Profile picture</Label>
            {user.avatarUrl ? <img src={user.avatarUrl} alt="" className="mt-2 h-16 w-16 rounded-full object-cover" /> : null}
            <Input id="completion-photo" className="mt-2" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
          </div>
        </div>
        {message && <p role="alert" className="text-sm text-destructive">{message}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onSignOut} disabled={saving}>Sign out</Button>
          <Button type="button" onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save and continue"}</Button>
        </div>
      </section>
    </div>
  );
}
