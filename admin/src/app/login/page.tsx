import { LoginForm } from "@/components/login-form";
import { genieIdentity } from "@/lib/genie-sso";

export const dynamic = "force-dynamic";

/** /login: Sign in with Google (through Genie) when this server is set up for it, and the emergency password login. */
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return <LoginForm genie={genieIdentity() !== null} genieError={typeof error === "string" ? error : null} />;
}
