import { redirect } from "next/navigation";

/** /users: the users are managed in Settings now (an old link or bookmark lands there). */
export default function UsersPage() {
  redirect("/settings/users");
}
