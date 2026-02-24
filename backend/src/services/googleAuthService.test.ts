import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { Request, Response } from 'express';

// Use vi.hoisted to create mocks that can be used in vi.mock factories
const {
    mockGenerateAuthUrl,
    mockGetToken,
    mockVerifyIdToken,
    mockObtainFromClientCredentials,
    mockStoreGrant,
    mockAuthenticated,
    mockOAuth2Constructor,
    mockOAuth2ClientConstructor,
    mockAxiosPost,
    mockCreateGrant
} = vi.hoisted(() => {
    const mockGenerateAuthUrl = vi.fn();
    const mockGetToken = vi.fn();
    const mockVerifyIdToken = vi.fn();
    const mockObtainFromClientCredentials = vi.fn();
    const mockStoreGrant = vi.fn();
    const mockAuthenticated = vi.fn();
    const mockAxiosPost = vi.fn();
    const mockCreateGrant = vi.fn();
    const mockOAuth2Constructor = vi.fn(function () {
        return {
            generateAuthUrl: mockGenerateAuthUrl,
            getToken: mockGetToken
        };
    });
    const mockOAuth2ClientConstructor = vi.fn(function () {
        return {
            verifyIdToken: mockVerifyIdToken
        };
    });

    return {
        mockGenerateAuthUrl,
        mockGetToken,
        mockVerifyIdToken,
        mockObtainFromClientCredentials,
        mockStoreGrant,
        mockAuthenticated,
        mockOAuth2Constructor,
        mockOAuth2ClientConstructor,
        mockAxiosPost,
        mockCreateGrant
    };
});

vi.mock('axios', () => ({
    default: {
        post: mockAxiosPost
    }
}));

// Mock modules before importing
vi.mock('googleapis', () => ({
    google: {
        auth: {
            OAuth2: mockOAuth2Constructor
        }
    }
}));

vi.mock('google-auth-library', () => ({
    OAuth2Client: mockOAuth2ClientConstructor
}));

vi.mock('../auth/keycloakManager.js', () => ({
    getKeycloakClient: vi.fn(() => ({
        grantManager: {
            obtainFromClientCredentials: mockObtainFromClientCredentials,
            createGrant: mockCreateGrant
        },
        storeGrant: mockStoreGrant,
        authenticated: mockAuthenticated
    }))
}));

vi.mock('../utils/sessionStore.js', () => ({
    sessionStore: {}
}));

vi.mock('../utils/logger.js', () => ({
    default: {
        error: vi.fn(),
        info: vi.fn()
    }
}));

vi.mock('../config/env.js', () => ({
    envConfig: {
        DOMAIN_URL: 'https://example.com',
        PORTAL_REALM: 'test-realm',
        PORTAL_AUTH_SERVER_CLIENT: 'test-portal-client',
        GOOGLE_OAUTH_CLIENT_ID: 'test-client-id',
        GOOGLE_OAUTH_CLIENT_SECRET: 'test-client-secret',
        KEYCLOAK_GOOGLE_CLIENT_ID: 'test-keycloak-client-id',
        KEYCLOAK_GOOGLE_CLIENT_SECRET: 'test-keycloak-client-secret'
    }
}));

import googleOauth, { createSession } from './googleAuthService.js';
import logger from '../utils/logger.js';

