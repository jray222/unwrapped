/** Shared application state. */

export const state = {
  sessionKind: null, // 'user' | 'instance_admin' | 'guest' | 'assignment'
  currentUser: null,
  csrfToken: '',
  memberships: [],
  currentFamilyId: null,
  currentFamilyRole: 'member',
  lists: [],
  currentList: null,
  currentPriceFilter: 'all',
  notifications: [],
  offlineQueue: [],
  activeModal: null,
  modalContext: {},
  pendingInviteToken: null,
  pendingAssistedToken: null,
};

export const OFFLINE_QUEUE_KEY = 'unwrapped_offline_queue';
