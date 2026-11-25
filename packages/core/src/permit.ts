// Constants of the permit format, shared by the API that signs permits and the Node SDK that verifies them.

export const PERMIT_TYP = 'stringbow-permit+jwt';
export const PERMIT_MAX_TTL_S = 600;
export const JWKS_PATH = '/.well-known/stringbow-keys.json';