describe('GoogleAuthService - Core OAuth', () => {
    let mockRequest: Partial<Request>;
    let mockResponse: Partial<Response>;

    beforeEach(() => {
        vi.clearAllMocks();

        // Reset mock implementations
        mockGenerateAuthUrl.mockReset();
        mockGetToken.mockReset();
        mockVerifyIdToken.mockReset();
        mockObtainFromClientCredentials.mockReset();
        mockStoreGrant.mockReset();
        mockAuthenticated.mockReset();
        mockAxiosPost.mockReset();
        mockCreateGrant.mockReset();

        mockRequest = {
            get: vi.fn((header: string) => {
                if (header === 'host') return 'example.com';
                return undefined;
            }) as any,
            session: {} as any,
            kauth: undefined
        };

        mockResponse = {
            cookie: vi.fn(),
            clearCookie: vi.fn()
        };
    });

    describe('generateAuthUrl', () => {
        it('should generate auth URL with correct parameters', () => {
            const expectedUrl = new URL('https://example.com/auth/realms/test-realm/protocol/openid-connect/auth');
            expectedUrl.searchParams.append('client_id', 'test-keycloak-client-id');
            expectedUrl.searchParams.append('redirect_uri', 'https://example.com/google/auth/callback');
            expectedUrl.searchParams.append('response_type', 'code');
            expectedUrl.searchParams.append('scope', 'openid');
            expectedUrl.searchParams.append('state', 'test-state');
            expectedUrl.searchParams.append('nonce', 'test-nonce');
            expectedUrl.searchParams.append('kc_idp_hint', 'google');

            const result = googleOauth.generateAuthUrl({
                nonce: 'test-nonce',
                state: 'test-state',
                req: mockRequest as Request
            });

            expect(result).toBe(expectedUrl.toString());
        });

        it('should throw error when client creation fails due to missing host', () => {
            (mockRequest.get as Mock).mockReturnValue(undefined);
            expect(() => googleOauth.generateAuthUrl({
                nonce: 'test-nonce',
                state: 'test-state',
                req: mockRequest as Request
            })).toThrow('HOST_HEADER_MISSING');
        });
    });



    describe('verifyAndGetProfile', () => {
        const mockTokenData = {
            id_token: 'header.eyJlbWFpbCI6InRlc3RAZXhhbXBsZS5jb20iLCJuYW1lIjoiVGVzdCBVc2VyIn0.signature',
            access_token: 'test-access-token'
        };

        it('should verify token and return user profile', async () => {
            mockAxiosPost.mockResolvedValue({ data: mockTokenData });

            const result = await googleOauth.verifyAndGetProfile({
                code: 'test-code'
            });

            expect(result).toEqual({ emailId: 'test@example.com', name: 'Test User', tokenData: mockTokenData });
            expect(mockAxiosPost).toHaveBeenCalled();
        });

        it('should throw error when token fetch fails', async () => {
            mockAxiosPost.mockRejectedValue(new Error('Token fetch failed'));
            await expect(googleOauth.verifyAndGetProfile({
                code: 'test-code'
            })).rejects.toThrow();
            expect(logger.error).toHaveBeenCalled();
        });

        it('should throw error for invalid tokens or payload', async () => {
            mockAxiosPost.mockResolvedValue({ data: { access_token: 'test' } });
            await expect(googleOauth.verifyAndGetProfile({
                code: 'test-code'
            })).rejects.toThrow('FAILED_TO_FETCH_ID_TOKEN');
        });
    });

    describe('createSession', () => {
        const mockGrant = {
            access_token: { token: 'test-access-token', content: { exp: 1234567890 } }
        };

        beforeEach(() => {
            mockAxiosPost.mockResolvedValue({
                data: {
                    access_token: 'test-access-token',
                    refresh_token: 'test-refresh-token',
                    id_token: 'test-id-token',
                    expires_in: 3600,
                    token_type: 'Bearer'
                }
            });
            mockCreateGrant.mockResolvedValue(mockGrant);
            mockAuthenticated.mockResolvedValue(undefined);
        });

        it('should create session successfully', async () => {
            const result = await createSession({ access_token: 'test', refresh_token: 'test', id_token: 'test', expires_in: 3600, token_type: 'Bearer' }, mockRequest as Request, mockResponse as Response);

            expect(result).toEqual({ access_token: 'test-access-token', expires_at: 1234567890 });
            expect(mockCreateGrant).toHaveBeenCalled();
            expect(mockStoreGrant).toHaveBeenCalledWith(mockGrant, mockRequest, mockResponse);
            expect(mockRequest.kauth).toEqual({ grant: mockGrant });
        });

        it('should throw error when grant token is invalid', async () => {
            mockCreateGrant.mockResolvedValue(null);
            await expect(createSession({ access_token: 'test', refresh_token: 'test', id_token: 'test', expires_in: 3600, token_type: 'Bearer' }, mockRequest as Request, mockResponse as Response))
                .rejects.toThrow('GRANT_CREATION_FAILED');
        });
    });
});
