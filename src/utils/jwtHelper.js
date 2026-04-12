import jwt from 'jsonwebtoken';

const normalizePem = (value) => {
  if (!value || typeof value !== 'string') return null;
  return value.replace(/\\n/g, '\n');
};

const privateKey = normalizePem(process.env.JWT_PRIVATE_KEY);
const publicKey = normalizePem(process.env.JWT_PUBLIC_KEY);
const preferredAlg = process.env.JWT_ALGORITHM || 'HS256';
const useAsymmetric = preferredAlg === 'RS256' && !!privateKey && !!publicKey;

const getSignSecret = () => (useAsymmetric ? privateKey : (process.env.JWT_SECRET || 'secret'));
const getVerifySecret = () => (useAsymmetric ? publicKey : (process.env.JWT_SECRET || 'secret'));

export const signJwt = (payload, expiresIn = '7d') => jwt.sign(payload, getSignSecret(), {
  algorithm: useAsymmetric ? 'RS256' : 'HS256',
  expiresIn
});

export const verifyJwt = (token) => jwt.verify(token, getVerifySecret(), {
  algorithms: useAsymmetric ? ['RS256'] : ['HS256']
});

