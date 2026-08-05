function normalizePlatformAccess(value) {
  return ['allow', 'jst', 'shopee'].includes(value) ? value : 'allow';
}

function isSystemAdmin(auth) {
  return auth?.username === 'admin' && auth?.role === 'admin';
}

function isGroupAdmin(auth) {
  return auth?.role === 'group_admin' && Boolean(auth?.group_id);
}

function isUserManager(auth) {
  return isSystemAdmin(auth) || isGroupAdmin(auth);
}

function canManageUser(auth, user) {
  if (!isUserManager(auth) || !user) return false;
  if (isSystemAdmin(auth)) return true;
  return user.id !== 'admin'
    && user.role !== 'admin'
    && user.group_id === auth.group_id;
}

function canGrantPlatformAccess(auth, requestedAccess) {
  if (isSystemAdmin(auth)) return true;
  if (!isGroupAdmin(auth)) return false;
  const ownAccess = normalizePlatformAccess(auth.platform_access);
  const requested = normalizePlatformAccess(requestedAccess);
  return ownAccess === 'allow' || ownAccess === requested;
}

function manageablePlatforms(auth) {
  if (isSystemAdmin(auth) || normalizePlatformAccess(auth?.platform_access) === 'allow') return ['jst', 'shopee'];
  return [normalizePlatformAccess(auth?.platform_access)];
}

export {
  canGrantPlatformAccess,
  canManageUser,
  isGroupAdmin,
  isSystemAdmin,
  isUserManager,
  manageablePlatforms,
};
