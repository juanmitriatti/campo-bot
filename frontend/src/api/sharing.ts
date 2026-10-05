import { apiRequest } from './client';

export interface SharedMember {
  userId: number;
  name: string | null;
  phone: string | null;
  phoneLabel: string;
  role: string;
  since: string;
}

export type InviteStatus = 'pending' | 'used' | 'revoked' | 'expired';

export interface FieldInvite {
  id: number;
  code: string;
  phone: string | null;
  phoneLabel: string | null;
  status: InviteStatus;
  expiresAt: string;
  createdAt: string;
}

export interface SharedByMeField {
  fieldId: number;
  fieldName: string;
  members: SharedMember[];
  invites: FieldInvite[];
}

export interface SharedWithMeField {
  fieldId: number;
  fieldName: string;
  role: string;
  since: string;
  ownerName: string | null;
  ownerPhone: string | null;
  ownerPhoneLabel: string | null;
}

export interface SharingOverview {
  /** El plan incluye compartir: si no, solo se ven (y se pueden dejar) los campos ajenos. */
  canShare: boolean;
  sharedByMe: SharedByMeField[];
  sharedWithMe: SharedWithMeField[];
}

export interface CreatedInvite {
  invite: { code: string; phone: string | null; phoneLabel: string; expiresAt: string };
  /** null cuando no hay número de bot configurado: se muestra el código pelado. */
  waLink: string | null;
  waText: string;
  registerLink: string | null;
  /** 'link' = lo reenvía el dueño. 'sent' = el bot lo mandó (requiere plantilla). */
  delivery: 'link' | 'sent';
}

export function fetchSharing(): Promise<SharingOverview> {
  return apiRequest<SharingOverview>('/sharing/overview');
}

export function inviteToField(fieldId: number, phone: string): Promise<CreatedInvite> {
  return apiRequest<CreatedInvite>(`/sharing/fields/${fieldId}/invites`, {
    method: 'POST',
    body: JSON.stringify({ phone }),
  });
}

export function revokeInvite(inviteId: number): Promise<{ revoked: boolean; message: string }> {
  return apiRequest(`/sharing/invites/${inviteId}`, { method: 'DELETE' });
}

export function removeMember(fieldId: number, memberId: number): Promise<{ removed: boolean; message: string }> {
  return apiRequest(`/sharing/fields/${fieldId}/members/${memberId}`, { method: 'DELETE' });
}

export function joinField(code: string): Promise<{ joined: boolean; fieldName: string; message: string }> {
  return apiRequest('/sharing/join', { method: 'POST', body: JSON.stringify({ code }) });
}
