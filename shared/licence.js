// Recognises the resolver error thrown by src/licence.js when a production installation has
// no active Marketplace licence, so screens can show a clear state instead of a raw error.
export const LICENCE_INACTIVE_CODE = 'NUVRIQO_LICENCE_INACTIVE';
export const LICENCE_INACTIVE_TITLE = 'Asset Manager licence inactive';
export const LICENCE_INACTIVE_MESSAGE = 'Asset Manager does not have an active licence for this site. Ask a Jira administrator to renew or activate it in Manage apps.';

export const isLicenceInactive = (error) => String(error?.message || error || '').includes(LICENCE_INACTIVE_CODE);

// Message to show for a failed resolver call: the licence text when that is the cause,
// otherwise the error's own message or the screen's fallback.
export const errorMessage = (error, fallback) => (isLicenceInactive(error) ? LICENCE_INACTIVE_MESSAGE : error?.message || fallback);
