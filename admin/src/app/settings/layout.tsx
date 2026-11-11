import { SettingsNav } from "@/components/settings/settings-nav";

/** The Settings app: its panes at the left (General, Users), the one picked beside them. */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 p-6 md:flex-row">
      <SettingsNav />
      <div className="flex min-w-0 flex-1 flex-col gap-4">{children}</div>
    </main>
  );
}
