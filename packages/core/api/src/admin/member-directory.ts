// ---------------------------------------------------------------------------
// The admin users plane's directory, derived from the shared `MemberDirectory`
// seam — so each host's `AdminUsersProvider` no longer carries its own
// identity join and email resolver.
// ---------------------------------------------------------------------------

import { Effect } from "effect";

import { MemberStatus, type MemberDirectoryShape } from "../server/member-directory";
import type { AdminUserDirectory, AdminUserIdentity } from "./reads";

/**
 * Both directions of the admin plane's directory over one org's
 * {@link MemberDirectoryShape}.
 *
 * `identities` is one batched `membersById` read for the page of ids (never a
 * lookup per user); a member the org does not hold reports absent identity.
 * `resolveEmail` receives the already-normalized email the contract promises
 * and answers with the host principal id, or `null` when no member has it.
 *
 * Both read ANY membership status, not the directory's active + pending
 * default: this plane reports footprint, not current access. A member who was
 * removed while their connections remain must still be named on the users
 * page and findable by the address an operator has for them.
 *
 * Both fail with `MemberDirectoryError`, which the shared reads treat as a
 * decorative-join outage (identities) or surface as a failed read (resolve).
 */
export const adminUserDirectoryFromMembers = (
  directory: MemberDirectoryShape,
  organizationId: string,
): AdminUserDirectory => ({
  identities: (externalIds) =>
    directory.membersById(organizationId, externalIds, MemberStatus.literals).pipe(
      Effect.map((members) => {
        const identities = new Map<string, AdminUserIdentity>();
        for (const [accountId, member] of members) {
          identities.set(accountId, {
            email: member.email,
            displayName: member.name,
          });
        }
        return identities;
      }),
    ),
  resolveEmail: (email) =>
    directory
      .findByEmail(organizationId, email, MemberStatus.literals)
      .pipe(Effect.map((member) => (member === null ? null : member.accountId))),
});
