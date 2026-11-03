import type { Request } from 'express';

export type FamilyRole = 'family_admin' | 'member';
export type PriorityLevel = 'really_want' | 'nice_to_have';
export type AssignmentStatus = 'assigned' | 'bought' | 'couldnt_get_it';
export type SessionKind = 'user' | 'instance_admin' | 'guest' | 'assignment';

export interface UserRecord {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  password_hash: string | null;
  google_sub: string | null;
  totp_secret: string | null;
  totp_enabled: boolean;
  passkey_enrolled: boolean;
  mfa_enrolled: boolean;
  created_at: string;
}

export interface FamilyMembership {
  family_id: string;
  family_name: string;
  family_slug: string;
  role: FamilyRole;
}

export interface GuestLinkContext {
  id: string;
  family_id: string;
  guest_first_name: string;
  allowed_list_ids: string[] | null; // null means all lists in family
  created_by_user_id: string;
  expires_at: string;
}

export interface AssignmentLinkContext {
  id: string;
  family_id: string;
  assignee_first_name: string;
  created_by_user_id: string;
  expires_at: string;
}

export interface AuthContext {
  sessionId: string;
  csrfToken: string;
  kind: SessionKind;
  // Populated when kind === 'user'
  user?: UserRecord;
  memberships?: FamilyMembership[];
  // Populated when kind === 'guest'
  guestLink?: GuestLinkContext;
  // Populated when kind === 'assignment'
  assignmentLink?: AssignmentLinkContext;
}

export interface AuthenticatedRequest extends Request {
  auth?: AuthContext;
}
