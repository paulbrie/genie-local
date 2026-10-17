import { redirect } from "next/navigation";

import { ProjectTabRedirect } from "@/components/project-tab-nav";
import { getProject, PROJECT_TABS } from "@/lib/project-page";

export const dynamic = "force-dynamic";

/**
 * /projects/<slug>: reopen the tab used last on this project. Old links with
 * ?tab=…[&app=…&commit=…] (Comms, Agents City) go to the matching page.
 */
export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const tab = one(query.tab);
  const base = `/projects/${encodeURIComponent(slug)}`;
  if (tab === "git") {
    const commit = one(query.commit);
    const app = one(query.app);
    const appQuery = app ? `?app=${encodeURIComponent(app)}` : "";
    redirect(
      commit && /^[0-9a-f]{4,64}$/i.test(commit)
        ? `${base}/git/${commit}${appQuery}`
        : `${base}/git${appQuery}`,
    );
  }
  if (tab && (PROJECT_TABS as readonly string[]).includes(tab)) redirect(`${base}/${tab}`);

  const detail = await getProject(slug);
  const hasGit = !!detail?.apps.some(({ app }) => app.isGit);
  return (
    <ProjectTabRedirect
      slug={slug}
      tabs={PROJECT_TABS.filter((t) => t !== "git" || hasGit)}
    />
  );
}
